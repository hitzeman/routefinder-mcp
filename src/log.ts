/**
 * Leak-resistant logging.
 *
 * Two hard constraints shape this module:
 *
 * 1. Output goes to stderr, never stdout. On a stdio MCP server stdout carries the
 *    JSON-RPC framing, so a stray write there corrupts the protocol.
 * 2. Activity download URLs are unrevocable bearer secrets and cached tracks contain
 *    home-adjacent GPS. Neither may reach a log. Callers are expected not to pass them,
 *    and `redact` is the defence in depth for when that discipline slips.
 */

/** Any http(s) URL. */
const URL_PATTERN = /\bhttps?:\/\/\S+/gi;

/**
 * A decimal with four or more fraction digits, which is the signature of a coordinate.
 * Distances and durations in this codebase carry at most two, so they survive intact.
 */
const COORDINATE_PATTERN = /-?\b\d{1,3}\.\d{4,}\b/g;

export function redact(message: string): string {
  return message
    .replace(URL_PATTERN, "[url-redacted]")
    .replace(COORDINATE_PATTERN, "[coord-redacted]");
}

export type LogSink = (line: string) => void;

const stderrSink: LogSink = (line) => {
  process.stderr.write(`${line}\n`);
};

let sink: LogSink = stderrSink;

/** Redirect log output, used by tests to capture and scan it. */
export function setLogSink(next: LogSink | null): void {
  sink = next ?? stderrSink;
}

function emit(level: string, message: string): void {
  sink(`[routefinder] ${level} ${redact(message)}`);
}

export function logInfo(message: string): void {
  emit("info", message);
}

export function logWarn(message: string): void {
  emit("warn", message);
}

export function logError(message: string): void {
  emit("error", message);
}
