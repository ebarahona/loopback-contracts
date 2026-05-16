/**
 * Strips credentials (user info) from a URL string. Returns the input
 * unchanged if not parseable as a URL.
 *
 * Handles:
 * - Standard URLs: `https://user:pass@host/path` -> `https://[REDACTED]@host/path`
 * - Git+SSH: `git+ssh://git@host:owner/repo.git` (preserves `git@` since
 *   that's not a credential)
 * - Bare git URLs with credentials (best-effort regex fallback)
 *
 * @internal — used by source resolvers and error messages
 */
export function redactUrl(uri: string): string {
  try {
    const url = new URL(uri);
    if (
      url.password === '' &&
      (url.username === '' || url.username === 'git')
    ) {
      return url.toString();
    }
    // `URL.toString()` percent-encodes the userinfo segment, so swapping in a
    // marker like `[REDACTED]` would render as `%5BREDACTED%5D`. Instead, strip
    // the userinfo entirely, then splice the marker back in (when applicable)
    // so the output reads cleanly in logs and error messages.
    const hadUsername = url.username !== '';
    url.password = '';
    url.username = '';
    const stripped = url.toString();
    if (!hadUsername) return stripped;
    // RFC 3986: scheme = ALPHA *( ALPHA / DIGIT / "+" / "-" / "." ). The
    // earlier `[a-z+]+` was too narrow and missed e.g. `s3://`, `h2://`,
    // `git-lfs://`, etc.
    return stripped.replace(/^([a-z][a-z0-9+.\-]*:\/\/)/i, '$1[REDACTED]@');
  } catch {
    // Fallback: regex-strip `://user[:pass]@` patterns. `git@` (no colon, no
    // password) is left intact — it's the conventional SSH login, not a
    // credential — matching the WHATWG-parser branch above.
    //
    // Edge case: the regex matches the *first* `@` only. If the userinfo
    // segment itself contains literal `@` characters (RFC-illegal but seen in
    // malformed inputs), redaction stops short and the remaining `@`-tail
    // leaks into the output. Acceptable for v1.0 because this branch only
    // runs when the WHATWG parser already rejected the URI, and the primary
    // (parsed) branch handles all well-formed credentialed URLs. Tighten
    // here if a real-world case demands it.
    return uri.replace(
      /(:\/\/)([^@/]+)@/,
      (match, prefix: string, userinfo: string) => {
        if (userinfo === 'git') return match;
        return `${prefix}[REDACTED]@`;
      },
    );
  }
}

/**
 * Strips any URL-shaped substring's credentials from an arbitrary string
 * (e.g. command stderr that mentions URLs).
 *
 * @internal
 */
export function redactUrlsInText(text: string): string {
  // RFC 3986 scheme grammar — see {@link redactUrl} for rationale.
  return text.replace(/[a-z][a-z0-9+.\-]*:\/\/[^\s]+/gi, m => redactUrl(m));
}
