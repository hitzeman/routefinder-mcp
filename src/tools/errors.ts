import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { logError, redact } from "../log.js";

/**
 * Domain error codes a tool may return. Add a code here rather than inventing free text,
 * so callers (and contract tests) can branch on it.
 */
export type ToolErrorCode =
  /** The cache directory cannot be read or created. Configuration, not transient. */
  | "cache_unavailable"
  /** A bug. The message is deliberately generic; details go to the stderr log. */
  | "internal_error";

export interface ToolErrorBody {
  error: { code: ToolErrorCode; message: string; retryable: boolean };
}

/**
 * Build an MCP tool-execution error.
 *
 * The error object travels as JSON in the text content and NOT as `structuredContent`:
 * the TypeScript SDK client validates any `structuredContent` against the tool's
 * `outputSchema` even when `isError` is set, so a structured error body would be
 * rejected by a conforming client as a schema violation. Text content is exempt.
 */
export function toolError(
  code: ToolErrorCode,
  message: string,
  retryable: boolean,
): CallToolResult {
  const body: ToolErrorBody = { error: { code, message: redact(message), retryable } };
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify(body) }],
  };
}

/**
 * Map an unexpected exception to a tool error without leaking a stack trace, a URL, or a
 * coordinate to the model. The full detail is logged (redacted) to stderr.
 */
export function unexpectedError(tool: string, error: unknown): CallToolResult {
  const code = error instanceof Error && "code" in error ? String(error.code) : undefined;
  logError(
    `${tool} failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
  );

  if (code !== undefined && ["EACCES", "EPERM", "ENOTDIR", "EROFS", "ENOSPC"].includes(code)) {
    return toolError(
      "cache_unavailable",
      `The activity cache could not be accessed (${code}). Check that ` +
        "ROUTEFINDER_CACHE_DIR points at a writable directory, then call again.",
      false,
    );
  }

  return toolError(
    "internal_error",
    `${tool} hit an unexpected error${code ? ` (${code})` : ""}. ` +
      "The server log has details. Retrying the same call is unlikely to help.",
    false,
  );
}
