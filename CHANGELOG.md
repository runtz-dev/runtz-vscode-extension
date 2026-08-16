# Changelog

## 1.0.1

- Unified VS Code and terminal authentication through `runtz login`; the
  extension now reuses existing CLI logins and sends new tokens through stdin.

## 1.0.0

- Added the Runtz Activity Bar view with overview and result actions.
- Added an unread-result badge that clears when the Runtz view is opened.
- Added a compact history of the four most recent VS Code scans, with project
  metadata, severity distribution, trend against the previous scan for the
  same target, and an exact deep link for each scan when its ID is available.
- Matched the platform trend badges with directional icons and a neutral dash
  when the finding count does not change.
- Added one-click SAST scans for folders.
- Added one-click SCA scans for supported dependency manifests.
- Added secure token configuration with cloud and self-hosted support.
- Added discreet status-bar progress and cancellation.
- Added trusted-workspace, canonical CLI path, secret redaction, and manifest
  snapshot protections.
- Added local VSIX packaging for pre-Marketplace testing.
- Added cross-platform CI and a protected, tag-driven Marketplace publication
  workflow.
- Removed the redundant vulnerability summary action; scan results now expose
  only the direct **Open in Runtz** link to the scan details.
- Standardized all extension UI and documentation copy on English.
