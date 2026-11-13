/**
 * stealth.js
 * ---------------------------------------------------------------------------
 * Basic anti-fingerprinting measures. These defeat *trivial* bot checks
 * (default HeadlessChrome UA, fixed 800x600 viewport, navigator.webdriver,
 * instant robotic interaction). They will not beat serious bot-management
 * products, and are not meant to.
 *
 * Everything here is deliberately self-consistent: the UA string, the
 * platform reported by navigator.platform, and Accept-Language all come
 * from the same randomly chosen profile.
 */

// ---------------------------------------------------------------------------
// Randomness helpers
// ---------------------------------------------------------------------------

/** Random integer in [min, max] inclusive. */
export function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/** Pick a random element from an array. */
export function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

/** Sleep for a random duration in [minMs, maxMs]. */
export function humanDelay(minMs = 300, maxMs = 1200) {
  return new Promise((resolve) => setTimeout(resolve, randInt(minMs, maxMs)));
}

// ---------------------------------------------------------------------------
// Browser profiles
// ---------------------------------------------------------------------------

// Recent desktop Chrome builds. Major versions are kept close together so
// the UA looks plausible next to whatever Chromium Puppeteer actually runs.
const CHROME_VERSIONS = ['138.0.0.0', '139.0.0.0', '140.0.0.0', '141.0.0.0', '142.0.0.0'];

const PLATFORMS = [
  {
    os: 'Windows',
    navigatorPlatform: 'Win32',
    uaToken: 'Windows NT 10.0; Win64; x64',
    viewports: [
      [1920, 1080],
      [1536, 864],
      [1366, 768],
      [1440, 900],
      [1600, 900],
    ],
  },
  {
    os: 'macOS',
    navigatorPlatform: 'MacIntel',
    uaToken: 'Macintosh; Intel Mac OS X 10_15_7',
    viewports: [
      [1440, 900],
      [1512, 982],
      [1680, 1050],
      [1280, 800],
    ],
  },
  {
    os: 'Linux',
    navigatorPlatform: 'Linux x86_64',
    uaToken: 'X11; Linux x86_64',
    viewports: [
      [1920, 1080],
      [1366, 768],
      [1600, 900],
    ],
  },
];

const LANGUAGES = [
  ['en-US', 'en'],
  ['en-GB', 'en'],
];

/**
 * Generate a random, internally consistent browser profile.
 * @returns {{userAgent: string, platform: string, os: string,
 *            viewport: {width: number, height: number, deviceScaleFactor: number},
 *            languages: string[], acceptLanguage: string}}
 */
export function randomProfile() {
  const platform = pick(PLATFORMS);
  const chrome = pick(CHROME_VERSIONS);
  const [baseW, baseH] = pick(platform.viewports);
  const languages = pick(LANGUAGES);

  return {
    os: platform.os,
    platform: platform.navigatorPlatform,
    userAgent:
      `Mozilla/5.0 (${platform.uaToken}) AppleWebKit/537.36 ` +
      `(KHTML, like Gecko) Chrome/${chrome} Safari/537.36`,
    // Real windows lose some height to browser chrome and vary slightly, so
    // jitter the viewport instead of using exact screen resolutions.
    viewport: {
      width: baseW - randInt(0, 16),
      height: baseH - randInt(70, 140),
      deviceScaleFactor: platform.os === 'macOS' ? 2 : 1,
    },
    languages,
    acceptLanguage: `${languages[0]},${languages[1]};q=0.9`,
  };
}

/** Launch arguments that remove the most obvious automation tells. */
export const STEALTH_LAUNCH_ARGS = [
  '--disable-blink-features=AutomationControlled',
  '--no-first-run',
  '--no-default-browser-check',
];

/**
 * Apply a profile to a page. Must be called before the first navigation so
 * the init script runs in every frame/document.
 *
 * @param {import('puppeteer').Page} page
 * @param {ReturnType<typeof randomProfile>} profile
 */
export async function applyStealth(page, profile) {
  await page.setUserAgent(profile.userAgent);
  await page.setViewport(profile.viewport);
  await page.setExtraHTTPHeaders({ 'Accept-Language': profile.acceptLanguage });

  // Runs in the page context before any site script.
  await page.evaluateOnNewDocument(
    ({ platform, languages }) => {
      const define = (obj, prop, value) => {
        try {
          Object.defineProperty(obj, prop, { get: () => value, configurable: true });
        } catch {
          /* property may be non-configurable in some contexts */
        }
      };

      // 1. navigator.webdriver is `true` under automation.
      define(Navigator.prototype, 'webdriver', false);

      // 2. Keep platform/languages consistent with the spoofed UA.
      define(Navigator.prototype, 'platform', platform);
      define(Navigator.prototype, 'languages', Object.freeze([...languages]));

      // 3. Headless Chrome exposes no `window.chrome.runtime`.
      if (!window.chrome) {
        define(window, 'chrome', { runtime: {} });
      }

      // 4. Headless reports Notification.permission 'denied' while the
      //    Permissions API says 'prompt'; make them agree.
      const origQuery = window.navigator.permissions?.query?.bind(window.navigator.permissions);
      if (origQuery) {
        window.navigator.permissions.query = (params) =>
          params && params.name === 'notifications'
            ? Promise.resolve({ state: Notification.permission, onchange: null })
            : origQuery(params);
      }
    },
    { platform: profile.platform, languages: profile.languages },
  );
}

/**
 * Light, human-ish interaction after the page has loaded: a few mouse moves
 * and incremental scrolls with random pauses. This also tends to trigger
 * lazy-loaded widgets and their API calls.
 *
 * @param {import('puppeteer').Page} page
 * @param {{width: number, height: number}} viewport
 * @param {number} budgetMs  Maximum time to spend interacting.
 */
export async function simulateHumanActivity(page, viewport, budgetMs) {
  const deadline = Date.now() + budgetMs;
  const width = viewport?.width ?? 1280;
  const height = viewport?.height ?? 720;

  while (Date.now() < deadline) {
    try {
      // Smooth-ish mouse movement to a random point.
      await page.mouse.move(randInt(20, width - 20), randInt(20, height - 20), {
        steps: randInt(8, 25),
      });
      await humanDelay(200, 700);

      // Scroll down a little (occasionally back up).
      const dy = Math.random() < 0.8 ? randInt(150, 600) : -randInt(100, 300);
      await page.mouse.wheel({ deltaY: dy });
    } catch {
      // Page may be navigating or closed; interaction is best-effort.
      return;
    }
    await humanDelay(800, 2500);
  }
}
