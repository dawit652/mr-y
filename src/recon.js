/**
 * recon.js
 * ---------------------------------------------------------------------------
 * Orchestrates a capture run:
 *
 *   launch browser -> apply stealth profile -> attach CDP collectors
 *   -> navigate -> observe (with human-like activity) -> drain -> report
 *
 * Exposed as a library function so it can be reused from tests or other
 * scripts; bin/netrecon.js is a thin CLI wrapper around it.
 */

import puppeteer from 'puppeteer';
import { createUrlFilter } from './filter.js';
import { STEALTH_LAUNCH_ARGS, applyStealth, humanDelay, randomProfile, simulateHumanActivity } from './stealth.js';
import { createHttpCollector } from './collectors/http.js';
import { createWebSocketCollector } from './collectors/websocket.js';
import { createSseCollector } from './collectors/sse.js';
import { buildReport } from './reporter.js';
import { sleep } from './util.js';

/**
 * Run a capture against `opts.url`.
 *
 * @param {object} opts  Resolved options (see src/config.js and src/cli.js)
 * @param {{ log?: (msg: string) => void, signal?: AbortSignal }} [hooks]
 *   `log` receives progress messages; `signal` ends observation early
 *   (e.g. on Ctrl+C) while still producing a report.
 * @returns {Promise<object>} The report object (see reporter.buildReport).
 */
export async function runRecon(opts, { log = () => {}, signal } = {}) {
  const startedAt = new Date();
  const filter = createUrlFilter(opts.keywords, { captureAll: opts.captureAll });
  const profile = opts.stealth ? randomProfile() : null;

  // -- 1. Launch browser ----------------------------------------------------
  const args = [...(opts.stealth ? STEALTH_LAUNCH_ARGS : [])];
  // Chrome refuses to start as root without disabling its sandbox
  // (typical inside Docker/CI containers).
  if (typeof process.getuid === 'function' && process.getuid() === 0) args.push('--no-sandbox');
  if (profile) args.push(`--window-size=${profile.viewport.width},${profile.viewport.height + 85}`);
  // Accept self-signed / intercepted (MITM proxy) certificates.
  args.push('--ignore-certificate-errors', '--ignore-ssl-errors');

  log('Launching browser…');
  const browser = await puppeteer.launch({
    acceptInsecureCerts: true, // Puppeteer >=22 name for the old `ignoreHTTPSErrors`
    headless: opts.headless,
    executablePath: opts.executablePath || undefined,
    args,
    // `--enable-automation` shows the infobar and sets navigator.webdriver.
    ignoreDefaultArgs: opts.stealth ? ['--enable-automation'] : [],
    defaultViewport: profile ? null : undefined,
  });

  try {
    const page = await browser.newPage();
    if (profile) await applyStealth(page, profile);

    // -- 2. Attach collectors on a dedicated CDP session --------------------
    const client = await page.createCDPSession();
    await client.send('Network.enable', {
      // Give Chrome room to retain response bodies until we fetch them.
      maxTotalBufferSize: 200 * 1024 * 1024,
      maxResourceBufferSize: 20 * 1024 * 1024,
    });

    const streamFilter = opts.filterStreams ? filter : null;
    const http = createHttpCollector(client, { filter, maxBodyBytes: opts.maxBodyBytes });
    const ws = createWebSocketCollector(client, {
      filter: streamFilter,
      messageLimit: opts.wsMessageLimit,
      maxFrameBytes: opts.maxFrameBytes,
    });
    const sse = createSseCollector(client, {
      filter: streamFilter,
      messageLimit: opts.sseMessageLimit,
      maxFrameBytes: opts.maxFrameBytes,
    });

    // -- 3. Navigate ----------------------------------------------------------
    // A short pause before navigating mimics a user typing/pasting a URL.
    if (opts.stealth) await humanDelay(400, 1500);
    log(`Navigating to ${opts.url}`);

    let navigationError = null;
    try {
      // 'domcontentloaded' + a separate idle wait is more robust than
      // 'networkidle0', which never fires on sites that poll constantly.
      await page.goto(opts.url, { waitUntil: 'domcontentloaded', timeout: opts.navTimeoutMs });
      await page.waitForNetworkIdle({ idleTime: 1000, timeout: 10_000 }).catch(() => {});
    } catch (err) {
      // Keep going: partial traffic is still useful for analysis.
      navigationError = err.message;
      log(`Navigation issue: ${err.message} (continuing with what was captured)`);
    }

    // -- 4. Observe -------------------------------------------------------------
    log(`Observing traffic for ${Math.round(opts.observeMs / 1000)}s… (Ctrl+C to stop early)`);
    const aborted = new Promise((resolve) => {
      if (signal?.aborted) return resolve();
      signal?.addEventListener('abort', resolve, { once: true });
    });
    const activity = profile
      ? simulateHumanActivity(page, profile.viewport, opts.observeMs)
      : sleep(opts.observeMs);
    await Promise.race([activity, sleep(opts.observeMs), aborted]);

    // -- 5. Collect page info and drain in-flight body fetches ----------------
    const finalUrl = page.url();
    const pageTitle = await page.title().catch(() => null);
    log('Collecting pending response bodies…');
    await Promise.race([http.drain(), sleep(10_000)]);

    const finishedAt = new Date();
    return buildReport(
      {
        tool: 'netrecon',
        target: opts.url,
        finalUrl,
        pageTitle,
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        durationMs: finishedAt - startedAt,
        browserVersion: await browser.version(),
        stealth: opts.stealth,
        profile,
        filter: {
          keywords: filter.keywords,
          captureAll: filter.captureAll,
          filterStreams: opts.filterStreams,
        },
        limits: {
          maxBodyBytes: opts.maxBodyBytes,
          maxFrameBytes: opts.maxFrameBytes,
          wsMessageLimit: opts.wsMessageLimit,
          sseMessageLimit: opts.sseMessageLimit,
        },
        navigationError,
        aborted: Boolean(signal?.aborted),
      },
      { http, ws, sse },
    );
  } finally {
    await browser.close().catch(() => {});
  }
}
