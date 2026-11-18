# netrecon

A Puppeteer-based CLI that loads a web page and records the network traffic it generates, then writes a structured JSON report.

## Features

1. **XHR/Fetch logging** - URLs, methods, request/response headers and response bodies.
2. **WebSocket capture** - connection URL plus the first N frames (sent and received).
3. **SSE detection** - detects Server-Sent Events streams and keeps the first N messages.
4. **Structured JSON output** - one report per run, easy to post-process.
5. **Basic stealth** - randomized user agent and viewport, realistic delays. This defeats trivial checks only; it will not get past real bot-detection systems.
6. **Keyword filter** - by default only URLs containing `api`, `odds`, `events`, `markets`, `sports` or `feed` are logged.

## Install

```sh
npm install
```

To use an existing Chrome/Chromium instead of the one Puppeteer downloads, set `PUPPETEER_EXECUTABLE_PATH` or pass `--chrome <path>`.

## Usage

```sh
npx netrecon https://example.com
node bin/netrecon.js https://example.com --time 20 --out report.json
node bin/netrecon.js https://example.com --all --ws-messages 25
node bin/netrecon.js https://example.com -k odds,live --filter-streams --headful
```

| Flag | Description |
| --- | --- |
| `-k, --keywords <list>` | Comma-separated URL keywords to filter on (default: `api,odds,events,markets,sports,feed`) |
| `-a, --all` | Disable keyword filter; log every XHR/Fetch |
| `--filter-streams` | Apply the keyword filter to WebSocket/SSE URLs too |
| `-t, --time <seconds>` | Seconds to keep observing after load (default: 15) |
| `--nav-timeout <sec>` | Navigation timeout in seconds (default: 45) |
| `-w, --ws-messages <n>` | WebSocket frames to keep per connection (default: 10) |
| `--sse-messages <n>` | SSE messages to keep per stream (default: 10) |
| `--max-body <bytes>` | Truncate response bodies above this size (default: 262144) |
| `-o, --out <file>` | Write the JSON report to this exact path |
| `--out-dir <dir>` | Directory for auto-named reports (default: `output`) |
| `--headful` | Show the browser window |
| `--no-stealth` | Disable UA/viewport randomisation and human-like delays |
| `--chrome <path>` | Use a specific Chrome/Chromium binary |
| `-h, --help` | Show help |

## Output format

The report is a JSON object with these top-level keys:

- `meta`: `target`, `finalUrl`, `pageTitle`, `startedAt`, `finishedAt`, `durationMs`, `browserVersion`, `stealth`, `profile` (UA, platform, viewport, languages), `filter`, `limits`, `navigationError`, `aborted`
- `summary`: per-channel counts (`seen`, `kept`, `filteredOut`, frames/messages) and `endpoints`, a list of unique `METHOD origin/path` entries with hit counts and status codes, which is handy for mapping an API surface
- `http`: array of `{ id, url, method, resourceType, matchedKeywords, startedAt, initiator, requestHeaders, postData, redirects, status, responseHeaders, mimeType, protocol, remoteAddress, fromCache, isStream, body, bodyEncoding, bodyBytes, bodyTruncated, bodyNote, failure, timing }`
  - Headers are the real on-the-wire values (including `cookie` / `set-cookie`), lower-cased.
  - `bodyEncoding` is `json` (body stored parsed), `utf8` or `base64` (binary).
- `websockets`: array of `{ id, url, status, handshake: { requestHeaders, status, responseHeaders }, frames: [{ direction: 'sent' | 'received', time, opcode, encoding, payload, payloadBytes, truncated }], framesSeen: { sent, received }, errors, closedAt }`
- `sse`: array of `{ id, url, transport, status, responseHeaders, messages: [{ time, event, id, data, truncated }], messagesSeen, closedAt, note }`
  - `transport` is `EventSource`, or `fetch`/`xhr` for streams read manually with `text/event-stream`. Messages from those streams are parsed from the raw body. This uses an experimental CDP method (Chrome 126+); if it is unavailable, the stream is still logged and `note` explains why.

