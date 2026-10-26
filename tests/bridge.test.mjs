import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import WebSocket from "ws";
import { request as httpRequest } from "node:http";
import { startApiBridge, nativeApiAvailable } from "../src/bridge.mjs";

function fixture() {
  let enabled = true;
  let disposed = 0;
  const calls = [];
  const streams = [];
  const peers = [];
  const connection = {
    createSharedFetchHandler: () => ({
      requestBodyMode: () => "buffered",
      fetch: async (request, peer) => {
        calls.push({ url: request.url, cookie: request.headers.get("cookie"), principal: peer.principal });
        if (new URL(request.url).pathname === "/api/wait") {
          await new Promise(resolve => request.signal.addEventListener("abort", resolve, { once: true }));
          return new Response(null, { status: 204 });
        }
        return Response.json({ echo: await request.json() });
      },
    }),
    createPeer: ({ principal }) => {
      const lifetime = new AbortController();
      const effects = new Set();
      const peer = {
        principal, signal: lifetime.signal,
        ctx: { effect: (fn) => { const close = fn(); effects.add(close); return () => { effects.delete(close); close(); }; } },
        dispose: async () => { disposed++; lifetime.abort(); for (const close of effects) close(); effects.clear(); },
      };
      peers.push(peer);
      return peer;
    },
  };
  const gateway = { wireStream: {
    async *open(endpoint, payload, uplink, peer, signal) {
      streams.push({ endpoint, peer, signal });
      if (endpoint === "fixture/fail") throw new Error("fixture failure");
      if (endpoint === "fixture/echo") {
        for await (const item of uplink) yield item;
      } else {
        yield payload;
        await new Promise(resolve => signal.addEventListener("abort", resolve, { once: true }));
      }
    },
    failure: () => ({ code: "fixture/failure", message: "stream failed", details: {} }),
  } };
  return { connection, gateway, calls, streams, peers, enabled: () => enabled, disable: () => { enabled = false; }, disposed: () => disposed };
}

async function login(bridge) {
  const url = new URL(bridge.address.launchUrl);
  const response = await fetch(url, { redirect: "manual" });
  assert.equal(response.status, 303);
  const cookie = response.headers.get("set-cookie").split(";", 1)[0];
  assert.match(cookie, /^dsh-auth-vscode-[a-f0-9]+=[A-Za-z0-9_-]+$/);
  await response.body?.cancel();
  return { base: url.origin, cookie };
}

function websocket(base, cookie) {
  return new WebSocket(base.replace("http:", "ws:") + "/api/remote.mux", { headers: { Cookie: cookie } });
}
function rawStatus(url, headers) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, { headers, agent: false }, response => { response.resume(); resolve(response.statusCode); });
    request.on("error", reject); request.end();
  });
}
function inbox(socket) {
  const messages = [];
  const waiting = [];
  socket.on("message", data => { const value = JSON.parse(data.toString()); const next = waiting.shift(); if (next) next(value); else messages.push(value); });
  return () => messages.length ? Promise.resolve(messages.shift()) : new Promise(resolve => waiting.push(resolve));
}

test("independent API authenticates owners and enforces Host/Origin without desktop renderer credentials", async () => {
  const f = fixture();
  let waterfall = 0;
  const bridge = await startApiBridge(f.connection, f.gateway, f.enabled, async (_req, _res, next) => { waterfall++; await next(); });
  try {
    const { base, cookie } = await login(bridge);
    assert.equal((await fetch(base + "/api")).status, 401);
    assert.equal((await fetch(base + "/?token=wrong", { redirect: "manual" })).status, 401);
    assert.equal((await fetch(bridge.address.launchUrl, { redirect: "manual", headers: { Origin: "https://foreign.example" } })).status, 403);
    assert.equal(await rawStatus(base + "/api", { Cookie: cookie, Host: "foreign.example" }), 403);
    const response = await fetch(base + "/api/fixture.call", { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: '{"value":"fixture"}' });
    assert.deepEqual(await response.json(), { echo: { value: "fixture" } });
    assert.equal(f.calls[0].cookie, null);
    assert.deepEqual(f.calls[0].principal, { kind: "owner" });
    assert.equal(waterfall, 1);
    assert.equal((await fetch(base + "/index.html", { headers: { Cookie: cookie } })).status, 404);
    f.disable(); bridge.enforceSwitch();
    assert.equal(await rawStatus(base + "/api", { Cookie: cookie }), 403);
    assert.ok(f.disposed() >= 1);
  } finally { await bridge.close(); }
});

test("shared Gateway mux carries concurrent streams, uplink/end, cancellation and failures", async () => {
  const f = fixture();
  const bridge = await startApiBridge(f.connection, f.gateway, f.enabled);
  try {
    const { base, cookie } = await login(bridge);
    const socket = websocket(base, cookie);
    const next = inbox(socket);
    await once(socket, "open");
    socket.send(JSON.stringify({ type: "open", streamId: "watch", endpoint: "fixture/watch", payload: { marker: "fixture" } }));
    assert.deepEqual(await next(), { type: "item", streamId: "watch", value: { marker: "fixture" } });
    socket.send(JSON.stringify({ type: "open", streamId: "echo", endpoint: "fixture/echo", payload: {} }));
    socket.send(JSON.stringify({ type: "item", streamId: "echo", value: { text: "fixture" } }));
    socket.send(JSON.stringify({ type: "end", streamId: "echo" }));
    assert.deepEqual(await next(), { type: "item", streamId: "echo", value: { text: "fixture" } });
    assert.deepEqual(await next(), { type: "end", streamId: "echo" });
    socket.send(JSON.stringify({ type: "open", streamId: "fail", endpoint: "fixture/fail", payload: {} }));
    assert.equal((await next()).error.code, "fixture/failure");
    socket.send(JSON.stringify({ type: "cancel", streamId: "watch" }));
    await new Promise(resolve => f.streams[0].signal.addEventListener("abort", resolve, { once: true }));
    assert.equal(f.streams[0].signal.aborted, true);
    const closed = once(socket, "close");
    f.disable(); bridge.enforceSwitch();
    await closed;
  } finally { await bridge.close(); }
});

test("restart creates a fresh endpoint credential; disabled native API selects the bridge", async () => {
  const f = fixture();
  const first = await startApiBridge(f.connection, f.gateway, f.enabled);
  const old = first.address.launchUrl;
  await first.close();
  const second = await startApiBridge(f.connection, f.gateway, f.enabled);
  try {
    assert.notEqual(new URL(old).searchParams.get("token"), new URL(second.address.launchUrl).searchParams.get("token"));
    const server = { host: "127.0.0.1", port: 41234, protocol: "http:" };
    const requests = [];
    assert.equal(await nativeApiAvailable(server, async (url, options) => { requests.push(options); return new Response(null, { status: 401 }); }), true);
    assert.equal(await nativeApiAvailable(server, async () => new Response(null, { status: 403 })), false);
    assert.equal(await nativeApiAvailable({ ...server, host: "remote.example" }), false);
    assert.equal(requests[0].headers, undefined);
    assert.equal(requests[0].redirect, "error");
  } finally { await second.close(); }
});
