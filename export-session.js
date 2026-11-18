/**
 * export-session.js – adds a logged-in Chrome profile's Narobet session to sessions.json
 * ---------------------------------------------------------------------------
 *   node export-session.js                          chrome-profile -> sessions.json as "acct-1"
 *   node export-session.js --id acct-2 --profile "C:\path\to\other-profile"
 *
 * Options:
 *   --profile <dir>   Chrome profile to read (default: $CHROME_PROFILE or ./chrome-profile)
 *   --id <name>       entry id in sessions.json (default: acct-1); an entry with this id is replaced
 *   --out <file>      sessions file to update (default: $SESSIONS_FILE or ./sessions.json)
 *   --force           export even if Narobet says the profile is not logged in
 *
 * Opens the profile in headless Chrome (close any Chrome window using it first),
 * loads Narobet so it can refresh the session, checks the login, then writes the
 * profile's Narobet cookies plus a matching user agent. Cookie values are never
 * printed. The running worker picks up the updated file without a restart.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';
import { isMainModule } from './src/casino/common.js';
import { loadConfig } from './src/casino/config.js';
import { checkLogin } from './src/casino/narobet.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

/** True when a cookie for `domain` is sent to `host`. */
function cookieMatchesHost(domain, host) {
  const d = String(domain || '').replace(/^\./, '').toLowerCase();
  return host === d || host.endsWith(`.${d}`);
}

/**
 * Reads the Narobet cookies out of `profileDir` and writes them into `outFile`.
 * Resolves to { id, cookieNames, loggedIn, userAgent, outFile, replaced }.
 */
export async function exportSession({
  profileDir, outFile, id = 'acct-1', baseUrl, sessionPath = '/games', executablePath,
  force = false, timeoutMs = 45_000,
}) {
  if (!fs.existsSync(profileDir)) throw new Error(`Chrome profile not found: ${profileDir}`);
  const host = new URL(baseUrl).hostname.toLowerCase();

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: true,
      executablePath: executablePath || undefined,
      userDataDir: profileDir,
      args: ['--no-first-run', '--no-default-browser-check'],
    });
  } catch (err) {
    if (/already running/i.test(err.message)) {
      throw new Error(`The profile ${profileDir} is open in another Chrome (a Chrome window, play-game.js or the old API). Close it and retry.`);
    }
    throw new Error(`Failed to launch Chrome: ${err.message}`);
  }

  let cookies;
  let loggedIn;
  let userAgent;
  try {
    const page = await browser.newPage();
    const url = new URL(sessionPath, baseUrl).href;
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    } catch (err) {
      throw new Error(`Could not load ${url}: ${err.message}`);
    }
    loggedIn = await checkLogin(page, { upstreamTimeoutMs: 15_000 });
    // The worker runs headless too, but cookies such as cf_clearance were issued
    // to the normal browser, so send the normal browser's user agent.
    userAgent = (await browser.userAgent()).replace('HeadlessChrome', 'Chrome');
    cookies = (await browser.cookies()).filter((c) => cookieMatchesHost(c.domain, host));
  } finally {
    await browser.close().catch(() => {});
  }

  if (loggedIn === false && !force) {
    throw new Error('This profile is not logged in to Narobet. Run `node play-game.js`, log in in the Chrome window, '
      + 'close it, then rerun this script (or pass --force to export anyway).');
  }
  if (!cookies.length) throw new Error(`The profile has no cookies for ${host}.`);

  const entry = {
    id,
    cookies: cookies.map((c) => {
      const out = { name: c.name, value: c.value, domain: c.domain, path: c.path || '/', secure: Boolean(c.secure), httpOnly: Boolean(c.httpOnly) };
      if (!String(c.domain).startsWith('.')) out.hostOnly = true;
      if (c.sameSite) out.sameSite = c.sameSite;
      if (typeof c.expires === 'number' && c.expires > 0) out.expires = c.expires;
      return out;
    }),
    userAgent,
    exportedAt: new Date().toISOString(),
  };

  let sessions = [];
  if (fs.existsSync(outFile)) {
    try {
      sessions = JSON.parse(fs.readFileSync(outFile, 'utf8'));
    } catch (err) {
      throw new Error(`${outFile} is not valid JSON (${err.message}); fix or delete it first.`);
    }
    if (!Array.isArray(sessions)) throw new Error(`${outFile} must contain a JSON array.`);
  }
  const index = sessions.findIndex((s) => s && s.id === id);
  if (index >= 0) sessions[index] = entry;
  else sessions.push(entry);

  // Write to a temp file and rename, so the worker never reads a half-written file.
  const tmp = `${outFile}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(sessions, null, 2)}\n`);
  fs.renameSync(tmp, outFile);

  return { id, cookieNames: entry.cookies.map((c) => c.name), loggedIn, userAgent, outFile, replaced: index >= 0 };
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--force') out.force = true;
    else if (a === '-h' || a === '--help') out.help = true;
    else if (['--profile', '--id', '--out'].includes(a)) {
      if (argv[i + 1] === undefined) throw new Error(`${a} needs a value`);
      out[a.slice(2)] = argv[++i];
    } else throw new Error(`Unknown option ${a} (try --help)`);
  }
  return out;
}

if (isMainModule(import.meta.url)) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
      console.log('Usage: node export-session.js [--profile <dir>] [--id <name>] [--out <file>] [--force]');
      process.exit(0);
    }
    const config = loadConfig();
    const result = await exportSession({
      profileDir: path.resolve(args.profile || process.env.CHROME_PROFILE || path.join(ROOT, 'chrome-profile')),
      outFile: path.resolve(args.out || config.sessionsFile),
      id: args.id || 'acct-1',
      baseUrl: config.baseUrl,
      sessionPath: config.sessionPath,
      executablePath: config.executablePath,
      force: Boolean(args.force),
    });
    console.log(`${result.replaced ? 'Updated' : 'Added'} "${result.id}" in ${result.outFile}: `
      + `${result.cookieNames.length} cookies (${result.cookieNames.join(', ')})`);
    console.log(`Logged in: ${result.loggedIn === null ? 'unknown (login check unavailable)' : result.loggedIn ? 'yes' : 'NO (exported with --force)'}`);
    console.log('sessions.json holds live login cookies: keep it private (it is git-ignored).');
  } catch (err) {
    console.error(`export-session: ${err.message}`);
    process.exit(1);
  }
}
