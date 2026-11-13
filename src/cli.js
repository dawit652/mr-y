/**
 * cli.js
 * ---------------------------------------------------------------------------
 * Command-line argument parsing. Uses Node's built-in `util.parseArgs`, so
 * there is no extra dependency. Returns a fully-resolved options object that
 * merges user flags over DEFAULTS.
 */

import { parseArgs } from 'node:util';
import { DEFAULTS } from './config.js';

export const USAGE = `
Usage: netrecon <url> [options]

Capture XHR/Fetch, WebSocket and Server-Sent Events traffic from a web page.

Options:
  -k, --keywords <list>     Comma-separated URL keywords to filter on
                            (default: ${DEFAULTS.keywords.join(',')})
  -a, --all                 Disable keyword filter; log every XHR/Fetch
      --filter-streams      Apply the keyword filter to WebSocket/SSE URLs too
  -t, --time <seconds>      Seconds to keep observing after load (default: ${DEFAULTS.observeMs / 1000})
      --nav-timeout <sec>   Navigation timeout in seconds (default: ${DEFAULTS.navTimeoutMs / 1000})
  -w, --ws-messages <n>     WebSocket frames to keep per connection (default: ${DEFAULTS.wsMessageLimit})
      --sse-messages <n>    SSE messages to keep per stream (default: ${DEFAULTS.sseMessageLimit})
      --max-body <bytes>    Truncate response bodies above this size (default: ${DEFAULTS.maxBodyBytes})
  -o, --out <file>          Write the JSON report to this exact path
      --out-dir <dir>       Directory for auto-named reports (default: ${DEFAULTS.outDir})
      --headful             Show the browser window
      --no-stealth          Disable UA/viewport randomisation and human-like delays
      --chrome <path>       Use a specific Chrome/Chromium binary
  -h, --help                Show this help
`;

/** Parse a strictly positive integer, or throw a readable error. */
function toPositiveInt(value, flag) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`Invalid value for ${flag}: "${value}" (expected a positive number)`);
  }
  return Math.floor(n);
}

/** Ensure the target is an absolute http(s) URL; add https:// if missing. */
function normaliseUrl(raw) {
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  let url;
  try {
    url = new URL(withScheme);
  } catch {
    throw new Error(`Invalid URL: "${raw}"`);
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error(`Unsupported protocol "${url.protocol}" (only http/https)`);
  }
  return url.href;
}

/**
 * @param {string[]} argv  process.argv.slice(2)
 * @returns {{help: true} | object}  resolved options
 */
export function parseCli(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      keywords: { type: 'string', short: 'k' },
      all: { type: 'boolean', short: 'a' },
      'filter-streams': { type: 'boolean' },
      time: { type: 'string', short: 't' },
      'nav-timeout': { type: 'string' },
      'ws-messages': { type: 'string', short: 'w' },
      'sse-messages': { type: 'string' },
      'max-body': { type: 'string' },
      out: { type: 'string', short: 'o' },
      'out-dir': { type: 'string' },
      headful: { type: 'boolean' },
      'no-stealth': { type: 'boolean' },
      chrome: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });

  if (values.help) return { help: true };
  if (positionals.length !== 1) {
    throw new Error('Exactly one target URL is required.');
  }

  const opts = { ...DEFAULTS, keywords: [...DEFAULTS.keywords] };
  opts.url = normaliseUrl(positionals[0]);

  if (values.keywords !== undefined) {
    opts.keywords = values.keywords
      .split(',')
      .map((k) => k.trim().toLowerCase())
      .filter(Boolean);
  }
  if (values.all) opts.captureAll = true;
  if (values['filter-streams']) opts.filterStreams = true;
  if (values.time !== undefined) opts.observeMs = toPositiveInt(values.time, '--time') * 1000;
  if (values['nav-timeout'] !== undefined) {
    opts.navTimeoutMs = toPositiveInt(values['nav-timeout'], '--nav-timeout') * 1000;
  }
  if (values['ws-messages'] !== undefined) {
    opts.wsMessageLimit = toPositiveInt(values['ws-messages'], '--ws-messages');
  }
  if (values['sse-messages'] !== undefined) {
    opts.sseMessageLimit = toPositiveInt(values['sse-messages'], '--sse-messages');
  }
  if (values['max-body'] !== undefined) {
    opts.maxBodyBytes = toPositiveInt(values['max-body'], '--max-body');
  }
  if (values.out) opts.outFile = values.out;
  if (values['out-dir']) opts.outDir = values['out-dir'];
  if (values.headful) opts.headless = false;
  if (values['no-stealth']) opts.stealth = false;
  if (values.chrome) opts.executablePath = values.chrome;

  return opts;
}
