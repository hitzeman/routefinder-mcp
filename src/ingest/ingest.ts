import { ActivityCache, cacheKey } from "../cache/store.js";
import { logInfo, logWarn } from "../log.js";
import { fetchActivityBytes, type FetchOptions } from "./fetch.js";

/** Short, non-identifying handle for a cache key, for log correlation. */
const shortKey = (key: string): string => key.slice(0, 12);

export type ActivityStatus =
  | "newly-cached"
  | "already-cached"
  | "unusable"
  | "failed";

export interface ActivityOutcome {
  /** Position in the submitted list, so a caller can correlate without the URL. */
  index: number;
  /** Cache key. Safe to surface: a digest, never the URL. */
  key: string;
  status: ActivityStatus;
  reason?: string;
  distanceM?: number;
  startTime?: string;
}

export interface IngestResult {
  newlyCached: number;
  alreadyCached: number;
  unusable: number;
  failed: number;
  /** Network requests actually issued. Zero on a fully cached batch. */
  requestsIssued: number;
  outcomes: ActivityOutcome[];
}

export interface IngestOptions extends FetchOptions {
  cache?: ActivityCache;
}

/**
 * Fetch, cache, and parse a batch of activities.
 *
 * Per-activity outcomes, so one unreachable or unparseable activity never fails the
 * batch. Already-cached activities issue no request at all, which is what makes repeat
 * calls free against the metered COROS cap.
 */
export async function ingestActivities(
  urls: readonly string[],
  options: IngestOptions = {},
): Promise<IngestResult> {
  const { cache = new ActivityCache(), ...fetchOptions } = options;
  await cache.init();

  const outcomes: ActivityOutcome[] = [];
  let requestsIssued = 0;

  logInfo(`ingest starting for ${urls.length} activities`);

  for (const [index, url] of urls.entries()) {
    const key = cacheKey(url);

    // Fully cached: nothing to do, and crucially nothing to request.
    if (await cache.hasTrack(key)) {
      const track = await cache.getTrack(key);
      outcomes.push({
        index,
        key,
        status: "already-cached",
        ...(track === null
          ? {}
          : { distanceM: track.totalDistanceM, startTime: track.startTime }),
      });
      continue;
    }

    // Raw bytes present but not parsed: rebuild the disposable tier for free.
    if (await cache.hasRaw(key)) {
      const parsed = await cache.parseFromRaw(key);
      if (parsed.ok) {
        outcomes.push({
          index,
          key,
          status: "already-cached",
          distanceM: parsed.track.totalDistanceM,
          startTime: parsed.track.startTime,
        });
      } else {
        outcomes.push({ index, key, status: "unusable", reason: parsed.reason });
      }
      continue;
    }

    requestsIssued += 1;
    const fetched = await fetchActivityBytes(url, fetchOptions);
    if (!fetched.ok) {
      outcomes.push({ index, key, status: "failed", reason: fetched.reason });
      logWarn(
        `activity #${index} (${shortKey(key)}) failed to fetch: ${fetched.reason}`,
      );
      continue;
    }

    // Raw tier first: a parser failure after this point costs no further requests.
    await cache.putRaw(key, fetched.bytes);

    const parsed = await cache.parseFromRaw(key);
    if (!parsed.ok) {
      outcomes.push({ index, key, status: "unusable", reason: parsed.reason });
      logWarn(
        `activity #${index} (${shortKey(key)}) is unusable: ${parsed.reason}`,
      );
      continue;
    }

    outcomes.push({
      index,
      key,
      status: "newly-cached",
      distanceM: parsed.track.totalDistanceM,
      startTime: parsed.track.startTime,
    });
    logInfo(
      `activity #${index} (${shortKey(key)}) cached, ${parsed.track.points.length} points`,
    );
  }

  const count = (status: ActivityStatus): number =>
    outcomes.filter((outcome) => outcome.status === status).length;

  const result: IngestResult = {
    newlyCached: count("newly-cached"),
    alreadyCached: count("already-cached"),
    unusable: count("unusable"),
    failed: count("failed"),
    requestsIssued,
    outcomes,
  };

  logInfo(
    `ingest complete: ${result.newlyCached} newly cached, ${result.alreadyCached} already cached, ` +
      `${result.unusable} unusable, ${result.failed} failed, ${result.requestsIssued} requests issued`,
  );

  return result;
}
