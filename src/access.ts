import * as path from "node:path"

import * as vscode from "vscode"

import {
  locateCli,
  readCliAuthStatus,
  runCliLogin,
  runCliLogout,
  type CliAuthStatus,
} from "./cli/runner"
import {
  ACCESS_WORKSPACE_STATE_KEY,
  DEFAULT_ENDPOINT,
  DEFAULT_PLATFORM_URL,
} from "./constants"
import { buildApiKeysUrl, normalizeBaseUrl } from "./platform"

type AccessAction = vscode.QuickPickItem & {
  id: "token" | "test" | "urls" | "cli" | "api-keys" | "remove"
}

export class AccessManager implements vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<void>()
  readonly onDidChange = this.changeEmitter.event

  constructor(private readonly context: vscode.ExtensionContext) {}

  dispose(): void {
    this.changeEmitter.dispose()
  }

  getEndpoint(): string {
    const value = readStringSetting("endpoint", DEFAULT_ENDPOINT)
    return normalizeBaseUrl(value, "Engine URL")
  }

  getPlatformUrl(): string {
    const value = readStringSetting("platformUrl", DEFAULT_PLATFORM_URL)
    return normalizeBaseUrl(value, "Platform URL")
  }

  getCliPath(): string {
    return readStringSetting("cliPath", "runtz").trim()
  }

  async ensureAccess(
    executable: string
  ): Promise<CliAuthStatus | undefined> {
    try {
      const status = await readCliAuthStatus(executable)
      if (status.authenticated) {
        await this.updateIdentity(status)
        return status
      }
      return this.promptAndLogin(
        executable,
        preferredLoginEndpoint(status, this.getEndpoint())
      )
    } catch (error) {
      await vscode.window.showErrorMessage(
        `Could not verify the Runtz CLI login. ${friendlyError(error)}`
      )
      return undefined
    }
  }

  async configure(): Promise<void> {
    const actions: AccessAction[] = [
      {
        id: "token",
        label: "$(key) Log in or change token",
        description: "Shared with the Runtz CLI and terminal",
      },
      {
        id: "test",
        label: "$(pass) Test CLI login",
        description: "Validate the configured token and workspace",
      },
      {
        id: "urls",
        label: "$(globe) Configure environment",
        description: "Runtz Cloud or a self-hosted installation",
      },
      ...(vscode.workspace.isTrusted
        ? [
            {
              id: "cli" as const,
              label: "$(terminal) Configure Runtz CLI",
              description: "Detect or change the executable path",
            },
          ]
        : []),
      {
        id: "api-keys",
        label: "$(link-external) Open API Keys",
        description: "Create or manage tokens in Runtz",
      },
      {
        id: "remove",
        label: "$(sign-out) Log out",
        description: "Remove the CLI login from this environment",
      },
    ]

    const selected = await vscode.window.showQuickPick(actions, {
      title: "Configure Runtz access",
      placeHolder: "Choose what to configure",
      ignoreFocusOut: true,
    })
    if (!selected) {
      return
    }

    switch (selected.id) {
      case "token":
        await this.promptAndLogin()
        break
      case "test":
        await this.testConnection()
        break
      case "urls":
        await this.configureEnvironment()
        break
      case "cli":
        await this.configureCliPath()
        break
      case "api-keys":
        try {
          await vscode.env.openExternal(
            vscode.Uri.parse(buildApiKeysUrl(this.getPlatformUrl()))
          )
        } catch (error) {
          await vscode.window.showErrorMessage(friendlyError(error))
        }
        break
      case "remove":
        await this.logout()
        break
    }
  }

  private async promptAndLogin(
    knownExecutable?: string,
    requestedEndpoint?: string
  ): Promise<CliAuthStatus | undefined> {
    const executable = knownExecutable ?? (await this.resolveTrustedCli())
    if (!executable) {
      return undefined
    }

    let endpoint = requestedEndpoint
    if (!endpoint) {
      try {
        const status = await readCliAuthStatus(executable)
        endpoint = preferredLoginEndpoint(status, this.getEndpoint())
      } catch {
        // A rejected or unreachable existing login must not prevent the user
        // from replacing it with the endpoint configured in VS Code.
        endpoint = this.getEndpoint()
      }
    }

    const token = await vscode.window.showInputBox({
      title: "Runtz login",
      prompt:
        "Paste a token created in API Keys. The Runtz CLI will store it for VS Code and terminal use.",
      placeHolder: "rtz_live_…",
      password: true,
      ignoreFocusOut: true,
      validateInput: (value) =>
        /^rtz_live_[^_\s]+_[^\s]+$/.test(value.trim())
          ? undefined
          : "Enter a valid Runtz token in the rtz_live_… format.",
    })
    if (token === undefined) {
      return undefined
    }

    try {
      const status = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Window,
          title: "Runtz: logging in through the CLI…",
        },
        () => runCliLogin(executable, endpoint, token.trim())
      )
      await this.updateIdentity(status)
      const destination = status.workspace?.name ?? status.endpoint
      void vscode.window.setStatusBarMessage(
        `$(pass) Runtz connected to ${destination}`,
        4_000
      )
      return status
    } catch (error) {
      await vscode.window.showErrorMessage(friendlyError(error))
      return undefined
    }
  }

  private async testConnection(): Promise<void> {
    const executable = await this.resolveTrustedCli()
    if (!executable) {
      return
    }
    try {
      const status = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Window,
          title: "Runtz: testing CLI login…",
        },
        () => readCliAuthStatus(executable)
      )
      await this.updateIdentity(status)
      if (!status.authenticated) {
        const selected = await vscode.window.showInformationMessage(
          "The Runtz CLI is not logged in.",
          "Log in"
        )
        if (selected === "Log in") {
          await this.promptAndLogin(executable)
        }
        return
      }
      if (status.workspace?.name) {
        await vscode.window.showInformationMessage(
          `Connected to workspace “${status.workspace.name}” through the Runtz CLI.`
        )
        return
      }
      await vscode.window.showInformationMessage(
        `A CLI login is configured for ${status.endpoint}, but this engine does not support token verification.`
      )
    } catch (error) {
      await vscode.window.showErrorMessage(friendlyError(error))
    }
  }

  private async configureEnvironment(): Promise<void> {
    const selected = await vscode.window.showQuickPick(
      [
        {
          id: "cloud" as const,
          label: "$(cloud) Runtz Cloud",
          description: DEFAULT_PLATFORM_URL,
        },
        {
          id: "self-hosted" as const,
          label: "$(server-environment) Self-hosted",
          description: "Enter the engine and platform URLs",
        },
      ],
      {
        title: "Runtz environment",
        ignoreFocusOut: true,
      }
    )
    if (!selected) {
      return
    }

    let endpoint = DEFAULT_ENDPOINT
    let platformUrl = DEFAULT_PLATFORM_URL
    if (selected.id === "self-hosted") {
      const engineInput = await vscode.window.showInputBox({
        title: "Runtz engine URL",
        value: readStringSetting("endpoint", DEFAULT_ENDPOINT),
        placeHolder: "https://engine.example.com",
        ignoreFocusOut: true,
        validateInput: validateUrlInput("Engine URL"),
      })
      if (engineInput === undefined) {
        return
      }
      const platformInput = await vscode.window.showInputBox({
        title: "Runtz platform URL",
        value: readStringSetting("platformUrl", DEFAULT_PLATFORM_URL),
        placeHolder: "https://security.example.com",
        ignoreFocusOut: true,
        validateInput: validateUrlInput("Platform URL"),
      })
      if (platformInput === undefined) {
        return
      }
      endpoint = normalizeBaseUrl(engineInput, "Engine URL")
      platformUrl = normalizeBaseUrl(platformInput, "Platform URL")
    }

    if (vscode.workspace.isTrusted) {
      let executable: string | undefined
      try {
        executable = (
          await locateCli(this.getCliPath(), workspaceFileRoots())
        ).executable
      } catch {
        // The URL preference is still useful before the CLI is installed.
      }
      if (executable) {
        let status: CliAuthStatus | undefined
        try {
          status = await readCliAuthStatus(executable)
        } catch {
          // Let a fresh login repair an invalid or unreachable previous one.
          const nextStatus = await this.promptAndLogin(executable, endpoint)
          if (!nextStatus) {
            return
          }
        }
        if (status?.authenticated && status.endpoint !== endpoint) {
          const nextStatus = await this.promptAndLogin(executable, endpoint)
          if (!nextStatus) {
            return
          }
        }
      }
    }

    const configuration = vscode.workspace.getConfiguration("runtz")
    await configuration.update(
      "endpoint",
      endpoint,
      vscode.ConfigurationTarget.Global
    )
    await configuration.update(
      "platformUrl",
      platformUrl,
      vscode.ConfigurationTarget.Global
    )
    this.changeEmitter.fire()
    void vscode.window.setStatusBarMessage(
      "$(pass) Runtz environment updated",
      3_000
    )
  }

  async configureCliPath(): Promise<void> {
    if (!vscode.workspace.isTrusted) {
      await vscode.window.showWarningMessage(
        "Trust this workspace before detecting or running the Runtz CLI."
      )
      return
    }
    const executable = await vscode.window.showInputBox({
      title: "Runtz CLI path",
      prompt: "Use “runtz” to search PATH, or enter an absolute path.",
      value: this.getCliPath(),
      placeHolder: "/usr/local/bin/runtz",
      ignoreFocusOut: true,
      validateInput: (value) => {
        const normalized = value.trim()
        if (!normalized) {
          return "Enter the Runtz CLI executable."
        }
        if (normalized !== "runtz" && !path.isAbsolute(normalized)) {
          return "Use “runtz” or an absolute path."
        }
        return undefined
      },
    })
    if (executable === undefined) {
      return
    }

    const normalized = executable.trim()
    try {
      const installation = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Window,
          title: "Runtz: detecting CLI…",
        },
        () => locateCli(normalized, workspaceFileRoots())
      )
      await vscode.workspace
        .getConfiguration("runtz")
        .update("cliPath", normalized, vscode.ConfigurationTarget.Global)
      void vscode.window.setStatusBarMessage(
        `$(pass) Runtz CLI ${installation.version} detected`,
        4_000
      )
    } catch (error) {
      await vscode.window.showErrorMessage(friendlyError(error))
    }
  }

  private async logout(): Promise<void> {
    const executable = await this.resolveTrustedCli()
    if (!executable) {
      return
    }
    const selected = await vscode.window.showWarningMessage(
      "Log out of Runtz in this environment? This also removes the stored login used by the terminal.",
      { modal: true },
      "Log out"
    )
    if (selected !== "Log out") {
      return
    }

    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Window,
          title: "Runtz: logging out through the CLI…",
        },
        () => runCliLogout(executable)
      )
      const status = await readCliAuthStatus(executable)
      await this.updateIdentity(status)
      if (status.authenticated) {
        await vscode.window.showWarningMessage(
          `The stored login was removed, but ${status.tokenSource ?? "an environment token"} still authenticates the Runtz CLI.`
        )
      } else {
        void vscode.window.setStatusBarMessage("Runtz: logged out", 3_000)
      }
    } catch (error) {
      await vscode.window.showErrorMessage(friendlyError(error))
    }
  }

  private async resolveTrustedCli(): Promise<string | undefined> {
    if (!vscode.workspace.isTrusted) {
      await vscode.window.showWarningMessage(
        "Trust this workspace before running the Runtz CLI."
      )
      return undefined
    }
    try {
      return (
        await locateCli(this.getCliPath(), workspaceFileRoots())
      ).executable
    } catch (error) {
      await vscode.window.showErrorMessage(friendlyError(error))
      return undefined
    }
  }

  private async updateIdentity(status: CliAuthStatus): Promise<void> {
    await this.context.globalState.update(
      ACCESS_WORKSPACE_STATE_KEY,
      status.workspace?.name
    )
    this.changeEmitter.fire()
  }
}

function validateUrlInput(label: string): (value: string) => string | undefined {
  return (value) => {
    try {
      normalizeBaseUrl(value, label)
      return undefined
    } catch (error) {
      return friendlyError(error)
    }
  }
}

function friendlyError(error: unknown): string {
  return error instanceof Error ? error.message : "An unexpected error occurred."
}

function workspaceFileRoots(): string[] {
  return (vscode.workspace.workspaceFolders ?? [])
    .filter((folder) => folder.uri.scheme === "file")
    .map((folder) => folder.uri.fsPath)
}

function readStringSetting(key: string, fallback: string): string {
  const value = vscode.workspace.getConfiguration("runtz").get<unknown>(key)
  return typeof value === "string" ? value : fallback
}

function preferredLoginEndpoint(
  status: CliAuthStatus,
  configuredEndpoint: string
): string {
  return status.authenticated || status.endpoint !== DEFAULT_ENDPOINT
    ? status.endpoint
    : configuredEndpoint
}
