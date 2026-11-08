import { checkActivityUrl, defaultUrlPolicy, type UrlPolicy } from "./url-policy.js";

export interface FetchLimits {
  /** Hard ceiling on a response body. A long run's FIT is a few hundred KB. */
  maxBytes: number;
  timeoutMs: number;
}

export const defaultFetchLimits: FetchLimits = {
  maxBytes: 8 * 1024 * 1024,
  timeoutMs: 30_000,
};

export type FetchFn = typeof globalThis.fetch;

export interface FetchOptions {
  limits?: FetchLimits;
  policy?: UrlPolicy;
  fetchImpl?: FetchFn;
}

export type FetchOutcome =
  | { ok: true; bytes: Buffer }
  | { ok: false; reason: string };

/**
 * Fetch one activity file.
 *
 * Credential-free by construction: no authorization header, cookie, or token is ever
 * attached. The object is public and content-addressed, so there is nothing to sign.
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
  } = options;

  const check = checkActivityUrl(candidateUrl, policy);
  if (!check.ok) {
    return { ok: false, reason: check.reason };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), limits.timeoutMs);

  try {
    const response = await fetchImpl(check.url, {
      // Never follow a redirect: the target has not been through the allowlist.
      redirect: "manual",
      signal: controller.signal,
      headers: { accept: "application/octet-stream" },
    });

    if (response.status >= 300 && response.status < 400) {
      return {
        ok: false,
        reason: `refused redirect (HTTP ${response.status}); redirect targets are not fetched`,
      };
    }

    if (!response.ok) {
      return { ok: false, reason: `HTTP ${response.status}` };
    }

    const declaredHeader = response.headers.get("content-length");
    const declaredLength = declaredHeader === null ? null : Number(declaredHeader);

    if (declaredLength !== null && Number.isFinite(declaredLength)) {
      if (declaredLength > limits.maxBytes) {
        return {
          ok: false,
          reason: `declared size ${declaredLength} B exceeds the ${limits.maxBytes} B limit`,
        };
      }
    }

    const body = response.body;
    if (body === null) {
      return { ok: false, reason: "response had no body" };
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
        reason: `truncated response: received ${received} B of a declared ${declaredLength} B`,
      };
    }

    return { ok: true, bytes: Buffer.concat(chunks) };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return { ok: false, reason: `request timed out after ${limits.timeoutMs} ms` };
    }
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: `request failed: ${detail}` };
  } finally {
    clearTimeout(timer);
  }
}
