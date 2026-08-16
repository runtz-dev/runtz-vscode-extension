import { spawn, type ChildProcess } from "node:child_process"
import { constants as fsConstants } from "node:fs"
import * as fs from "node:fs/promises"
import * as path from "node:path"

import type * as vscode from "vscode"

import { parseCliScanOutput } from "./output"
import type { ParsedCliScan, ScanType } from "../types"

const MAX_CAPTURE_LENGTH = 1_000_000
const MAX_THRESHOLD = "2147483647"
// ANSI escape sequences necessarily contain the ESC control character.
// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /\u001B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g

type ProcessOptions = {
  cwd?: string
  env?: NodeJS.ProcessEnv
  input?: string
  output?: vscode.OutputChannel
  cancellation?: vscode.CancellationToken
  timeoutMs?: number
  redactions?: string[]
}

type ProcessResult = {
  code: number
  stdout: string
  stderr: string
}

export type RunCliScanOptions = {
  executable: string
  type: ScanType
  targetPath: string
  source: string
  cwd: string
  output: vscode.OutputChannel
  cancellation: vscode.CancellationToken
}

export type CliInstallation = {
  executable: string
  version: string
}

export type CliAuthStatus = {
  authenticated: boolean
  verified: boolean
  workspace?: {
    id?: string
    name: string
  }
  apiKey?: {
    name?: string
    prefix?: string
    expiresAt?: string
  }
  endpoint: string
  tokenSource?: string
}

export class CliNotFoundError extends Error {
  constructor(executable: string) {
    super(`Runtz CLI not found at “${executable}”.`)
    this.name = "CliNotFoundError"
  }
}

export class CliCancelledError extends Error {
  constructor() {
    super("Scan cancelled.")
    this.name = "CliCancelledError"
  }
}

export class CliRunError extends Error {
  readonly exitCode: number | undefined

  constructor(message: string, exitCode?: number) {
    super(message)
    this.name = "CliRunError"
    this.exitCode = exitCode
  }
}

export async function probeCli(executable: string): Promise<string> {
  const result = await runProcess(executable, ["version"], {
    timeoutMs: 5_000,
    env: safeChildEnvironment(),
  })
  if (result.code !== 0) {
    throw new CliRunError(
      lastUsefulLine(result.stderr) || "Could not query the Runtz CLI version.",
      result.code
    )
  }
  const version = result.stdout.match(/^runtz\s+(\S+)/m)?.[1]
  if (!version) {
    throw new CliRunError(
      "The configured executable did not return a valid Runtz CLI version."
    )
  }
  return version
}

export async function locateCli(
  configuredExecutable: string,
  blockedRoots: string[]
): Promise<CliInstallation> {
  const executable = await resolveCliExecutable(configuredExecutable, blockedRoots)
  const version = await probeCli(executable)
  return { executable, version }
}

export async function readCliAuthStatus(
  executable: string
): Promise<CliAuthStatus> {
  const result = await runProcess(executable, ["whoami", "--json"], {
    timeoutMs: 35_000,
    env: safeChildEnvironment(true),
  })
  if (result.code !== 0) {
    throw new CliRunError(
      authCommandError(result.stderr, result.stdout),
      result.code
    )
  }
  return parseCliAuthStatus(result.stdout)
}

export async function runCliLogin(
  executable: string,
  endpoint: string,
  token: string
): Promise<CliAuthStatus> {
  const result = await runProcess(
    executable,
    ["login", "--endpoint", endpoint],
    {
      timeoutMs: 35_000,
      env: safeChildEnvironment(true),
      input: `${token}\n`,
      redactions: [token],
    }
  )
  if (result.code !== 0) {
    const message = sanitizeOutput(
      lastUsefulLine(result.stderr) || lastUsefulLine(result.stdout) || "",
      [token]
    )
    throw new CliRunError(message || "Could not log in to Runtz.", result.code)
  }
  return readCliAuthStatus(executable)
}

export async function runCliLogout(executable: string): Promise<void> {
  const result = await runProcess(executable, ["logout"], {
    timeoutMs: 10_000,
    env: safeChildEnvironment(true),
  })
  if (result.code !== 0) {
    throw new CliRunError(
      lastUsefulLine(result.stderr) || "Could not log out of Runtz.",
      result.code
    )
  }
}

