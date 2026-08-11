import { constants as fsConstants } from "node:fs"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"

import { isSupportedScaManifest } from "./constants"
import type { ScanType } from "./types"

const SAST_EXTENSIONS = new Set([
  ".cs",
  ".go",
  ".java",
  ".js",
  ".jsx",
  ".kt",
  ".kts",
  ".mjs",
  ".cjs",
  ".php",
  ".py",
  ".rb",
  ".rs",
  ".ts",
  ".tsx",
])

const IGNORED_DIRECTORIES = new Set([
  ".cache",
  ".git",
  ".next",
  ".terraform",
  ".venv",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "target",
  "vendor",
  "venv",
])

const URL_PATTERN =
  /(?:git\+)?(?:https?|ssh):\/\/[^\s"'<>]+|(?:git|ftp):\/\/[^\s"'<>]+/gi
const MAX_MANIFEST_BYTES = 10 * 1024 * 1024

export class UnsafeScanTargetError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "UnsafeScanTargetError"
  }
}

export type SafeScaSnapshot = {
  path: string
  dispose: () => Promise<void>
}

export async function resolveSafeScanTarget(
  type: ScanType,
  workspaceRoot: string,
  targetPath: string
): Promise<string> {
  const targetLinkStat = await fs.lstat(targetPath)
  if (targetLinkStat.isSymbolicLink()) {
    throw new UnsafeScanTargetError(
      "For security, select a real folder or manifest, not a symbolic link."
    )
  }

  const [canonicalWorkspace, canonicalTarget] = await Promise.all([
    fs.realpath(workspaceRoot),
    fs.realpath(targetPath),
  ])
  if (!isInside(canonicalTarget, canonicalWorkspace)) {
    throw new UnsafeScanTargetError(
      "The selected target resolves outside the workspace."
    )
  }

  const stat = await fs.stat(canonicalTarget)
  if (type === "sast") {
    if (!stat.isDirectory()) {
      throw new UnsafeScanTargetError(
        "A Runtz SAST scan must be started from a folder."
      )
    }
    await rejectScannableSymlinks(canonicalTarget)
  } else {
    if (!stat.isFile() || !isSupportedScaManifest(canonicalTarget)) {
      throw new UnsafeScanTargetError(
        "Select a dependency manifest supported by the Runtz CLI."
      )
    }
    await rejectManifestCredentials(canonicalTarget, stat.size)
  }
  return canonicalTarget
}

export function containsEmbeddedUrlCredentials(value: string): boolean {
  const decodedValue = decodeTextualEscapes(value)
  for (const match of decodedValue.matchAll(URL_PATTERN)) {
    const rawUrl = trimUrlPunctuation(match[0])
    try {
      const url = new URL(rawUrl)
      const protocol = url.protocol.toLowerCase()
      const ordinarySshUser =
        (protocol === "ssh:" || protocol === "git+ssh:") &&
        url.username === "git"
      if (url.password || (url.username && !ordinarySshUser)) {
        return true
      }
      for (const [key, queryValue] of url.searchParams) {
        if (queryValue && isSensitiveParameter(key)) {
          return true
        }
      }
      const fragment = new URLSearchParams(url.hash.replace(/^#/, ""))
      for (const [key, fragmentValue] of fragment) {
        if (fragmentValue && isSensitiveParameter(key)) {
          return true
        }
      }
    } catch {
      // The CLI parser will report malformed manifests. This preflight only
      // blocks URL shapes that can be confidently identified as credentials.
    }
  }
  return false
}

export async function createSafeScaSnapshot(
  manifestPath: string
): Promise<SafeScaSnapshot> {
  const beforeOpen = await fs.lstat(manifestPath)
  if (beforeOpen.isSymbolicLink() || !beforeOpen.isFile()) {
    throw new UnsafeScanTargetError(
      "The manifest changed before the scan. Select a real file again."
    )
  }

  const noFollow = "O_NOFOLLOW" in fsConstants ? fsConstants.O_NOFOLLOW : 0
  const handle = await fs.open(manifestPath, fsConstants.O_RDONLY | noFollow)
  let contents: Buffer
  try {
    const opened = await handle.stat()
    if (
      !opened.isFile() ||
      opened.dev !== beforeOpen.dev ||
      opened.ino !== beforeOpen.ino
    ) {
      throw new UnsafeScanTargetError(
        "The manifest changed during the security check. Try again."
      )
    }
    if (opened.size > MAX_MANIFEST_BYTES) {
      throw new UnsafeScanTargetError(
        "The selected manifest is too large for a safe security check."
      )
    }
    contents = await handle.readFile()
  } finally {
    await handle.close()
  }

  rejectCredentialContent(contents.toString("utf8"))

  const temporaryRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "runtz-vscode-sca-")
  )
  try {
    const projectName = path.basename(path.dirname(manifestPath)) || "project"
    const snapshotDirectory = path.join(temporaryRoot, projectName)
    const snapshotPath = path.join(snapshotDirectory, path.basename(manifestPath))
    await fs.mkdir(snapshotDirectory, { mode: 0o700 })
    await fs.writeFile(snapshotPath, contents, { mode: 0o600 })
    return {
      path: snapshotPath,
      dispose: () => fs.rm(temporaryRoot, { recursive: true, force: true }),
    }
  } catch (error) {
    await fs.rm(temporaryRoot, { recursive: true, force: true })
    throw error
  }
}

