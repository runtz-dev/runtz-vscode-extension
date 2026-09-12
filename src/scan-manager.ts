import * as path from "node:path"

import * as vscode from "vscode"

import type { AccessManager } from "./access"
import {
  CliCancelledError,
  CliNotFoundError,
  locateCli,
  runCliScan,
} from "./cli/runner"
import {
  LEGACY_LAST_SCAN_STATE_KEY,
  LEGACY_SCAN_TOTALS_STATE_KEY,
  SCAN_STATE_KEY,
} from "./constants"
import {
  createSafeScaSnapshot,
  resolveSafeScanTarget,
} from "./path-security"
import {
  completeScanState,
  previousTotal,
  readScanState,
  readScanTotals,
  scanHistoryKey,
} from "./scan-state"
import type { ScanResult, ScanType } from "./types"
import type { SidebarProvider } from "./view/sidebar"

type ActiveScan = {
  id: symbol
  type: ScanType
  cancellation: vscode.CancellationTokenSource
}

export class ScanManager implements vscode.Disposable {
  private readonly statusBar: vscode.StatusBarItem
  private running: ActiveScan | undefined

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly access: AccessManager,
    private readonly sidebar: SidebarProvider,
    private readonly output: vscode.OutputChannel
  ) {
    this.statusBar = vscode.window.createStatusBarItem(
      "runtz.scanStatus",
      vscode.StatusBarAlignment.Left,
      100
    )
    this.statusBar.name = "Runtz scan"
    this.statusBar.command = "runtz.cancelScan"
  }

  dispose(): void {
    this.running?.cancellation.cancel()
    this.running?.cancellation.dispose()
    this.statusBar.dispose()
  }

  cancel(): void {
    this.running?.cancellation.cancel()
  }

  async start(type: ScanType, resource: vscode.Uri | undefined): Promise<void> {
    if (this.running) {
      void vscode.window.setStatusBarMessage(
        `Runtz: a ${this.running.type.toUpperCase()} scan is already running`,
        3_000
      )
      return
    }
    if (!vscode.workspace.isTrusted) {
      await vscode.window.showWarningMessage(
        "Trust this workspace before running the Runtz CLI."
      )
      return
    }
    if (!resource || resource.scheme !== "file") {
      await vscode.window.showErrorMessage(
        `Select ${type === "sast" ? "a folder" : "a supported manifest"} in the Explorer.`
      )
      return
    }

    const workspaceFolder = vscode.workspace.getWorkspaceFolder(resource)
    if (!workspaceFolder) {
      await vscode.window.showErrorMessage(
        "The selected target must belong to an open VS Code workspace."
      )
      return
    }

    // Reserve the slot before the first await. Otherwise two rapid context-menu
    // clicks can launch overlapping scans and make cancellation target the
    // wrong process.
    const id = Symbol("runtz-scan")
    const cancellation = new vscode.CancellationTokenSource()
    this.running = { id, type, cancellation }
    this.sidebar.setError(undefined)
    this.sidebar.setRunning(type)
    this.statusBar.text = `$(sync~spin) Runtz: preparing ${type.toUpperCase()}`
    this.statusBar.tooltip = "Scan in progress — click to cancel"
    this.statusBar.show()

    let deferredError: string | undefined
    let disposeTarget: (() => Promise<void>) | undefined
    try {
      const originalTargetPath = await resolveSafeScanTarget(
        type,
        workspaceFolder.uri.fsPath,
        resource.fsPath
      )
      let targetPath = originalTargetPath
      throwIfCancelled(cancellation.token)

      let executable: string
      try {
        const installation = await locateCli(
          this.access.getCliPath(),
          workspaceFileRoots()
        )
        executable = installation.executable
      } catch (error) {
        if (error instanceof CliNotFoundError) {
          const message = "Install the Runtz CLI before running scans."
          this.sidebar.setError({ type, message })
          void this.handleMissingCli()
          return
        }
        throw error
      }
      throwIfCancelled(cancellation.token)

      const access = await this.access.ensureAccess(executable)
      if (!access) {
        return
      }
      throwIfCancelled(cancellation.token)

      if (type === "sca") {
        const snapshot = await createSafeScaSnapshot(originalTargetPath)
        targetPath = snapshot.path
        disposeTarget = snapshot.dispose
      }
      throwIfCancelled(cancellation.token)

      this.statusBar.text = `$(sync~spin) Runtz: ${type.toUpperCase()}`
      const cwd = type === "sast" ? targetPath : path.dirname(targetPath)
      const source = workspaceSource(workspaceFolder, resource)
      const historyKey = scanResultHistoryKey(type, workspaceFolder, resource)
      const persistedState = readScanState(
        this.context.workspaceState.get(SCAN_STATE_KEY),
        this.context.workspaceState.get(LEGACY_LAST_SCAN_STATE_KEY)
      )
      const currentState = {
        ...persistedState,
        totals: {
          ...readScanTotals(
            this.context.workspaceState.get(LEGACY_SCAN_TOTALS_STATE_KEY)
          ),
          ...persistedState.totals,
        },
      }
      const parsed = await runCliScan({
        executable,
        type,
        targetPath,
        source,
        cwd,
        output: this.output,
        cancellation: cancellation.token,
      })
      const result: ScanResult = {
        ...parsed,
        type,
        createdAt: new Date().toISOString(),
        ...optionalPreviousTotal(previousTotal(currentState, historyKey)),
      }
      const nextState = completeScanState(currentState, historyKey, result)
      await this.context.workspaceState.update(SCAN_STATE_KEY, nextState)
      this.sidebar.setRecentScans(nextState.recentScans)
      void vscode.window.setStatusBarMessage(
        `$(pass) Runtz ${type.toUpperCase()} completed`,
        5_000
      )
    } catch (error) {
      if (error instanceof CliCancelledError) {
        this.output.appendLine("Scan cancelled by the user.")
        void vscode.window.setStatusBarMessage("Runtz: scan cancelled", 3_000)
      } else {
        const message = friendlyError(error)
        this.output.appendLine(`Error: ${message}`)
        this.sidebar.setError({ type, message })
        deferredError = `Runtz ${type.toUpperCase()}: ${message}`
      }
    } finally {
      if (disposeTarget) {
        try {
          await disposeTarget()
        } catch (error) {
          this.output.appendLine(
            `Warning: could not remove the temporary manifest: ${friendlyError(error)}`
          )
        }
      }
      if (this.running?.id === id) {
        cancellation.dispose()
        this.running = undefined
        this.sidebar.setRunning(undefined)
        this.statusBar.hide()
      }
    }

    // Do not await the notification: the process and busy UI are already
    // finished, so a user can immediately retry even while the toast is open.
    if (deferredError) {
      void vscode.window
        .showErrorMessage(deferredError, "View output")
        .then((action) => {
          if (action === "View output") {
            this.output.show(true)
          }
        })
    }
  }

  private async handleMissingCli(): Promise<void> {
    const selected = await vscode.window.showErrorMessage(
      "Install the Runtz CLI before running scans.",
      "Install CLI",
      "Configure path"
    )
    if (selected === "Install CLI") {
      await vscode.env.openExternal(
        vscode.Uri.parse("https://runtz.dev/docs")
      )
    } else if (selected === "Configure path") {
      await this.access.configureCliPath()
    }
  }
}

function workspaceSource(folder: vscode.WorkspaceFolder, resource: vscode.Uri): string {
  const relative = path.relative(folder.uri.fsPath, resource.fsPath)
  if (!relative) {
    return folder.name
  }
  return `${folder.name}/${relative.split(path.sep).join("/")}`
}

function friendlyError(error: unknown): string {
  return error instanceof Error ? error.message : "An unexpected error occurred."
}

function workspaceFileRoots(): string[] {
  return (vscode.workspace.workspaceFolders ?? [])
    .filter((folder) => folder.uri.scheme === "file")
    .map((folder) => folder.uri.fsPath)
}

function throwIfCancelled(token: vscode.CancellationToken): void {
  if (token.isCancellationRequested) {
    throw new CliCancelledError()
  }
}

function scanResultHistoryKey(
  type: ScanType,
  folder: vscode.WorkspaceFolder,
  resource: vscode.Uri
): string {
  return scanHistoryKey(
    type,
    folder.uri.toString(),
    path.relative(folder.uri.fsPath, resource.fsPath)
  )
}

function optionalPreviousTotal(
  value: number | undefined
): Pick<ScanResult, "previousTotal"> | Record<string, never> {
  return value === undefined ? {} : { previousTotal: value }
}
