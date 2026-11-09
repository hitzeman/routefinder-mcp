import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { ActivityCache } from "../../src/cache/store.js";
import { loadSettings, type Settings } from "../../src/config.js";
import type { FetchFn } from "../../src/ingest/fetch.js";
import type { UrlPolicy } from "../../src/ingest/url-policy.js";
import { createServer } from "../../src/server.js";

export const TEST_POLICY: UrlPolicy = {
  allowedHosts: ["activities.test"],
  allowedPathPrefix: "/fit/",
};
export const TEST_BASE = "https://activities.test";

export interface McpHarness {
  client: Client;
  cache: ActivityCache;
  root: string;
  close: () => Promise<void>;
}

export interface HarnessOptions {
  fetchImpl?: FetchFn;
  settings?: Settings;
  /** Use this cache instead of a fresh temp directory. */
  cache?: ActivityCache;
}

/**
 * A real MCP client connected to a real server over the SDK's linked in-memory transport.
 * Nothing is mocked except the network boundary (fetchImpl) and the cache location.
 */
export async function connectHarness(options: HarnessOptions = {}): Promise<McpHarness> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "routefinder-harness-"));
  const cache = options.cache ?? new ActivityCache(root);

  const server = createServer({
    cache,
    settings: options.settings ?? loadSettings({}),
    fetchOptions: {
      policy: TEST_POLICY,
      fetchImpl:
        options.fetchImpl ??
        (() => Promise.reject(new Error("this test must not touch the network"))),
      limits: { maxBytes: 1024 * 1024, timeoutMs: 2_000, retries: 0 },
    },
  });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "contract-test", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  return {
    client,
    cache,
    root,
    close: async () => {
      await client.close();
      await server.close();
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}

/**
 * In-memory fetch double keyed by URL path. No sockets: each call resolves to a Response
 * built from the map, or 404. Records every requested path.
 */
export function mockFetch(routes: Record<string, Buffer | (() => Response | Promise<Response>)>): {
  fetchImpl: FetchFn;
  requested: string[];
} {
  const requested: string[] = [];
  const fetchImpl: FetchFn = (input) => {
    const href =
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const { pathname } = new URL(href);
    requested.push(pathname);
    const route = routes[pathname];
    if (route === undefined) return Promise.resolve(new Response("not found", { status: 404 }));
    if (typeof route === "function") return Promise.resolve(route());
    return Promise.resolve(
      new Response(new Uint8Array(route), {
        status: 200,
        headers: { "content-length": String(route.byteLength) },
      }),
    );
  };
  return { fetchImpl, requested };
}

export function textOf(result: object): string {
  const content = (result as { content?: unknown }).content as Array<{ type: string; text?: string }> | undefined;
  return content?.find((c) => c.type === "text")?.text ?? "";
}
