import { test } from "node:test";
import assert from "node:assert/strict";
import { createConnectHandler, CONNECT_PATH } from "../src/api.mjs";
import { apply, inject, Config } from "../src/index.mjs";

const server = { host: "127.0.0.1", port: 41234, protocol: "http:" };
const request = (method) =>
  new Request(`http://127.0.0.1:41234${CONNECT_PATH}`, { method });
const enabledControl = { read: () => ({ enabled: true, revision: 0 }) };
test("status never reads or returns credentials; only the explicit POST issues an address", async () => {
  let calls = 0;
  const handler = createConnectHandler(
    {
      authenticatedUrl: (base) => {
        calls++;
        return `${base}?token=fixture-only`;
      },
    },
    server,
    enabledControl,
  );
  const status = await handler(request("GET"));
  assert.deepEqual(await status.json(), {
    available: true,
    enabled: true,
    revision: 0,
  });
  assert.equal(calls, 0);
  const issued = await handler(request("POST"));
  assert.equal(issued.headers.get("cache-control"), "no-store");
  assert.deepEqual(await issued.json(), {
    url: "http://127.0.0.1:41234/?token=fixture-only",
  });
  assert.equal(calls, 1);
});
test("registration uses the authenticated owner-only exact Fetch carrier", () => {
  let registration;
  apply(
    {
      connection: {
        fetch: {
          register: (route) => {
            registration = route;
          },
        },
      },
      webServer: server,
      settings: { describe: () => [{ ns: "vscode-connect", revision: 0 }] },
    },
    { enabled: { get: () => false } },
  );
  assert.deepEqual(inject, ["connection", "webServer", "settings", "credentials", "typertGateway"]);
  assert.equal(registration.path, CONNECT_PATH);
  assert.deepEqual(registration.methods, ["GET", "POST", "PATCH"]);
  assert.equal(Config.dict.enabled.meta.volatile, true);
  assert.equal(Config({}).enabled.get(), true);
  assert.equal(Config({ enabled: false }).enabled.get(), false);
  assert.equal(Config({ enabled: true }).enabled.get(), true);
});
test("refuses public listeners, invalid ports, foreign authorization targets, and secret-bearing errors", async () => {
  const connection = {
    authenticatedUrl: () => {
      throw new Error("private-secret");
    },
  };
  for (const value of [
    { ...server, host: "0.0.0.0" },
    { ...server, port: 0 },
    { ...server, protocol: "file:" },
  ]) {
    const response = await createConnectHandler(
      connection,
      value,
      enabledControl,
    )(request("POST"));
    assert.equal(response.status, 503);
    assert.ok(!(await response.text()).includes("private-secret"));
  }
  for (const url of [
    "http://example.com/?token=private-secret",
    "http://127.0.0.1:41234/?token=one&token=two",
  ]) {
    const response = await createConnectHandler(
      { authenticatedUrl: () => url },
      server,
      enabledControl,
    )(request("POST"));
    assert.equal(response.status, 503);
    assert.ok(!(await response.text()).includes("private-secret"));
  }
  assert.equal(
    (
      await createConnectHandler(
        connection,
        server,
        enabledControl,
      )(request("POST"))
    ).status,
    503,
  );
});

test("disabled entry never issues an address; switch changes persist through native settings with revision checks", async () => {
  let enabled = false;
  let revision = 0;
  let issued = 0;
  let registration;
  const writes = [];
  apply(
    {
      connection: {
        authenticatedUrl: (base) => {
          issued++;
          return `${base}?token=fixture-only`;
        },
        fetch: {
          register: (route) => {
            registration = route;
          },
        },
      },
      webServer: server,
      settings: {
        describe: () => [{ ns: "vscode-connect", revision }],
        update: async (ns, values, expected) => {
          if (expected !== revision) throw new Error("fixture conflict");
          writes.push({ ns, values, expected });
          enabled = values.enabled;
          revision++;
        },
      },
    },
    { enabled: { get: () => enabled } },
  );
  const handler = registration.fetch;
  const patch = (body) =>
    handler(
      new Request(`http://127.0.0.1:41234${CONNECT_PATH}`, {
        method: "PATCH",
        body: JSON.stringify(body),
        headers: { "content-type": "application/json" },
      }),
    );
  assert.deepEqual(await (await handler(request("GET"))).json(), {
    available: true,
    enabled: false,
    revision: 0,
  });
  assert.equal((await handler(request("POST"))).status, 403);
  assert.equal(issued, 0);
  assert.deepEqual(await (await patch({ enabled: true, revision: 0 })).json(), {
    available: true,
    enabled: true,
    revision: 1,
  });
  assert.deepEqual(writes, [
    { ns: "vscode-connect", values: { enabled: true }, expected: 0 },
  ]);
  // With no Gateway/effect, enabling settings must not issue a native address.
  assert.equal((await handler(request("POST"))).status, 503);
  assert.equal(issued, 0);
  assert.equal((await patch({ enabled: false, revision: 0 })).status, 409);
  for (const body of [
    { enabled: "false", revision: 1 },
    { enabled: false },
    { enabled: false, revision: 1, token: "fixture-only" },
  ]) {
    assert.equal((await patch(body)).status, 400);
  }
  assert.equal(writes.length, 1);
  assert.equal((await patch({ enabled: false, revision: 1 })).status, 200);
  assert.equal((await handler(request("POST"))).status, 403);
  assert.equal(issued, 0);
});
test("cancellation and unsupported methods cannot issue credentials", async () => {
  let calls = 0;
  const handler = createConnectHandler(
    {
      authenticatedUrl: () => {
        calls++;
        return "";
      },
    },
    server,
  );
  assert.equal((await handler(request("DELETE"))).status, 405);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    handler(new Request("http://127.0.0.1/", { signal: controller.signal })),
    { name: "AbortError" },
  );
  assert.equal(calls, 0);
});


test("pairing is available only through enabled native owner Fetch requests", async () => {
  let enabled = false;
  let calls = 0;
  const handler = createConnectHandler({}, server, {
    read: () => ({ enabled, revision: 0 }),
    pair: async () => { calls++; return { version: 1, key: "fixture-paired-secret" }; },
  });
  const pair = () => handler(new Request(`http://127.0.0.1:41234${CONNECT_PATH}`, {
    method: "POST", body: JSON.stringify({ action: "pair" }),
  }));
  assert.equal((await pair()).status, 403);
  assert.equal(calls, 0);
  enabled = true;
  const response = await pair();
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), { version: 1, key: "fixture-paired-secret" });
  assert.equal(calls, 1);
  const status = await handler(request("GET"));
  assert.ok(!(await status.text()).includes("fixture-paired-secret"));
});

test("Copy uses an independently authenticated carrier and rechecks the enable switch after readiness", async () => {
  let enabled = true;
  let nativeCalls = 0;
  const target = { host: "127.0.0.1", port: 42345, protocol: "http:", launchUrl: "http://127.0.0.1:42345/?token=fixture-bridge" };
  const handler = createConnectHandler({ authenticatedUrl: () => { nativeCalls++; throw new Error("native unavailable"); } }, server, {
    read: () => ({ enabled, revision: 0 }), address: async () => target,
  });
  assert.deepEqual(await (await handler(request("POST"))).json(), { url: target.launchUrl });
  assert.equal(nativeCalls, 0);
  const switched = createConnectHandler({}, server, {
    read: () => ({ enabled, revision: 0 }), address: async () => { enabled = false; return target; },
  });
  assert.equal((await switched(request("POST"))).status, 403);
});
