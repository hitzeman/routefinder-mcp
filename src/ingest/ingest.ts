import { ActivityCache, cacheKey } from "../cache/store.js";
import { logInfo, logWarn } from "../log.js";
import { fetchActivityBytes, type FetchOptions } from "./fetch.js";

/** Short, non-identifying handle for a cache key, for log correlation. */
const shortKey = (key: string): string => key.slice(0, 12);

export const ACTIVITY_STATUSES = [
  "newly-cached",
  "already-cached",
  "unusable",
  "failed",
  "skipped",
] as const;

export type ActivityStatus = (typeof ACTIVITY_STATUSES)[number];

export interface ActivityOutcome {
  /** Position in the submitted list, so a caller can correlate without the URL. */
  index: number;
  /** Cache key. Safe to surface: a digest, never the URL. */
  key: string;
  status: ActivityStatus;
  reason?: string;
  /** Present on failed and skipped outcomes: whether calling again could succeed. */
  retryable?: boolean;
  distanceM?: number;
  startTime?: string;
}

export interface IngestResult {
  newlyCached: number;
  alreadyCached: number;
  unusable: number;
  failed: number;
  skipped: number;
  /** Network requests actually issued, including retries. Zero on a fully cached batch. */
  requestsIssued: number;
  /** True when the batch deadline cut the call short; the rest can be resumed. */
  deadlineReached: boolean;
  outcomes: ActivityOutcome[];
}

export interface IngestOptions extends FetchOptions {
  cache?: ActivityCache;
  /** Downloads in flight at once. Default 4. */
  concurrency?: number;
  /** Wall-clock budget for the whole batch. Default 45 s. */
  deadlineMs?: number;
}

/**
 * Fetch, cache, and parse a batch of activities.
 *
 * Per-activity outcomes, so one unreachable or unparseable activity never fails the
 * batch. Already-cached activities issue no request at all, which is what makes repeat
 * calls free against the metered COROS cap.
 *
 * A batch deadline bounds the call so it can return a partial, resumable result inside
 * an MCP client's request timeout. Activities not started before the deadline come back
 * as `skipped` and retryable; resubmitting the same list costs nothing for the ones that
 * did complete.
 */
export async function ingestActivities(
  urls: readonly string[],
  options: IngestOptions = {},
): Promise<IngestResult> {
  const {
    cache = new ActivityCache(),
    concurrency = 4,
    deadlineMs = 45_000,
    signal: externalSignal,
    ...fetchOptions
  } = options;
  await cache.init();

  const deadline = new AbortController();
  const deadlineTimer = setTimeout(() => deadline.abort(), deadlineMs);
  const onExternalAbort = (): void => deadline.abort();
  externalSignal?.addEventListener("abort", onExternalAbort, { once: true });

  const outcomes: ActivityOutcome[] = new Array<ActivityOutcome>(urls.length);
  let requestsIssued = 0;

  logInfo(`ingest starting for ${urls.length} activities`);

  // Duplicates would race each other into the same cache file. Process the first
  // occurrence and point the rest at it.
  const firstIndexByKey = new Map<string, number>();
  const work: Array<{ index: number; url: string; key: string }> = [];
  for (const [index, url] of urls.entries()) {
    const key = cacheKey(url);
    const first = firstIndexByKey.get(key);
    if (first === undefined) {
      firstIndexByKey.set(key, index);
      work.push({ index, url, key });
    } else {
      outcomes[index] = {
        index,
        key,
        status: "skipped",
        reason: `duplicate of #${first} in this batch`,
        retryable: false,
      };
    }
  }

  const processOne = async (index: number, url: string, key: string): Promise<ActivityOutcome> => {
    // Fully cached and readable: nothing to do, and crucially nothing to request.
    const cached = await cache.getTrack(key);
    if (cached !== null) {
      return {
        index,
        key,
        status: "already-cached",
        distanceM: cached.totalDistanceM,
        startTime: cached.startTime,
      };
    }

    // Raw bytes present (and the track tier missing or corrupt): rebuild it for free.
    if (await cache.hasRaw(key)) {
      const parsed = await cache.parseFromRaw(key);
      return parsed.ok
        ? {
            index,
            key,
            status: "already-cached",
            distanceM: parsed.track.totalDistanceM,
            startTime: parsed.track.startTime,
          }
        : { index, key, status: "unusable", reason: parsed.reason };
    }

    if (deadline.signal.aborted) {
      return {
        index,
        key,
        status: "skipped",
        reason:
          "batch deadline reached before this activity was started; call " +
          "ingest_activities again with the same URLs (completed ones are free)",
        retryable: true,
      };
    }

    const fetched = await fetchActivityBytes(url, { ...fetchOptions, signal: deadline.signal });
    requestsIssued += fetched.attempts;
    if (!fetched.ok) {
      logWarn(`activity #${index} (${shortKey(key)}) failed to fetch: ${fetched.reason}`);
      return { index, key, status: "failed", reason: fetched.reason, retryable: fetched.retryable };
    }

    // Raw tier first: a parser failure after this point costs no further requests.
    await cache.putRaw(key, fetched.bytes);

    const parsed = await cache.parseFromRaw(key);
    if (!parsed.ok) {
      logWarn(`activity #${index} (${shortKey(key)}) is unusable: ${parsed.reason}`);
      return { index, key, status: "unusable", reason: parsed.reason };
    }

    logInfo(`activity #${index} (${shortKey(key)}) cached, ${parsed.track.points.length} points`);
    return {
      index,
      key,
      status: "newly-cached",
      distanceM: parsed.track.totalDistanceM,
      startTime: parsed.track.startTime,
    };
  };

  try {
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < work.length) {
        const item = work[next];
        next += 1;
        if (item === undefined) break;
        try {
          outcomes[item.index] = await processOne(item.index, item.url, item.key);
        } catch (error) {
          // Cache I/O failures land here. Keep the batch alive and say so.
          const detail = error instanceof Error && "code" in error ? String(error.code) : "I/O error";
          outcomes[item.index] = {
            index: item.index,
            key: item.key,
            status: "failed",
            reason: `cache write or read failed (${detail}); check ROUTEFINDER_CACHE_DIR`,
            retryable: false,
          };
        }
      }
    };
    const workers = Math.max(1, Math.min(concurrency, work.length));
    await Promise.all(Array.from({ length: workers }, worker));
  } finally {
    clearTimeout(deadlineTimer);
    externalSignal?.removeEventListener("abort", onExternalAbort);
  }

  const count = (status: ActivityStatus): number =>
    outcomes.filter((outcome) => outcome.status === status).length;

  const result: IngestResult = {
    newlyCached: count("newly-cached"),
    alreadyCached: count("already-cached"),
    unusable: count("unusable"),
    failed: count("failed"),
    skipped: count("skipped"),
    requestsIssued,
    deadlineReached: deadline.signal.aborted && !(externalSignal?.aborted ?? false),
    outcomes,
  };

  logInfo(
    `ingest complete: ${result.newlyCached} newly cached, ${result.alreadyCached} already cached, ` +
      `${result.unusable} unusable, ${result.failed} failed, ${result.skipped} skipped, ` +
      `${result.requestsIssued} requests issued`,
  );

  return result;
}

