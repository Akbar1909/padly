import { randomUUID } from "node:crypto";
import { Redis, type RedisOptions } from "ioredis";
import { env } from "./env.server";

declare global {
  // eslint-disable-next-line no-var
  var redisGlobal: Redis | undefined;
}

/**
 * Create a new connection. BullMQ workers need their own blocking connection. Producers pass
 * `{ enableOfflineQueue: false }` so commands fail fast while Redis is down instead of waiting.
 */
export function createRedis(options: RedisOptions = {}): Redis {
  // BullMQ requires maxRetriesPerRequest: null on connections it blocks on.
  return new Redis(env().REDIS_URL, { maxRetriesPerRequest: null, ...options });
}

/** Reject after `ms` (the operation itself is not cancelled). */
export function withTimeout<T>(promise: Promise<T>, ms: number, what = "operation"): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Shared connection for non-blocking commands (queues, throttle state). */
export function redis(): Redis {
  if (!global.redisGlobal) {
    global.redisGlobal = createRedis();
  }
  return global.redisGlobal;
}

// ─── Locks ──────────────────────────────────────────────────────────────────

// Delete the key only if it still holds our nonce: a lock that expired and was
// taken by someone else must not be released by the old holder.
const RELEASE_SCRIPT = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Take a lock that expires after `ttlMs`. Returns its release function, or null if it's held. */
export async function tryLock(key: string, ttlMs: number): Promise<(() => Promise<void>) | null> {
  const nonce = randomUUID();
  const ok = await redis().set(key, nonce, "PX", ttlMs, "NX");
  if (ok !== "OK") return null;
  return async () => {
    await redis().eval(RELEASE_SCRIPT, 1, key, nonce);
  };
}

/**
 * Run `fn` while holding `key`, waiting up to `waitMs` for another holder to
 * finish. If the lock still can't be had after that (a holder outlived its
 * TTL and someone else got in), run anyway rather than fail the caller.
 */
export async function withLock<T>(
  key: string,
  opts: { ttlMs: number; waitMs: number; pollMs?: number },
  fn: () => Promise<T>,
): Promise<T> {
  const deadline = Date.now() + opts.waitMs;
  let release = await tryLock(key, opts.ttlMs);
  while (!release && Date.now() < deadline) {
    await sleep(opts.pollMs ?? 100);
    release = await tryLock(key, opts.ttlMs);
  }
  try {
    return await fn();
  } finally {
    await release?.();
  }
}
