/**
 * collectors/sse.js
 * ---------------------------------------------------------------------------
 * Detects Server-Sent Events streams and records their first messages.
 *
 * Two flavours of SSE are handled:
 *
 *  1. The browser `EventSource` API. Chrome reports these with resource type
 *     "EventSource" and emits a `Network.eventSourceMessageReceived` event for
 *     every parsed message, so no parsing is needed.
 *
 *  2. Manual streaming with fetch()/XHR + `text/event-stream` (common in SPAs
 *     that need custom headers). Chrome emits no message events for these,
 *     so the collector asks CDP to stream the raw body
 *     (`Network.streamResourceContent`, experimental, Chrome 126+) and parses
 *     the SSE wire format itself from `Network.dataReceived` chunks. If that
 *     CDP method is unavailable the stream is still detected and logged,
 *     just without messages.
 */

import { normaliseHeaders, nowIso, truncateUtf8 } from '../util.js';

/**
 * @param {import('puppeteer').CDPSession} client
 * @param {{ filter: ReturnType<import('../filter.js').createUrlFilter> | null,
 *           messageLimit: number, maxFrameBytes: number }} opts
 */
export function createSseCollector(client, { filter, messageLimit, maxFrameBytes }) {
  const streams = new Map(); // requestId -> entry
  const parsers = new Map(); // requestId -> SseParser (fetch/XHR streams only)
  const stats = { seen: 0, kept: 0, filteredOut: 0, messages: 0 };
  const ignored = new Set(); // requestIds dropped by the filter
  let nextId = 1;

  /** Store a message on an entry, respecting limits. */
  const record = (entry, msg) => {
    stats.messages++;
    entry.messagesSeen++;
    if (entry.messages.length >= messageLimit) return;
    const { value, truncated } = truncateUtf8(msg.data ?? '', maxFrameBytes);
    entry.messages.push({
      time: nowIso(),
      event: msg.event || 'message',
      id: msg.id || null,
      data: truncated ? value : tryParseJson(value),
      truncated,
    });
  };

  // -- Detection: any response with an event-stream MIME or EventSource type
  client.on('Network.responseReceived', (e) => {
    const mime = (e.response.mimeType || '').toLowerCase();
    if (e.type !== 'EventSource' && mime !== 'text/event-stream') return;

    stats.seen++;
    const matched = filter ? filter.test(e.response.url) : [];
    if (matched === null) {
      stats.filteredOut++;
      ignored.add(e.requestId);
      return;
    }
    stats.kept++;

    const entry = {
      id: nextId++,
      requestId: e.requestId,
      url: e.response.url,
      matchedKeywords: matched,
      transport: e.type === 'EventSource' ? 'EventSource' : e.type.toLowerCase(), // fetch/xhr
      openedAt: nowIso(),
      status: e.response.status,
      responseHeaders: normaliseHeaders(e.response.headers),
      messages: [],
      messagesSeen: 0,
      closedAt: null,
      note: null,
    };
    streams.set(e.requestId, entry);

    // Flavour 2: ask Chrome to forward raw chunks so we can parse them.
    if (entry.transport !== 'EventSource') {
      const parser = new SseParser((msg) => record(entry, msg));
      parsers.set(e.requestId, parser);
      client
        .send('Network.streamResourceContent', { requestId: e.requestId })
        .then(({ bufferedData }) => {
          if (bufferedData) parser.push(Buffer.from(bufferedData, 'base64').toString('utf8'));
        })
        .catch((err) => {
          parsers.delete(e.requestId);
          entry.note = `message capture unavailable for ${entry.transport} stream: ${err.message}`;
        });
    }
  });

  // -- Flavour 1: Chrome-parsed EventSource messages ------------------------
  client.on('Network.eventSourceMessageReceived', (e) => {
    if (ignored.has(e.requestId)) return;
    const entry = streams.get(e.requestId);
    if (!entry) return;
    record(entry, { event: e.eventName, id: e.eventId, data: e.data });
  });

  // -- Flavour 2: raw chunks for fetch/XHR streams --------------------------
  client.on('Network.dataReceived', (e) => {
    const parser = parsers.get(e.requestId);
    if (parser && e.data) parser.push(Buffer.from(e.data, 'base64').toString('utf8'));
  });

  // -- Stream ended ----------------------------------------------------------
  const onEnd = (e) => {
    const entry = streams.get(e.requestId);
    if (!entry) return;
    entry.closedAt = nowIso();
    if (e.errorText && !e.canceled) entry.note = `stream error: ${e.errorText}`;
    parsers.delete(e.requestId);
  };
  client.on('Network.loadingFinished', onEnd);
  client.on('Network.loadingFailed', onEnd);

  return {
    stats,
    results: () => [...streams.values()],
  };
}

/**
 * Minimal incremental parser for the SSE wire format
 * (https://html.spec.whatwg.org/multipage/server-sent-events.html).
 * Feed it text chunks; it calls `onMessage({event, id, data})` per event.
 */
export class SseParser {
  constructor(onMessage) {
    this.onMessage = onMessage;
    this.buffer = '';
    this.reset();
  }

  reset() {
    this.event = '';
    this.data = [];
    this.id = null;
  }

  push(chunk) {
    this.buffer += chunk;
    // Process complete lines only; keep the trailing partial line buffered.
    const lines = this.buffer.split(/\r\n|\r|\n/);
    this.buffer = lines.pop();
    for (const line of lines) this.#line(line);
  }

  #line(line) {
    if (line === '') {
      // Blank line = dispatch the accumulated event.
      if (this.data.length) {
        this.onMessage({ event: this.event, id: this.id, data: this.data.join('\n') });
      }
      this.reset();
      return;
    }
    if (line.startsWith(':')) return; // comment / keep-alive
    const idx = line.indexOf(':');
    const field = idx === -1 ? line : line.slice(0, idx);
    let value = idx === -1 ? '' : line.slice(idx + 1);
    if (value.startsWith(' ')) value = value.slice(1);

    if (field === 'data') this.data.push(value);
    else if (field === 'event') this.event = value;
    else if (field === 'id') this.id = value;
    // 'retry' and unknown fields are ignored.
  }
}

function tryParseJson(text) {
  const t = text.trimStart();
  if (!(t.startsWith('{') || t.startsWith('['))) return text;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
