// Opt-in source-only soak: real Gateway 0.2.1-rc.2, isolated Cordis scopes,
// synthetic events, loopback sockets. No DSH process/Profile/session is used.
import assert from "node:assert/strict";
import { once } from "node:events";
import { Readable } from "node:stream";
import { setImmediate as nextTurn, setTimeout as delay } from "node:timers/promises";
import { Context } from "@deepseek-ai/cordis";
import { TypertGatewayService } from "@deepseek-ai/dsh-api-gateway";
import { REMOTE_EVENT_STREAM_ENDPOINT, REMOTE_EVENT_STREAM_PAYLOAD } from "@deepseek-ai/dsh-api-gateway/stream-protocol";
import WebSocket from "ws";
import { startApiBridge } from "../src/bridge.mjs";

assert.equal(typeof globalThis.gc, "function", "Run with node --expose-gc scripts/memory-check.mjs");
const count = Number(process.argv[2] ?? 200);
assert.ok(Number.isSafeInteger(count) && count >= 20 && count <= 2000, "Cycle count must be 20–2000");
const root = new Context();
const gateway = new TypertGatewayService(root, {});
const source = new Readable({ objectMode: true, read() {} });
const stopEvents = gateway.registerRemoteEvents(signal => {
  signal.addEventListener("abort", () => source.push(null), { once: true });
  return source;
}, { home: "fixture-only" });
const peers = new Set();
const PeerPlugin = () => {};
let created = 0;
let disposed = 0;
const bridge = await startApiBridge({
  createSharedFetchHandler: () => ({ requestBodyMode: () => "buffered", fetch: async () => Response.json({ ok: true }) }),
  createPeer: ({ principal }) => {
    const fiber = root.plugin(PeerPlugin);
    const lifetime = new AbortController();
    const peer = { ctx: fiber.ctx, signal: lifetime.signal, principal, interactions: "answer", dispose: async () => {
      disposed++; lifetime.abort(); peers.delete(peer); await fiber.dispose();
    } };
    created++; peers.add(peer); return peer;
  },
}, gateway, () => true);
const response = await fetch(bridge.address.launchUrl, { redirect: "manual" });
const cookie = response.headers.get("set-cookie").split(";", 1)[0];
await response.body?.cancel();
const base = new URL(bridge.address.launchUrl).origin;
const samples = [];
const sample = async cycle => {
  await nextTurn(); globalThis.gc(); await nextTurn(); globalThis.gc();
  samples.push({ cycle, heapMiB: +(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2), peers: peers.size });
};
async function cycle(index) {
  const socket = new WebSocket(base.replace("http:", "ws:") + "/api/remote.mux", { headers: { Cookie: cookie } });
  const frames = [];
  let waiter;
  socket.on("message", data => { frames.push(JSON.parse(data.toString())); waiter?.(); });
  const read = async () => {
    while (!frames.length) await new Promise(resolve => { waiter = resolve; });
    waiter = undefined;
    return frames.shift();
  };
  try {
    await once(socket, "open");
    socket.send(JSON.stringify({ type: "open", streamId: "events", endpoint: REMOTE_EVENT_STREAM_ENDPOINT, payload: REMOTE_EVENT_STREAM_PAYLOAD }));
    assert.equal((await read()).value.type, "ready");
    for (let i = 0; i < 4; i++) {
      source.push({ event: "fixture/event", args: [{ index, i, text: `${index}:${i}:` + "x".repeat(64 * 1024) }] });
      assert.equal((await read()).value.event, "fixture/event");
    }
    const closed = once(socket, "close"); socket.close(); await closed;
    for (let i = 0; i < 200 && (peers.size || gateway.hasLiveClient()); i++) await delay(2);
    assert.equal(peers.size, 0, "closed clients must release every Peer scope");
    assert.equal(gateway.hasLiveClient(), false, "Gateway event subscription must end with its socket");
  } finally { socket.terminate(); }
}
try {
  for (let i = 0; i < 20; i++) await cycle(i);
  await sample(0);
  for (let i = 1; i <= count; i++) {
    await cycle(i + 20);
    if (i % Math.ceil(count / 5) === 0 || i === count) await sample(i);
  }
  console.log(JSON.stringify({ cycles: count, warmup: 20, created, disposed, samples }, null, 2));
} finally {
  await bridge.close(); await stopEvents(); await root.fiber.dispose();
}
