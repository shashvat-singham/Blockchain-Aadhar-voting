'use strict';

const { env } = require('./env');
const { tooManyRequests } = require('./http');

/**
 * Fixed-window rate limiting.
 *
 * Backed by Upstash Redis when configured, which is the only correct option on
 * a serverless platform where each request may hit a different instance.
 * Without it we fall back to a per-instance in-memory counter -- useful in
 * local development, and better than nothing in production, but it is NOT a
 * real global limit. /api/health says so out loud.
 */

const memory = new Map();

function memoryIncrement(key, windowSeconds) {
  const now = Date.now();
  const entry = memory.get(key);

  if (!entry || entry.resetAt <= now) {
    const fresh = { count: 1, resetAt: now + windowSeconds * 1000 };
    memory.set(key, fresh);
    // Opportunistic sweep; the map is bounded by traffic to one warm instance.
    if (memory.size > 5_000) {
      for (const [k, v] of memory) if (v.resetAt <= now) memory.delete(k);
    }
    return { count: 1, resetAt: fresh.resetAt };
  }

  entry.count += 1;
  return { count: entry.count, resetAt: entry.resetAt };
}

async function upstash(commands) {
  const response = await fetch(`${env.upstashUrl}/pipeline`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.upstashToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(commands),
    signal: AbortSignal.timeout(3_000),
  });

  if (!response.ok) {
    throw new Error(`Upstash responded ${response.status}`);
  }
  return response.json();
}

async function redisIncrement(key, windowSeconds) {
  // INCR then EXPIRE NX: the TTL is set once per window, not refreshed on every
  // hit, which is what makes this a fixed window rather than a sliding one.
  const result = await upstash([
    ['INCR', key],
    ['EXPIRE', key, String(windowSeconds), 'NX'],
    ['TTL', key],
  ]);

  const count = Number(result[0]?.result ?? 0);
  const ttl = Number(result[2]?.result ?? windowSeconds);
  return { count, resetAt: Date.now() + Math.max(ttl, 1) * 1000 };
}

/**
 * @param {string} bucket Logical limiter name, e.g. 'otp-request'.
 * @param {string} identity Subject being limited (IP, voter hash, ...).
 * @param {{ limit: number, windowSeconds: number }} options
 * @returns {Promise<{ allowed: boolean, remaining: number, retryAfterSeconds: number }>}
 */
async function consume(bucket, identity, { limit, windowSeconds }) {
  const key = `rl:${bucket}:${identity}`;

  let state;
  if (env.upstashUrl && env.upstashToken) {
    try {
      state = await redisIncrement(key, windowSeconds);
    } catch (error) {
      // Availability over strictness: a Redis outage must not stop an election.
      console.error('Rate limiter unavailable, falling back to in-memory:', error.message);
      state = memoryIncrement(key, windowSeconds);
    }
  } else {
    state = memoryIncrement(key, windowSeconds);
  }

  const retryAfterSeconds = Math.max(1, Math.ceil((state.resetAt - Date.now()) / 1000));
  return {
    allowed: state.count <= limit,
    remaining: Math.max(0, limit - state.count),
    retryAfterSeconds,
  };
}

/** `consume` that throws a 429 instead of returning a verdict. */
async function enforce(bucket, identity, options, message) {
  const result = await consume(bucket, identity, options);
  if (!result.allowed) {
    throw tooManyRequests(message || 'Too many requests. Please wait and try again.', result.retryAfterSeconds);
  }
  return result;
}

/** True when limits are globally consistent rather than per-instance. */
const isDistributed = () => Boolean(env.upstashUrl && env.upstashToken);

module.exports = { consume, enforce, isDistributed };
