/**
 * narobet.js
 * ---------------------------------------------------------------------------
 * Narobet-specific steps, run inside one incognito context loaded with one
 * session's cookies: open a page on narobet.bet, then call the game init API
 * from inside it with fetch(), so the request carries that session's cookies
 * exactly like the real site does.
 */

import { ApiError, pickPlayUrl, withTimeout } from './common.js';

// Everything else (images, scripts, css, fonts, media) is skipped: the API call
// only needs a document on the Narobet origin.
const KEEP_TYPES = new Set(['document', 'fetch', 'xhr']);

/** Opens `sessionPath` in `context` with the session's cookies. */
export async function openSessionPage(context, session, opts) {
  await context.setCookie(...session.cookies);
  const page = await context.newPage();
  page.setDefaultTimeout(opts.navTimeoutMs);
  if (session.userAgent) await page.setUserAgent({ userAgent: session.userAgent });
  if (opts.blockResources) {
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      if (req.isInterceptResolutionHandled()) return;
      (KEEP_TYPES.has(req.resourceType()) ? req.continue() : req.abort()).catch(() => {});
    });
  }
  const url = new URL(opts.sessionPath, opts.baseUrl).href;
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: opts.navTimeoutMs });
  } catch (err) {
    throw new ApiError(502, `Could not load ${url}`, err.message, { retryable: true });
  }
  return page;
}

/** Runs fetch() inside the page. Returns { status, text, error? }. */
async function fetchInPage(page, path, init, timeoutMs) {
  const call = page.evaluate(async (path, init, timeoutMs) => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const r = await fetch(path, { ...init, credentials: 'include', signal: ctrl.signal });
      return { status: r.status, text: await r.text() };
    } catch (e) {
      return { status: 0, text: '', error: e.name === 'AbortError' ? 'timeout' : String(e.message || e) };
    } finally {
      clearTimeout(t);
    }
  }, path, init, timeoutMs);
  // Outer guard in case evaluate itself hangs (frozen page).
  return withTimeout(call, timeoutMs + 5_000, 'Upstream request');
}

/** One init call; returns the launch URL or throws an ApiError. */
export async function requestPlayUrl(page, gameUuid, opts) {
  const res = await fetchInPage(page, opts.initPath, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ gameUuid }),
  }, opts.upstreamTimeoutMs);

  if (res.status === 0) {
    const timedOut = res.error === 'timeout';
    throw new ApiError(timedOut ? 504 : 502, timedOut ? 'Narobet did not answer in time' : 'Upstream request failed',
      res.error, { retryable: true });
  }
  let data = null;
  try { data = JSON.parse(res.text); } catch { /* non-JSON body */ }

  if (res.status === 401 || res.status === 403) {
    throw new ApiError(401, `Narobet rejected the session (HTTP ${res.status})`, data ?? res.text.slice(0, 300),
      { retryable: false, authFailure: true });
  }
  if (res.status === 429 || res.status >= 500) {
    throw new ApiError(502, `Narobet returned HTTP ${res.status}`, data ?? res.text.slice(0, 300), { retryable: true });
  }
  if (res.status >= 400) {
    throw new ApiError(res.status === 404 ? 404 : 502, `Narobet rejected the request (HTTP ${res.status})`,
      data ?? res.text.slice(0, 300), { retryable: false });
  }
  const playUrl = pickPlayUrl(data);
  if (!playUrl) {
    throw new ApiError(502, 'No launch URL in Narobet response', data ?? res.text.slice(0, 300), { retryable: false });
  }
  return playUrl;
}

/** Best-effort login check via next-auth's session endpoint: true / false / null (unknown). */
export async function checkLogin(page, opts) {
  try {
    const res = await fetchInPage(page, '/api/auth/session', { method: 'GET' }, opts.upstreamTimeoutMs);
    if (res.status !== 200) return null;
    const data = JSON.parse(res.text);
    return Boolean(data && data.user);
  } catch {
    return null;
  }
}
