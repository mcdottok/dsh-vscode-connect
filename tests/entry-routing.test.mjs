import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { apply } from "../src/index.mjs";

async function fixture(failBridge = false) {
  let nativeRequests = 0;
  let nativeCredentials = 0;
  const native = createServer((_request, response) => {
    nativeRequests++;
    response.writeHead(401).end();
  });
  await new Promise(resolve => native.listen(0, "127.0.0.1", resolve));
  const effects = [];
  let route;
  const ctx = {
    webServer: { host: "127.0.0.1", port: native.address().port, protocol: "http:" },
    effect: fn => { effects.push(fn()); },
    settings: { describe: () => [{ ns: "vscode-connect", revision: 0 }] },
    waterfall: (_event, _request, _response, next) => next(),
    typertGateway: { wireStream: {
      open: async function* () {},
      failure: () => ({ code: "fixture", message: "fixture", details: {} }),
    } },
    connection: {
      authenticatedUrl: () => { nativeCredentials++; return `http://127.0.0.1:${native.address().port}/?token=fixture-native`; },
      fetch: { register: value => { route = value; } },
      createSharedFetchHandler: () => {
        if (failBridge) throw new Error("fixture bridge unavailable");
        return { requestBodyMode: () => "buffered", fetch: async () => Response.json({ ok: true }) };
      },
    },
  };
  apply(ctx, { enabled: { get: () => true } });
  return {
    nativePort: native.address().port,
    copy: () => route.fetch(new Request(`http://127.0.0.1:${native.address().port}${route.path}`, { method: "POST" })),
    nativeRequests: () => nativeRequests,
    nativeCredentials: () => nativeCredentials,
    close: async () => {
      for (const cleanup of effects.reverse()) await cleanup();
      await new Promise(resolve => native.close(resolve));
    },
  };
}

test("Copy selects the bounded carrier even when the native API is available", async () => {
  const f = await fixture();
  try {
    const response = await f.copy();
    assert.equal(response.status, 200);
    const { url } = await response.json();
    const target = new URL(url);
    assert.notEqual(Number(target.port), f.nativePort);
    const login = await fetch(url, { redirect: "manual" });
    assert.equal(login.status, 303);
    assert.match(login.headers.get("set-cookie"), /^dsh-auth-vscode-/);
    await login.body?.cancel();
    assert.equal(f.nativeRequests(), 0);
    assert.equal(f.nativeCredentials(), 0);
  } finally { await f.close(); }
});

test("an unavailable bounded carrier fails visibly instead of issuing an unbounded native address", async () => {
  const f = await fixture(true);
  try {
    const response = await f.copy();
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { code: "CONNECTION_ADDRESS_UNAVAILABLE" });
    assert.equal(f.nativeRequests(), 0);
    assert.equal(f.nativeCredentials(), 0);
  } finally { await f.close(); }
});
