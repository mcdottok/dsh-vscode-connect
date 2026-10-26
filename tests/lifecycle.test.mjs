import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import WebSocket from "ws";
import { setTimeout as delay } from "node:timers/promises";
import { startApiBridge } from "../src/bridge.mjs";
import { RemoteStreamMuxServer } from "../src/vendor/remote-stream-server.mjs";

async function eventually(check) {
  for (let i = 0; i < 200; i++) { if (check()) return; await delay(5); }
  assert.ok(check(), "resources were not released");
}

function peerFixture() {
  const active = new Set();
  let created = 0;
  let disposed = 0;
  return {
    active, created: () => created, disposed: () => disposed,
    createPeer: ({ principal }) => {
      created++;
      const controller = new AbortController();
      const effects = new Set();
      const peer = {
        principal, signal: controller.signal,
        ctx: { effect: fn => {
          const cleanup = fn(); effects.add(cleanup);
          return () => { if (effects.delete(cleanup)) cleanup(); };
        } },
        dispose: async () => {
          disposed++;
          controller.abort(); active.delete(peer);
          for (const cleanup of effects) cleanup();
          effects.clear();
        },
      };
      active.add(peer);
      return peer;
    },
  };
}

async function authenticate(bridge) {
  const response = await fetch(bridge.address.launchUrl, { redirect: "manual" });
  const cookie = response.headers.get("set-cookie").split(";", 1)[0];
  await response.body?.cancel();
  return { base: new URL(bridge.address.launchUrl).origin, cookie };
}

async function connect(base, cookie) {
  const socket = new WebSocket(base.replace("http:", "ws:") + "/api/remote.mux", { headers: { Cookie: cookie } });
  await once(socket, "open");
  return socket;
}
async function disconnect(socket) {
  const closed = once(socket, "close"); socket.close(); await closed;
}

test("finished HTTP requests abort their lifetimes; concurrent sockets share and release only their own Peer", async () => {
  const peers = peerFixture();
  const liveRequests = new Set();
  let requestPeer;
  const bridge = await startApiBridge({
    createPeer: peers.createPeer,
    createSharedFetchHandler: () => ({ requestBodyMode: () => "buffered", fetch: async (request, peer) => {
      requestPeer = peer;
      liveRequests.add(request.signal);
      request.signal.addEventListener("abort", () => liveRequests.delete(request.signal), { once: true });
      return Response.json({ ok: true });
    } }),
  }, { wireStream: { open: async function* () {}, failure: () => ({ code: "fixture", message: "fixture", details: {} }) } }, () => true);
  const sockets = [];
  try {
    const { base, cookie } = await authenticate(bridge);
    assert.equal(peers.created(), 0, "credential exchange alone should not allocate a Host Peer");
    const first = await connect(base, cookie); sockets.push(first);
    const second = await connect(base, cookie); sockets.push(second);
    assert.equal(peers.active.size, 1);
    await (await fetch(base + "/api/fixture", { headers: { Cookie: cookie } })).json();
    await eventually(() => liveRequests.size === 0);
    assert.ok(peers.active.has(requestPeer), "HTTP result and forwarded events must use the same Peer");
    await disconnect(first);
    assert.equal(peers.active.size, 1, "one client leaving must not disconnect another");
    await disconnect(second);
    await eventually(() => peers.active.size === 0);
    assert.equal(peers.disposed(), 1);
    await (await fetch(base + "/api/fixture", { headers: { Cookie: cookie } })).json();
    await eventually(() => peers.active.size === 0 && liveRequests.size === 0);
    assert.equal(peers.created(), 2);
    assert.equal(peers.disposed(), 2);
  } finally {
    for (const socket of sockets) socket.terminate();
    await bridge.close();
  }
});

async function muxFixture(open, limits) {
  const peers = peerFixture();
  const peer = peers.createPeer({ principal: { kind: "owner" } });
  const mux = new RemoteStreamMuxServer(open, () => ({ code: "fixture", message: "fixture", details: {} }), 60_000, 262_144, limits);
  const server = createServer();
  server.on("upgrade", (request, socket, head) => mux.handleUpgrade(request, socket, head, peer));
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const socket = await connect(`http://127.0.0.1:${server.address().port}`, "");
  return { mux, socket, close: async () => {
    socket.terminate(); await mux.close(); await peer.dispose();
    await new Promise(resolve => server.close(resolve));
  } };
}

