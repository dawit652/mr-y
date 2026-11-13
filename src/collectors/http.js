/**
 * collectors/http.js
 * ---------------------------------------------------------------------------
 * Captures XHR and Fetch requests via raw Chrome DevTools Protocol (CDP)
 * Network events, including:
 *   - full URL, method, request headers (as sent on the wire, incl. cookies),
 *     POST body
 *   - status, response headers (raw, incl. Set-Cookie), MIME type, timing
 *   - response body (decoded, parsed as JSON when possible, truncated when
 *     over the size limit)
 *
 * Why raw CDP instead of page.on('request')? The CDP `requestId` is shared
 * with the *ExtraInfo events (real wire headers) and with the WebSocket/SSE
 * collectors, so everything can be correlated on a single key.
 *
 * CDP event order is not guaranteed (ExtraInfo events can arrive before or
 * after their main event), so ExtraInfo payloads are buffered until the
 * matching entry exists.
 */

import { isJsonMime, isTextMime, normaliseHeaders, nowIso, truncateUtf8 } from '../util.js';

// CDP resource types we treat as "XHR/Fetch".
const TRACKED_TYPES = new Set(['XHR', 'Fetch']);

/**
 * @param {import('puppeteer').CDPSession} client  CDP session with Network enabled
 * @param {{ filter: ReturnType<import('../filter.js').createUrlFilter>, maxBodyBytes: number }} opts
 */
export function createHttpCollector(client, { filter, maxBodyBytes }) {
  /** requestId -> entry (only for requests that passed the filter) */
  const entries = new Map();
  /** requestId -> headers, for ExtraInfo events that arrived early */
  const earlyReqExtra = new Map();
  const earlyResExtra = new Map();
  /** In-flight Network.getResponseBody / getRequestPostData calls. */
  const pending = new Set();

  const stats = { seen: 0, kept: 0, filteredOut: 0 };
  let nextId = 1;

  /** Track a promise so drain() can wait for it. */
  const track = (p) => {
    pending.add(p);
    p.finally(() => pending.delete(p));
  };

  // -- Request is about to be sent ------------------------------------------
  client.on('Network.requestWillBeSent', (e) => {
    // A redirect re-uses the same requestId: record the hop and update URL.
    const existing = entries.get(e.requestId);
    if (existing && e.redirectResponse) {
      existing.redirects.push({
        url: existing.url,
        status: e.redirectResponse.status,
        location: e.request.url,
      });
      existing.url = e.request.url;
      existing.method = e.request.method;
      return;
    }

    if (!TRACKED_TYPES.has(e.type)) return;
    stats.seen++;

    const matched = filter.test(e.request.url);
    if (matched === null) {
      stats.filteredOut++;
      return;
    }
    stats.kept++;

    const entry = {
      id: nextId++,
      requestId: e.requestId,
      url: e.request.url,
      method: e.request.method,
      resourceType: e.type.toLowerCase(), // 'xhr' | 'fetch'
      matchedKeywords: matched,
      startedAt: e.wallTime ? new Date(e.wallTime * 1000).toISOString() : nowIso(),
      initiator: summariseInitiator(e.initiator),
      requestHeaders: normaliseHeaders(e.request.headers),
      postData: e.request.postData ?? null,
      redirects: [],
      status: null,
      statusText: null,
      responseHeaders: null,
      mimeType: null,
      protocol: null,
      remoteAddress: null,
      fromCache: false,
      isStream: false,
      body: null,
      bodyEncoding: null, // 'json' | 'utf8' | 'base64'
      bodyBytes: null,
      bodyTruncated: false,
      bodyNote: null,
      failure: null,
      timing: null,
      encodedDataLength: null,
      state: 'pending', // pending -> responded -> finished | failed
    };
    entries.set(e.requestId, entry);

    // Merge wire headers that arrived before this event.
    if (earlyReqExtra.has(e.requestId)) {
      Object.assign(entry.requestHeaders, earlyReqExtra.get(e.requestId));
      earlyReqExtra.delete(e.requestId);
    }

    // Large POST bodies are not inlined in the event; fetch them separately.
    if (e.request.hasPostData && entry.postData == null) {
      track(
        client
          .send('Network.getRequestPostData', { requestId: e.requestId })
          .then((r) => (entry.postData = r.postData))
          .catch(() => (entry.postData = '[unavailable]')),
      );
    }
  });

  // -- Real on-the-wire request headers (cookies, etc.) ---------------------
  client.on('Network.requestWillBeSentExtraInfo', (e) => {
    const headers = normaliseHeaders(e.headers);
    const entry = entries.get(e.requestId);
    if (entry) Object.assign(entry.requestHeaders, headers);
    else earlyReqExtra.set(e.requestId, headers);
  });

  // -- Response headers received --------------------------------------------
  client.on('Network.responseReceived', (e) => {
    const entry = entries.get(e.requestId);
    if (!entry) return;
    const r = e.response;
    entry.state = 'responded';
    entry.url = r.url;
    entry.status = r.status;
    entry.statusText = r.statusText || null;
    entry.responseHeaders = {
      ...normaliseHeaders(r.headers),
      ...(earlyResExtra.get(e.requestId) ?? {}),
    };
    earlyResExtra.delete(e.requestId);
    entry.mimeType = r.mimeType;
    entry.protocol = r.protocol ?? null;
    entry.remoteAddress = r.remoteIPAddress ? `${r.remoteIPAddress}:${r.remotePort}` : null;
    entry.fromCache = Boolean(r.fromDiskCache || r.fromServiceWorker || r.fromPrefetchCache);
    entry.timing = summariseTiming(r.timing);
    // A fetch() of an SSE endpoint never "finishes"; flag it and let the
    // SSE collector capture the messages.
    if ((r.mimeType || '').toLowerCase() === 'text/event-stream') {
      entry.isStream = true;
      entry.bodyNote = 'text/event-stream: see "sse" section for messages';
    }
  });

  // -- Raw response headers (incl. Set-Cookie) ------------------------------
  client.on('Network.responseReceivedExtraInfo', (e) => {
    const headers = normaliseHeaders(e.headers);
    const entry = entries.get(e.requestId);
    if (entry && entry.responseHeaders) Object.assign(entry.responseHeaders, headers);
    else earlyResExtra.set(e.requestId, headers);
  });

  // -- Body fully downloaded: fetch it --------------------------------------
  client.on('Network.loadingFinished', (e) => {
    const entry = entries.get(e.requestId);
    if (!entry) return;
    entry.state = 'finished';
    entry.encodedDataLength = e.encodedDataLength;
    if (entry.isStream) return;
    track(fetchBody(client, entry, maxBodyBytes));
  });

  // -- Request failed / was cancelled ---------------------------------------
  client.on('Network.loadingFailed', (e) => {
    const entry = entries.get(e.requestId);
    if (!entry) return;
    entry.state = 'failed';
    entry.failure = e.canceled ? 'canceled' : e.errorText;
    if (e.blockedReason) entry.failure += ` (blocked: ${e.blockedReason})`;
    if (e.corsErrorStatus) entry.failure += ` (cors: ${e.corsErrorStatus.corsError})`;
  });

  return {
    stats,
    /** Wait for all outstanding body/postData fetches to settle. */
    async drain() {
      while (pending.size) await Promise.allSettled([...pending]);
    },
    /** Snapshot of all captured entries, in request order. */
    results() {
      return [...entries.values()].map((entry) => {
        if (entry.state === 'pending' || (entry.state === 'responded' && !entry.isStream)) {
          entry.bodyNote ??= 'request still in flight when capture ended';
        }
        return entry;
      });
    },
  };
}

