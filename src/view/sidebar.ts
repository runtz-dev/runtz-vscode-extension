import { randomBytes } from "node:crypto"

import * as vscode from "vscode"

import { RECENT_SCAN_LIMIT } from "../scan-state"
import type { ScanResult, ScanType, SeverityCounts } from "../types"
import {
  effectiveSeverityCounts,
  formatScanDate,
  scanFindingLabel,
  scanMetricLabel,
  scanTrend,
  SEVERITY_KEYS,
  severitySummary,
  type ScanTrend,
  type SeverityKey,
  unreadCountAfterScan,
} from "./presentation"

type SidebarMessage = {
  command?: unknown
  scanKey?: unknown
}

type ScanError = {
  type: ScanType
  message: string
}

const ALLOWED_COMMANDS = new Set([
  "runtz.openOverview",
  "runtz.openLastScan",
  "runtz.configureAccess",
  "runtz.showOutput",
])

const SEVERITY_LABELS: Record<SeverityKey, string> = {
  critical: "Critical",
  high: "High",
  medium: "Medium",
  low: "Low",
  unknown: "Unknown",
}

export class SidebarProvider
  implements vscode.WebviewViewProvider, vscode.Disposable
{
  private view: vscode.WebviewView | undefined
  private recentScans: ScanResult[]
  private runningType: ScanType | undefined
  private error: ScanError | undefined
  private unreadScans = 0
  private readonly scanActions = new Map<string, ScanResult>()
  private readonly subscriptions: vscode.Disposable[]
  private viewSubscriptions: vscode.Disposable[] = []

  constructor(
    private readonly extensionUri: vscode.Uri,
    initialScans: readonly ScanResult[]
  ) {
    this.recentScans = initialScans.slice(0, RECENT_SCAN_LIMIT)
    this.subscriptions = [
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.render()),
      vscode.workspace.onDidGrantWorkspaceTrust(() => this.render()),
    ]
  }

  dispose(): void {
    this.disposeViewSubscriptions()
    for (const subscription of this.subscriptions) {
      subscription.dispose()
    }
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.disposeViewSubscriptions()
    this.view = view
    this.unreadScans = 0
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "resources")],
    }
    this.viewSubscriptions = [
      view.webview.onDidReceiveMessage((message: SidebarMessage) => {
        if (typeof message.command !== "string") {
          return
        }
        if (message.command === "runtz.openLastScan") {
          const scan =
            typeof message.scanKey === "string"
              ? this.scanActions.get(message.scanKey)
              : undefined
          if (scan) {
            void vscode.commands.executeCommand(message.command, scan)
          }
          return
        }
        if (ALLOWED_COMMANDS.has(message.command)) {
          void vscode.commands.executeCommand(message.command)
        }
      }),
      view.onDidChangeVisibility(() => {
        if (view.visible) {
          this.unreadScans = 0
          this.syncBadge()
        }
      }),
      view.onDidDispose(() => {
        if (this.view === view) {
          this.view = undefined
        }
        this.scanActions.clear()
        this.disposeViewSubscriptions()
      }),
    ]
    this.syncBadge()
    this.render()
  }

  setRecentScans(scans: readonly ScanResult[]): void {
    this.recentScans = scans.slice(0, RECENT_SCAN_LIMIT)
    this.error = undefined
    this.unreadScans = unreadCountAfterScan(
      this.unreadScans,
      this.view?.visible === true
    )
    this.syncBadge()
    this.render()
  }

  setRunning(type: ScanType | undefined): void {
    this.runningType = type
    this.render()
  }

  setError(error: ScanError | undefined): void {
    this.error = error
    this.render()
  }

  private syncBadge(): void {
    if (!this.view) {
      return
    }
    const count = this.view.visible ? 0 : this.unreadScans
    this.view.badge =
      count > 0
        ? {
            value: count,
            tooltip:
              count === 1
                ? "1 new Runtz scan result"
                : `${count} new Runtz scan results`,
          }
        : { value: 0, tooltip: "" }
  }

  private disposeViewSubscriptions(): void {
    const subscriptions = this.viewSubscriptions
    this.viewSubscriptions = []
    for (const subscription of subscriptions) {
      subscription.dispose()
    }
  }

  private render(): void {
    if (!this.view) {
      return
    }
    this.scanActions.clear()
    const webview = this.view.webview
    const nonce = randomBytes(16).toString("base64")
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "resources", "sidebar.css")
    )
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "resources", "sidebar.js")
    )

    this.view.description = this.runningType
      ? `${this.runningType.toUpperCase()} in progress`
      : ""
    webview.html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
    <link rel="stylesheet" href="${styleUri}">
    <title>Runtz</title>
  </head>
  <body>
    <main class="shell">
      <button class="overview-button" type="button" data-command="runtz.openOverview">
        <span>Open Runtz overview</span>
        <span class="arrow" aria-hidden="true">↗</span>
      </button>

      ${this.renderResults()}

      <button class="config-button" type="button" data-command="runtz.configureAccess">
        <span aria-hidden="true">⚙</span>
        <span>Configure access</span>
      </button>
    </main>
    <script nonce="${nonce}" src="${scriptUri}"></script>
  </body>
