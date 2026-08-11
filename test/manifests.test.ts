import { readFileSync } from "node:fs"
import { resolve } from "node:path"

import { describe, expect, it } from "vitest"

import {
  isSupportedScaManifest,
  SUPPORTED_SCA_MANIFESTS,
} from "../src/constants"

type ContextMenuEntry = {
  command: string
  group?: string
  when: string
}

type ExtensionManifest = {
  activationEvents?: string[]
  contributes?: {
    commands?: Array<{
      command: string
      title: string
    }>
    menus?: {
      "explorer/context"?: ContextMenuEntry[]
      commandPalette?: ContextMenuEntry[]
    }
  }
}

const extensionManifest = JSON.parse(
  readFileSync(resolve(__dirname, "../package.json"), "utf8")
) as ExtensionManifest

describe("isSupportedScaManifest", () => {
  it.each([
    "package.json",
    "requirements.txt",
    "go.mod",
    "pom.xml",
    "Gemfile.lock",
    "composer.json",
    "Cargo.toml",
    "src/payments.csproj",
  ])("accepts %s", (manifest) => {
    expect(isSupportedScaManifest(manifest)).toBe(true)
  })

  it.each([
    "package-lock.json",
    "pnpm-lock.yaml",
    "pyproject.toml",
    "build.gradle",
    "README.md",
  ])("rejects unsupported %s", (manifest) => {
    expect(isSupportedScaManifest(manifest)).toBe(false)
  })
})

describe("Explorer context menu scan actions", () => {
  const entries = extensionManifest.contributes?.menus?.["explorer/context"] ?? []

  it("contributes exactly one SAST action and one SCA action", () => {
    expect(entries).toHaveLength(2)
    expect(entries.map(({ command }) => command)).toEqual([
      "runtz.scanSast",
      "runtz.scanSca",
    ])

    const sast = findEntry(entries, "runtz.scanSast")
    const sca = findEntry(entries, "runtz.scanSca")

    expect(sast.when).toBe(
      "resourceScheme == file && explorerResourceIsFolder && isWorkspaceTrusted"
    )
    expect(sca.when).toContain("!explorerResourceIsFolder")
    expect(sca.when).toContain("isWorkspaceTrusted")
    expect(sca.group).toBe(sast.group)
  })

  it("keeps the SCA menu regex in parity with supported manifests", () => {
    expect(SUPPORTED_SCA_MANIFESTS).toEqual([
      "package.json",
      "requirements.txt",
      "go.mod",
      "pom.xml",
      "gemfile.lock",
      "composer.json",
      "cargo.toml",
    ])

    const pattern = extractFilenamePattern(findEntry(entries, "runtz.scanSca").when)
    const supported = [
      "package.json",
      "requirements.txt",
      "go.mod",
      "pom.xml",
      "Gemfile.lock",
      "composer.json",
      "Cargo.toml",
      "payments.csproj",
      "PAYMENTS.CSPROJ",
    ]
    const unsupported = [
      "package-lock.json",
      "requirements-dev.txt",
      "go.sum",
      "build.gradle",
      "Gemfile",
      "composer.lock",
      "Cargo.lock",
      "payments.fsproj",
      "payments.csproj.user",
      "README.md",
    ]

    for (const filename of supported) {
      expect(pattern.test(filename), filename).toBe(true)
      expect(isSupportedScaManifest(filename), filename).toBe(true)
    }
    for (const filename of unsupported) {
      expect(pattern.test(filename), filename).toBe(false)
      expect(isSupportedScaManifest(filename), filename).toBe(false)
    }
  })
})

describe("Recent scan result action", () => {
  it("exposes only the direct Open in Runtz command", () => {
    const contributedCommands =
      extensionManifest.contributes?.commands?.map(({ command }) => command) ?? []
    const paletteCommands =
      extensionManifest.contributes?.menus?.commandPalette?.map(
        ({ command }) => command
      ) ?? []
    const activationEvents = extensionManifest.activationEvents ?? []

    expect(contributedCommands).toContain("runtz.openLastScan")
    expect(paletteCommands).toContain("runtz.openLastScan")
    expect(activationEvents).toContain("onCommand:runtz.openLastScan")

    expect(contributedCommands).not.toContain("runtz.openVulnerabilities")
    expect(paletteCommands).not.toContain("runtz.openVulnerabilities")
    expect(activationEvents).not.toContain(
      "onCommand:runtz.openVulnerabilities"
    )
  })
})

function findEntry(
  entries: ContextMenuEntry[],
  command: string
): ContextMenuEntry {
  const entry = entries.find((candidate) => candidate.command === command)
  if (!entry) {
    throw new Error(`Missing Explorer context menu entry for ${command}`)
  }
  return entry
}

function extractFilenamePattern(when: string): RegExp {
  const match = when.match(/resourceFilename\s*=~\s*\/(.+)\/([a-z]*)$/)
  const source = match?.[1]
  if (!source) {
    throw new Error("Missing resourceFilename regex in SCA Explorer menu condition")
  }
  return new RegExp(source, match[2] ?? "")
}
