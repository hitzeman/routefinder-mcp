import test from "node:test";
import assert from "node:assert/strict";

import { checkActivityUrl } from "../src/ingest/url-policy.js";
import { fetchActivityBytes, type FetchFn } from "../src/ingest/fetch.js";

/** A fetch that fails loudly: any call proves a request escaped the policy. */
const forbiddenFetch: FetchFn = () => {
  throw new Error("policy must reject before any network request is issued");
};

test("off-allowlist host is rejected", () => {
  const check = checkActivityUrl("https://evil.example.com/fit/v2/a/b.fit");
  assert.equal(check.ok, false);
  if (check.ok) return;
  assert.match(check.reason, /allowlist/);
});

test("allowlisted host with a wrong path prefix is rejected", () => {
  const check = checkActivityUrl("https://s3.coros.com/private/secrets.json");
  assert.equal(check.ok, false);
  if (check.ok) return;
  assert.match(check.reason, /prefix/);
});

test("non-HTTPS scheme is rejected", () => {
  const check = checkActivityUrl("http://s3.coros.com/fit/v2/a/b.fit");
  assert.equal(check.ok, false);
  if (check.ok) return;
  assert.match(check.reason, /HTTPS only/);
});

test("malformed URL is rejected", () => {
  const check = checkActivityUrl("not a url at all");
  assert.equal(check.ok, false);
});

test("a conforming activity URL passes", () => {
  const check = checkActivityUrl("https://s3.coros.com/fit/v2/athlete/file.fit");
  assert.equal(check.ok, true);
});

test("rejection reasons never echo the URL", () => {
  const secret = "https://s3.coros.com/private/athlete-1234/file_deadbeef.fit";
  const check = checkActivityUrl(secret);
  assert.equal(check.ok, false);
  if (check.ok) return;
  assert.ok(!check.reason.includes("athlete-1234"));
  assert.ok(!check.reason.includes("deadbeef"));
  assert.ok(!check.reason.includes(secret));
});

/**
 * The allowlist must short-circuit before any socket is opened. A fetch that throws on
 * invocation makes an escaped request a test failure rather than a silent success.
 */
test("rejected URLs issue no network request", async () => {
  for (const candidate of [
    "https://evil.example.com/fit/a.fit",
    "http://s3.coros.com/fit/a.fit",
    "https://s3.coros.com/not-fit/a.fit",
    "garbage",
  ]) {
    const outcome = await fetchActivityBytes(candidate, {
      fetchImpl: forbiddenFetch,
    });
    assert.equal(outcome.ok, false, `${candidate} must be refused`);
  }
});