</html>`
  }

  private renderResults(): string {
    const running = this.runningType
      ? `<div class="running" role="status"><span class="pulse" aria-hidden="true"></span>Running ${this.runningType.toUpperCase()}…</div>`
      : ""
    const sectionStart = `<section class="results-section" aria-labelledby="recent-scans-title" aria-busy="${Boolean(this.runningType)}">
      <header class="section-heading">
        <h2 id="recent-scans-title">Recent scans</h2>
        <p>Last 4 scans run from VS Code.</p>
      </header>
      ${running}`

    if (this.error && this.recentScans.length === 0) {
      return `${sectionStart}
        <div class="scan-card state-card">
          <div class="error-state" role="alert">
            <p>Could not complete the ${this.error.type.toUpperCase()} scan</p>
            <span>${escapeHtml(this.error.message)}</span>
          </div>
          <div class="result-actions">
            <button type="button" data-command="runtz.showOutput">
              <span>View output</span><span aria-hidden="true">→</span>
            </button>
          </div>
        </div>
      </section>`
    }

    if (this.recentScans.length === 0) {
      const emptyCopy = emptyStateCopy()
      return `${sectionStart}
        <div class="scan-card state-card">
          <div class="empty-state">
            <p>${emptyCopy.title}</p>
            <span>${emptyCopy.description}</span>
          </div>
        </div>
      </section>`
    }

    const cards = this.recentScans
      .map((result, index, scans) => {
        const scanKey = randomBytes(16).toString("hex")
        this.scanActions.set(scanKey, result)
        return `<li class="scan-history-item">${renderScanCard(result, scanKey, index + 1, scans.length)}</li>`
      })
      .join("")

    return `${sectionStart}
      ${this.error ? renderErrorNotice(this.error) : ""}
      <ol class="scan-history">${cards}</ol>
    </section>`
  }
}

function renderErrorNotice(error: ScanError): string {
  return `<div class="scan-notice" role="alert">
    <div>
      <strong>${error.type.toUpperCase()} scan failed</strong>
      <span>${escapeHtml(error.message)}</span>
    </div>
    <button type="button" data-command="runtz.showOutput">View output</button>
  </div>`
}

function renderScanCard(
  result: ScanResult,
  scanKey: string,
  position: number,
  totalScans: number
): string {
  const counts = effectiveSeverityCounts(result)
  const trend = scanTrend(result)
  const metricCount =
    result.type === "sca" ? (result.dependencies ?? 0) : (result.files ?? 0)
  const metricNoun =
    result.type === "sca"
      ? metricCount === 1
        ? "dependency"
        : "dependencies"
      : metricCount === 1
        ? "file"
        : "files"
  const findingNoun =
    result.type === "sca"
      ? result.total === 1
        ? "vulnerability"
        : "vulnerabilities"
      : result.total === 1
        ? "finding"
        : "findings"
  const metricAriaLabel = `${metricCount} ${metricNoun}`
  const findingAriaLabel = `${result.total} ${findingNoun}`
  const projectLabelId = `scan-project-${scanKey}`
  const formattedDate = formatScanDate(result.createdAt)
  const openAriaLabel = `Open scan ${position} of ${totalScans}: ${result.projectName}, ${result.type.toUpperCase()}, from ${formattedDate}, in Runtz`
  return `<article class="scan-card" aria-labelledby="${projectLabelId}">
    <div class="scan-summary">
      <span class="scan-icon" aria-hidden="true">${cubeIcon()}</span>
      <div class="scan-identity">
        <h3 id="${projectLabelId}" title="${escapeHtml(result.projectName)}">${escapeHtml(result.projectName)}</h3>
        <span>${result.type.toUpperCase()} · ${escapeHtml(formattedDate)}</span>
      </div>
    </div>

    <div class="scan-metrics">
      <span class="metric-chip" aria-label="${escapeHtml(metricAriaLabel)}">${escapeHtml(scanMetricLabel(result))}</span>
      <span class="finding-chip" aria-label="${escapeHtml(findingAriaLabel)}">${escapeHtml(scanFindingLabel(result))}</span>
      <span class="trend-chip ${trend.kind}" role="img" aria-label="${escapeHtml(trend.label)}" title="${escapeHtml(trend.label)}">${trendIcon(trend.kind)}<span aria-hidden="true">${escapeHtml(trend.symbol)}</span></span>
    </div>

    ${renderSeverityBreakdown(result, counts)}

    <div class="result-actions">
      <button type="button" data-command="runtz.openLastScan" data-scan-key="${scanKey}" aria-label="${escapeHtml(openAriaLabel)}">
        <span>Open in Runtz</span><span aria-hidden="true">↗</span>
      </button>
    </div>
  </article>`
}

function trendIcon(kind: ScanTrend["kind"]): string {
  const paths =
    kind === "increased"
      ? `<path d="M16 7h6v6"></path><path d="m22 7-8.5 8.5-5-5L2 17"></path>`
      : kind === "decreased"
        ? `<path d="M16 17h6v-6"></path><path d="m22 17-8.5-8.5-5 5L2 7"></path>`
        : ""

  return paths
    ? `<svg class="trend-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${paths}</svg>`
    : ""
}