test("disabling a busy entry disposes its Peer once and late releases cannot dispose a replacement", async () => {
  const peers = peerFixture();
  let enabled = true;
  const bridge = await startApiBridge({
    createPeer: peers.createPeer,
    createSharedFetchHandler: () => ({ requestBodyMode: () => "buffered", fetch: async () => Response.json({ ok: true }) }),
  }, { wireStream: { open: async function* () {}, failure: () => ({ code: "fixture", message: "fixture", details: {} }) } }, () => enabled);
  const sockets = [];
  try {
    const { base, cookie } = await authenticate(bridge);
    const first = await connect(base, cookie); sockets.push(first);
    const oldClosed = once(first, "close");
    enabled = false; bridge.enforceSwitch();
    enabled = true;
    const second = await connect(base, cookie); sockets.push(second);
    await oldClosed;
    assert.equal(peers.disposed(), 1);
    assert.equal(peers.active.size, 1);
    await disconnect(second);
    await eventually(() => peers.active.size === 0);
    assert.equal(peers.created(), 2);
    assert.equal(peers.disposed(), 2);
  } finally { for (const socket of sockets) socket.terminate(); await bridge.close(); }
});

test("socket cleanup does not wait for a stalled opener, and returns its late iterator", async () => {
  const opening = Promise.withResolvers();
  let started = false;
  let returned = 0;
  const fixture = await muxFixture(() => { started = true; return opening.promise; });
  const source = { [Symbol.asyncIterator]() { return this; }, next: async () => ({ done: true }), return: async () => { returned++; return { done: true }; } };
  try {
    fixture.socket.send(JSON.stringify({ type: "open", streamId: "late", endpoint: "fixture/late", payload: {} }));
    await eventually(() => started);
    await disconnect(fixture.socket);
    await eventually(() => fixture.mux.connections.size === 0);
    opening.resolve(source);
    await eventually(() => returned === 1);
  } finally { opening.resolve(source); await fixture.close(); }
});

test("cancelling a blocked read frees its stream slot and socket without waiting for iterator.return", async () => {
  const read = Promise.withResolvers();
  const returning = Promise.withResolvers();
  let waiting = 0;
  let returns = 0;
  let aborted;
  const fixture = await muxFixture(async (_endpoint, _payload, _uplink, _peer, control) => {
    aborted = control.signal;
    return { [Symbol.asyncIterator]() { return this; }, next: () => { waiting++; return read.promise; }, return: () => { returns++; return returning.promise; } };
  });
  try {
    fixture.socket.send(JSON.stringify({ type: "open", streamId: "blocked", endpoint: "fixture/blocked", payload: {} }));
    await eventually(() => waiting === 1);
    fixture.socket.send(JSON.stringify({ type: "cancel", streamId: "blocked" }));
    await eventually(() => returns === 1);
    assert.equal(aborted.aborted, true);
    await disconnect(fixture.socket);
    await eventually(() => fixture.mux.connections.size === 0);
  } finally { read.resolve({ done: true }); returning.resolve({ done: true }); await fixture.close(); }
});

test("a stalled downlink closes even when no send callback arrives", async () => {
  const fixture = await muxFixture(async function* () { yield { value: "fixture" }; }, { timeoutMs: 30 });
  const callbacks = [];
  const physical = [...fixture.mux.server.clients][0];
  const originalSend = physical.send;
  try {
    physical.send = (_text, callback) => { callbacks.push(callback); }; // Owned socket: never drains.
    const closed = once(fixture.socket, "close", { signal: AbortSignal.timeout(1000) });
    fixture.socket.send(JSON.stringify({ type: "open", streamId: "stalled", endpoint: "fixture/stalled", payload: {} }));
    await closed;
    await eventually(() => fixture.mux.connections.size === 0);
  } finally {
    physical.send = originalSend;
    for (const callback of callbacks) callback(new Error("fixture cleanup"));
    await fixture.close();
  }
});

test("concurrent downlinks cannot queue unlimited bytes behind a slow socket", async () => {
  const fixture = await muxFixture(async function* () { yield { text: "x".repeat(400) }; }, { maxPendingBytes: 1024, timeoutMs: 10_000 });
  const callbacks = [];
  const physical = [...fixture.mux.server.clients][0];
  const originalSend = physical.send;
  try {
    physical.send = (_text, callback) => { callbacks.push(callback); };
    const closed = once(fixture.socket, "close", { signal: AbortSignal.timeout(1000) });
    for (let i = 0; i < 4; i++) fixture.socket.send(JSON.stringify({ type: "open", streamId: `buffer-${i}`, endpoint: "fixture/buffer", payload: {} }));
    await closed;
    await eventually(() => fixture.mux.connections.size === 0);
  } finally {
    physical.send = originalSend;
    for (const callback of callbacks) callback(new Error("fixture cleanup"));
    await fixture.close();
  }
});
