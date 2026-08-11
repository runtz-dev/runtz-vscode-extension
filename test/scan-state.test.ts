import { describe, expect, it } from "vitest"

import {
  completeScanState,
  previousTotal,
  RECENT_SCAN_LIMIT,
  readScanResult,
  readScanState,
  scanHistoryKey,
} from "../src/scan-state"
import type { ScanResult } from "../src/types"

describe("scan state", () => {
  it("prepends the newest scan and updates its trend baseline", () => {
    const key = scanHistoryKey("sca", "file:///workspace-a", "package.json")
    const older = scan({ scanId: "older", total: 4 })
    const newest = scan({ scanId: "newest", total: 9 })
    const next = completeScanState(
      { recentScans: [older], totals: { existing: 4 } },
      key,
      newest
    )

    expect(next.recentScans.map((result) => result.scanId)).toEqual([
      "newest",
      "older",
    ])
    expect(next.totals).toEqual({ existing: 4, [key]: 9 })
    expect(previousTotal(next, key)).toBe(9)
  })

  it("keeps only four scans in newest-first order", () => {
    const key = scanHistoryKey("sca", "file:///workspace", "package.json")
    let state = readScanState(undefined)

    for (let index = 1; index <= RECENT_SCAN_LIMIT + 2; index += 1) {
      state = completeScanState(
        state,
        key,
        scan({ scanId: `scan-${index}`, total: index })
      )
    }

    expect(state.recentScans.map((result) => result.scanId)).toEqual([
      "scan-6",
      "scan-5",
      "scan-4",
      "scan-3",
    ])
  })

  it("preserves repeated scans for the same project without deduplicating", () => {
    const key = scanHistoryKey("sca", "file:///workspace", "package.json")
    const first = scan({ scanId: "first" })
    const second = scan({ scanId: "second" })

    const state = completeScanState(
      completeScanState(readScanState(undefined), key, first),
      key,
      second
    )

    expect(state.recentScans).toHaveLength(2)
    expect(state.recentScans.map((result) => result.scanId)).toEqual([
      "second",
      "first",
    ])
    expect(state.recentScans.every((result) => result.projectName === "frontend"))
      .toBe(true)
  })

  it("reads valid history items individually, caps them, and preserves valid totals", () => {
    const persistedScans = [
      scan({ scanId: "one" }),
      { ...scan({ scanId: "invalid" }), total: -1 },
      scan({ scanId: "two" }),
      scan({ scanId: "three" }),
      scan({ scanId: "four" }),
      scan({ scanId: "five" }),
    ]

    const state = readScanState({
      recentScans: persistedScans,
      totals: { valid: 2, negative: -1, fractional: 1.5, text: "3" },
    })

    expect(state.recentScans.map((result) => result.scanId)).toEqual([
      "one",
      "two",
      "three",
      "four",
    ])
    expect(state.totals).toEqual({ valid: 2 })
  })

  it("migrates an inline legacy lastScan when no valid history exists", () => {
    const legacy = scan({ scanId: "inline-legacy" })

    expect(
      readScanState({ recentScans: [{ total: -1 }], lastScan: legacy }).recentScans
    ).toEqual([legacy])
  })

  it("migrates a separately persisted legacy scan as the final fallback", () => {
    const separateLegacy = scan({ scanId: "separate-legacy" })

    expect(readScanState(undefined, separateLegacy).recentScans).toEqual([
      separateLegacy,
    ])
    expect(
      readScanState(
        { lastScan: scan({ scanId: "inline-legacy" }) },
        separateLegacy
      ).recentScans[0]?.scanId
    ).toBe("inline-legacy")
  })

  it("keeps trend baselines independent from the bounded scan history", () => {
    const oldKey = scanHistoryKey("sast", "file:///workspace", "old-service")
    const activeKey = scanHistoryKey("sca", "file:///workspace", "package.json")
    let state = {
      recentScans: Array.from({ length: RECENT_SCAN_LIMIT }, (_, index) =>
        scan({ scanId: `existing-${index}` })
      ),
      totals: { [oldKey]: 17, [activeKey]: 3 },
    }

    state = completeScanState(state, activeKey, scan({ scanId: "new", total: 8 }))

    expect(state.recentScans).toHaveLength(RECENT_SCAN_LIMIT)
    expect(previousTotal(state, oldKey)).toBe(17)
    expect(previousTotal(state, activeKey)).toBe(8)
  })

  it("keeps equal display paths in separate workspace roots isolated", () => {
    const first = scanHistoryKey("sast", "file:///workspace-a", "services/api")
    const second = scanHistoryKey("sast", "file:///workspace-b", "services/api")

    expect(first).not.toBe(second)
  })

  it("normalizes target separators and rejects malformed persisted scans", () => {
    expect(scanHistoryKey("sca", "file:///workspace", "apps\\web\\package.json"))
      .toBe(scanHistoryKey("sca", "file:///workspace", "apps/web/package.json"))
    expect(readScanResult({ total: -1 })).toBeUndefined()
    expect(readScanState({ totals: { valid: 2, invalid: -1 } }).totals).toEqual({
      valid: 2,
    })
  })
})

function scan(overrides: Partial<ScanResult> = {}): ScanResult {
  return {
    type: "sca",
    projectName: "frontend",
    createdAt: "2026-08-11T12:00:00.000Z",
    total: 9,
    dependencies: 28,
    severities: {
      critical: 0,
      high: 4,
      medium: 5,
      low: 0,
      unknown: 0,
    },
    ...overrides,
  }
}
