/**
 * Unit tests for src/casino/capacity.js.
 *
 *   node --test test/capacity.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CapacityEstimator } from '../src/casino/capacity.js';

test('uses the initial guess until the first job is reported, then follows real durations', () => {
  const c = new CapacityEstimator({ slots: 5, timeoutMs: 45_000, safety: 0.8, initialJobMs: 1_000 });
  // 36s budget / 1s per job = 36 rounds of 5 jobs.
  assert.equal(c.safeQueue(), 180);
  assert.equal(c.jobsPerSec(), 5);
  c.record(200);
  assert.equal(c.snapshot().avgJobMs, 200, 'first sample replaces the guess');
  assert.equal(c.safeQueue(), 5 * 180);
  assert.equal(c.jobsPerSec(), 25);
});

test('smooths later samples and ignores junk', () => {
  const c = new CapacityEstimator({ slots: 5, timeoutMs: 45_000 });
  c.record(200);
  c.record(1_200);
  assert.equal(c.snapshot().avgJobMs, 400); // 200 + 0.2 * (1200 - 200)
  for (const junk of [undefined, NaN, -5, 'x']) c.record(junk);
  assert.equal(c.snapshot().samples, 2);
});

test('always admits at least one round, even when jobs are slower than the timeout', () => {
  const c = new CapacityEstimator({ slots: 5, timeoutMs: 1_000, initialJobMs: 5_000 });
  assert.equal(c.safeQueue(), 5);
});

test('Retry-After grows with how far the queue is over the limit', () => {
  const c = new CapacityEstimator({ slots: 5, timeoutMs: 45_000, initialJobMs: 1_000 }); // 5 jobs/s, limit 180
  assert.equal(c.retryAfterSec(100), 1);
  assert.equal(c.retryAfterSec(180), 1);
  assert.equal(c.retryAfterSec(229), 10); // 50 over / 5 per second
  assert.equal(c.retryAfterSec(1e9), 300, 'capped');
});

test('turned-away clients are spread over the time it takes to serve them all', () => {
  let r = 0;
  const c = new CapacityEstimator({ slots: 5, timeoutMs: 45_000, initialJobMs: 200, random: () => r }); // 25 jobs/s
  const now = Date.now();
  for (let i = 0; i < 2_500; i++) c.noteShed(now);
  // 2500 waiting clients at 25 jobs/s -> spread over ~100s.
  r = 0;
  assert.equal(c.retryAfterSec(c.safeQueue(), now), 1);
  r = 0.5;
  assert.equal(c.retryAfterSec(c.safeQueue(), now), 51);
  r = 0.999;
  assert.equal(c.retryAfterSec(c.safeQueue(), now), 100);
  // The spread fades as time passes (30s half-life): 1250 left -> ~50s.
  r = 0.5;
  assert.equal(c.retryAfterSec(c.safeQueue(), now + 30_000), 26);
});
