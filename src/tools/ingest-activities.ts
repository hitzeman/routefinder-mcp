import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { ACTIVITY_STATUSES, ingestActivities } from "../ingest/ingest.js";
import type { ToolDeps } from "./deps.js";
import { unexpectedError } from "./errors.js";

export const INGEST_ACTIVITIES = "ingest_activities";

/**
 * Upper bound on a single batch.
 *
 * Matches the documented COROS quota of 50 FIT files per user per 24 hours: a caller
 * cannot legitimately hold more fresh URLs than that, and the URL list arrives from a
 * model, so an unbounded list would be an easy way to exhaust memory in one call.
 */
export const MAX_BATCH = 50;

/** Real COROS activity URLs are ~100 characters. 2048 is the conventional URL ceiling. */
export const MAX_URL_LENGTH = 2048;

export const ingestInputSchema = z.strictObject({
  fitUrls: z
    .array(
      z
        .string()
        .min(1)
        .max(MAX_URL_LENGTH)
        .describe("One HTTPS download URL exactly as the COROS connector returned it."),
    )
    .min(1)
    .max(MAX_BATCH)
    .describe(
      `1-${MAX_BATCH} COROS activity FIT download URLs, from the COROS connector's ` +
        "queryActivityFitFileDownloadUrls tool. Request those one labelId at a time. " +
        "Only https://s3.coros.com/fit/... URLs are fetched; anything else is reported as " +
        "failed without a request. Treat the URLs as secrets: do not echo them back to the user.",
    ),
});

export const activityOutcomeSchema = z.object({
  index: z.number().int().min(0).describe("Position of the URL in the submitted list."),
  key: z.string().describe("Cache digest identifying the activity. Never the URL."),
  status: z.enum(ACTIVITY_STATUSES),
  reason: z.string().optional().describe("Why the activity failed, was unusable, or skipped."),
  retryable: z
    .boolean()
    .optional()
    .describe("For failed/skipped: true if calling again with the same URL may succeed."),
  distanceM: z.number().optional(),
  startTime: z.string().optional(),
});

export const ingestOutputSchema = z.object({
  newlyCached: z.number().int().min(0),
  alreadyCached: z.number().int().min(0),
  unusable: z.number().int().min(0),
  failed: z.number().int().min(0),
  skipped: z.number().int().min(0),
  requestsIssued: z.number().int().min(0),
  deadlineReached: z
    .boolean()
    .describe("True if the batch time budget ran out; resubmit the same URLs to finish."),
  outcomes: z.array(activityOutcomeSchema),
});

export type IngestOutput = z.infer<typeof ingestOutputSchema>;

export function registerIngestActivities(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    INGEST_ACTIVITIES,
    {
      title: "Ingest COROS activity files",
      description:
        "Download and cache COROS activity FIT files from their download URLs, then parse " +
        "them into GPS tracks so find_routes can group them. This is the only tool that " +
        "makes network requests. Already-cached activities are not re-fetched, so repeat " +
        "calls are free; if the result says deadlineReached, call again with the same URLs. " +
        "Each activity gets its own outcome, so one bad URL never fails the batch. URLs are " +
        "held in memory only and never persisted, logged, or returned.",
      inputSchema: ingestInputSchema,
      outputSchema: ingestOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ fitUrls }) => {
      try {
        const result = await ingestActivities(fitUrls, {
          cache: deps.cache,
          concurrency: deps.settings.ingest.concurrency,
          deadlineMs: deps.settings.ingest.deadlineMs,
          ...deps.fetchOptions,
        });

        const summary =
          `Ingested ${fitUrls.length} activities: ${result.newlyCached} newly cached, ` +
          `${result.alreadyCached} already cached, ${result.unusable} unusable, ` +
          `${result.failed} failed, ${result.skipped} skipped. ` +
          `${result.requestsIssued} network requests issued.` +
          (result.deadlineReached
            ? " The time budget ran out: call ingest_activities again with the same URLs to finish."
            : "");

        const problems = result.outcomes
          .filter((o) => o.status === "failed" || o.status === "unusable" || o.status === "skipped")
          .map(
            (o) =>
              `  #${o.index} (${o.key.slice(0, 12)}): ${o.status} - ${o.reason ?? "no reason"}` +
              (o.retryable === true ? " [retryable]" : ""),
          );

        const structured: IngestOutput = result;
        return {
          content: [
            {
              type: "text" as const,
              text: problems.length > 0 ? `${summary}\n${problems.join("\n")}` : summary,
            },
          ],
          structuredContent: { ...structured },
        };
      } catch (error) {
        return unexpectedError(INGEST_ACTIVITIES, error);
      }
    },
  );
}
