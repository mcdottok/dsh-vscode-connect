import { test } from "node:test";
import assert from "node:assert/strict";
import { createConnection } from "node:net";
import { createDecipheriv, createHmac, randomBytes } from "node:crypto";
import { once } from "node:events";
import { loadPairingKey, startPairingServer } from "../src/pairing.mjs";

function exchange(endpoint, key, nonce = randomBytes(32).toString("hex")) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(endpoint);
    let input = "";
    socket.setTimeout(2500, () => { socket.destroy(); reject(new Error("timeout")); });
    socket.on("error", reject);
    socket.on("connect", () => {
      const time = Date.now();
      const mac = createHmac("sha256", Buffer.from(key, "base64url")).update(`request:${nonce}:${time}`).digest("hex");
      socket.write(JSON.stringify({ nonce, time, mac }) + "\n");
    });
    socket.on("data", chunk => { input += chunk; });
    socket.on("close", () => {
      if (!input) { resolve(undefined); return; }
      try {
        const value = JSON.parse(input);
        const cipher = createDecipheriv("aes-256-gcm", Buffer.from(key, "base64url"), Buffer.from(value.iv, "hex"));
        cipher.setAAD(Buffer.from(nonce)); cipher.setAuthTag(Buffer.from(value.tag, "hex"));
        resolve(JSON.parse(Buffer.concat([cipher.update(Buffer.from(value.body, "hex")), cipher.final()]).toString()));
      } catch(error) { reject(error); }
    });
  });
}

test("native pairing identity persists and malformed records fail closed", async () => {
  let stored;
  const credentials = { modifyRecord: async (_key, fn) => { stored = await fn(stored) ?? stored; return stored; } };
  const first = await loadPairingKey(credentials);
  assert.equal(await loadPairingKey(credentials), first);
  assert.match(first, /^[A-Za-z0-9_-]{43}$/);
  await assert.rejects(loadPairingKey({ modifyRecord: async () => ({ kind: "grant", payload: {} }) }));
});

test("authenticated IPC returns changing addresses, rejects strangers, replays and disabled access", async () => {
  const key = randomBytes(32).toString("base64url");
  const endpoint = process.platform === "win32" ? `\\\\.\\pipe\\dsh-pair-test-${randomBytes(16).toString("hex")}` : `/tmp/dsh-pair-${randomBytes(12).toString("hex")}.sock`;
  let enabled = true;
  let url = "http://127.0.0.1:41234/?token=fixture-first";
  let calls = 0;
  const close = startPairingServer(key, () => { calls++; return url; }, () => enabled, endpoint);
  try {
    // A connect attempt is queued behind listen on the same event loop.
    const nonce = randomBytes(32).toString("hex");
    assert.equal((await exchange(endpoint, key, nonce)).url, url);
    assert.equal(await exchange(endpoint, key, nonce), undefined);
    assert.equal(await exchange(endpoint, randomBytes(32).toString("base64url")), undefined);
    assert.equal(calls, 1);
    url = "http://127.0.0.1:42345/?token=fixture-restarted";
    assert.equal((await exchange(endpoint, key)).url, url);
    enabled = false;
    assert.equal(await exchange(endpoint, key), undefined);
    assert.equal(calls, 2);
  } finally { close(); }
});