export async function runCliScan(
  options: RunCliScanOptions
): Promise<ParsedCliScan> {
  const args = [
    options.type,
    options.targetPath,
    "--source",
    options.source,
    "--critical-threshold",
    MAX_THRESHOLD,
    "--high-threshold",
    MAX_THRESHOLD,
    "--medium-threshold",
    MAX_THRESHOLD,
    "--low-threshold",
    MAX_THRESHOLD,
  ]

  options.output.appendLine("")
  options.output.appendLine(
    `[${new Date().toISOString()}] Starting ${options.type.toUpperCase()} scan for ${options.source}`
  )

  const result = await runProcess(options.executable, args, {
    cwd: options.cwd,
    cancellation: options.cancellation,
    output: options.output,
    env: {
      ...safeChildEnvironment(true),
      NO_COLOR: "1",
      RUNTZ_CRITICAL_THRESHOLD: "0",
      RUNTZ_HIGH_THRESHOLD: "0",
      RUNTZ_MEDIUM_THRESHOLD: "0",
      RUNTZ_LOW_THRESHOLD: "0",
    },
  })

  // Exit 3 means a severity gate fired after the scan was already stored. The
  // extension sets unreachable thresholds, but accepting a valid result keeps
  // compatibility with future CLI versions and platform limits.
  if (result.code !== 0 && result.code !== 3) {
    throw new CliRunError(
      lastUsefulLine(result.stderr) ||
        `The Runtz CLI exited with code ${result.code}.`,
      result.code
    )
  }

  return parseCliScanOutput(sanitizeOutput(result.stdout, undefined))
}

function runProcess(
  executable: string,
  args: string[],
  options: ProcessOptions
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess
    try {
      child = spawn(executable, args, {
        cwd: options.cwd,
        env: options.env,
        shell: false,
        detached: false,
        windowsHide: true,
        stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      })
    } catch (error) {
      reject(mapSpawnError(error, executable))
      return
    }

    let stdout = ""
    let stderr = ""
    let cancelled = false
    let timedOut = false
    let settled = false
    let forceKillTimer: NodeJS.Timeout | undefined
    let timeoutTimer: NodeJS.Timeout | undefined

    if (options.input !== undefined) {
      // The login token is written to the child's stdin, never argv or logs.
      // Ignore a broken pipe here and report the CLI's own exit and stderr.
      child.stdin?.on("error", () => undefined)
      child.stdin?.end(options.input)
    }

    const cancellationDisposable = options.cancellation?.onCancellationRequested(
      () => {
        cancelled = true
        forceKillTimer = terminateChild(child, () => {
          forceKillTimer = undefined
        })
      }
    )

    if (options.timeoutMs) {
      timeoutTimer = setTimeout(() => {
        timedOut = true
        forceKillTimer = terminateChild(child, () => {
          forceKillTimer = undefined
        })
      }, options.timeoutMs)
    }

    child.stdout?.on("data", (chunk: Buffer) => {
      const value = chunk.toString("utf8")
      stdout = appendCapped(stdout, value)
    })
    child.stderr?.on("data", (chunk: Buffer) => {
      const value = chunk.toString("utf8")
      stderr = appendCapped(stderr, value)
    })

    child.once("error", (error) => {
      finish(() => reject(mapSpawnError(error, executable)))
    })
    child.once("close", (code) => {
      appendOutput(options.output, stdout, options.redactions)
      appendOutput(options.output, stderr, options.redactions)
      finish(() => {
        if (cancelled) {
          reject(new CliCancelledError())
          return
        }
        if (timedOut) {
          reject(new CliRunError("The Runtz CLI did not respond in time."))
          return
        }
        resolve({ code: code ?? 1, stdout, stderr })
      })
    })

    function finish(callback: () => void): void {
      if (settled) {
        return
      }
      settled = true
      cancellationDisposable?.dispose()
      if (timeoutTimer) {
        clearTimeout(timeoutTimer)
      }
      if (forceKillTimer) {
        clearTimeout(forceKillTimer)
      }
      callback()
    }
  })
}

