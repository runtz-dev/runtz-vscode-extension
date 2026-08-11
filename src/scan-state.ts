import type { ScanResult, ScanType, SeverityCounts } from "./types"

export const RECENT_SCAN_LIMIT = 4

export type ScanState = {
  recentScans: ScanResult[]
  totals: Record<string, number>
}

export function readScanState(
  value: unknown,
  legacyLastScan?: unknown
): ScanState {
  const persisted = isRecord(value) ? value : undefined
  const recentScans = Array.isArray(persisted?.recentScans)
    ? persisted.recentScans
        .map(readScanResult)
        .filter((scan): scan is ScanResult => scan !== undefined)
        .slice(0, RECENT_SCAN_LIMIT)
    : []

  if (recentScans.length === 0) {
    const migratedScan =
      readScanResult(persisted?.lastScan) ?? readScanResult(legacyLastScan)
    if (migratedScan) {
      recentScans.push(migratedScan)
    }
  }

  return {
    recentScans,
    totals: readScanTotals(persisted?.totals),
  }
}

export function readScanResult(value: unknown): ScanResult | undefined {
  if (!isRecord(value)) {
    return undefined
  }
  if (
    (value.type !== "sast" && value.type !== "sca") ||
    typeof value.projectName !== "string" ||
    typeof value.createdAt !== "string" ||
    !isNonNegativeInteger(value.total) ||
    !isSeverityCounts(value.severities)
  ) {
    return undefined
  }
  if (
    !isOptionalNonNegativeInteger(value.previousTotal) ||
    !isOptionalNonNegativeInteger(value.files) ||
    !isOptionalNonNegativeInteger(value.manifests) ||
    !isOptionalNonNegativeInteger(value.dependencies) ||
    (value.scanId !== undefined && typeof value.scanId !== "string")
  ) {
    return undefined
  }
  return value as ScanResult
}

export function readScanTotals(value: unknown): Record<string, number> {
  if (!isRecord(value)) {
    return {}
  }
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, number] => isNonNegativeInteger(entry[1])
    )
  )
}

export function completeScanState(
  current: ScanState,
  historyKey: string,
  result: ScanResult
): ScanState {
  return {
    recentScans: [result, ...current.recentScans].slice(0, RECENT_SCAN_LIMIT),
    totals: { ...current.totals, [historyKey]: result.total },
  }
}

export function previousTotal(
  current: ScanState,
  historyKey: string
): number | undefined {
  return current.totals[historyKey]
}

export function scanHistoryKey(
  type: ScanType,
  workspaceUri: string,
  relativeTarget: string
): string {
  return JSON.stringify([
    type,
    workspaceUri,
    relativeTarget.replaceAll("\\", "/"),
  ])
}

function isSeverityCounts(value: unknown): value is SeverityCounts {
  if (!isRecord(value)) {
    return false
  }
  return ["critical", "high", "medium", "low", "unknown"].every((key) =>
    isNonNegativeInteger(value[key])
  )
}

function isOptionalNonNegativeInteger(value: unknown): boolean {
  return value === undefined || isNonNegativeInteger(value)
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}
