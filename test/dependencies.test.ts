import test from "node:test";
import assert from "node:assert/strict";

test("MCP SDK server and stdio transport resolve from the built output", async () => {
  const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
  const { StdioServerTransport } = await import(
    "@modelcontextprotocol/sdk/server/stdio.js"
  );
  assert.equal(typeof McpServer, "function");
  assert.equal(typeof StdioServerTransport, "function");
});

test("Garmin FIT SDK exposes the decoder and stream entry points", async () => {
  const { Decoder, Stream } = await import("@garmin/fitsdk");
  assert.equal(typeof Decoder, "function");
  assert.equal(typeof Stream.fromBuffer, "function");
  assert.equal(typeof Decoder.isFIT, "function");
});

test("schema validator resolves and validates", async () => {
  const { z } = await import("zod");
  assert.equal(z.string().parse("ok"), "ok");
});
