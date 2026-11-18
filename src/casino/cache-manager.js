/**
 * cache-manager.js
 * ---------------------------------------------------------------------------
 * Short-lived Redis cache for game launch URLs.
 *
 *   key   `${prefix}:cache:play:${uuid}`
 *   value JSON { playUrl, sessionId, fetchedAt }
 *
 * Entries expire after `ttlSec` (Redis drops them itself) and are also
 * age-checked on read, so lowering the TTL takes effect immediately.
 * The cache is an optimisation only: any Redis error is logged and treated as
 * a miss, so a Redis hiccup never fails a request on its own.
 */

export class CacheManager {
  /** @param redis an ioredis client (or anything with get/set/del) */
  constructor(redis, { prefix = 'mr-y', ttlSec = 240, log = console.log } = {}) {
    this.redis = redis;
    this.prefix = prefix;
    this.ttlSec = ttlSec;
    this.log = log;
    this.hits = 0;
    this.misses = 0;
    this.errors = 0;
  }

  key(uuid) { return `${this.prefix}:cache:play:${uuid.toLowerCase()}`; }

  /** Returns { playUrl, sessionId, fetchedAt, ageMs } or null. */
  async get(uuid) {
    if (this.ttlSec <= 0) return null;
    let raw;
    try {
      raw = await this.redis.get(this.key(uuid));
    } catch (err) {
      this.#fail('read', err);
      return null;
    }
    const entry = parse(raw);
    const ageMs = entry ? Date.now() - entry.fetchedAt : Infinity;
    if (!entry || ageMs >= this.ttlSec * 1000) {
      this.misses++;
      return null;
    }
    this.hits++;
    return { ...entry, ageMs };
  }

  async set(uuid, { playUrl, sessionId = null }) {
    if (this.ttlSec <= 0 || !playUrl) return false;
    const value = JSON.stringify({ playUrl, sessionId, fetchedAt: Date.now() });
    try {
      await this.redis.set(this.key(uuid), value, 'EX', this.ttlSec);
      return true;
    } catch (err) {
      this.#fail('write', err);
      return false;
    }
  }

  async delete(uuid) {
    try {
      return (await this.redis.del(this.key(uuid))) > 0;
    } catch (err) {
      this.#fail('delete', err);
      return false;
    }
  }

  stats() {
    return { ttlSec: this.ttlSec, hits: this.hits, misses: this.misses, errors: this.errors };
  }

  #fail(op, err) {
    this.errors++;
    this.log(`Cache ${op} failed (treating as miss): ${err.message}`);
  }
}

function parse(raw) {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    return v && typeof v.playUrl === 'string' && typeof v.fetchedAt === 'number' ? v : null;
  } catch {
    return null;
  }
}
