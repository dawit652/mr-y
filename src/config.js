/**
 * config.js
 * ---------------------------------------------------------------------------
 * Central place for default settings. Every value here can be overridden
 * from the command line (see src/cli.js).
 */

export const DEFAULTS = Object.freeze({
  // URL keywords that mark a request as "interesting". Matching is
  // case-insensitive and done against the full request URL.
  keywords: ['api', 'odds', 'events', 'markets', 'sports', 'feed'],

  // When true, the keyword filter is bypassed and every XHR/Fetch is logged.
  captureAll: false,

  // When true, the keyword filter is also applied to WebSocket and SSE URLs.
  // Off by default: streaming endpoints are rare and almost always relevant,
  // and their hostnames often don't contain any of the keywords.
  filterStreams: false,

  // How long (ms) to keep observing after the initial page load settles.
  // Many apps open sockets / start polling only after hydration.
  observeMs: 15_000,

  // Navigation timeout (ms).
  navTimeoutMs: 45_000,

  // How many WebSocket frames (sent + received) to keep per connection.
  wsMessageLimit: 10,

  // How many SSE messages to keep per stream.
  sseMessageLimit: 10,

  // Response bodies larger than this (bytes) are truncated in the JSON log.
  maxBodyBytes: 256 * 1024,

  // Individual WS/SSE payloads larger than this (bytes) are truncated.
  maxFrameBytes: 16 * 1024,

  // Output directory for JSON reports.
  outDir: 'output',

  // Explicit output file path (overrides outDir naming when set).
  outFile: null,

  // Browser options.
  headless: true,
  stealth: true,
  executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || null,
});
