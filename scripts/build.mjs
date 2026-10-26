import { mkdir, readFile } from "node:fs/promises";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const manifest = JSON.parse(
  await readFile(path.join(root, "package.json"), "utf8"),
);
await mkdir(path.join(root, "dist"), { recursive: true });
await build({
  entryPoints: [path.join(root, "src/index.mjs")],
  outfile: path.join(root, "dist/index.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  external: ["ws"],
});
await build({
  entryPoints: [path.join(root, "src/client.jsx")],
  outfile: path.join(root, "dist/client.js"),
  bundle: true,
  platform: "browser",
  format: "cjs",
  target: "es2022",
  external: ["react"],
  loader: { ".css": "text" },
  banner: {
    js: `window.__ModuleLoader__.load({ id: ${JSON.stringify(manifest.name)}, factory: (require) => { var module = { exports: {} }; var exports = module.exports;`,
  },
  footer: { js: "return module.exports; } });" },
});
console.log(`Built ${manifest.name}@${manifest.version}`);
