import type { ActivityCache } from "../cache/store.js";
import type { Settings } from "../config.js";
import type { FetchOptions } from "../ingest/fetch.js";

/** Everything a tool handler needs, injected so tests can substitute each piece. */
export interface ToolDeps {
  cache: ActivityCache;
  settings: Settings;
  fetchOptions: FetchOptions;
}
