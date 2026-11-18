// mr-y Casino API: GET /play/:uuid -> { success, playUrl }
// All settings can be overridden with env vars (see src/casino-api.js for defaults).
import { API_DEFAULTS, startServer } from './src/casino-api.js';

const env = process.env;
const num = (v, d) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? d : Number(v));

const opts = {
  host: env.HOST || API_DEFAULTS.host,
  port: num(env.PORT, API_DEFAULTS.port),
  baseUrl: env.NAROBET_URL || API_DEFAULTS.baseUrl,
  executablePath: env.CHROME_PATH || API_DEFAULTS.executablePath,
  userDataDir: env.CHROME_PROFILE || API_DEFAULTS.userDataDir,
  headless: env.HEADLESS !== 'false',
  retries: num(env.RETRIES, API_DEFAULTS.retries),
  requestTimeoutMs: num(env.REQUEST_TIMEOUT_MS, API_DEFAULTS.requestTimeoutMs),
};

const log = (msg) => console.log(`[${new Date().toISOString()}] ${msg}`);

const { url, close } = await startServer(opts, { log });
log(`mr-y Casino API running on ${url}  (GET /play/:uuid, GET /health?deep)`);

let stopping = false;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  log(`${signal} received, closing browser…`);
  const force = setTimeout(() => process.exit(1), 10_000);
  await close().catch((err) => log(`Shutdown error: ${err.message}`));
  clearTimeout(force);
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
// pm2 on Windows sends a 'shutdown' message instead of a signal.
process.on('message', (msg) => { if (msg === 'shutdown') shutdown('shutdown'); });

// Never let a stray rejection kill the API; log it and keep serving.
process.on('unhandledRejection', (err) => log(`Unhandled rejection: ${err?.stack || err}`));
// After an uncaught exception state is unknown: close Chrome cleanly (releases the
// profile lock) and exit so pm2 restarts us.
process.on('uncaughtException', (err) => { log(`Uncaught exception: ${err?.stack || err}`); shutdown('uncaughtException'); });
