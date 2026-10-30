# DSH VS Code Connect

[简体中文](README.md) | English

Connect DeepSeek Harness / DSH Desktop to the companion [DSH Coding Agent](https://github.com/mcdottok/vscode-dsh) extension and continue the same conversation in your editor, with an experience similar to the Codex and Claude Code extensions for VS Code.

## Demo

[![Watch the demo](docs/assets/demo-preview.jpg)](docs/assets/demo.mp4)

[Watch the demo video](docs/assets/demo.mp4)

## Install and connect

Both plugins are required: **install this plugin in DeepSeek Harness / DSH Desktop and the companion extension in VS Code**.

In **DeepSeek Harness / DSH Desktop → Plugins → Add plugin**, enter the package name below and click **Install**. No manual download is needed:

```text
dsh-vscode-connect@latest
```

1. After installation, enable the plugin and keep Desktop running. New installations enable **VS Code connection** by default.
2. DSH Coding Agent has temporarily been removed from the VS Code Marketplace; the reason is not yet clear. We hope to republish it later. In the meantime, download the `.vsix` from [GitHub Releases](https://github.com/mcdottok/vscode-dsh/releases), then select **Extensions: Install from VSIX...** in VS Code and choose the downloaded file. Open a trusted project folder and select **DSH Desktop** in the extension’s connection settings.
3. On Windows, the plugins discover and connect automatically on the same machine. Select the same workspace and existing session to continue development.

After downloading the VSIX, you can also install it from its directory using the command line (replace the filename with the downloaded version):

```powershell
code --install-extension ./dsh-coding-agent-0.1.83.vsix
```

For extension source code and issues, see the [vscode-dsh GitHub repository](https://github.com/mcdottok/vscode-dsh).

Browser access and a specific Desktop layout are not required. A previously saved disabled setting is respected; re-enable it under **Settings → General → VS Code connection**.

Available on [npm](https://www.npmjs.com/package/dsh-vscode-connect). Alternatively, download a `.tgz` from [GitHub Releases](https://github.com/mcdottok/dsh-vscode-connect/releases) and install the local file. If a registry mirror cannot find the package yet, select the official npm registry and retry.

### Command-line installation from npm

For a DSH Web / CLI installation, run:

```powershell
dsh plugin --profile web add dsh-vscode-connect@latest
```

For Desktop's `desktop` profile, run this with **the CLI bundled with that Desktop installation**:

```powershell
dsh plugin --profile desktop add dsh-vscode-connect@latest
```

When managing the `desktop` profile, `dsh` must refer to the target Desktop's bundled CLI. Do not use a global DSH command from another runtime version to modify Desktop's profile. Desktop users can also use the **Add plugin** entry described above.

The package is downloaded from npm; `dsh plugin` installs it into the selected profile and registers the plugin.

## Connection notes

- This is the **Desktop companion plugin** for **DSH Coding Agent** in VS Code. Install both to connect to Desktop.
- A ready connection entry means Desktop can accept connections. Check the VS Code extension for the actual connection status.
- This plugin is not required when the VS Code extension runs an independent service using a locally installed npm `dsh` package. Opening the same session in that service and Desktop may prevent model changes or message sending because another instance holds the session. Release it in the other instance, use a new session, or connect to the original Desktop instead. Different sessions in the same workspace are not subject to this restriction.

## Manual connection and controls

For other platforms, remote environments, or when automatic connection is unavailable, choose **Copy connection address** under **Settings → General → VS Code connection** in Desktop, then run **DSH: Connect to Desktop** in VS Code and paste the address. Existing manual connection settings take precedence over discovery. If recovery fails, check that Desktop, both plugins and the connection switch are enabled, then copy a fresh address and reconnect.

The address contains credentials; do not share it. Automatic connection currently supports local Windows only, with credentials protected by Windows account encryption and VS Code SecretStorage. Turning the switch off stops dedicated connections and automatic discovery.

## Development and compatibility

```powershell
npm ci --ignore-scripts
npm test
```

On Windows, run `.\build.cmd` to build and package into `artifacts/`. Alternatively, run `npm run build`, create `artifacts/`, then run `npm pack --ignore-scripts --pack-destination artifacts`. No sibling extension repository is required.

Later updates in the same kernel series are admitted without a separate release for every RC. Build dependencies remain pinned to the verified baseline; complete behavior on newer runtimes still needs validation.

See `engines.dsh` in `package.json` for declared runtime compatibility. A declared version does not imply full Desktop acceptance. See the [changelog](CHANGELOG.md), [contributing guide](CONTRIBUTING.md) and [lifecycle checks](reviews/memory-lifecycle.md).

## License

MIT. See [third-party notices](THIRD_PARTY_NOTICES.txt) for DeepSeek-derived code and dependency attribution. This is an independent community project.