async function resolveCliExecutable(
  configuredExecutable: string,
  blockedRoots: string[]
): Promise<string> {
  const canonicalBlockedRoots = await Promise.all(
    blockedRoots.map(async (root) => {
      try {
        return await fs.realpath(root)
      } catch {
        return path.resolve(root)
      }
    })
  )
  const requested = configuredExecutable.trim()
  if (!requested) {
    throw new CliNotFoundError("runtz")
  }

  if (path.isAbsolute(requested)) {
    return validateExecutable(requested, canonicalBlockedRoots)
  }
  if (requested !== "runtz") {
    throw new CliRunError(
      "Configure “runtz” or an absolute path to the Runtz CLI."
    )
  }

  const candidates = process.platform === "win32" ? ["runtz.exe"] : ["runtz"]
  for (const rawDirectory of (process.env.PATH ?? "").split(path.delimiter)) {
    const directory = rawDirectory.replace(/^"|"$/g, "").trim()
    // Empty and relative PATH entries resolve against the clicked workspace,
    // which would let repository content replace the trusted CLI.
    if (!directory || !path.isAbsolute(directory)) {
      continue
    }
    for (const name of candidates) {
      try {
        return await validateExecutable(
          path.join(directory, name),
          canonicalBlockedRoots
        )
      } catch (error) {
        if (error instanceof UnsafeCliPathError) {
          throw error
        }
      }
    }
  }
  throw new CliNotFoundError(requested)
}

class UnsafeCliPathError extends CliRunError {
  constructor() {
    super(
      "For security, the Runtz CLI must be installed outside the workspace folders."
    )
    this.name = "UnsafeCliPathError"
  }
}

async function validateExecutable(
  candidate: string,
  blockedRoots: string[]
): Promise<string> {
  try {
    const realPath = await fs.realpath(candidate)
    const stat = await fs.stat(realPath)
    if (!stat.isFile()) {
      throw new CliNotFoundError(candidate)
    }
    await fs.access(realPath, fsConstants.X_OK)
    if (blockedRoots.some((root) => isInside(realPath, root))) {
      throw new UnsafeCliPathError()
    }
    return realPath
  } catch (error) {
    if (error instanceof CliRunError) {
      throw error
    }
    if (isNodeError(error) && (error.code === "ENOENT" || error.code === "ENOTDIR")) {
      throw new CliNotFoundError(candidate)
    }
    if (isNodeError(error) && error.code === "EACCES") {
      throw new CliRunError(`Permission denied when running “${candidate}”.`)
    }
    throw error
  }
}

function isInside(candidate: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate))
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
}

function safeChildEnvironment(includeAuthentication = false): NodeJS.ProcessEnv {
  const allowed = [
    "PATH",
    "Path",
    "LANG",
    "LC_ALL",
    "TMPDIR",
    "TMP",
    "TEMP",
    "HOME",
    "XDG_CONFIG_HOME",
    "APPDATA",
    "AppData",
    "USERPROFILE",
    "SYSTEMROOT",
    "SystemRoot",
    "WINDIR",
    "HTTPS_PROXY",
    "HTTP_PROXY",
    "NO_PROXY",
    "https_proxy",
    "http_proxy",
    "no_proxy",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
  ]
  if (includeAuthentication) {
    allowed.push(
      "RUNTZ_TOKEN",
      "RUNTZ_API_KEY",
      "RUNTZ_ENDPOINT",
      "RUNTZ_CONFIG_DIR"
    )
  }
  const environment: NodeJS.ProcessEnv = {}
  for (const key of allowed) {
    const value = process.env[key]
    if (value !== undefined) {
      environment[key] = value
    }
  }
  return environment
}

