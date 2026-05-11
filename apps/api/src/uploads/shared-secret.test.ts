import { describe, expect, it } from 'vitest';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { verifyTusdSharedSecret } from './shared-secret.js';

const SECRET = 'a'.repeat(64);

interface MockReply {
  code: (c: number) => MockReply;
  send: (b: unknown) => MockReply;
  _code: number | null;
  _body: unknown;
}

function makeReply(): MockReply {
  const reply: MockReply = {
    _code: null,
    _body: null,
    code(c) {
      this._code = c;
      return this;
    },
    send(b) {
      this._body = b;
      return this;
    },
  };
  return reply;
}

function makeReq(headerValue: string | undefined): FastifyRequest {
  const headers: Record<string, string | undefined> = {};
  if (headerValue !== undefined) {
    headers['x-tusd-shared-secret'] = headerValue;
  }
  return { headers } as unknown as FastifyRequest;
}

describe('verifyTusdSharedSecret', () => {
  it('returns false + 401 AUTH_REQUIRED when header missing', async () => {
    const verify = verifyTusdSharedSecret(SECRET);
    const reply = makeReply();
    const req = makeReq(undefined);

    const result = await verify(req, reply as unknown as FastifyReply);

    expect(result).toBe(false);
    expect(reply._code).toBe(401);
    expect((reply._body as { error: { code: string } }).error.code).toBe('AUTH_REQUIRED');
  });

  it('returns false + 401 AUTH_INVALID when header is wrong (same length)', async () => {
    const verify = verifyTusdSharedSecret(SECRET);
    const reply = makeReply();
    // Same length as SECRET (64), but different content.
    const wrong = 'b'.repeat(64);
    const req = makeReq(wrong);

    const result = await verify(req, reply as unknown as FastifyReply);

    expect(result).toBe(false);
    expect(reply._code).toBe(401);
    expect((reply._body as { error: { code: string } }).error.code).toBe('AUTH_INVALID');
  });

  it('returns true when header matches exactly', async () => {
    const verify = verifyTusdSharedSecret(SECRET);
    const reply = makeReply();
    const req = makeReq(SECRET);

    const result = await verify(req, reply as unknown as FastifyReply);

    expect(result).toBe(true);
    expect(reply._code).toBeNull();
    expect(reply._body).toBeNull();
  });

  it('rejects when header has different length (no timingSafeEqual crash)', async () => {
    const verify = verifyTusdSharedSecret(SECRET);
    const reply = makeReply();
    const req = makeReq('short');

    // Must NOT throw — timingSafeEqual would throw on mismatched lengths,
    // so the implementation must short-circuit on the length check first.
    const result = await verify(req, reply as unknown as FastifyReply);

    expect(result).toBe(false);
    expect(reply._code).toBe(401);
    expect((reply._body as { error: { code: string } }).error.code).toBe('AUTH_INVALID');
  });
});
