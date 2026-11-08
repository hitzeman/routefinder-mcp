/**
 * Containment policy for activity file URLs.
 *
 * These URLs arrive from a model, so fetching one is a server-side request forgery
 * surface. The policy is an allowlist: a URL is fetched only if it is HTTPS, on an
 * expected host, and under an expected path prefix. Everything else is refused before a
 * socket is opened.
 */

/** Default allowlist. Override for tests or if COROS changes its object host. */
export const DEFAULT_ALLOWED_HOSTS: readonly string[] = ["s3.coros.com"];

/** Default required path prefix for a COROS activity file. */
export const DEFAULT_ALLOWED_PATH_PREFIX = "/fit/";

export interface UrlPolicy {
  allowedHosts: readonly string[];
  allowedPathPrefix: string;
}

export const defaultUrlPolicy: UrlPolicy = {
  allowedHosts: DEFAULT_ALLOWED_HOSTS,
  allowedPathPrefix: DEFAULT_ALLOWED_PATH_PREFIX,
};

export type UrlCheck = { ok: true; url: URL } | { ok: false; reason: string };

/**
 * Validate a candidate activity file URL against the policy.
 *
 * Reasons never echo the URL: a download URL is an unrevocable bearer secret and must
 * not reach logs, errors, or tool output.
 */
export function checkActivityUrl(
  candidate: string,
  policy: UrlPolicy = defaultUrlPolicy,
): UrlCheck {
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return { ok: false, reason: "not a valid URL" };
  }

  if (url.protocol !== "https:") {
    return { ok: false, reason: `scheme ${url.protocol} is not allowed; HTTPS only` };
  }

  if (!policy.allowedHosts.includes(url.hostname)) {
    return { ok: false, reason: "host is not on the activity file allowlist" };
  }

  if (!url.pathname.startsWith(policy.allowedPathPrefix)) {
    return { ok: false, reason: "path is not under the allowed activity file prefix" };
  }

  return { ok: true, url };
}