function renderSeverityBreakdown(
  result: ScanResult,
  counts: SeverityCounts
): string {
  const chartTotal = Math.max(
    1,
    SEVERITY_KEYS.reduce((total, key) => total + counts[key], 0)
  )
  let offset = 0
  const segments = SEVERITY_KEYS.flatMap((key) => {
    const count = counts[key]
    if (count === 0) {
      return []
    }
    const segment = `<rect class="severity-${key}" x="${offset}" y="0" width="${count}" height="6"></rect>`
    offset += count
    return segment
  }).join("")
  const legend = SEVERITY_KEYS.map(
    (key) => `<div class="severity-stat" title="${SEVERITY_LABELS[key]}: ${counts[key]}">
      <span class="severity-marker severity-${key}"></span>
      <span class="severity-value">${counts[key]}</span>
    </div>`
  ).join("")

  return `<div class="severity-breakdown" role="img" aria-label="${escapeHtml(severitySummary(result, counts))}">
    <svg class="severity-track" viewBox="0 0 ${chartTotal} 6" preserveAspectRatio="none" aria-hidden="true" focusable="false">
      <rect class="severity-background" x="0" y="0" width="${chartTotal}" height="6"></rect>
      ${segments}
    </svg>
    <div class="severity-counts" aria-hidden="true">${legend}</div>
  </div>`
}

function emptyStateCopy(): { title: string; description: string } {
  if (!vscode.workspace.workspaceFolders?.length) {
    return {
      title: "No folder open.",
      description: "Open a project to run Runtz scans.",
    }
  }
  if (!vscode.workspace.isTrusted) {
    return {
      title: "Restricted Mode.",
      description: "Trust this workspace to enable Runtz scans.",
    }
  }
  return {
    title: "No scans yet for this workspace.",
    description: "Right-click a folder or supported manifest to run a scan.",
  }
}

function cubeIcon(): string {
  return `<svg viewBox="0 0 24 24" focusable="false" aria-hidden="true">
    <path d="M12 3 20 7.5v9L12 21l-8-4.5v-9L12 3Z"></path>
    <path d="m4.4 7.7 7.6 4.2 7.6-4.2M12 12v8.5"></path>
  </svg>`
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;")
}
