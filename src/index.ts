#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { ConfigError, loadSettings } from "./config.js";
import { logError, logInfo } from "./log.js";
import { createServer } from "./server.js";

/**
 * stdio entry point.
 *
 * Single user, single machine, launched by a local MCP client. Nothing listens on a
 * socket, so there is no transport-level auth story to get wrong. All diagnostics go to
 * stderr; stdout belongs to the JSON-RPC framing.
 */
async function main(): Promise<void> {
  // Validate configuration before connecting, so a bad env var fails loudly at launch
  // instead of producing silently wrong groupings later.
  const settings = loadSettings();
  const server = createServer({ settings });
  await server.connect(new StdioServerTransport());
  logInfo("routefinder-mcp ready on stdio");
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError) {
    logError(error.message);
  } else {
    logError(error instanceof Error ? (error.stack ?? error.message) : String(error));
  }
  process.exit(1);
});