/**
 * Retrieve and decode a response body, honouring the size limit.
 * JSON bodies under the limit are stored parsed for easy analysis.
 */
async function fetchBody(client, entry, maxBodyBytes) {
  // Redirects, 204s and HEAD requests have no body to fetch.
  if (entry.method === 'HEAD' || entry.status === 204 || entry.status === 304) return;
  try {
    const { body, base64Encoded } = await client.send('Network.getResponseBody', {
      requestId: entry.requestId,
    });

    if (base64Encoded && !isTextMime(entry.mimeType)) {
      // Binary payload: keep base64 (truncated on a 4-char boundary).
      const bytes = Math.floor((body.length * 3) / 4);
      const maxChars = Math.floor((maxBodyBytes * 4) / 3 / 4) * 4;
      entry.bodyEncoding = 'base64';
      entry.bodyBytes = bytes;
      entry.bodyTruncated = body.length > maxChars;
      entry.body = entry.bodyTruncated ? body.slice(0, maxChars) : body;
      return;
    }

    const text = base64Encoded ? Buffer.from(body, 'base64').toString('utf8') : body;
    const { value, truncated, bytes } = truncateUtf8(text, maxBodyBytes);
    entry.bodyBytes = bytes;
    entry.bodyTruncated = truncated;

    if (!truncated && (isJsonMime(entry.mimeType) || looksLikeJson(text))) {
      try {
        entry.body = JSON.parse(text);
        entry.bodyEncoding = 'json';
        return;
      } catch {
        /* fall through and store as text */
      }
    }
    entry.body = value;
    entry.bodyEncoding = 'utf8';
  } catch (err) {
    // Common causes: body evicted from Chrome's buffer, redirect, page closed.
    entry.bodyNote = `body unavailable: ${err.message}`;
  }
}

function looksLikeJson(text) {
  const t = text.trimStart();
  return t.startsWith('{') || t.startsWith('[');
}

/** Keep only the interesting part of the CDP initiator object. */
function summariseInitiator(init) {
  if (!init) return null;
  const frame = init.stack?.callFrames?.[0];
  return {
    type: init.type,
    url: frame?.url || init.url || null,
    line: frame ? frame.lineNumber + 1 : (init.lineNumber ?? null),
    function: frame?.functionName || null,
  };
}

/** Convert CDP ResourceTiming into a few human-meaningful millisecond values. */
function summariseTiming(t) {
  if (!t) return null;
  const span = (a, b) => (a >= 0 && b >= 0 ? Math.round((b - a) * 100) / 100 : null);
  return {
    dnsMs: span(t.dnsStart, t.dnsEnd),
    connectMs: span(t.connectStart, t.connectEnd),
    tlsMs: span(t.sslStart, t.sslEnd),
    ttfbMs: span(t.sendStart, t.receiveHeadersEnd),
  };
}