JSON payloads (response bodies, WebSocket frames, SSE `data`) are stored as parsed objects when they parse cleanly.

## Notes and limitations

- The keyword filter applies to XHR/Fetch. WebSocket and SSE streams are always captured unless you pass `--filter-streams`, because their hostnames rarely contain the keywords.
- Traffic from cross-origin iframes running in a separate process, and from service or shared workers, is not captured.
- Press Ctrl+C during observation to stop early. The report is still written.

## Project layout

```
bin/netrecon.js          CLI entry point
src/cli.js               argument parsing and usage text
src/config.js            default settings
src/filter.js            keyword filter
src/stealth.js           UA/viewport randomisation and delays
src/collectors/http.js   XHR/Fetch collector
src/collectors/websocket.js  WebSocket collector
src/collectors/sse.js    SSE collector
src/reporter.js          JSON report + console summary
src/util.js              shared helpers (truncation, MIME checks)
src/recon.js             orchestration (browser session)
test/                    integration test and local fixture server
```

## Testing

`npm test` runs the integration test against the local fixture server (`test/fixture-server.js`, which you can also start by hand with `node test/fixture-server.js`).

## mr-y casino API

`GET /play/:uuid` turns a Narobet game UUID into a launch URL (`{ success, playUrl }`). It runs as two processes:

```
client ─▶ server.js ──(Redis cache hit, 4 min)──▶ response
              │ miss
              ▼
        BullMQ queue (Redis) ──▶ queue-worker.js ──▶ shared Chrome, one incognito
                                  (max 5 jobs at once,    context per job, cookies from
                                   across all workers)    a rotating sessions.json account
```

- `server.js` never starts Chrome. It answers from the Redis cache, otherwise it enqueues a job and waits for it. Requests for the same game at the same time share one job. When the queue is too deep it answers 503 with `Retry-After`. A request that waits longer than `REQUEST_TIMEOUT_MS` gets 504, but its job keeps running and caches the result.
- `queue-worker.js` processes up to 5 jobs at once. The cap is stored in Redis, so it covers all worker processes together. Each job uses a fresh incognito context in one shared Chrome and the next account from `sessions.json`. A session Narobet rejects is benched and the job moves on to another account. Transient errors are retried with backoff.
- `GET /health` reports Redis, the queue and the worker count. `GET /health?deep` also checks every session's login.

Setup:

1. Run Redis 6.2+ (for example `docker run -d -p 6379:6379 redis:7-alpine`).
2. Create `sessions.json` from a logged-in Chrome profile with `npm run export-session`. It reads `./chrome-profile` and saves it as `acct-1`. For more accounts, run `node export-session.js --profile <dir> --id acct-2`. Close any Chrome using that profile first. If the profile is logged out, the script says so; log in with `node play-game.js` and rerun. You can also write the file by hand from `sessions.example.json`. `sessions.json` is git-ignored, and edits are picked up without a restart.
3. Start both processes with `npm run worker` and `npm run api`, or with `pm2 start ecosystem.config.cjs`.

Launch links: by default a link is reused for 4 minutes, and simultaneous requests for the same game share one Narobet call. If Narobet links are single-use, set `CACHE_TTL_SEC=0`. Then every request gets its own fresh link (the response header is `X-Cache: OFF`), nothing is cached, and the API's setting applies even if the worker's differs.

Settings come from env vars, listed in `src/casino/config.js`. The main ones are `REDIS_URL`, `PORT`, `WORKER_CONCURRENCY`, `GLOBAL_CONCURRENCY`, `RATE_LIMIT_MAX`, `CACHE_TTL_SEC`, `SESSION_STRATEGY` (`round-robin` or `random`) and `REQUEST_TIMEOUT_MS`.

Tests: `test/casino-queue.test.js` runs everything end to end against a fake Narobet. It needs Redis (`TEST_REDIS_URL`, default `redis://127.0.0.1:6379/15`), only touches keys under its own prefix, and is skipped when Redis is down.

## Responsible use

Only analyze sites you own or are authorized to test, and respect their terms of service and robots policies.
