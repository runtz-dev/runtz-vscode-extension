export const DEFAULT_ENDPOINT = "https://engine.runtz.dev"
export const DEFAULT_PLATFORM_URL = "https://runtz.dev"
export const TOKEN_SECRET_KEY = "runtz.apiToken"
export const TOKEN_ENDPOINT_SECRET_KEY = "runtz.apiTokenEndpoint"
export const SCAN_STATE_KEY = "runtz.scanState"
export const LEGACY_LAST_SCAN_STATE_KEY = "runtz.lastScan"
export const LEGACY_SCAN_TOTALS_STATE_KEY = "runtz.scanTotals"
export const ACCESS_WORKSPACE_STATE_KEY = "runtz.accessWorkspace"

export const SUPPORTED_SCA_MANIFESTS = [
  "package.json",
  "requirements.txt",
  "go.mod",
  "pom.xml",
  "gemfile.lock",
  "composer.json",
  "cargo.toml",
] as const

export function isSupportedScaManifest(path: string): boolean {
  const normalized = path.replaceAll("\\", "/")
  const base = normalized.slice(normalized.lastIndexOf("/") + 1).toLowerCase()
  return SUPPORTED_SCA_MANIFESTS.includes(
    base as (typeof SUPPORTED_SCA_MANIFESTS)[number]
  ) || base.endsWith(".csproj")
}
