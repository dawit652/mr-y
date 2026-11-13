/**
 * reporter.js
 * ---------------------------------------------------------------------------
 * Turns raw collector output into:
 *   1. a structured JSON report written to disk, and
 *   2. a compact, human-readable console summary.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

// ---------------------------------------------------------------------------
// ANSI colour helpers (disabled when not a TTY or NO_COLOR is set)
// ---------------------------------------------------------------------------
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code) => (s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const c = {
  bold: paint('1'),
  dim: paint('2'),
  red: paint('31'),
  green: paint('32'),
  yellow: paint('33'),
  blue: paint('34'),
  magenta: paint('35'),
  cyan: paint('36'),
};

// ---------------------------------------------------------------------------
// Report assembly
// ---------------------------------------------------------------------------

/**
 * Build the final report object.
 * @param {object} meta  Run metadata from recon.js
 * @param {{http: object, ws: object, sse: object}} collectors
 */
export function buildReport(meta, { http, ws, sse }) {
  const httpEntries = http.results().map(stripInternal);
  const wsEntries = ws.results().map(stripInternal);
  const sseEntries = sse.results().map(stripInternal);

  return {
    meta,
    summary: {
      http: { ...http.stats, uniqueEndpoints: uniqueEndpoints(httpEntries).length },
      websockets: { ...ws.stats },
      sse: { ...sse.stats },
      endpoints: uniqueEndpoints(httpEntries),
    },
    http: httpEntries,
    websockets: wsEntries,
    sse: sseEntries,
  };
}

/** Drop CDP-internal fields that are noise in the saved report. */
function stripInternal({ requestId, state, ...rest }) {
  return rest;
}

/**
 * Collapse requests into unique "METHOD origin/path" endpoints (query string
 * removed) with hit counts and observed status codes. This is usually the
 * most useful view when mapping an app's API surface.
 */
function uniqueEndpoints(entries) {
  const map = new Map();
  for (const e of entries) {
    let key;
    try {
      const u = new URL(e.url);
      key = `${e.method} ${u.origin}${u.pathname}`;
    } catch {
      key = `${e.method} ${e.url}`;
    }
    const rec = map.get(key) ?? { endpoint: key, count: 0, statuses: [], mimeTypes: [] };
    rec.count++;
    if (e.status != null && !rec.statuses.includes(e.status)) rec.statuses.push(e.status);
    if (e.mimeType && !rec.mimeTypes.includes(e.mimeType)) rec.mimeTypes.push(e.mimeType);
    map.set(key, rec);
  }
  return [...map.values()].sort((a, b) => b.count - a.count);
}

// ---------------------------------------------------------------------------
// JSON output
// ---------------------------------------------------------------------------

/** Default file name: <outDir>/<host>_<timestamp>.json */
export function defaultReportPath(outDir, targetUrl) {
  const host = new URL(targetUrl).hostname.replace(/[^a-z0-9.-]/gi, '_');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join(outDir, `${host}_${stamp}.json`);
}

/** Write the report as pretty-printed JSON, creating directories as needed. */
export async function writeReport(report, filePath) {
  await mkdir(path.dirname(path.resolve(filePath)), { recursive: true });
  await writeFile(filePath, JSON.stringify(report, null, 2) + '\n', 'utf8');
  return path.resolve(filePath);
}

// ---------------------------------------------------------------------------
// Console summary
// ---------------------------------------------------------------------------

const MAX_ROWS = 40;
const URL_WIDTH = 90;

