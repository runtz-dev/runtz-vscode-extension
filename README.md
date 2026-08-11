<p align="center">
  <img src="resources/icon.png" alt="Runtz" width="96">
</p>

# Runtz Security for VS Code

Run Runtz SAST and SCA scans from the Explorer without adding noise to your
editor. The extension delegates scanning to the official Runtz CLI and sends
the resulting security report to your configured Runtz platform.

## Requirements

- VS Code 1.95 or newer.
- The [Runtz CLI](https://runtz.dev/home/docs) installed and available as
  `runtz` in `PATH`.
- A workspace API key created in **Runtz → API Keys**.

The extension stores the API key in VS Code `SecretStorage`. It never writes
the token to settings, workspace files, command arguments, or logs.

## Usage

### SAST

Right-click a folder in the Explorer and select **Runtz: SAST Scan**.

### SCA

Right-click a supported dependency manifest and select **Runtz: SCA Scan**.

Supported by the current CLI:

- `package.json`
- `requirements.txt`
- `go.mod`
- `pom.xml`
- `Gemfile.lock`
- `composer.json`
- `Cargo.toml`
- `*.csproj`

Only the relevant single Runtz action appears in each context menu. Scan
progress stays in the status bar, and completed results appear in the Runtz
Activity Bar view. After the Runtz view has been opened once in the current
window, its icon shows the number of completed scan results you have not opened
yet; opening the view clears the badge.

The recent-scans list keeps up to four results run from the current VS Code
workspace. Each card shows the project, scan time, dependency or file count,
finding total, severity distribution, and trend, and opens that exact scan in
Runtz when its scan ID is available. The trend compares the total with the
previous scan for the same target and scan type.

## Configure access

Open the Runtz view and select **Configure access** to:

- add or replace the workspace token;
- test the connection;
- switch between Runtz Cloud and a self-hosted installation;
- configure the Runtz CLI executable path;
- remove the stored token.

Cloud defaults:

- Engine: `https://engine.runtz.dev`
- Platform: `https://runtz.dev`

Self-hosted users configure the engine and web platform URLs separately.
The engine must use HTTPS unless it is running on a loopback address such as
`localhost`. Token verification requires a current engine with
`GET /api/v1/keys/verify`.

In SSH, WSL, or Dev Containers, install the CLI in the remote environment where
the workspace extension runs. The current public CLI installers target Linux
and macOS; native Windows support depends on a Windows Runtz CLI executable.

## Install locally before Marketplace publication

From this directory:

```bash
npm ci
npm run package:vsix
code --install-extension runtz-security-1.0.0.vsix --force
```

Alternatively, run **Extensions: Install from VSIX…** in the VS Code Command
Palette and select the generated file.

For development, open this directory in VS Code, run `npm install`, and press
F5 to launch an Extension Development Host.

## Marketplace release

Pull requests and pushes to `main` run the extension checks on Linux, macOS,
and Windows and produce a short-lived VSIX artifact. Marketplace publication
uses a separate protected workflow:

1. Create or join the Visual Studio Marketplace publisher with ID `runtz`.
2. Create an Azure DevOps personal access token for **All accessible
   organizations** with only **Marketplace → Manage** enabled.
3. Create the GitHub Environment `vscode-marketplace` with required reviewers.
4. Add the Marketplace token as the Environment secret `VSCE_PAT`.
5. Update `version` in `package.json` and this changelog.
6. Merge the release commit into `main`.
7. Push a matching tag such as `v1.0.0`.

The workflow verifies that the tag matches the extension version and points to
a commit on `main`, reruns every check, packages one exact VSIX, records its
SHA-256 digest, waits for Environment approval, and publishes that same file.
No Marketplace credential is exposed to pull-request or build jobs.

Azure DevOps global personal access tokens are scheduled to retire on December
1, 2026. Before then, migrate this publish job to Microsoft Entra ID or
Marketplace trusted publishing so it no longer depends on a long-lived secret.

## Security model

- Scans only run in trusted, local workspaces.
- The CLI is started directly with `shell: false`.
- Selected paths are passed as individual arguments.
- The token is supplied only to the child process environment.
- The token is bound to the engine where it was verified; changing the endpoint
  requires explicit authorization.
- The extension never executes a workspace-provided `node_modules/.bin` tool.
- The CLI executable is resolved to a canonical path outside the workspace.
- Symbolic-link escapes and credential-bearing dependency URLs are rejected.
- SCA runs the CLI against a private, immutable snapshot of the verified
  manifest; the snapshot is removed as soon as the scan finishes.
- SAST and SCA behavior remains owned by the official Runtz CLI.

SCA checks dependency names and versions against the GitHub Advisory API, so it
requires outbound access to `api.github.com` even with a self-hosted Runtz
installation. The extension does not forward an ambient `GITHUB_TOKEN` to the
CLI.

## License

Business Source License 1.1. See [LICENSE](LICENSE).
