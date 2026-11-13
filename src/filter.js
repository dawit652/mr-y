/**
 * filter.js
 * ---------------------------------------------------------------------------
 * Keyword-based URL filter. A URL matches when it contains any keyword
 * (case-insensitive). The matched keywords are returned so the report can
 * show *why* each request was kept.
 */

/**
 * Build a filter from a keyword list.
 *
 * @param {string[]} keywords
 * @param {{captureAll?: boolean}} [opts]
 * @returns {{ test(url: string): string[] | null, keywords: string[], captureAll: boolean }}
 *   `test` returns the list of matched keywords (possibly empty when
 *   captureAll is on), or `null` when the URL should be dropped.
 */
export function createUrlFilter(keywords, { captureAll = false } = {}) {
  const needles = keywords.map((k) => k.toLowerCase()).filter(Boolean);

  return {
    keywords: needles,
    captureAll,
    test(url) {
      const haystack = safeDecode(url).toLowerCase();
      const matched = needles.filter((k) => haystack.includes(k));
      if (matched.length > 0) return matched;
      return captureAll || needles.length === 0 ? [] : null;
    },
  };
}

/** Decode percent-escapes so "%61pi" still matches "api"; never throws. */
function safeDecode(url) {
  try {
    return decodeURIComponent(url);
  } catch {
    return url;
  }
}