function parseCliAuthStatus(value: string): CliAuthStatus {
  let parsed: unknown
  try {
    parsed = JSON.parse(stripAnsi(value).trim())
  } catch {
    throw new CliRunError(
      "Update the Runtz CLI: this extension requires `runtz whoami --json`."
    )
  }
  if (!parsed || typeof parsed !== "object") {
    throw new CliRunError("The Runtz CLI returned an invalid login status.")
  }
  const candidate = parsed as Record<string, unknown>
  if (
    typeof candidate.authenticated !== "boolean" ||
    typeof candidate.verified !== "boolean" ||
    typeof candidate.endpoint !== "string" ||
    !candidate.endpoint.trim()
  ) {
    throw new CliRunError("The Runtz CLI returned an invalid login status.")
  }

  const status: CliAuthStatus = {
    authenticated: candidate.authenticated,
    verified: candidate.verified,
    endpoint: candidate.endpoint,
  }
  if (typeof candidate.tokenSource === "string" && candidate.tokenSource) {
    status.tokenSource = candidate.tokenSource
  }
  if (candidate.workspace !== undefined) {
    if (!isStringRecord(candidate.workspace, "name")) {
      throw new CliRunError("The Runtz CLI returned an invalid workspace.")
    }
    const workspace = candidate.workspace as Record<string, unknown> & {
      name: string
    }
    status.workspace = {
      name: workspace.name,
      ...(typeof workspace.id === "string"
        ? { id: workspace.id }
        : {}),
    }
  }
  if (candidate.apiKey !== undefined) {
    if (!candidate.apiKey || typeof candidate.apiKey !== "object") {
      throw new CliRunError("The Runtz CLI returned invalid API key metadata.")
    }
    const apiKey = candidate.apiKey as Record<string, unknown>
    status.apiKey = {
      ...(typeof apiKey.name === "string" ? { name: apiKey.name } : {}),
      ...(typeof apiKey.prefix === "string" ? { prefix: apiKey.prefix } : {}),
      ...(typeof apiKey.expiresAt === "string"
        ? { expiresAt: apiKey.expiresAt }
        : {}),
    }
  }
  if (status.verified && !status.workspace) {
    throw new CliRunError("The Runtz CLI returned an invalid verified login.")
  }
  return status
}

function authCommandError(stderr: string, stdout: string): string {
  const detail = lastUsefulLine(stderr) || lastUsefulLine(stdout)
  if (/flag provided but not defined.*json|unknown flag.*json/i.test(detail ?? "")) {
    return "Update the Runtz CLI: this extension requires `runtz whoami --json`."
  }
  return detail || "Could not read the Runtz CLI login."
}

function isStringRecord(
  value: unknown,
  key: string
): value is Record<string, unknown> & Record<typeof key, string> {
  return Boolean(
    value &&
      typeof value === "object" &&
      key in value &&
      typeof (value as Record<string, unknown>)[key] === "string" &&
      ((value as Record<string, unknown>)[key] as string).trim()
  )
}

function terminateChild(
  child: ChildProcess,
  onForced: () => void
): NodeJS.Timeout | undefined {
  if (child.exitCode !== null || child.signalCode !== null) {
    return undefined
  }
  child.kill("SIGTERM")
  return setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL")
    }
    onForced()
  }, 3_000)
}

function mapSpawnError(error: unknown, executable: string): Error {
  if (isNodeError(error) && error.code === "ENOENT") {
    return new CliNotFoundError(executable)
  }
  if (isNodeError(error) && error.code === "EACCES") {
    return new CliRunError(`Permission denied when running “${executable}”.`)
  }
  return error instanceof Error
    ? error
    : new CliRunError("Could not start the Runtz CLI.")
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error
}

function appendCapped(current: string, next: string): string {
  const value = current + next
  return value.length <= MAX_CAPTURE_LENGTH
    ? value
    : value.slice(value.length - MAX_CAPTURE_LENGTH)
}

function appendOutput(
  output: vscode.OutputChannel | undefined,
  value: string,
  redactions: string[] | undefined
): void {
  if (!output) {
    return
  }
  output.append(sanitizeOutput(value, redactions))
}

function sanitizeOutput(value: string, redactions: string[] | undefined): string {
  let safe = stripAnsi(value)
  for (const secret of redactions ?? []) {
    if (secret) {
      safe = safe.split(secret).join("[REDACTED]")
    }
  }
  return safe
}

function stripAnsi(value: string): string {
  return value.replace(ANSI_PATTERN, "")
}

function lastUsefulLine(value: string): string | undefined {
  return stripAnsi(value)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1)
}
