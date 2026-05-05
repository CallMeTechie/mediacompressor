// packages/auth/src/argon2-semaphore.ts
type Resolver<T> = (value: T | PromiseLike<T>) => void;

interface Waiter<T> {
  task: () => Promise<T>;
  resolve: Resolver<T>;
  reject: (err: unknown) => void;
  timer?: NodeJS.Timeout;
}

export class SemaphoreTimeoutError extends Error {
  constructor(public readonly timeoutMs: number) {
    super(`Argon2Semaphore wait exceeded ${timeoutMs} ms`);
    this.name = 'SemaphoreTimeoutError';
  }
}

export interface SemaphoreRunOptions {
  /** Max wait time in queue before SemaphoreTimeoutError is thrown. Default 500 ms (Spec Sektion 7). */
  timeoutMs?: number;
}

export class Argon2Semaphore {
  private active = 0;
  private readonly waiters: Waiter<unknown>[] = [];

  constructor(private readonly maxConcurrent: number) {
    if (maxConcurrent < 1) throw new Error('maxConcurrent must be ≥ 1');
  }

  async run<T>(task: () => Promise<T>, options: SemaphoreRunOptions = {}): Promise<T> {
    const timeoutMs = options.timeoutMs ?? 500;

    if (this.active < this.maxConcurrent) {
      this.active++;
      try {
        return await task();
      } finally {
        this.release();
      }
    }

    return new Promise<T>((resolve, reject) => {
      const waiter: Waiter<unknown> = {
        task: task as () => Promise<unknown>,
        resolve: resolve as Resolver<unknown>,
        reject,
      };
      waiter.timer = setTimeout(() => {
        const idx = this.waiters.indexOf(waiter);
        if (idx >= 0) {
          this.waiters.splice(idx, 1);
          reject(new SemaphoreTimeoutError(timeoutMs));
        }
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  private release(): void {
    this.active--;
    const next = this.waiters.shift();
    if (!next) return;
    if (next.timer) clearTimeout(next.timer);
    this.active++;
    next.task()
      .then((v) => next.resolve(v))
      .catch((e) => next.reject(e))
      .finally(() => this.release());
  }
}
