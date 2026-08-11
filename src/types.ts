export type ScanType = "sast" | "sca"

export type SeverityCounts = {
  critical: number
  high: number
  medium: number
  low: number
  unknown: number
}

export type ScanResult = {
  type: ScanType
  scanId?: string
  projectName: string
  createdAt: string
  total: number
  previousTotal?: number
  files?: number
  manifests?: number
  dependencies?: number
  severities: SeverityCounts
}

export type ParsedCliScan = Omit<ScanResult, "type" | "createdAt">
