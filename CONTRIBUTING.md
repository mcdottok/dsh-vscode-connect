# Contributing

Install dependencies with `npm ci --ignore-scripts`. Run `npm test` for build and regression checks. `npm run test:server` tests server source without building; `npm run test:memory -- 1000` is an optional isolated lifecycle diagnostic.

Keep credential handling on the server and preserve the explicit copy action, loopback authentication, queue limits, cancellation and resource cleanup. Add regression coverage for changed behavior. Describe the exact runtime tested and distinguish automated results from Desktop acceptance.

Never submit live connection addresses, credentials, private profiles or generated bundles. Preserve the upstream notices in `THIRD_PARTY_NOTICES.txt` when modifying vendored code.

## Distribution and directory listing

The plugin is published to [npm](https://www.npmjs.com/package/dsh-vscode-connect). Publish subsequent versions from this repository with `npm publish --access public --registry=https://registry.npmjs.org/`; the existing prepack hook builds the runtime entries. GitHub Releases provide an alternative prebuilt tarball distribution. Run the manual **Package release tarball** workflow, download its Actions artifact, and attach `dsh-vscode-connect.tgz` to a Release. The fixed filename supports a stable `releases/latest/download/dsh-vscode-connect.tgz` link; the versioned archive is available for pinned release links. An Actions artifact alone is not a public Release asset.

The repository deliberately omits generated `dist/`. Its current build needs development dependencies and has no Git-install `prepare` hook. Submit a working prebuilt Release URL as the listing's `tarball` rather than assuming a source checkout can install directly.

For the [awesome-dsh-plugin directory](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/main/contributing.md), submit one `data/plugins/mcdottok__dsh-vscode-connect.yml` entry with `https://github.com/mcdottok/dsh-vscode-connect`, category `dev`, and these descriptions:

- en: Connects DeepSeek Harness to Visual Studio Code with local Windows auto-pairing and manual connection.
- zh: 连接 DeepSeek Harness 与 Visual Studio Code，支持 Windows 本机自动配对和手动连接。

Add `dsh-plugin` as a GitHub repository topic. Before submitting, the public repository must be at least one day old. The package manifest points to `mcdottok/dsh-vscode-connect`. The listing `icon` can point to the repository's `assets/vscode.png` on GitHub; icon and screenshot fields are optional.

Official DeepSeek packages are development inputs bundled into this plugin, not production `dependencies`. The only production dependency is `ws`. Keep any future external official runtime dependency in `peerDependencies` with explicit compatible prerelease branches.