function shorten(s, n) {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function statusColor(status) {
  if (status == null) return c.dim('---');
  if (status >= 500) return c.red(status);
  if (status >= 400) return c.yellow(status);
  if (status >= 300) return c.cyan(status);
  return c.green(status);
}

function formatBytes(n) {
  if (n == null) return '';
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

/** Short one-line preview of a frame/message payload. */
function preview(payload, n = 100) {
  const s = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return shorten(s.replace(/\s+/g, ' '), n);
}

/**
 * Print a human-readable summary to stdout.
 * @param {ReturnType<typeof buildReport>} report
 * @param {string} [reportPath]
 */
export function printSummary(report, reportPath) {
  const { meta, summary, http, websockets, sse } = report;
  const out = [];
  const hr = c.dim('─'.repeat(72));

  out.push('', c.bold('NETWORK RECON SUMMARY'), hr);
  out.push(`${c.bold('Target:')}    ${meta.target}`);
  if (meta.finalUrl && meta.finalUrl !== meta.target) out.push(`${c.bold('Final URL:')} ${meta.finalUrl}`);
  if (meta.pageTitle) out.push(`${c.bold('Title:')}     ${meta.pageTitle}`);
  out.push(`${c.bold('Duration:')}  ${(meta.durationMs / 1000).toFixed(1)}s`);
  out.push(
    `${c.bold('Filter:')}    ${
      meta.filter.captureAll ? 'off (capturing all)' : meta.filter.keywords.join(', ')
    }${meta.filter.filterStreams ? ' (also applied to WS/SSE)' : ''}`,
  );
  if (meta.profile) {
    out.push(`${c.bold('Profile:')}   ${meta.profile.os}, ${meta.profile.viewport.width}x${meta.profile.viewport.height}`);
    out.push(c.dim(`           ${meta.profile.userAgent}`));
  }
  if (meta.navigationError) out.push(c.red(`Navigation warning: ${meta.navigationError}`));

  // -- XHR / Fetch -----------------------------------------------------------
  out.push('', c.bold(c.blue(`XHR/Fetch  ${summary.http.kept} logged`)) +
    c.dim(`  (${summary.http.seen} seen, ${summary.http.filteredOut} filtered out, ${summary.http.uniqueEndpoints} unique endpoints)`));
  for (const e of http.slice(0, MAX_ROWS)) {
    const size = e.bodyBytes != null ? formatBytes(e.bodyBytes) : e.isStream ? 'stream' : '';
    const flag = e.failure ? c.red(` ✗ ${e.failure}`) : '';
    out.push(
      `  ${c.bold(e.method.padEnd(6))} ${statusColor(e.status)} ${c.dim(e.resourceType.padEnd(5))} ` +
        `${shorten(e.url, URL_WIDTH)} ${c.dim(size)}${flag}`,
    );
  }
  if (http.length > MAX_ROWS) out.push(c.dim(`  … ${http.length - MAX_ROWS} more in JSON report`));

  if (summary.endpoints.length) {
    out.push('', c.bold('Top endpoints'));
    for (const ep of summary.endpoints.slice(0, 15)) {
      out.push(`  ${String(ep.count).padStart(4)}×  ${shorten(ep.endpoint, URL_WIDTH)} ${c.dim(ep.statuses.join(','))}`);
    }
  }

  // -- WebSockets -----------------------------------------------------------
  out.push('', c.bold(c.magenta(`WebSockets  ${summary.websockets.kept} connection(s)`)) +
    c.dim(`  (${summary.websockets.frames} frames total)`));
  for (const ws of websockets) {
    out.push(`  ${c.bold(`#${ws.id}`)} ${ws.url} ${c.dim(`[${ws.status}, ↑${ws.framesSeen.sent} ↓${ws.framesSeen.received}]`)}`);
    for (const f of ws.frames.slice(0, 5)) {
      const arrow = f.direction === 'sent' ? c.yellow('↑') : c.green('↓');
      out.push(`      ${arrow} ${c.dim(f.opcode.padEnd(6))} ${preview(f.payload)}`);
    }
  }

  // -- SSE -------------------------------------------------------------------
  out.push('', c.bold(c.cyan(`Server-Sent Events  ${summary.sse.kept} stream(s)`)) +
    c.dim(`  (${summary.sse.messages} messages total)`));
  for (const s of sse) {
    out.push(`  ${c.bold(`#${s.id}`)} ${s.url} ${c.dim(`[${s.transport}, ${s.status}, ${s.messagesSeen} msgs]`)}`);
    for (const m of s.messages.slice(0, 5)) {
      out.push(`      ${c.green('↓')} ${c.dim(m.event.padEnd(10))} ${preview(m.data)}`);
    }
    if (s.note) out.push(c.dim(`      note: ${s.note}`));
  }

  out.push('', hr);
  if (reportPath) out.push(`${c.bold('JSON report:')} ${reportPath}`);
  out.push('');
  console.log(out.join('\n'));
}
