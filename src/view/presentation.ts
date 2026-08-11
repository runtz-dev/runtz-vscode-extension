import type { ScanResult, SeverityCounts } from "../types"

export const SEVERITY_KEYS = [
  "critical",
  "high",
  "medium",
  "low",
  "unknown",
] as const

export type SeverityKey = (typeof SEVERITY_KEYS)[number]

export type ScanTrend = {
  kind: "increased" | "decreased" | "stable" | "new"
  label: string
  symbol: string
}

export function scanMetricLabel(result: ScanResult): string {
  if (result.type === "sca") {
    return `${result.dependencies ?? 0} deps`
  }
  const count = result.files ?? 0
  return `${count} ${count === 1 ? "file" : "files"}`
}

export function scanFindingLabel(result: ScanResult): string {
  const singular = result.type === "sca" ? "vuln" : "finding"
  const plural = result.type === "sca" ? "vulns" : "findings"
  return `${result.total} ${result.total === 1 ? singular : plural}`
}

export function scanTrend(result: ScanResult): ScanTrend {
  if (result.previousTotal === undefined) {
    return { kind: "new", label: "No previous scan", symbol: "New" }
  }
  const delta = result.total - result.previousTotal
  const singular = result.type === "sca" ? "vulnerability" : "finding"
  const plural = result.type === "sca" ? "vulnerabilities" : "findings"
  if (delta > 0) {
    return {
      kind: "increased",
      label: `${delta} more ${delta === 1 ? singular : plural} than the previous scan`,
      symbol: `+${delta}`,
    }
  }
  if (delta < 0) {
    const improvement = Math.abs(delta)
    return {
      kind: "decreased",
      label: `${improvement} fewer ${improvement === 1 ? singular : plural} than the previous scan`,
      symbol: `-${improvement}`,
    }
  }
  return { kind: "stable", label: "No change since the previous scan", symbol: "−" }
}

export function formatScanDate(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return "Unknown time"
  }
  return new Intl.DateTimeFormat("en-US", {
    year: "2-digit",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date)
}

export function effectiveSeverityCounts(result: ScanResult): SeverityCounts {
  const counts = { ...result.severities }
  const reported = SEVERITY_KEYS.reduce((total, key) => total + counts[key], 0)
  if (result.total > reported) {
    counts.unknown += result.total - reported
  }
  return counts
}

export function severitySummary(
  result: ScanResult,
  counts: SeverityCounts
): string {
  const noun = result.type === "sca" ? "vulnerabilities" : "findings"
  return `${result.total} ${noun}: ${counts.critical} critical, ${counts.high} high, ${counts.medium} medium, ${counts.low} low, ${counts.unknown} unknown`
}

export function unreadCountAfterScan(
  currentUnread: number,
  viewVisible: boolean
): number {
  return viewVisible ? 0 : currentUnread + 1
}
