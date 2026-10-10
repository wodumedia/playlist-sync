import { describe, expect, it } from 'vitest';
import { ChildTimeout, execWithTimeout, formatTimeout, isTimeoutError } from '../src/timeout.ts';

describe('formatTimeout', () => {
  it('seconds below 10 minutes, minutes above', () => {
    expect(formatTimeout(120_000)).toBe('120s');
    expect(formatTimeout(60_000)).toBe('60s');
    expect(formatTimeout(3_600_000)).toBe('60 min');
  });
});

describe('execWithTimeout', () => {
  it('kills a child that runs past the limit and throws ChildTimeout with a clear message', () => {
    const started = Date.now();
    let caught: unknown;
    try {
      execWithTimeout('sleep', ['10'], { label: 'Music read', timeoutMs: 300 });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ChildTimeout);
    expect((caught as ChildTimeout).timeoutMs).toBe(300);
    expect((caught as Error).message).toBe('Music read timed out after 0s');
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('returns stdout when the child finishes in time', () => {
    expect(execWithTimeout('echo', ['ok'], { label: 'x', timeoutMs: 5000 })).toBe('ok\n');
  });

  it('rethrows any other failure unchanged (status and stdout kept)', () => {
    let caught: { status?: number; stdout?: string } | undefined;
    try {
      execWithTimeout('sh', ['-c', 'echo probe; exit 2'], { label: 'x', timeoutMs: 5000 });
    } catch (err) {
      caught = err as { status?: number; stdout?: string };
    }
    expect(caught).not.toBeInstanceOf(ChildTimeout);
    expect(caught?.status).toBe(2);
    expect(caught?.stdout).toBe('probe\n');
  });

  it('passes the limit and kill signal to the exec, and maps ETIMEDOUT', () => {
    let seen: { timeout?: number; killSignal?: unknown } = {};
    const fake = (_c: string, _a: string[], o: { timeout?: number; killSignal?: unknown }) => {
      seen = o;
      throw Object.assign(new Error('spawnSync osascript ETIMEDOUT'), { code: 'ETIMEDOUT' });
    };
    expect(() =>
      execWithTimeout(
        'osascript',
        [],
        { label: 'Apple Music writer', timeoutMs: 3_600_000, killSignal: 'SIGTERM' },
        fake as never,
      ),
    ).toThrow('Apple Music writer timed out after 60 min');
    expect(seen.timeout).toBe(3_600_000);
    expect(seen.killSignal).toBe('SIGTERM');
  });

  it('isTimeoutError', () => {
    expect(isTimeoutError({ code: 'ETIMEDOUT' })).toBe(true);
    expect(isTimeoutError(new Error('x'))).toBe(false);
    expect(isTimeoutError(null)).toBe(false);
  });
});
