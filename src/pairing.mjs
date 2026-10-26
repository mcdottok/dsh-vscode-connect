import { createServer } from "node:net";
import { createCipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const RECORD = "vscode-connect/local-pairing-v1";
export const pipeName = (key) => `\\\\.\\pipe\\dsh-vscode-${createHash("sha256").update(key).digest("hex")}`;
const mac = (key, value) => createHmac("sha256", Buffer.from(key, "base64url")).update(value).digest("hex");

/** Persistent native credential record, independent of the process launch token. */
export async function loadPairingKey(credentials) {
  const record = await credentials.modifyRecord(RECORD, async (current) => {
    if (current !== undefined) return undefined;
    return { kind: "grant", payload: { version: 1, key: randomBytes(32).toString("base64url") } };
  });
  if (record?.kind !== "grant" || record.payload?.version !== 1 || !/^[A-Za-z0-9_-]{43}$/.test(record.payload.key))
    throw new Error("Invalid local pairing record");
  return record.payload.key;
}

/** No TCP listener or public credential route. Responses require a paired key and are encrypted. */
export function startPairingServer(key, readUrl, enabled, endpoint = pipeName(key)) {
  const sockets = new Set();
  const seen = new Map();
  const server = createServer((socket) => {
    if (sockets.size >= 16) { socket.destroy(); return; }
    sockets.add(socket);
    const deadline = setTimeout(() => socket.destroy(), 2000);
    socket.on("error", () => {});
    socket.on("close", () => { clearTimeout(deadline); sockets.delete(socket); });
    socket.setTimeout(2000, () => socket.destroy());
    let input = "";
    let handled = false;
    socket.on("data", async (chunk) => {
      input += chunk.toString("utf8");
      if (input.length > 1024) { socket.destroy(); return; }
      if (handled || !input.includes("\n")) return;
      handled = true;
      try {
        const value = JSON.parse(input.slice(0, input.indexOf("\n")));
        const now = Date.now();
        for (const [nonce, expires] of seen) if (expires < now) seen.delete(nonce);
        if (!enabled() || !/^[a-f0-9]{64}$/.test(value.nonce) || !Number.isSafeInteger(value.time) ||
            Math.abs(now - value.time) > 30_000 || seen.has(value.nonce) || seen.size >= 1024 ||
            typeof value.mac !== "string" || !/^[a-f0-9]{64}$/.test(value.mac) ||
            !timingSafeEqual(Buffer.from(value.mac, "hex"), Buffer.from(mac(key, `request:${value.nonce}:${value.time}`), "hex")))
          throw new Error("Invalid request");
        seen.set(value.nonce, now + 60_000);
        const iv = randomBytes(12);
        const cipher = createCipheriv("aes-256-gcm", Buffer.from(key, "base64url"), iv);
        cipher.setAAD(Buffer.from(value.nonce));
        const url = await readUrl();
        if (!enabled() || socket.destroyed) throw new Error("Connection disabled");
        const body = Buffer.concat([cipher.update(JSON.stringify({ url, nonce: value.nonce })), cipher.final()]);
        socket.end(JSON.stringify({ iv: iv.toString("hex"), body: body.toString("hex"), tag: cipher.getAuthTag().toString("hex") }) + "\n");
      } catch { socket.destroy(); }
    });
  });
  // Duplicate instances fail closed; never take over or delete another listener.
  server.on("error", () => {});
  server.listen(endpoint);
  server.unref();
  return () => { for (const socket of sockets) socket.destroy(); server.close(); seen.clear(); };
}
