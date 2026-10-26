import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { startAutomaticDiscovery, protectBootstrap } from "../src/automatic-discovery.mjs";

test("manual enablement publishes only a protected bootstrap; disable and disposal withdraw it", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "dsh-auto-fixture-"));
  let enabled = false;
  let protections = 0;
  const fixtureKey = "K".repeat(43);
  const publisher = startAutomaticDiscovery(fixtureKey, () => enabled, {
    directory,
    protect: async text => { protections++; assert.equal(JSON.parse(text).key, fixtureKey); return "fixture-wrapped-credential"; },
  });
  try {
    await publisher.refresh();
    assert.deepEqual(await readdir(directory), []);
    assert.equal(protections, 0);
    enabled = true;
    await publisher.refresh();
    const files = await readdir(directory);
    assert.equal(files.length, 1);
    const text = await readFile(path.join(directory, files[0]), "utf8");
    assert.ok(!text.includes(fixtureKey));
    const record = JSON.parse(text);
    assert.equal(record.pid, process.pid);
    assert.equal(record.version, 1);
    assert.equal(record.protectedKey, "fixture-wrapped-credential");
    await publisher.refresh();
    assert.equal(protections, 1);
    enabled = false;
    await publisher.refresh();
    assert.deepEqual(await readdir(directory), []);
    enabled = true;
    await publisher.refresh();
    await publisher.close();
    assert.deepEqual(await readdir(directory), []);
    await publisher.refresh();
    assert.deepEqual(await readdir(directory), []);
  } finally { await publisher.close(); await rm(directory, { recursive: true, force: true }); }
});

test("late protection cannot publish after the person disables the entry", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "dsh-auto-fixture-"));
  let enabled = true;
  let finish;
  const pending = new Promise(resolve => { finish = resolve; });
  const publisher = startAutomaticDiscovery("K".repeat(43), () => enabled, { directory, protect: () => pending });
  try {
    const writing = publisher.refresh();
    enabled = false;
    finish("fixture-wrapped-credential");
    await writing;
    assert.deepEqual(await readdir(directory), []);
  } finally { await publisher.close(); await rm(directory, { recursive: true, force: true }); }
});

test("slow bootstrap protection coalesces thousands of refresh requests instead of retaining a promise chain", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "dsh-auto-slow-"));
  const protecting = Promise.withResolvers();
  let calls = 0;
  const publisher = startAutomaticDiscovery("K".repeat(43), () => true, {
    directory, protect: () => { calls++; return protecting.promise; },
  });
  try {
    const pending = publisher.refresh();
    for (let i = 0; i < 5_000; i++) assert.equal(publisher.refresh(), pending);
    protecting.resolve("fixture-wrapped-credential");
    await pending;
    assert.equal(calls, 1);
    assert.equal((await readdir(directory)).length, 1);
  } finally {
    protecting.resolve("fixture-wrapped-credential");
    await publisher.close(); await rm(directory, { recursive: true, force: true });
  }
});

test("Windows bootstrap uses current-account encryption rather than a plaintext key", { skip: process.platform !== "win32" }, async () => {
  const text = JSON.stringify({ version: 1, key: "fixture-only-never-a-live-grant" });
  const protectedKey = await protectBootstrap(text);
  assert.match(protectedKey, /^[A-Za-z0-9+/=]+$/);
  assert.ok(!Buffer.from(protectedKey, "base64").includes(Buffer.from("fixture-only")));
});
