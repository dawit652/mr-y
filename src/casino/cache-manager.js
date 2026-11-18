/**
 * cache-manager.js
 * ---------------------------------------------------------------------------
 * Short-lived two-tier cache for game launch URLs.
 *
 *   Redis   key `${prefix}:cache:play:${uuid}`, value JSON { playUrl, sessionId, fetchedAt },
 *           expires after `ttlSec` (Redis drops it itself). Shared by every process.
 *   memory  up to `memoryEntries` recent entries in this process, so hot games
 *           are answered without a Redis round trip. An entry expires at the
 *           same moment as its Redis copy (fetchedAt + ttl).
 *
 * Entries are also age-checked on read, so lowering the TTL takes effect
 * immediately. The cache is an optimisation only: any Redis error is logged
 * and treated as a miss, so a Redis hiccup never fails a request on its own.
 */

export class CacheManager {
  /** @param redis an ioredis client (or anything with get/set/del) */
  constructor(redis, { prefix = 'mr-y', ttlSec = 240, memoryEntries = 0, log = console.log } = {}) {
    this.redis = redis;
    this.prefix = prefix;
    this.ttlSec = ttlSec;
    this.memoryEntries = memoryEntries;
    this.memory = new Map(); // uuid -> entry, oldest first
    this.log = log;
    this.memoryHits = 0;
    this.hits = 0;
    this.misses = 0;
    this.errors = 0;
  }

  key(uuid) { return `${this.prefix}:cache:play:${uuid.toLowerCase()}`; }

  /** Memory tier only (synchronous). Returns an entry with ageMs, or null. */
  peek(uuid) {
    const id = uuid.toLowerCase();
    const entry = this.memory.get(id);
    if (!entry) return null;
    const ageMs = Date.now() - entry.fetchedAt;
    if (ageMs >= this.ttlSec * 1000) {
      this.memory.delete(id);
      return null;
    }
    this.memoryHits++;
    return { ...entry, ageMs };
  }

  /** Memory, then Redis. Returns { playUrl, sessionId, fetchedAt, ageMs } or null. */
  async get(uuid) {
    if (this.ttlSec <= 0) return null;
    const local = this.peek(uuid);
    if (local) return local;
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
    this.remember(uuid, entry);
    return { ...entry, ageMs };
  }

  /** Writes Redis and memory. */
  async set(uuid, { playUrl, sessionId = null, fetchedAt = Date.now() }) {
    if (this.ttlSec <= 0 || !playUrl) return false;
    const entry = { playUrl, sessionId, fetchedAt };
    // Redis keeps the entry only for what is left of its lifetime.
    const ttlLeft = Math.ceil(this.ttlSec - (Date.now() - fetchedAt) / 1000);
    if (ttlLeft <= 0) return false;
    this.remember(uuid, entry);
    try {
      await this.redis.set(this.key(uuid), JSON.stringify(entry), 'EX', ttlLeft);
      return true;
    } catch (err) {
      this.#fail('write', err);
      return false;
    }
  }

  /** Memory tier only, e.g. for a URL another process already stored in Redis. */
  remember(uuid, { playUrl, sessionId = null, fetchedAt }) {
    if (this.memoryEntries <= 0 || this.ttlSec <= 0 || !playUrl || typeof fetchedAt !== 'number') return;
    const id = uuid.toLowerCase();
    this.memory.delete(id); // re-insert as newest
    this.memory.set(id, { playUrl, sessionId, fetchedAt });
    while (this.memory.size > this.memoryEntries) this.memory.delete(this.memory.keys().next().value);
  }

  async delete(uuid) {
    this.memory.delete(uuid.toLowerCase());
    try {
      return (await this.redis.del(this.key(uuid))) > 0;
    } catch (err) {
      this.#fail('delete', err);
      return false;
    }
  }

  stats() {
    return {
      ttlSec: this.ttlSec, memoryHits: this.memoryHits, hits: this.hits, misses: this.misses,
      errors: this.errors, memoryEntries: this.memory.size,
    };
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
