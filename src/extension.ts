import * as vscode from "vscode"

import { AccessManager } from "./access"
import { LEGACY_LAST_SCAN_STATE_KEY, SCAN_STATE_KEY } from "./constants"
import {
  buildOverviewUrl,
  buildScanDetailsUrl,
} from "./platform"
import { ScanManager } from "./scan-manager"
import { readScanResult, readScanState } from "./scan-state"
import type { ScanResult } from "./types"
import { SidebarProvider } from "./view/sidebar"

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel("Runtz")
  const access = new AccessManager(context)
  const sidebar = new SidebarProvider(
    context.extensionUri,
    currentRecentScans(context)
  )
  const scans = new ScanManager(context, access, sidebar, output)

  context.subscriptions.push(
    output,
    access,
    sidebar,
    scans,
    vscode.window.registerWebviewViewProvider("runtz.sidebar", sidebar, {
      webviewOptions: {
        retainContextWhenHidden: true,
      },
    }),
    vscode.commands.registerCommand(
      "runtz.scanSast",
      (resource?: vscode.Uri) => scans.start("sast", resource)
    ),
    vscode.commands.registerCommand(
      "runtz.scanSca",
      (resource?: vscode.Uri) => scans.start("sca", resource)
    ),
    vscode.commands.registerCommand("runtz.cancelScan", () => scans.cancel()),
    vscode.commands.registerCommand("runtz.showOutput", () => output.show(true)),
    vscode.commands.registerCommand("runtz.configureAccess", () => access.configure()),
    vscode.commands.registerCommand("runtz.openOverview", () =>
      openUrl(() => buildOverviewUrl(access.getPlatformUrl()))
    ),
    vscode.commands.registerCommand("runtz.openLastScan", (candidate?: unknown) => {
      const result =
        readScanResult(candidate) ?? currentRecentScans(context).at(0)
      if (!result) {
        return vscode.window.showInformationMessage(
          "Run a Runtz scan to open its results."
        )
      }
      return openUrl(() => buildScanDetailsUrl(access.getPlatformUrl(), result))
    })
  )
}

async function openUrl(factory: () => string): Promise<void> {
  try {
    await vscode.env.openExternal(vscode.Uri.parse(factory()))
  } catch (error) {
    await vscode.window.showErrorMessage(
      error instanceof Error ? error.message : "Could not open Runtz."
    )
  }
}

function currentRecentScans(context: vscode.ExtensionContext): ScanResult[] {
  return readScanState(
    context.workspaceState.get(SCAN_STATE_KEY),
    context.workspaceState.get(LEGACY_LAST_SCAN_STATE_KEY)
  ).recentScans
}