function isInside(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate)
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  )
}

async function rejectScannableSymlinks(root: string): Promise<void> {
  const directory = await fs.opendir(root)
  for await (const entry of directory) {
    const entryPath = path.join(root, entry.name)
    if (entry.isDirectory()) {
      if (!IGNORED_DIRECTORIES.has(entry.name)) {
        await rejectScannableSymlinks(entryPath)
      }
      continue
    }
    if (
      entry.isSymbolicLink() &&
      SAST_EXTENSIONS.has(path.extname(entry.name).toLowerCase())
    ) {
      throw new UnsafeScanTargetError(
        `The scan was stopped because ${entryPath} is a symbolic link to source code.`
      )
    }
  }
}

async function rejectManifestCredentials(
  manifestPath: string,
  size: number
): Promise<void> {
  if (size > MAX_MANIFEST_BYTES) {
    throw new UnsafeScanTargetError(
      "The selected manifest is too large for a safe security check."
    )
  }
  const contents = await fs.readFile(manifestPath, "utf8")
  rejectCredentialContent(contents)
}

function trimUrlPunctuation(value: string): string {
  return value.replace(/[),.;\]}]+$/, "")
}

function rejectCredentialContent(contents: string): void {
  if (containsEmbeddedUrlCredentials(contents)) {
    throw new UnsafeScanTargetError(
      "The manifest appears to contain credentials in a dependency URL. Remove the secret before running the SCA scan."
    )
  }
}

function decodeTextualEscapes(value: string): string {
  return value
    .replace(/\\\//g, "/")
    .replace(/\\u\{([0-9a-f]{1,6})\}/gi, (_, code: string) =>
      safeCodePoint(code)
    )
    .replace(/\\u([0-9a-f]{4})/gi, (_, code: string) => safeCodePoint(code))
    .replace(/\\U([0-9a-f]{8})/g, (_, code: string) => safeCodePoint(code))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => safeCodePoint(code))
    .replace(/&#([0-9]+);/g, (_, code: string) => safeCodePoint(code, 10))
    .replace(/&amp;/gi, "&")
}

function safeCodePoint(value: string, radix = 16): string {
  const codePoint = Number.parseInt(value, radix)
  try {
    return String.fromCodePoint(codePoint)
  } catch {
    return ""
  }
}

function isSensitiveParameter(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "")
  return (
    /(?:^|api|access|private|secret)key$/.test(normalized) ||
    /(auth|authorization|credential|password|passwd|secret|sig|signature|token)$/.test(
      normalized
    )
  )
}
