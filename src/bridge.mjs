import { createServer } from "node:http";
import { Readable } from "node:stream";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { RemoteStreamMuxServer, rejectRemoteStreamUpgrade } from "./vendor/remote-stream-server.mjs";

const BODY_LIMIT = 300 * 1024 * 1024;
const same = (actual, expected) => typeof actual === "string" && Buffer.byteLength(actual) === Buffer.byteLength(expected) && timingSafeEqual(Buffer.from(actual), Buffer.from(expected));

/** A separate API carrier, never a second Harness, browser shell or renderer credential bypass. */
export async function startApiBridge(connection, gateway, enabled, runRequest = (_req, _res, next) => next()) {
  const token = randomBytes(32).toString("base64url");
  const cookieName = `dsh-auth-vscode-${randomBytes(12).toString("hex")}`;
  const cookieValue = randomBytes(32).toString("base64url");
  const carrier = connection.createSharedFetchHandler("/api");
  const sockets = new Set();
  const requests = new Set();
  const releases = new Set();
  let peer;
  let stopped = false;
  let port;
  const dispose = (scope) => {
    if (scope.disposed) return;
    scope.disposed = true;
    let done;
    try { done = Promise.resolve(scope.value.dispose()).catch(() => {}); }
    catch { done = Promise.resolve(); }
    releases.add(done);
    void done.then(() => releases.delete(done));
  };
  // HTTP calls and all active mux sockets share one owner identity (Remote
  // event replies must match their stream's Peer). Idle keep-alive TCP sockets
  // do not keep Host scopes alive after the last request/stream has finished.
  const acquire = () => {
    if (!peer || peer.value.signal.aborted)
      peer = { value: connection.createPeer({ principal: { kind: "owner" } }), leases: 0, disposed: false };
    const current = peer;
    current.leases++;
    let released = false;
    return { value: current.value, release: () => {
      if (released) return;
      released = true;
      if (--current.leases === 0) {
        if (peer === current) peer = undefined;
        dispose(current);
      }
    } };
  };
  const mux = new RemoteStreamMuxServer(
    (endpoint, payload, uplink, admitted, control) => gateway.wireStream.open(endpoint, payload, uplink, admitted, control.signal),
    (error) => gateway.wireStream.failure(error), 2000, 256 * 1024,
  );
  const admitted = (req) => {
    if (stopped || !enabled()) return 403;
    const origin = `http://127.0.0.1:${port}`;
    if (req.headers.host !== `127.0.0.1:${port}` || (req.headers.origin !== undefined && req.headers.origin !== origin)) return 403;
    const cookies = req.headers.cookie?.split(";") ?? [];
    return cookies.some((value) => same(value.trim(), `${cookieName}=${cookieValue}`)) ? undefined : 401;
  };
  const reject = (res, status) => {
    res.writeHead(status, { "cache-control": "no-store", "content-type": "text/plain", "x-content-type-options": "nosniff" });
    res.end(status === 401 ? "unauthorized" : "unavailable");
  };
  const server = createServer((req, res) => {
    const abort = new AbortController();
    let lease;
    requests.add(abort);
    res.once("close", () => {
      requests.delete(abort);
      // Completion also ends the request lifetime, not just a failed socket.
      abort.abort();
      lease?.release();
    });
    void (async () => {
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
      // Check Host, Origin and the entry switch even for initial credential exchange.
      const auth = admitted(req);
      if (auth === 403) { reject(res, 403); return; }
      if (url.pathname === "/" && req.method === "GET") {
        if (url.searchParams.getAll("token").length !== 1 || [...url.searchParams.keys()].some((key) => key !== "token") || !same(url.searchParams.get("token"), token)) {
          reject(res, 401); return;
        }
        res.writeHead(303, {
          location: "./", "cache-control": "no-store", "referrer-policy": "no-referrer",
          "set-cookie": `${cookieName}=${cookieValue}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000`,
        });
        res.end(); return;
      }
      if (auth !== undefined) { reject(res, auth); return; }
      if (url.pathname === "/api" && req.method === "GET") {
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        res.end('{"available":true}'); return;
      }
      if (!url.pathname.startsWith("/api/") || url.search) { reject(res, 404); return; }
      const method = req.method ?? "GET";
      const headers = Object.fromEntries(Object.entries(req.headers).filter(([, value]) => typeof value === "string"));
      // This transport authenticates before invoking the shared registry. Native routes never see bridge credentials.
      delete headers.cookie;
      const bodyMode = carrier.requestBodyMode({ method, url });
      let body;
      if (method !== "GET" && method !== "HEAD") {
        if (bodyMode === "streaming") body = Readable.toWeb(req);
        else {
          if (Number(req.headers["content-length"]) > BODY_LIMIT) { reject(res, 413); req.destroy(); return; }
          const chunks = [];
          let size = 0;
          for await (const chunk of req) {
            size += chunk.byteLength;
            if (size > BODY_LIMIT) { reject(res, 413); req.destroy(); return; }
            chunks.push(chunk);
          }
          if (chunks.length) body = Buffer.concat(chunks);
        }
      }
      const request = new Request(url, { method, headers, ...(body === undefined ? {} : { body, duplex: "half" }), signal: abort.signal });
      const dispatch = async () => {
        abort.signal.throwIfAborted();
        if (!enabled()) { reject(res, 403); return; }
        lease = acquire();
        const response = await carrier.fetch(request, lease.value);
        if (abort.signal.aborted) { await response.body?.cancel(); return; }
        res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
        if (response.body) {
          const reader = response.body.getReader();
          const cancel = () => { void reader.cancel().catch(() => {}); };
          abort.signal.addEventListener("abort", cancel, { once: true });
          try {
            while (!abort.signal.aborted) {
              const next = await reader.read();
              if (next.done || abort.signal.aborted || res.destroyed) break;
              if (!res.write(next.value)) await new Promise((resolve) => {
                const done = () => { res.off("drain", done); res.off("close", done); resolve(); };
                res.once("drain", done); res.once("close", done);
              });
            }
          } finally { abort.signal.removeEventListener("abort", cancel); reader.releaseLock(); }
        }
        res.end();
      };
      // Retain the native request waterfall (for example maintenance admission) on the same Host.
      await runRequest(req, res, dispatch);
    })().catch(() => { if (res.destroyed) return; if (!res.headersSent) reject(res, 503); else res.destroy(); });
  });
  server.maxHeadersCount = 64;
  server.headersTimeout = 10_000;
  server.requestTimeout = 60_000;
  server.maxConnections = 128;
  server.on("connection", (socket) => { sockets.add(socket); socket.on("error", () => {}); socket.on("close", () => sockets.delete(socket)); });
  server.on("upgrade", (req, socket, head) => {
    socket.on("error", () => {});
    const auth = admitted(req);
    if (auth !== undefined) { rejectRemoteStreamUpgrade(socket, auth); return; }
    if (req.url !== "/api/remote.mux") { rejectRemoteStreamUpgrade(socket, 403); return; }
    const lease = acquire();
    // Release the Peer before waiting for a cancelled provider's iterator.
    socket.once("close", lease.release);
    try { mux.handleUpgrade(req, socket, head, lease.value); }
    catch { lease.release(); socket.destroy(); }
  });
  await new Promise((resolve, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => { server.off("error", rejectListen); resolve(); });
  });
  port = server.address().port;
  server.on("error", () => {});
  server.unref();
  const enforceSwitch = () => {
    if (!enabled()) {
      for (const abort of requests) abort.abort();
      if (peer) { const previous = peer; peer = undefined; dispose(previous); }
      for (const socket of sockets) socket.destroy();
    }
  };
  const timer = setInterval(enforceSwitch, 1000);
  timer.unref();
  return {
    address: { host: "127.0.0.1", port, protocol: "http:", launchUrl: `http://127.0.0.1:${port}/?token=${token}` },
    enforceSwitch,
    close: async () => {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      for (const abort of requests) abort.abort();
      for (const socket of sockets) socket.destroy();
      if (peer) { const previous = peer; peer = undefined; dispose(previous); }
      await Promise.all([mux.close(), new Promise((resolve) => server.close(resolve))]);
      await Promise.all(releases);
    },
  };
}

/** Test the existing carrier without sending credentials, following redirects or opening a browser. */
export async function nativeApiAvailable(server, fetcher = fetch) {
  if (server.host !== "127.0.0.1" || server.protocol !== "http:" || !Number.isSafeInteger(server.port)) return false;
  try {
    const response = await fetcher(`http://127.0.0.1:${server.port}/api`, { redirect: "error", signal: AbortSignal.timeout(750) });
    await response.body?.cancel();
    return response.status === 401;
  } catch { return false; }
}
