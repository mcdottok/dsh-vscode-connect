# DSH VS Code Connect

[简体中文](README.md) | [English](README.en.md)

Connect DeepSeek Harness / DSH Desktop to the DSH extension in VS Code and continue the same conversation in your editor.

## Demo

[![Watch the demo](docs/assets/demo-preview.jpg)](docs/assets/demo.mp4)

[Watch the demo video](docs/assets/demo.mp4)

## Install and connect

In **DeepSeek Harness / DSH Desktop → Plugins → Add plugin**, enter the package name below and click **Install**. No manual download is needed:

```text
dsh-vscode-connect@latest
```

1. After installation, enable the plugin and keep Desktop running. New installations enable **VS Code connection** by default.
2. Install the companion DSH extension in VS Code and open a trusted project folder.
3. On Windows, the plugins discover and connect automatically on the same machine. Select the same workspace and existing session to continue development.

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

Here, `dsh` must refer to the target Desktop's bundled CLI. Do not use a global DSH command from another runtime version to modify Desktop's profile. Desktop users can also use the **Add plugin** entry described above.

The package is downloaded from npm; `dsh plugin` installs it into the selected profile and registers the plugin.

## Manual connection and controls

For other platforms, remote environments, or when automatic connection is unavailable, choose **Copy connection address** in Desktop and run **DSH: Connect to Desktop** in VS Code. Existing manual connection settings take precedence over discovery.

The address contains credentials; do not share it. Automatic connection currently supports local Windows only, with credentials protected by Windows account encryption and VS Code SecretStorage. Turning the switch off stops dedicated connections and automatic discovery.

## Development and compatibility

```powershell
npm ci --ignore-scripts
npm test
```

On Windows, run `.\build.cmd` to build and package into `artifacts/`. Alternatively, run `npm run build`, create `artifacts/`, then run `npm pack --ignore-scripts --pack-destination artifacts`. No sibling extension repository is required.

See `engines.dsh` in `package.json` for declared runtime compatibility. A declared version does not imply full Desktop acceptance. See the [changelog](CHANGELOG.md), [contributing guide](CONTRIBUTING.md) and [lifecycle checks](reviews/memory-lifecycle.md).

## License

MIT. See [third-party notices](THIRD_PARTY_NOTICES.txt) for DeepSeek-derived code and dependency attribution. This is an independent community project.
