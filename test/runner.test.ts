import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"

import type * as vscode from "vscode"
import { afterEach, describe, expect, it } from "vitest"

import { locateCli, runCliScan } from "../src/cli/runner"

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      fs.rm(directory, { recursive: true, force: true })
    )
  )
})

describe.skipIf(process.platform === "win32")("CLI runner", () => {
  it("resolves and probes one absolute executable", async () => {
    const directory = await makeTempDirectory()
    const executable = await writeFakeCli(directory)

    process.env.AWS_SECRET_ACCESS_KEY = "must-not-reach-version-probe"
    process.env.RUNTZ_TOKEN = "must-not-reach-version-probe"
    try {
      await expect(locateCli(executable, [])).resolves.toEqual({
        executable: await fs.realpath(executable),
        version: "9.9.9-test",
      })
    } finally {
      delete process.env.AWS_SECRET_ACCESS_KEY
      delete process.env.RUNTZ_TOKEN
    }
  })

  it("refuses an executable stored inside a workspace", async () => {
    const workspace = await makeTempDirectory()
    const executable = await writeFakeCli(workspace)

    await expect(locateCli(executable, [workspace])).rejects.toThrow(
      "outside the workspace folders"
    )
  })

  it("canonicalizes workspace roots before checking the CLI path", async () => {
    const realWorkspace = await makeTempDirectory()
    const executable = await writeFakeCli(realWorkspace)
    const linkParent = await makeTempDirectory()
    const linkedWorkspace = path.join(linkParent, "workspace-link")
    await fs.symlink(realWorkspace, linkedWorkspace, "dir")

    await expect(locateCli(executable, [linkedWorkspace])).rejects.toThrow(
      "outside the workspace folders"
    )
  })

  it("passes the token only through env and redacts split output chunks", async () => {
    const directory = await makeTempDirectory()
    const executable = await writeFakeCli(directory)
    const token = "rtz_live_0123456789abcdef_0123456789abcdef"
    let log = ""
    const output = {
      append(value: string) {
        log += value
      },
      appendLine(value: string) {
        log += `${value}\n`
      },
    } as unknown as vscode.OutputChannel
    const cancellation = {
      isCancellationRequested: false,
      onCancellationRequested() {
        return { dispose() {} }
      },
    } as unknown as vscode.CancellationToken

    process.env.AWS_SECRET_ACCESS_KEY = "must-not-reach-cli"
    let result
    try {
      result = await runCliScan({
        executable,
        type: "sast",
        targetPath: "/tmp/project with spaces",
        source: "project",
        cwd: directory,
        endpoint: "https://engine.runtz.dev",
        token,
        output,
        cancellation,
      })
    } finally {
      delete process.env.AWS_SECRET_ACCESS_KEY
    }

    expect(result.projectName).toBe("fake-project")
    expect(log).toContain("[REDACTED]")
    expect(log).not.toContain(token)
    expect(log).toContain("ambient-secret=absent")
  })
})

async function makeTempDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "runtz-vscode-test-"))
  temporaryDirectories.push(directory)
  return directory
}

async function writeFakeCli(directory: string): Promise<string> {
  const executable = path.join(directory, "runtz")
  await fs.writeFile(
    executable,
    `#!/bin/sh
if [ "$1" = "version" ]; then
  if [ -n "\${AWS_SECRET_ACCESS_KEY:-}" ] || [ -n "\${RUNTZ_TOKEN:-}" ]; then
    printf '%s\n' 'ambient secret reached version probe' >&2
    exit 1
  fi
  printf '%s\n' 'runtz 9.9.9-test (test/arch)'
  exit 0
fi

token=\${RUNTZ_TOKEN:-}
for argument in "$@"; do
  if [ "$argument" = "$token" ]; then
    printf '%s\n' 'token appeared in argv' >&2
    exit 1
  fi
done

token_prefix=$(printf '%.15s' "$token")
token_suffix=\${token#"$token_prefix"}
printf '%s' "$token_prefix" >&2
sleep 0.05
printf '%s\n' "$token_suffix" >&2
printf 'ambient-secret=%s\n' "\${AWS_SECRET_ACCESS_KEY:-absent}" >&2
printf '%s\n' \
  'Project: fake-project' \
  'Files: 3' \
  'Findings: 1' \
  'Scan ID: fake-scan' \
  'Severity gate: critical=1 high=0 medium=0 low=0 unknown=0'
`,
    { mode: 0o755 }
  )
  return executable
}
