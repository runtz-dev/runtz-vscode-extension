import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import {
  containsEmbeddedUrlCredentials,
  createSafeScaSnapshot,
  resolveSafeScanTarget,
} from "../src/path-security"

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      fs.rm(directory, { recursive: true, force: true })
    )
  )
})

describe("scan target security", () => {
  it("accepts a real folder and manifest inside the workspace", async () => {
    const workspace = await makeTempDirectory()
    const source = path.join(workspace, "src")
    const manifest = path.join(workspace, "package.json")
    await fs.mkdir(source)
    await fs.writeFile(path.join(source, "index.ts"), "export const ok = true\n")
    await fs.writeFile(manifest, '{"name":"safe","dependencies":{}}\n')

    await expect(resolveSafeScanTarget("sast", workspace, source)).resolves.toBe(
      await fs.realpath(source)
    )
    await expect(resolveSafeScanTarget("sca", workspace, manifest)).resolves.toBe(
      await fs.realpath(manifest)
    )
  })

  it("rejects a selected manifest symlink", async () => {
    const workspace = await makeTempDirectory()
    const outside = await makeTempDirectory()
    const outsideManifest = path.join(outside, "package.json")
    const link = path.join(workspace, "package.json")
    await fs.writeFile(outsideManifest, '{"name":"outside"}\n')
    await fs.symlink(outsideManifest, link)

    await expect(resolveSafeScanTarget("sca", workspace, link)).rejects.toThrow(
      "symbolic link"
    )
  })

  it("rejects source-file symlinks discovered below a SAST folder", async () => {
    const workspace = await makeTempDirectory()
    const outside = await makeTempDirectory()
    const source = path.join(workspace, "src")
    await fs.mkdir(source)
    await fs.writeFile(path.join(outside, "secret.ts"), "const secret = 'value'\n")
    await fs.symlink(
      path.join(outside, "secret.ts"),
      path.join(source, "secret.ts")
    )

    await expect(resolveSafeScanTarget("sast", workspace, source)).rejects.toThrow(
      "symbolic link to source code"
    )
  })

  it("rejects credential-bearing dependency URLs", () => {
    expect(
      containsEmbeddedUrlCredentials(
        '"private": "git+https://build-user:super-secret@example.com/pkg.git"'
      )
    ).toBe(true)
    expect(
      containsEmbeddedUrlCredentials(
        '"private": "https://example.com/pkg.tgz?auth-token=super-secret"'
      )
    ).toBe(true)
    expect(
      containsEmbeddedUrlCredentials(
        '"private": "git+https://token-value@example.com/pkg.git"'
      )
    ).toBe(true)
    expect(
      containsEmbeddedUrlCredentials(
        '"private": "git+https:\\/\\/user:secret@example.com/pkg.git"'
      )
    ).toBe(true)
    expect(
      containsEmbeddedUrlCredentials(
        '"private": "https://example.com/pkg.tgz?apikey=super-secret"'
      )
    ).toBe(true)
    expect(
      containsEmbeddedUrlCredentials(
        '"private": "https://example.com/pkg.tgz?sig=super-secret"'
      )
    ).toBe(true)
    expect(
      containsEmbeddedUrlCredentials(
        "<version>https&#58;&#47;&#47;user&#58;secret&#64;example.com/pkg</version>"
      )
    ).toBe(true)
  })

  it("allows public and ordinary SSH dependency URLs", () => {
    expect(
      containsEmbeddedUrlCredentials(
        '"public": "https://example.com/pkg.tgz", "git": "git+ssh://git@github.com/org/repo.git"'
      )
    ).toBe(false)
  })

  it("scans an immutable manifest snapshot and removes it afterward", async () => {
    const workspace = await makeTempDirectory()
    const manifest = path.join(workspace, "package.json")
    const original = '{"name":"safe","dependencies":{"react":"19.0.0"}}\n'
    await fs.writeFile(manifest, original)

    const snapshot = await createSafeScaSnapshot(manifest)
    await fs.writeFile(
      manifest,
      '{"dependencies":{"private":"https://user:secret@example.com/pkg"}}\n'
    )

    expect(await fs.readFile(snapshot.path, "utf8")).toBe(original)
    expect(path.basename(snapshot.path)).toBe("package.json")
    await snapshot.dispose()
    await expect(fs.stat(snapshot.path)).rejects.toMatchObject({ code: "ENOENT" })
  })
})

async function makeTempDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "runtz-path-test-"))
  temporaryDirectories.push(directory)
  return directory
}
