/**
 * capacity.js
 * ---------------------------------------------------------------------------
 * Estimates how much queued work can still finish within the request timeout.
 *
 * Workers report how long each job took; with `slots` jobs running at once
 * (the queue's global concurrency), a job at position p finishes after about
 * ceil(p / slots) * avgJob. The API admits a new job only while the queue is
 * shorter than safeQueue(), so admitted requests finish in time, and tells
 * everyone else (Retry-After) when to come back. Those waits are spread out
 * by how many requests were turned away recently, so the clients come back at
 * roughly the rate capacity frees up instead of all at the same second.
 */

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const SHED_HALF_LIFE_MS = 30_000;

export class CapacityEstimator {
  constructor({ slots, timeoutMs, safety = 0.8, initialJobMs = 1_000, alpha = 0.2, random = Math.random }) {
    this.slots = Math.max(1, slots);
    this.timeoutMs = timeoutMs;
    this.safety = safety;
    this.alpha = alpha;
    this.random = random;
    this.avgJobMs = initialJobMs; // prior until the first real sample
    this.samples = 0;
    this.recentShed = 0;          // requests turned away recently (decays with a 30s half-life)
    this.shedAt = Date.now();
  }

  /** Call for every request turned away; their Retry-After values are spread over the time it takes to serve them all. */
  noteShed(now = Date.now()) {
    this.#decay(now);
    this.recentShed++;
  }

  #decay(now) {
    const dt = now - this.shedAt;
    if (dt > 0) {
      this.recentShed *= 0.5 ** (dt / SHED_HALF_LIFE_MS);
      this.shedAt = now;
    }
  }

  /** Records one finished job's duration (exponentially weighted average). */
  record(ms) {
    if (!Number.isFinite(ms) || ms < 0) return;
    this.avgJobMs = this.samples === 0 ? ms : this.avgJobMs + this.alpha * (ms - this.avgJobMs);
    this.samples++;
  }

  jobsPerSec() {
    return (this.slots * 1000) / Math.max(this.avgJobMs, 1);
  }

  /** Queued + running jobs that can all finish within the timeout (never below one round). */
  safeQueue() {
    const rounds = Math.floor((this.timeoutMs * this.safety) / Math.max(this.avgJobMs, 1));
    return this.slots * Math.max(1, rounds);
  }

  /**
   * Seconds to tell a turned-away client to wait: until a queue of `queued`
   * jobs has drained below the safe size, plus a random share of the time
   * needed to serve everyone else who was turned away recently.
   */
  retryAfterSec(queued, now = Date.now()) {
    this.#decay(now);
    const perSec = this.jobsPerSec();
    const drain = Math.max(1, queued - this.safeQueue() + 1) / perSec;
    const spread = this.recentShed / perSec;
    return clamp(Math.ceil(drain + this.random() * spread), 1, 300);
  }

  snapshot() {
    return {
      slots: this.slots,
      avgJobMs: Math.round(this.avgJobMs),
      jobsPerSec: Math.round(this.jobsPerSec() * 10) / 10,
      safeQueue: this.safeQueue(),
      samples: this.samples,
      recentlyTurnedAway: Math.round(this.recentShed),
    };
  }
}
