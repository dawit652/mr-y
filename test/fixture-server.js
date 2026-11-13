// Local fixture site for integration tests: HTTP + WebSocket + SSE.
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { WebSocketServer } from 'ws';

const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>netrecon fixture</title></head>
<body><h1>fixture</h1>
<script>
window.addEventListener('load', () => {
  fetch('/api/odds?sport=football').then(r => r.text());
  fetch('/api/markets', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Test': '1' },
    body: JSON.stringify({ id: 42 }),
  }).then(r => r.text());
  const xhr = new XMLHttpRequest();
  xhr.open('GET', '/feed/events');
  xhr.send();
  fetch('/static/unrelated.json').then(r => r.text());
  const ws = new WebSocket('ws://' + location.host + '/live');
  ws.onopen = () => ws.send('{"type":"subscribe","channel":"odds"}');
  ws.onmessage = () => {};
  const es = new EventSource('/stream/updates');
  es.addEventListener('price', () => {});
  // fetch()-based SSE stream (no EventSource), read manually.
  fetch('/feed/stream').then(async (r) => {
    const reader = r.body.getReader();
    while (!(await reader.read()).done) {}
  }).catch(() => {});
  // Report what automation tells the page can see (stealth check).
  fetch('/api/probe?webdriver=' + navigator.webdriver + '&platform=' + encodeURIComponent(navigator.platform));
});
</script></body></html>`;

export async function startFixtureServer(port = 0) {
  const sseResponses = new Set();
  const timers = new Set();

  const server = http.createServer((req, res) => {
    const { pathname } = new URL(req.url, 'http://localhost');
    const json = (obj) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(obj));
    };

    if (pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(PAGE);
    } else if (pathname === '/api/odds') {
      json({ sport: 'football', odds: [{ match: 'A v B', home: 1.8, away: 2.1 }] });
    } else if (pathname === '/api/markets') {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        let echo = raw;
        try { echo = JSON.parse(raw); } catch { /* keep raw */ }
        json({ ok: true, received: echo });
      });
    } else if (pathname === '/feed/events') {
      json({ events: [{ id: 1, name: 'Kickoff' }, { id: 2, name: 'Goal' }] });
    } else if (pathname === '/static/unrelated.json') {
      json({ hello: 'world' });
    } else if (pathname === '/api/probe') {
      json({ ok: true });
    } else if (pathname === '/stream/updates' || pathname === '/feed/stream') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      sseResponses.add(res);
      let n = 0;
      const t = setInterval(() => {
        n += 1;
        res.write(`event: price\nid: ${n}\ndata: ${JSON.stringify({ n, price: +(1 + n / 10).toFixed(2) })}\n\n`);
      }, 500);
      timers.add(t);
      req.on('close', () => {
        clearInterval(t);
        timers.delete(t);
        sseResponses.delete(res);
      });
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
    }
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const { pathname } = new URL(req.url, 'http://localhost');
    if (pathname !== '/live') {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });
  wss.on('connection', (ws) => {
    ws.send(JSON.stringify({ type: 'welcome' }));
    ws.on('message', () => ws.send(JSON.stringify({ type: 'ack' })));
    ws.on('error', () => {});
    let i = 0;
    const t = setInterval(() => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'tick', n: ++i }));
    }, 300);
    timers.add(t);
    ws.on('close', () => {
      clearInterval(t);
      timers.delete(t);
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  const { port: actual } = server.address();

  return {
    url: `http://127.0.0.1:${actual}/`,
    async close() {
      for (const t of timers) clearInterval(t);
      timers.clear();
      for (const res of sseResponses) res.end();
      sseResponses.clear();
      for (const client of wss.clients) client.terminate();
      await new Promise((r) => wss.close(r));
      server.closeAllConnections?.();
      await new Promise((r) => server.close(r));
    },
  };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { url } = await startFixtureServer(8080);
  console.log(`Fixture server listening at ${url}`);
}
