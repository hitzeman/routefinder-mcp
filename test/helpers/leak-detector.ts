/**
 * Detectors for the two things that must never escape.
 *
 * The asymmetry is deliberate. A cached track is *supposed* to contain coordinates --
 * that is what it is for -- so coordinates are forbidden only in logs. A download URL is
 * an unrevocable bearer secret and is forbidden everywhere: cache contents, cache
 * filenames, logs, errors, and tool output.
 */

const URL_PATTERN = /\bhttps?:\/\/\S+/i;
const COORDINATE_PATTERN = /-?\b\d{1,3}\.\d{4,}\b/;

export function findUrlLeak(text: string): string | null {
  return text.match(URL_PATTERN)?.[0] ?? null;
}

export function findCoordinateLeak(text: string): string | null {
  return text.match(COORDINATE_PATTERN)?.[0] ?? null;
}

/** Any URL-ish fragment of a known secret appearing verbatim. */
export function findSecretFragment(
  text: string,
  fragments: readonly string[],
): string | null {
  for (const fragment of fragments) {
    if (fragment.length >= 6 && text.includes(fragment)) return fragment;
  }
  return null;
}
