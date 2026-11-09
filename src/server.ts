import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { ActivityCache } from "./cache/store.js";
import { loadSettings, type Settings } from "./config.js";
import { defaultFetchLimits, type FetchOptions } from "./ingest/fetch.js";
import { registerFindRoutes } from "./tools/find-routes.js";
import { registerIngestActivities } from "./tools/ingest-activities.js";

export interface ServerDeps {
  cache?: ActivityCache;
  fetchOptions?: FetchOptions;
  /** Defaults to loadSettings(process.env), which throws ConfigError on bad values. */
  settings?: Settings;
}

export const SERVER_NAME = "routefinder-mcp";
export const SERVER_VERSION = "0.1.0";

/**
 * Build the server. Every tool lives in src/tools/<name>.ts and exports its input and
 * output schemas alongside a register function; this file only wires them up.
 */
export function createServer(deps: ServerDeps = {}): McpServer {
  const settings = deps.settings ?? loadSettings();
  const cache = deps.cache ?? new ActivityCache();
  const fetchOptions: FetchOptions = {
    limits: { ...defaultFetchLimits, timeoutMs: settings.ingest.fetchTimeoutMs },
    ...deps.fetchOptions,
  };

  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        "Workflow: (1) use the COROS connector's querySportRecords to find activities in a " +
        "distance band (outdoor/trail run only, not track); (2) get each FIT download URL " +
        "with queryActivityFitFileDownloadUrls, one labelId at a time (metered: 50 files/day); " +
        "(3) pass the URLs to ingest_activities; (4) call find_routes and render its GeoJSON " +
        "as a map. find_routes is free; only step 2 spends quota.",
    },
  );

  const toolDeps = { cache, settings, fetchOptions };
  registerIngestActivities(server, toolDeps);
  registerFindRoutes(server, toolDeps);

  return server;
}
