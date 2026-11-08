import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { ActivityCache } from "./cache/store.js";
import { ingestActivities } from "./ingest/ingest.js";
import type { FetchOptions } from "./ingest/fetch.js";
import { discoverRoutes } from "./routes/discover.js";
import { summarize, toGeoJson } from "./routes/geojson.js";

/**
 * Upper bound on a single ingest batch.
 *
 * Generous relative to the COROS daily cap, but not unbounded: the URL list arrives from
 * a model, and an unbounded list would be an easy way to spend a whole day's quota or
 * exhaust memory in one call.
 */
const MAX_BATCH = 100;

export interface ServerDeps {
  cache?: ActivityCache;
  fetchOptions?: FetchOptions;
}

export const SERVER_NAME = "routefinder-mcp";
export const SERVER_VERSION = "0.1.0";

export function createServer(deps: ServerDeps = {}): McpServer {
  const cache = deps.cache ?? new ActivityCache();
  const fetchOptions = deps.fetchOptions ?? {};

  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  server.registerTool(
    "ingest_activities",
    {
      title: "Ingest COROS activity files",
      description:
        "Download and cache COROS activity FIT files from their download URLs, then " +
        "parse them into GPS tracks. This is the only tool that makes network requests. " +
        "Obtain the URLs from the COROS connector one labelId at a time. Already-cached " +
        "activities are not re-fetched, so repeat calls are free. URLs are treated as " +
        "secrets: they are held in memory only and never persisted or logged.",
      inputSchema: {
        fitUrls: z
          .array(z.string())
          .min(1)
          .max(MAX_BATCH)
          .describe(
            "COROS activity FIT file download URLs, as returned by the COROS connector.",
          ),
      },
    },
    async ({ fitUrls }) => {
      const result = await ingestActivities(fitUrls, { cache, ...fetchOptions });

      const summary =
        `Ingested ${fitUrls.length} activities: ${result.newlyCached} newly cached, ` +
        `${result.alreadyCached} already cached, ${result.unusable} unusable, ` +
        `${result.failed} failed. ${result.requestsIssued} network requests issued.`;

      const problems = result.outcomes
        .filter((o) => o.status === "failed" || o.status === "unusable")
        .map((o) => `  #${o.index} (${o.key.slice(0, 12)}): ${o.status} - ${o.reason}`);

      const text = problems.length > 0 ? `${summary}\n${problems.join("\n")}` : summary;

      return {
        content: [{ type: "text" as const, text }],
        structuredContent: {
          newlyCached: result.newlyCached,
          alreadyCached: result.alreadyCached,
          unusable: result.unusable,
          failed: result.failed,
          requestsIssued: result.requestsIssued,
          outcomes: result.outcomes,
        },
      };
    },
  );

  server.registerTool(
    "find_routes",
    {
      title: "Find distinct routes of a target distance",
      description:
        "Group previously ingested activities of a target distance into the distinct " +
        "routes they represent, and return them as GeoJSON with a run count and " +
        "last-run date per route. Reads the cache only and makes no network requests, " +
        "so it is free to call repeatedly. Render the returned GeoJSON as a map.",
      inputSchema: {
        targetMiles: z
          .number()
          .positive()
          .describe("Target route distance in miles, for example 7."),
        toleranceMiles: z
          .number()
          .positive()
          .optional()
          .describe("How far from the target a run may be and still count. Default 0.5."),
      },
    },
    async ({ targetMiles, toleranceMiles }) => {
      const tracks = await cache.allTracks();
      const result = discoverRoutes(tracks, targetMiles, toleranceMiles ?? 0.5);
      const geojson = toGeoJson(result);

      return {
        content: [{ type: "text" as const, text: summarize(result) }],
        structuredContent: {
          state: result.state,
          routeCount: result.routes.length,
          consideredCount: result.consideredCount,
          cachedCount: result.cachedCount,
          excludedCount: result.excluded.length,
          routes: result.routes.map((route) => ({
            id: route.id,
            label: route.label,
            distanceMiles: route.distanceMiles,
            runCount: route.runCount,
            firstRunDate: route.firstRunDate,
            lastRunDate: route.lastRunDate,
          })),
          geojson,
        },
      };
    },
  );

  return server;
}
