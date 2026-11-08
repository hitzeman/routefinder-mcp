import http from "node:http";
import type { AddressInfo } from "node:net";

export interface FixtureServer {
  /** Host:port of the running server. */
  host: string;
  /** Request counts keyed by path, so tests can assert a path was never requested. */
  hits: Map<string, number>;
  /**
   * A fetch implementation for the production code under test.
   *
   * The URL policy requires HTTPS, and standing up a trusted TLS listener in-process
   * would need a generated certificate. This wrapper keeps the policy intact by letting
   * the test pass an `https://` URL while the bytes travel over the local HTTP socket.
   * Everything the fetch layer actually exercises - status handling, header parsing,
   * streaming, the size cap, the timeout - runs against a real server and a real socket.
   */
  fetchImpl: typeof globalThis.fetch;
  /** Number of times the injected fetch was invoked at all. */
  callCount: () => number;
  close: () => Promise<void>;
}

export async function startFixtureServer(
  fitBytes: Buffer,
): Promise<FixtureServer> {
  const hits = new Map<string, number>();
  let calls = 0;

  const server = http.createServer((req, res) => {
    // Route on the pathname, as a real server does: the caller may append a query
    // string or fragment, and that must not change which activity is served.
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    hits.set(path, (hits.get(path) ?? 0) + 1);

    switch (path) {
      case "/fit/good.fit": {
        res.writeHead(200, {
          "content-type": "application/octet-stream",
          "content-length": String(fitBytes.byteLength),
        });
        res.end(fitBytes);
        return;
      }

      case "/fit/oversized-declared.fit": {
        const body = Buffer.alloc(4096, 1);
        res.writeHead(200, { "content-length": String(body.byteLength) });
        res.end(body);
        return;
      }

      case "/fit/oversized-chunked.fit": {
        // No content-length, so only the streaming cap can stop this.
        res.writeHead(200, { "transfer-encoding": "chunked" });
        for (let i = 0; i < 8; i += 1) res.write(Buffer.alloc(512, 2));
        res.end();
        return;
      }

      case "/fit/slow.fit": {
        res.writeHead(200, { "content-type": "application/octet-stream" });
        res.write(Buffer.alloc(8, 3));
        // Never finishes within any sane test timeout.
        setTimeout(() => res.end(), 60_000).unref();
        return;
      }

      case "/fit/redirect.fit": {
        res.writeHead(302, { location: "/fit/redirect-target.fit" });
        res.end();
        return;
      }

      case "/fit/redirect-target.fit": {
        res.writeHead(200, { "content-length": String(fitBytes.byteLength) });
        res.end(fitBytes);
        return;
      }

      default: {
        res.writeHead(404);
        res.end("no such activity");
        return;
      }
    }
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const host = `127.0.0.1:${port}`;

  const fetchImpl: typeof globalThis.fetch = (input, init) => {
    calls += 1;
    const original = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    const local = new URL(original.href);
    local.protocol = "http:";
    local.host = host;
    return globalThis.fetch(local, init);
  };

  return {
    host,
    hits,
    fetchImpl,
    callCount: () => calls,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}
