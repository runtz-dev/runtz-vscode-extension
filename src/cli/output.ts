import type { ParsedCliScan, SeverityCounts } from "../types"

const EMPTY_SEVERITIES: SeverityCounts = {
  critical: 0,
  high: 0,
  medium: 0,
  low: 0,
  unknown: 0,
}

export class CliOutputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "CliOutputError"
  }
}

export function parseCliScanOutput(stdout: string): ParsedCliScan {
  const projectName = matchText(stdout, /^Project:\s*(.+)$/m)
  const findings = matchNumber(stdout, /^Findings:\s*(\d+)$/m)
  const vulnerabilities = matchNumber(stdout, /^Vulnerabilities:\s*(\d+)$/m)
  const total = findings ?? vulnerabilities

  if (!projectName || total === undefined) {
    throw new CliOutputError(
      "The CLI completed but returned an unrecognized result format. Update the Runtz CLI and try again."
    )
  }

  const scanId = matchText(stdout, /^Scan ID:\s*(\S+)$/m)
  const severityLine = matchText(stdout, /^Severity gate:\s*(.+)$/m)
  const result: ParsedCliScan = {
    ...(scanId ? { scanId } : {}),
    projectName,
    total,
    severities: severityLine
      ? parseSeverityCounts(severityLine)
      : { ...EMPTY_SEVERITIES },
  }
  const files = matchNumber(stdout, /^Files:\s*(\d+)$/m)
  const manifests = matchNumber(stdout, /^Manifests:\s*(\d+)$/m)
  const dependencies = matchNumber(stdout, /^Dependencies:\s*(\d+)$/m)
  if (files !== undefined) {
    result.files = files
  }
  if (manifests !== undefined) {
    result.manifests = manifests
  }
  if (dependencies !== undefined) {
    result.dependencies = dependencies
  }
  return result
}

function parseSeverityCounts(value: string): SeverityCounts {
  const counts = { ...EMPTY_SEVERITIES }
  const matches = value.matchAll(/\b(critical|high|medium|low|unknown)=(\d+)\b/g)
  for (const match of matches) {
    const severity = match[1] as keyof SeverityCounts
    counts[severity] = Number.parseInt(match[2] ?? "0", 10)
  }
  return counts
}

function matchText(value: string, pattern: RegExp): string | undefined {
  return value.match(pattern)?.[1]?.trim()
}

function matchNumber(value: string, pattern: RegExp): number | undefined {
  const matched = matchText(value, pattern)
  return matched === undefined ? undefined : Number.parseInt(matched, 10)
}
