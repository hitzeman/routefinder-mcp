import { checkActivityUrl, defaultUrlPolicy, type UrlPolicy } from "./url-policy.js";

export interface FetchLimits {
  /** Hard ceiling on a response body. A long run's FIT is a few hundred KB. */
  maxBytes: number;
  /** Per-attempt timeout. */
  timeoutMs: number;
  /** Extra attempts after a retryable failure (429, 5xx, timeout, network error). */
  retries?: number;
  /** Delay before a retry when the server sends no usable Retry-After. */
  retryBaseDelayMs?: number;
  /**
   * Ceiling on any single retry wait, including one requested by Retry-After. A server
   * asking for longer than this gets a retryable failure instead of a stalled batch.
   */
  maxRetryDelayMs?: number;
}

export const defaultFetchLimits: FetchLimits = {
  maxBytes: 8 * 1024 * 1024,
  timeoutMs: 15_000,
  retries: 1,
  retryBaseDelayMs: 500,
  maxRetryDelayMs: 5_000,
};

export type FetchFn = typeof globalThis.fetch;

export interface FetchOptions {
  limits?: FetchLimits;
  policy?: UrlPolicy;
  fetchImpl?: FetchFn;
  /** Aborts the fetch from outside, e.g. when the batch deadline passes. */
  signal?: AbortSignal;
}

export type FetchOutcome =
  | { ok: true; bytes: Buffer; attempts: number }
  | {
      ok: false;
      reason: string;
      /** True when calling again later could plausibly succeed. */
      retryable: boolean;
      /** Network requests actually issued, including retries. Zero if refused by policy. */
      attempts: number;
    };

type AttemptOutcome =
  | { ok: true; bytes: Buffer }
  | { ok: false; reason: string; retryable: boolean; retryAfterMs?: number };

const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

/** Retry-After as delta-seconds or an HTTP date, in milliseconds; null if unusable. */
export function parseRetryAfter(header: string | null, now = Date.now()): number | null {
  if (header === null || header.trim() === "") return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return seconds >= 0 ? seconds * 1000 : null;
  const date = Date.parse(header);
  return Number.isNaN(date) ? null : Math.max(0, date - now);
}

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });

async function attemptOnce(
  url: URL,
  limits: FetchLimits,
  fetchImpl: FetchFn,
  outer: AbortSignal | undefined,
): Promise<AttemptOutcome> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, limits.timeoutMs);
  const onOuterAbort = (): void => controller.abort();
  outer?.addEventListener("abort", onOuterAbort, { once: true });

  try {
    const response = await fetchImpl(url, {
      // Never follow a redirect: the target has not been through the allowlist.
      redirect: "manual",
      signal: controller.signal,
      headers: { accept: "application/octet-stream" },
    });

    if (response.status >= 300 && response.status < 400) {
      return {
        ok: false,
        retryable: false,
        reason: `refused redirect (HTTP ${response.status}); redirect targets are not fetched`,
      };
    }

    if (!response.ok) {
      const retryable = RETRYABLE_STATUSES.has(response.status);
      const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"));
      await response.body?.cancel().catch(() => undefined);
      const hint =
        response.status === 429
          ? "rate limited by the activity file host"
          : retryable
            ? "activity file host temporarily unavailable"
            : "activity file host refused the request";
      return {
        ok: false,
        retryable,
        reason: `HTTP ${response.status}: ${hint}`,
        ...(retryAfterMs === null ? {} : { retryAfterMs }),
      };
    }

    const declaredHeader = response.headers.get("content-length");
    const declaredLength = declaredHeader === null ? null : Number(declaredHeader);

    if (declaredLength !== null && Number.isFinite(declaredLength)) {
      if (declaredLength > limits.maxBytes) {
        await response.body?.cancel().catch(() => undefined);
        return {
          ok: false,
          retryable: false,
          reason: `declared size ${declaredLength} B exceeds the ${limits.maxBytes} B limit`,
        };
      }
    }

    const body = response.body;
    if (body === null) {
      return { ok: false, retryable: true, reason: "response had no body" };
    }

    const chunks: Uint8Array[] = [];
    let received = 0;
    const reader = body.getReader();

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;

      received += value.byteLength;
      if (received > limits.maxBytes) {
        await reader.cancel().catch(() => undefined);
        return {
          ok: false,
          retryable: false,
          reason: `response exceeded the ${limits.maxBytes} B limit`,
        };
      }
      chunks.push(value);
    }

    if (
      declaredLength !== null &&
      Number.isFinite(declaredLength) &&
      received !== declaredLength
    ) {
      return {
        ok: false,
        retryable: true,
        reason: `truncated response: received ${received} B of a declared ${declaredLength} B`,
      };
    }

    return { ok: true, bytes: Buffer.concat(chunks) };
  } catch (error) {
    if (outer?.aborted) {
      return {
        ok: false,
        retryable: true,
        reason: "batch deadline reached during download; call again to resume",
      };
    }
    if (timedOut || (error instanceof Error && error.name === "AbortError")) {
      return {
        ok: false,
        retryable: true,
        reason: `request timed out after ${limits.timeoutMs} ms`,
      };
    }
    // Deliberately not echoing error.message: undici messages can include the URL.
    const name = error instanceof Error ? error.name : "unknown error";
    const code =
      error instanceof Error && error.cause instanceof Error && "code" in error.cause
        ? ` (${String(error.cause.code)})`
        : "";
    return { ok: false, retryable: true, reason: `network error: ${name}${code}` };
  } finally {
    clearTimeout(timer);
    outer?.removeEventListener("abort", onOuterAbort);
  }
}

/**
 * Fetch one activity file.
 *
 * Credential-free by construction: no authorization header, cookie, or token is ever
 * attached. The object is public and content-addressed, so there is nothing to sign.
 *
 * Retries are bounded and cheap to justify: the bytes host is unmetered, so a retry
 * spends no COROS quota. The quota was spent when the URL was obtained.
 *
 * Failure reasons never contain the URL.
 */
export async function fetchActivityBytes(
  candidateUrl: string,
  options: FetchOptions = {},
): Promise<FetchOutcome> {
  const {
    limits = defaultFetchLimits,
    policy = defaultUrlPolicy,
    fetchImpl = globalThis.fetch,
    signal,
  } = options;
  const retries = limits.retries ?? 0;
  const baseDelay = limits.retryBaseDelayMs ?? 500;
  const maxDelay = limits.maxRetryDelayMs ?? 5_000;

  const check = checkActivityUrl(candidateUrl, policy);
  if (!check.ok) {
    return { ok: false, reason: check.reason, retryable: false, attempts: 0 };
  }

  let attempts = 0;
  for (;;) {
    attempts += 1;
    const outcome = await attemptOnce(check.url, limits, fetchImpl, signal);
    if (outcome.ok) return { ok: true, bytes: outcome.bytes, attempts };

    const fail = { ok: false as const, reason: outcome.reason, retryable: outcome.retryable, attempts };
    if (!outcome.retryable || attempts > retries || signal?.aborted) return fail;

    const wait = outcome.retryAfterMs ?? baseDelay * 2 ** (attempts - 1);
    if (wait > maxDelay) {
      return { ...fail, reason: `${outcome.reason}; server asked to wait ${Math.ceil(wait / 1000)} s` };
    }
    await sleep(wait, signal);
    if (signal?.aborted) return fail;
  }
}
