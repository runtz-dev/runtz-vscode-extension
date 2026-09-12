import type { ScanResult, ScanType } from "./types"

export function normalizeBaseUrl(value: string, label: string): string {
  let url: URL
  try {
    url = new URL(value.trim())
  } catch {
    throw new Error(`${label} is invalid.`)
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`${label} must use http or https.`)
  }
  if (url.protocol === "http:" && !isLoopbackHost(url.hostname)) {
    throw new Error(`${label} must use https outside localhost.`)
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(`${label} cannot contain credentials, query parameters, or fragments.`)
  }

  url.pathname = url.pathname.replace(/\/+$/, "")
  return url.toString().replace(/\/$/, "")
}

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase()
  return (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized === "[::1]" ||
    /^127(?:\.\d{1,3}){3}$/.test(normalized)
  )
}

export function buildOverviewUrl(platformUrl: string): string {
  return appendPath(platformUrl, "overview")
}

export function buildScanTypeUrl(platformUrl: string, type: ScanType): string {
  return appendPath(platformUrl, type)
}

export function buildScanDetailsUrl(
  platformUrl: string,
  result: Pick<ScanResult, "type" | "projectName" | "scanId">
): string {
  const url = new URL(
    appendPath(platformUrl, result.type, result.projectName)
  )
  const scanId = result.scanId?.trim()
  if (scanId) {
    url.searchParams.set("scanId", scanId)
  }
  return url.toString()
}

export function buildApiKeysUrl(platformUrl: string): string {
  return appendPath(platformUrl, "api-keys")
}

function appendPath(base: string, ...segments: string[]): string {
  const url = new URL(normalizeBaseUrl(base, "Platform URL"))
  const prefix = url.pathname.replace(/\/$/, "")
  const suffix = segments.map((segment) => encodeURIComponent(segment)).join("/")
  url.pathname = `${prefix}/${suffix}`.replace(/\/+/g, "/")
  return url.toString()
}
