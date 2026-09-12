import { describe, expect, it } from "vitest"

import {
  buildApiKeysUrl,
  buildOverviewUrl,
  buildScanDetailsUrl,
  buildScanTypeUrl,
  normalizeBaseUrl,
} from "../src/platform"

describe("platform URLs", () => {
  it("builds cloud routes", () => {
    expect(buildOverviewUrl("https://runtz.dev")).toBe(
      "https://runtz.dev/overview"
    )
    expect(buildScanTypeUrl("https://runtz.dev", "sca")).toBe(
      "https://runtz.dev/sca"
    )
    expect(buildApiKeysUrl("https://runtz.dev/")).toBe(
      "https://runtz.dev/api-keys"
    )
  })

  it("encodes project names, scan IDs, and preserves a self-hosted base path", () => {
    expect(
      buildScanDetailsUrl("https://security.example.com/runtz", {
        type: "sast",
        projectName: "checkout api/worker",
        scanId: "scan/id ?42",
      })
    ).toBe(
      "https://security.example.com/runtz/sast/checkout%20api%2Fworker?scanId=scan%2Fid+%3F42"
    )
  })

  it("falls back to the latest project scan for legacy results without an ID", () => {
    expect(
      buildScanDetailsUrl("https://runtz.dev", {
        type: "sca",
        projectName: "frontend",
      })
    ).toBe("https://runtz.dev/sca/frontend")
  })

  it("rejects unsafe URL shapes", () => {
    expect(() => normalizeBaseUrl("javascript:alert(1)", "URL")).toThrow()
    expect(() => normalizeBaseUrl("https://user:pass@runtz.dev", "URL")).toThrow()
    expect(() => normalizeBaseUrl("https://runtz.dev?token=secret", "URL")).toThrow()
    expect(() => normalizeBaseUrl("http://192.168.1.20:8080", "URL")).toThrow(
      "must use https"
    )
  })

  it("allows HTTP only for loopback development endpoints", () => {
    expect(normalizeBaseUrl("http://localhost:8080", "URL")).toBe(
      "http://localhost:8080"
    )
    expect(normalizeBaseUrl("http://127.0.0.1:8080", "URL")).toBe(
      "http://127.0.0.1:8080"
    )
    expect(normalizeBaseUrl("http://[::1]:8080", "URL")).toBe(
      "http://[::1]:8080"
    )
  })

  it("normalizes repeated trailing slashes", () => {
    expect(normalizeBaseUrl("https://runtz.dev///", "URL")).toBe(
      "https://runtz.dev"
    )
  })
})
