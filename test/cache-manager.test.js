/**
 * Unit tests for src/casino/cache-manager.js against an in-memory Redis stand-in.
 *
 *   node --test test/cache-manager.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CacheManager } from '../src/casino/cache-manager.js';

function fakeRedis() {
  const store = new Map();
  return {
    store,
    calls: [],
    async get(k) { return store.get(k)?.value ?? null; },
    async set(k, value, ...args) { this.calls.push(['set', k, ...args]); store.set(k, { value }); return 'OK'; },
    async del(k) { return store.delete(k) ? 1 : 0; },
  };
}

const UUID = 'AAAAAAAA-1111-4111-8111-111111111111';

test('stores entries under a namespaced, lower-cased key with a TTL', async () => {
  const redis = fakeRedis();
  const cache = new CacheManager(redis, { prefix: 'p', ttlSec: 240, log: () => {} });
  assert.equal(await cache.set(UUID, { playUrl: 'https://g/1', sessionId: 'a' }), true);
  assert.deepEqual(redis.calls[0], ['set', `p:cache:play:${UUID.toLowerCase()}`, 'EX', 240]);
  const hit = await cache.get(UUID);
  assert.equal(hit.playUrl, 'https://g/1');
  assert.equal(hit.sessionId, 'a');
  assert.ok(hit.ageMs >= 0 && hit.ageMs < 1_000);
  assert.deepEqual(cache.stats(), { ttlSec: 240, memoryHits: 0, hits: 1, misses: 0, errors: 0, memoryEntries: 0 });
});

test('memory tier answers hot keys without Redis and expires with the Redis copy', async () => {
  const redis = fakeRedis();
  const cache = new CacheManager(redis, { prefix: 'p', ttlSec: 240, memoryEntries: 100, log: () => {} });
  await cache.set(UUID, { playUrl: 'https://g/1', sessionId: 'a' });
  let redisReads = 0;
  redis.get = async () => { redisReads++; return null; };
  assert.equal(cache.peek(UUID).playUrl, 'https://g/1');
  assert.equal((await cache.get(UUID)).playUrl, 'https://g/1');
  assert.equal(redisReads, 0);
  assert.equal(cache.stats().memoryHits, 2);

  cache.remember(UUID, { playUrl: 'https://g/old', fetchedAt: Date.now() - 241_000 });
  assert.equal(cache.peek(UUID), null, 'expired memory entries are dropped');
});

test('a Redis hit is copied into memory', async () => {
  const redis = fakeRedis();
  const writer = new CacheManager(redis, { prefix: 'p', log: () => {} });
  await writer.set(UUID, { playUrl: 'https://g/2' });
  const reader = new CacheManager(redis, { prefix: 'p', memoryEntries: 10, log: () => {} });
  assert.equal(reader.peek(UUID), null);
  assert.equal((await reader.get(UUID)).playUrl, 'https://g/2');
  assert.equal(reader.peek(UUID).playUrl, 'https://g/2');
});

test('memory tier keeps at most memoryEntries entries, dropping the oldest', () => {
  const cache = new CacheManager(fakeRedis(), { memoryEntries: 2, log: () => {} });
  const id = (n) => `${String(n).padStart(8, '0')}-1111-4111-8111-111111111111`;
  for (const n of [1, 2, 3]) cache.remember(id(n), { playUrl: `u${n}`, fetchedAt: Date.now() });
  assert.equal(cache.peek(id(1)), null);
  assert.equal(cache.peek(id(3)).playUrl, 'u3');
  assert.equal(cache.stats().memoryEntries, 2);
});

test('an entry is stored in Redis only for the rest of its lifetime', async () => {
  const redis = fakeRedis();
  const cache = new CacheManager(redis, { prefix: 'p', ttlSec: 240, log: () => {} });
  assert.equal(await cache.set(UUID, { playUrl: 'x', fetchedAt: Date.now() - 200_000 }), true);
  assert.deepEqual(redis.calls[0].slice(2), ['EX', 40]);
  assert.equal(await cache.set(UUID, { playUrl: 'x', fetchedAt: Date.now() - 300_000 }), false, 'already expired');
});

test('treats entries older than the TTL as a miss', async () => {
  const redis = fakeRedis();
  const cache = new CacheManager(redis, { prefix: 'p', ttlSec: 240, log: () => {} });
  redis.store.set(cache.key(UUID), { value: JSON.stringify({ playUrl: 'https://old', fetchedAt: Date.now() - 241_000 }) });
  assert.equal(await cache.get(UUID), null);
});

test('ignores corrupt entries', async () => {
  const redis = fakeRedis();
  const cache = new CacheManager(redis, { prefix: 'p', log: () => {} });
  redis.store.set(cache.key(UUID), { value: '{nope' });
  assert.equal(await cache.get(UUID), null);
});

test('a Redis failure is a miss, not an error', async () => {
  const broken = { get: async () => { throw new Error('ECONNREFUSED'); }, set: async () => { throw new Error('ECONNREFUSED'); } };
  const logs = [];
  const cache = new CacheManager(broken, { log: (m) => logs.push(m) });
  assert.equal(await cache.get(UUID), null);
  assert.equal(await cache.set(UUID, { playUrl: 'x' }), false);
  assert.equal(cache.stats().errors, 2);
  assert.match(logs[0], /treating as miss/);
});

test('ttlSec 0 disables the cache', async () => {
  const redis = fakeRedis();
  const cache = new CacheManager(redis, { ttlSec: 0, log: () => {} });
  assert.equal(await cache.set(UUID, { playUrl: 'x' }), false);
  assert.equal(await cache.get(UUID), null);
  assert.equal(redis.calls.length, 0);
});
