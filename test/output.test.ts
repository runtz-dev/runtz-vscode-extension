import { describe, expect, it } from "vitest"

import { CliOutputError, parseCliScanOutput } from "../src/cli/output"

describe("parseCliScanOutput", () => {
  it("parses a SAST scan with severity counts", () => {
    const result = parseCliScanOutput(`SAST scan completed and sent to Runtz Platform.
Project: storefront
Files: 42
Findings: 7
Scan ID: 66f1c7a8
Severity gate: critical=2 high=3 medium=1 low=1 unknown=0
`)

    expect(result).toEqual({
      projectName: "storefront",
      files: 42,
      total: 7,
      scanId: "66f1c7a8",
      severities: {
        critical: 2,
        high: 3,
        medium: 1,
        low: 1,
        unknown: 0,
      },
    })
  })

  it("parses a multi-language SCA scan", () => {
    const result = parseCliScanOutput(`SCA scan completed and sent to Runtz Platform.
Project: payments-api
Manifests: 3
Dependencies: 88
Vulnerabilities: 4
Scan ID: 66f1c7b9
Severity gate: critical=1 high=2 medium=1 low=0
`)

    expect(result).toEqual({
      projectName: "payments-api",
      manifests: 3,
      dependencies: 88,
      total: 4,
      scanId: "66f1c7b9",
      severities: {
        critical: 1,
        high: 2,
        medium: 1,
        low: 0,
        unknown: 0,
      },
    })
  })

  it("keeps working with CLI versions that do not print severity gates", () => {
    const result = parseCliScanOutput(`Project: demo
Files: 2
Findings: 0
Scan ID: abc
`)

    expect(result.total).toBe(0)
    expect(result.severities).toEqual({
      critical: 0,
      high: 0,
      medium: 0,
      low: 0,
      unknown: 0,
    })
  })

  it("rejects an unrecognized successful output", () => {
    expect(() => parseCliScanOutput("done")).toThrow(CliOutputError)
  })
})
