import { describe, expect, it } from 'vitest';
import { Argon2Semaphore, SemaphoreTimeoutError } from './argon2-semaphore.js';

describe('Argon2Semaphore', () => {
  it('runs up to maxConcurrent tasks in parallel, queues the rest', async () => {
    const sem = new Argon2Semaphore(2);
    let active = 0;
    let maxActive = 0;
    const task = async (delay: number) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, delay));
      active--;
    };
    await Promise.all([
      sem.run(() => task(20)),
      sem.run(() => task(20)),
      sem.run(() => task(20)),
      sem.run(() => task(20)),
    ]);
    expect(maxActive).toBe(2);
  });

  it('propagates errors thrown inside the task', async () => {
    const sem = new Argon2Semaphore(1);
    await expect(
      sem.run(async () => {
        throw new Error('inner');
      }),
    ).rejects.toThrow('inner');
  });

  it('releases the slot even when the task throws', async () => {
    const sem = new Argon2Semaphore(1);
    await sem.run(async () => { throw new Error('x'); }).catch(() => {});
    await expect(sem.run(async () => 42)).resolves.toBe(42);
  });

  it('rejects with SemaphoreTimeoutError when wait exceeds timeoutMs (C2-Rev1)', async () => {
    const sem = new Argon2Semaphore(1);
    const slow = sem.run(() => new Promise((r) => setTimeout(r, 200)));
    await expect(
      sem.run(() => Promise.resolve('x'), { timeoutMs: 30 }),
    ).rejects.toBeInstanceOf(SemaphoreTimeoutError);
    await slow;
  });

  it('default timeout is 500 ms (matches Spec Sektion 7)', async () => {
    const sem = new Argon2Semaphore(1);
    const slow = sem.run(() => new Promise((r) => setTimeout(r, 600)));
    const start = Date.now();
    await expect(sem.run(() => Promise.resolve('x'))).rejects.toBeInstanceOf(
      SemaphoreTimeoutError,
    );
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(450);
    expect(elapsed).toBeLessThan(700);
    await slow;
  });
});
