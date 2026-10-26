import z from "@deepseek-ai/schemastery";
import { CONNECT_PATH, createConnectHandler } from "./api.mjs";
import { loadPairingKey, startPairingServer } from "./pairing.mjs";
import { startApiBridge } from "./bridge.mjs";
import { startAutomaticDiscovery } from "./automatic-discovery.mjs";

export const name = "vscode-connect";
export const inject = ["connection", "webServer", "settings", "credentials", "typertGateway"];
export const Config = z.object({
  enabled: z.boolean().default(true).volatile(),
});
const ENTRY = "vscode-connect";

export function apply(ctx, config) {
  let stopped = false;
  let bridge;
  const ready = ctx.typertGateway?.wireStream && ctx.effect
    ? startApiBridge(ctx.connection, ctx.typertGateway, () => config.enabled.get() === true,
        (req, res, next) => ctx.waterfall("connection/request", req, res, next)).then(async (value) => {
        if (stopped) { await value.close(); throw new Error("Plugin disposed"); }
        bridge = value;
        return value;
      })
    : undefined;
  void ready?.catch(() => {});
  const address = async () => {
    if (stopped) throw new Error("Plugin disposed");
    // Every issued address must use our bounded mux. Selecting the native
    // carrier here bypasses its pending-byte cap and stalled-write deadline.
    const value = await ready;
    if (!value || stopped) throw new Error("Local API unavailable");
    return value.address;
  };
  ctx.effect?.(() => async () => { stopped = true; await bridge?.close(); });
  let pairing;
  let automatic;
  if (process.platform === "win32" && ctx.credentials && ctx.effect) {
    let close;
    ctx.effect(() => async () => { stopped = true; close?.(); await automatic?.close(); });
    pairing = loadPairingKey(ctx.credentials).then((key) => {
      if (stopped) throw new Error("Plugin disposed");
      close = startPairingServer(key, async () => {
        const target = await address();
        const { host, port, protocol } = target;
        if (host !== "127.0.0.1" || protocol !== "http:" || !Number.isSafeInteger(port) || port < 1 || port > 65535)
          throw new Error("Local listener unavailable");
        return target.launchUrl ?? ctx.connection.authenticatedUrl(`http://127.0.0.1:${port}/`);
      }, () => config.enabled.get() === true);
      automatic = startAutomaticDiscovery(key, () => config.enabled.get() === true);
      return { version: 1, key };
    });
    void pairing.catch(() => {});
  }
  const read = () => {
    const form = ctx.settings
      .describe({ redactSecrets: true })
      .find((row) => row.ns === ENTRY);
    if (!form) throw new Error("Connection settings unavailable");
    return { enabled: config.enabled.get() === true, revision: form.revision };
  };
  // Native Connection enforces authentication, owner principal and Host/Origin trust.
  // Registrations belong to this fiber and disappear when the plugin is disabled.
  ctx.connection.fetch.register({
    path: CONNECT_PATH,
    methods: ["GET", "POST", "PATCH"],
    requestBody: "buffered",
    fetch: createConnectHandler(ctx.connection, ctx.webServer, {
      read,
      address,
      pair: async () => {
        if (!pairing) throw new Error("Pairing unavailable");
        return pairing;
      },
      update: async (enabled, revision) => {
        await ctx.settings.update(ENTRY, { enabled }, revision);
        bridge?.enforceSwitch();
        await automatic?.refresh();
        return read();
      },
    }),
  });
}
