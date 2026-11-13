/**
 * collectors/websocket.js
 * ---------------------------------------------------------------------------
 * Captures WebSocket connections opened by the page, using CDP events:
 *
 *   Network.webSocketCreated                    -> new connection (URL, initiator)
 *   Network.webSocketWillSendHandshakeRequest   -> upgrade request headers
 *   Network.webSocketHandshakeResponseReceived  -> 101 response + headers
 *   Network.webSocketFrameSent / FrameReceived  -> individual messages
 *   Network.webSocketFrameError                 -> protocol errors
 *   Network.webSocketClosed                     -> connection closed
 *
 * Only the first `messageLimit` frames per connection are stored (to keep
 * the report small) but every frame is counted.
 */

import { normaliseHeaders, nowIso, truncateUtf8 } from '../util.js';

// WebSocket opcodes (RFC 6455 section 5.2).
const OPCODES = { 0: 'continuation', 1: 'text', 2: 'binary', 8: 'close', 9: 'ping', 10: 'pong' };

/**
 * @param {import('puppeteer').CDPSession} client
 * @param {{ filter: ReturnType<import('../filter.js').createUrlFilter> | null,
 *           messageLimit: number, maxFrameBytes: number }} opts
 *   `filter` is null when streams should not be keyword-filtered.
 */
export function createWebSocketCollector(client, { filter, messageLimit, maxFrameBytes }) {
  const sockets = new Map(); // requestId -> entry
  const stats = { seen: 0, kept: 0, filteredOut: 0, frames: 0 };
  let nextId = 1;

  client.on('Network.webSocketCreated', (e) => {
    stats.seen++;
    const matched = filter ? filter.test(e.url) : [];
    if (matched === null) {
      stats.filteredOut++;
      return;
    }
    stats.kept++;
    sockets.set(e.requestId, {
      id: nextId++,
      requestId: e.requestId,
      url: e.url,
      matchedKeywords: matched,
      openedAt: nowIso(),
      initiator: e.initiator?.stack?.callFrames?.[0]?.url || e.initiator?.url || null,
      status: 'connecting', // connecting -> open -> closed | error
      handshake: { requestHeaders: null, status: null, responseHeaders: null },
      frames: [],
      framesSeen: { sent: 0, received: 0 },
      errors: [],
      closedAt: null,
    });
  });

  client.on('Network.webSocketWillSendHandshakeRequest', (e) => {
    const ws = sockets.get(e.requestId);
    if (ws) ws.handshake.requestHeaders = normaliseHeaders(e.request.headers);
  });

  client.on('Network.webSocketHandshakeResponseReceived', (e) => {
    const ws = sockets.get(e.requestId);
    if (!ws) return;
    ws.handshake.status = e.response.status;
    ws.handshake.responseHeaders = normaliseHeaders(e.response.headers);
    ws.status = e.response.status === 101 ? 'open' : 'error';
  });

  /** Shared handler for sent/received frames. */
  const onFrame = (direction) => (e) => {
    const ws = sockets.get(e.requestId);
    if (!ws) return;
    stats.frames++;
    ws.framesSeen[direction]++;
    if (ws.frames.length >= messageLimit) return;

    const { opcode, payloadData } = e.response;
    const isBinary = opcode === 2;
    const { value, truncated, bytes } = truncateUtf8(payloadData, maxFrameBytes);

    ws.frames.push({
      direction,
      time: nowIso(),
      opcode: OPCODES[opcode] ?? opcode,
      // Binary frames are delivered base64-encoded by CDP.
      encoding: isBinary ? 'base64' : 'utf8',
      payload: !isBinary && !truncated ? tryParseJson(value) : value,
      payloadBytes: isBinary ? Math.floor((payloadData.length * 3) / 4) : bytes,
      truncated,
    });
  };
  client.on('Network.webSocketFrameSent', onFrame('sent'));
  client.on('Network.webSocketFrameReceived', onFrame('received'));

  client.on('Network.webSocketFrameError', (e) => {
    const ws = sockets.get(e.requestId);
    if (!ws) return;
    ws.errors.push({ time: nowIso(), message: e.errorMessage });
  });

  client.on('Network.webSocketClosed', (e) => {
    const ws = sockets.get(e.requestId);
    if (!ws) return;
    ws.status = 'closed';
    ws.closedAt = nowIso();
  });

  return {
    stats,
    results: () => [...sockets.values()],
  };
}

/** Return parsed JSON for JSON-looking text payloads; otherwise the string. */
function tryParseJson(text) {
  const t = text.trimStart();
  if (!(t.startsWith('{') || t.startsWith('['))) return text;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
