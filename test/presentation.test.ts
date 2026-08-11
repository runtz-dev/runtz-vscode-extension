import { describe, expect, it } from "vitest"

import {
  effectiveSeverityCounts,
  formatScanDate,
  scanFindingLabel,
  scanMetricLabel,
  scanTrend,
  severitySummary,
  unreadCountAfterScan,
} from "../src/view/presentation"
import type { ScanResult } from "../src/types"

describe("scan presentation", () => {
  it("uses scan-specific metric and finding labels", () => {
    expect(scanMetricLabel(scan({ type: "sca", dependencies: 28 }))).toBe(
      "28 deps"
    )
    expect(scanFindingLabel(scan({ type: "sca", total: 1 }))).toBe("1 vuln")
    expect(scanMetricLabel(scan({ type: "sast", files: 1 }))).toBe("1 file")
    expect(scanFindingLabel(scan({ type: "sast", total: 4 }))).toBe(
      "4 findings"
    )
  })

  it("describes increased, decreased, stable, and first scans", () => {
    expect(scanTrend(scan({ total: 9, previousTotal: 8 }))).toMatchObject({
      kind: "increased",
      label: "1 more vulnerability than the previous scan",
      symbol: "+1",
    })
    expect(scanTrend(scan({ total: 7, previousTotal: 9 }))).toMatchObject({
      kind: "decreased",
      label: "2 fewer vulnerabilities than the previous scan",
      symbol: "-2",
    })
    expect(scanTrend(scan({ total: 9, previousTotal: 9 }))).toMatchObject({
      kind: "stable",
      symbol: "−",
    })
    expect(scanTrend(scan({ total: 9 }))).toEqual({
      kind: "new",
      label: "No previous scan",
      symbol: "New",
    })
  })

  it("accounts for findings without a CLI severity breakdown", () => {
    const result = scan({ total: 3 })
    const counts = effectiveSeverityCounts(result)

    expect(counts.unknown).toBe(3)
    expect(severitySummary(result, counts)).toContain("3 unknown")
  })

  it("formats dates in English and handles invalid state", () => {
    expect(formatScanDate("2026-08-11T12:00:00.000Z")).toMatch(/^8\/11\/26, /u)
    expect(formatScanDate("invalid")).toBe("Unknown time")
  })

  it("increments unread results only while the Runtz view is hidden", () => {
    expect(unreadCountAfterScan(0, false)).toBe(1)
    expect(unreadCountAfterScan(2, false)).toBe(3)
    expect(unreadCountAfterScan(2, true)).toBe(0)
  })
})

function scan(overrides: Partial<ScanResult>): ScanResult {
  return {
    type: "sca",
    projectName: "frontend",
    createdAt: "2026-08-11T12:00:00.000Z",
    total: 0,
    severities: {
      critical: 0,
      high: 0,
      medium: 0,
      low: 0,
      unknown: 0,
    },
    ...overrides,
  }
}
