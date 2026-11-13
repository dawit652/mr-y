/**
 * util.js
 * ---------------------------------------------------------------------------
 * Small shared helpers used by the collectors and reporter.
 */

/**
 * Truncate a string to at most `maxBytes` UTF-8 bytes.
 * @returns {{ value: string, truncated: boolean, bytes: number }}
 */
export function truncateUtf8(str, maxBytes) {
  const buf = Buffer.from(str ?? '', 'utf8');
  if (buf.length <= maxBytes) return { value: str ?? '', truncated: false, bytes: buf.length };
  // Slicing may split a multi-byte char; toString replaces it with U+FFFD.
  return { value: buf.subarray(0, maxBytes).toString('utf8'), truncated: true, bytes: buf.length };
}

/** MIME types whose bodies are safe to store as text. */
export function isTextMime(mime = '') {
  const m = mime.toLowerCase();
  return (
    m.startsWith('text/') ||
    m.includes('json') ||
    m.includes('javascript') ||
    m.includes('xml') ||
    m.includes('x-www-form-urlencoded') ||
    m.includes('graphql')
  );
}

/** True for JSON-ish MIME types (application/json, application/vnd.api+json, ...). */
export function isJsonMime(mime = '') {
  return /\bjson\b/i.test(mime);
}

/** Lower-case all header names so lookups are predictable. */
export function normaliseHeaders(headers = {}) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) out[k.toLowerCase()] = v;
  return out;
}

/** ISO timestamp for "now". */
export const nowIso = () => new Date().toISOString();

/** Sleep for `ms` milliseconds. */
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
