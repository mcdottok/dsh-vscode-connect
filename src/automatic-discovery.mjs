import { spawn } from "node:child_process";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";

const SCRIPT = "$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; $text=[Console]::In.ReadToEnd(); $bytes=[Text.Encoding]::UTF8.GetBytes($text); $entropy=[Text.Encoding]::UTF8.GetBytes('dsh-vscode-connect.bootstrap.v1'); [Console]::Out.Write([Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect($bytes,$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser)))";

/** Only the current Windows account can unwrap this bootstrap grant. No shell or command-line secret. */
export function protectBootstrap(value) {
  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", SCRIPT], { windowsHide: true, stdio: ["pipe", "pipe", "ignore"] });
    let output = "";
    const timer = setTimeout(() => { child.kill(); }, 5000);
    child.stdout.on("data", chunk => { output += chunk.toString("utf8"); if (output.length > 16_384) child.kill(); });
    child.stdin.on("error", () => {});
    child.on("error", () => { clearTimeout(timer); reject(new Error("Local bootstrap protection unavailable")); });
    child.on("close", code => {
      clearTimeout(timer);
      if (code === 0 && /^[A-Za-z0-9+/=]{32,16384}$/.test(output)) resolve(output);
      else reject(new Error("Local bootstrap protection unavailable"));
    });
    child.stdin.end(value);
  });
}

/** Publish only while the person has enabled the connection entry. The record never contains a plaintext key or URL. */
export function startAutomaticDiscovery(key, enabled, options = {}) {
  const directory = options.directory ?? path.join(process.env.LOCALAPPDATA ?? path.join(homedir(), "AppData", "Local"), "dsh-vscode-connect", "instances");
  const createdAt = Date.now();
  const filename = path.join(directory, `${createdAt}-${randomBytes(12).toString("hex")}.json`);
  const temporary = `${filename}.tmp`;
  const protect = options.protect ?? protectBootstrap;
  let protectedKey;
  let stopped = false;
  let pending;
  let dirty = false;
  const remove = () => unlink(filename).catch(() => {});
  const publish = async () => {
    if (stopped || !enabled()) { await remove(); return; }
    protectedKey ??= await protect(JSON.stringify({ version: 1, key }));
    if (stopped || !enabled()) { await remove(); return; }
    await mkdir(directory, { recursive: true, mode: 0o700 });
    try {
      await writeFile(temporary, JSON.stringify({ version: 1, pid: process.pid, createdAt, updatedAt: Date.now(), protectedKey }), { mode: 0o600 });
      if (stopped || !enabled()) { await remove(); return; }
      await rename(temporary, filename);
    } finally { await unlink(temporary).catch(() => {}); }
  };
  // Slow storage/protection must not grow a promise chain on every timer tick.
  // Coalesce requests into the current write and at most one trailing refresh.
  const refresh = () => {
    if (stopped) return Promise.resolve();
    dirty = true;
    pending ??= Promise.resolve().then(async () => {
      while (dirty && !stopped) {
        dirty = false;
        await publish().catch(() => {});
      }
    }).finally(() => {
      pending = undefined;
      if (dirty && !stopped) return refresh();
    });
    return pending;
  };
  const timer = setInterval(() => { void refresh(); }, 2000);
  timer.unref();
  void refresh();
  return { refresh, close: async () => { stopped = true; dirty = false; clearInterval(timer); await pending; await remove(); await unlink(temporary).catch(() => {}); } };
}
