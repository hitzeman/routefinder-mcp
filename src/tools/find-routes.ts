import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { discoverRoutes } from "../routes/discover.js";
import { summarize, toGeoJson } from "../routes/geojson.js";
import type { ToolDeps } from "./deps.js";
import { unexpectedError } from "./errors.js";

export const FIND_ROUTES = "find_routes";

export const MIN_TARGET_MILES = 0.5;
export const MAX_TARGET_MILES = 100;
export const MAX_TOLERANCE_MILES = 5;
export const DEFAULT_TOLERANCE_MILES = 0.5;

export const findRoutesInputSchema = z.strictObject({
  targetMiles: z
    .number()
    .min(MIN_TARGET_MILES)
    .max(MAX_TARGET_MILES)
    .describe(
      `Target route distance in miles (${MIN_TARGET_MILES}-${MAX_TARGET_MILES}), e.g. 7. ` +
        "Convert from kilometres before calling (1 km = 0.621 mi).",
    ),
  toleranceMiles: z
    .number()
    .positive()
    .max(MAX_TOLERANCE_MILES)
    .default(DEFAULT_TOLERANCE_MILES)
    .describe(
      `How far from targetMiles a run may be and still count, in miles (max ${MAX_TOLERANCE_MILES}). ` +
        `Default ${DEFAULT_TOLERANCE_MILES}.`,
    ),
});

const coordinate = z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)]);

export const routeSummarySchema = z.object({
  id: z.string(),
  label: z.string().describe('Display label in result order: "Route A", "Route B", ...'),
  distanceMiles: z.number(),
  runCount: z.number().int().min(1),
  firstRunDate: z.string(),
  lastRunDate: z.string(),
});

export const findRoutesOutputSchema = z.object({
  state: z
    .enum(["ok", "empty-cache", "no-match"])
    .describe("empty-cache: call ingest_activities first. no-match: nothing cached is in range."),
  routeCount: z.number().int().min(0),
  consideredCount: z.number().int().min(0),
  cachedCount: z.number().int().min(0),
  excludedCount: z
    .number()
    .int()
    .min(0)
    .describe("In-range activities dropped as laps of a small circuit (e.g. a track)."),
  unreadableCount: z
    .number()
    .int()
    .min(0)
    .describe("Cached track files that failed validation. Re-ingesting rebuilds them for free."),
  routes: z.array(routeSummarySchema),
  geojson: z.object({
    type: z.literal("FeatureCollection"),
    features: z.array(
      z.object({
        type: z.literal("Feature"),
        geometry: z.object({
          type: z.literal("LineString"),
          coordinates: z.array(coordinate),
        }),
        properties: routeSummarySchema,
      }),
    ),
  }),
});

export type FindRoutesOutput = z.infer<typeof findRoutesOutputSchema>;

export function registerFindRoutes(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    FIND_ROUTES,
    {
      title: "Find distinct routes of a target distance",
      description:
        "Group previously ingested activities of a target distance into the distinct routes " +
        "they represent. Returns per-route run count, median distance and first/last run " +
        "dates, plus a GeoJSON FeatureCollection with one simplified LineString per route " +
        "([longitude, latitude] order). Reads the local cache only and makes no network " +
        "requests, so it is free to call repeatedly with different distances. Render the " +
        "GeoJSON as a map with one colour per route; routes usually share a start point.",
      inputSchema: findRoutesInputSchema,
      outputSchema: findRoutesOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ targetMiles, toleranceMiles }) => {
      try {
        const { tracks, unreadable } = await deps.cache.loadTracks();
        const result = discoverRoutes(tracks, targetMiles, toleranceMiles, deps.settings.discover);
        const geojson = toGeoJson(result);

        const structured: FindRoutesOutput = {
          state: result.state,
          routeCount: result.routes.length,
          consideredCount: result.consideredCount,
          cachedCount: result.cachedCount,
          excludedCount: result.excluded.length,
          unreadableCount: unreadable.length,
          routes: result.routes.map((route) => ({
            id: route.id,
            label: route.label,
            distanceMiles: route.distanceMiles,
            runCount: route.runCount,
            firstRunDate: route.firstRunDate,
            lastRunDate: route.lastRunDate,
          })),
          geojson,
        };

        const note =
          unreadable.length > 0
            ? `\n${unreadable.length} cached track file(s) were unreadable and skipped; ` +
              "re-ingesting those activities rebuilds them without new requests."
            : "";

        return {
          content: [{ type: "text" as const, text: summarize(result) + note }],
          structuredContent: { ...structured },
        };
      } catch (error) {
        return unexpectedError(FIND_ROUTES, error);
      }
    },
  );
}
