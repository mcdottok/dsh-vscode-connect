import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const React = require("react");
const { createRoot } = require("react-dom/client");
const { JSDOM } = require("jsdom");

test("uses General and bundle detail slots; copies only on a click and never renders the token", async () => {
  const dom = new JSDOM(
    '<!doctype html><html><head></head><body><div id="root"></div></body></html>',
    { url: "https://fixture.local/" },
  );
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const previousAct = globalThis.IS_REACT_ACT_ENVIRONMENT;
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  let exports;
  const requests = [];
  const copied = [];
  const registrations = [];
  const cleanups = [];
  const dictionaries = new Map();
  let enabled = false;
  let revision = 0;
  dom.window.__ModuleLoader__ = {
    load: ({ factory }) => {
      exports = factory(require);
    },
  };
  vm.runInNewContext(
    await readFile(new URL("../dist/client.js", import.meta.url), "utf8"),
    {
      window: dom.window,
      Event: dom.window.Event,
      document: dom.window.document,
      navigator: {
        clipboard: {
          writeText: async (value) => {
            copied.push(value);
          },
        },
      },
      URL,
      AbortController,
      fetch: async (_path, options) => {
        requests.push(options.method);
        if (options.method === "PATCH") {
          const body = JSON.parse(options.body);
          assert.equal(body.revision, revision);
          enabled = body.enabled;
          revision++;
        }
        return Response.json(
          options.method !== "POST"
            ? { available: true, enabled, revision }
            : { url: "http://127.0.0.1:41234/?token=fixture-secret" },
        );
      },
    },
  );
  exports.apply({
    effect: (callback) => {
      cleanups.push(callback());
    },
    locale: {
      register: (ns, value) => {
        dictionaries.set(ns, value);
        return () => {};
      },
    },
    slots: {
      inject: (_slot, register) => {
        register();
      },
      register: (options, component) => {
        registrations.push({ options, component });
        return () => {};
      },
    },
  });
  assert.deepEqual(
    registrations.map(({ options }) => options.name),
    ["settings.general.item", "plugins.bundle.config"],
  );
  assert.equal(registrations[1].options.key, "dsh-vscode-connect");
  const root = createRoot(dom.window.document.querySelector("#root"));
  try {
    await React.act(async () => {
      root.render(
        React.createElement(registrations[1].component, {
          t: (key) => dictionaries.get("vscodeConnect").zh[key],
        }),
      );
    });
    assert.deepEqual(requests, ["GET"]);
    const toggle = dom.window.document.querySelector('[role="switch"]');
    const copy = dom.window.document.querySelector(".vsc-connect__button");
    assert.equal(toggle.getAttribute("aria-checked"), "false");
    assert.equal(copy.disabled, true);
    assert.match(dom.window.document.body.textContent, /连接入口已关闭/);
    await React.act(async () => {
      copy.click();
    });
    assert.deepEqual(requests, ["GET"]);
    await React.act(async () => {
      toggle.click();
    });
    assert.deepEqual(requests, ["GET", "PATCH", "GET"]);
    assert.equal(toggle.getAttribute("aria-checked"), "true");
    assert.equal(copy.disabled, false);
    await React.act(async () => {
      copy.click();
    });
    assert.deepEqual(requests, ["GET", "PATCH", "GET", "POST"]);
    assert.equal(copied[0], "http://127.0.0.1:41234/?token=fixture-secret");
    assert.ok(
      !dom.window.document.documentElement.innerHTML.includes("fixture-secret"),
    );
    assert.match(dom.window.document.body.textContent, /已复制/);
    await React.act(async () => {
      toggle.click();
    });
    assert.equal(toggle.getAttribute("aria-checked"), "false");
    assert.equal(copy.disabled, true);
  } finally {
    await React.act(async () => root.unmount());
    for (const cleanup of cleanups.reverse()) cleanup?.();
    dom.window.close();
    globalThis.window = previousWindow;
    globalThis.document = previousDocument;
    globalThis.IS_REACT_ACT_ENVIRONMENT = previousAct;
  }
});

test("exports package metadata for Desktop's manifest fallback and starts the client without slot-owner dependencies", async () => {
  const metadataPath = require.resolve("dsh-vscode-connect/package.json");
  const manifest = JSON.parse(await readFile(metadataPath, "utf8"));
  assert.equal(manifest.name, "dsh-vscode-connect");
  assert.equal(manifest.dsh.client.immediately, true);
  assert.deepEqual(manifest.dsh.client.inject, [
    "@deepseek-ai/dsh-client-locale",
    "@deepseek-ai/dsh-client-ui-renderer",
  ]);
});
