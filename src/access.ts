import * as path from "node:path"

import * as vscode from "vscode"

import { locateCli } from "./cli/runner"
import {
  ACCESS_WORKSPACE_STATE_KEY,
  DEFAULT_ENDPOINT,
  DEFAULT_PLATFORM_URL,
  TOKEN_ENDPOINT_SECRET_KEY,
  TOKEN_SECRET_KEY,
} from "./constants"
import { buildApiKeysUrl, normalizeBaseUrl } from "./platform"

type VerifyResponse = {
  workspace: {
    name: string
  }
}

export type VerifiedAccess = {
  token: string
  endpoint: string
}

type AccessAction = vscode.QuickPickItem & {
  id: "token" | "test" | "urls" | "cli" | "api-keys" | "remove"
}

export class AccessManager implements vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<void>()
  readonly onDidChange = this.changeEmitter.event

  private readonly secretChangeSubscription: vscode.Disposable

  constructor(private readonly context: vscode.ExtensionContext) {
    this.secretChangeSubscription = context.secrets.onDidChange((event) => {
      if (event.key === TOKEN_SECRET_KEY) {
        this.changeEmitter.fire()
      }
    })
  }

  dispose(): void {
    this.secretChangeSubscription.dispose()
    this.changeEmitter.dispose()
  }

  async getToken(): Promise<string | undefined> {
    return this.context.secrets.get(TOKEN_SECRET_KEY)
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

  async ensureAccess(): Promise<VerifiedAccess | undefined> {
    const existing = await this.getToken()
    if (existing) {
      const endpoint = this.getEndpoint()
      const verifiedEndpoint = await this.context.secrets.get(
        TOKEN_ENDPOINT_SECRET_KEY
      )
      if (verifiedEndpoint !== endpoint) {
        const selected = await vscode.window.showWarningMessage(
          `The engine endpoint changed to ${endpoint}. Allow Runtz to send your token to this address?`,
          { modal: true },
          "Allow and test"
        )
        if (selected !== "Allow and test") {
          return undefined
        }
        try {
          await verifyToken(endpoint, existing)
          await this.context.secrets.store(TOKEN_ENDPOINT_SECRET_KEY, endpoint)
        } catch (error) {
          await vscode.window.showErrorMessage(friendlyError(error))
          return undefined
        }
      }
      return { token: existing, endpoint }
    }
    return this.promptAndStoreToken()
  }

  async configure(): Promise<void> {
    const hasToken = Boolean(await this.getToken())
    const actions: AccessAction[] = [
      {
        id: "token",
        label: hasToken ? "$(key) Change token" : "$(key) Add token",
        description: "Stored securely by VS Code",
      },
      ...(hasToken
        ? [
            {
              id: "test" as const,
              label: "$(pass) Test connection",
              description: "Validate the token and workspace",
            },
          ]
        : []),
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
      ...(hasToken
        ? [
            {
              id: "remove" as const,
              label: "$(sign-out) Remove access",
              description: "Delete the token from this VS Code installation",
            },
          ]
        : []),
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
        await this.promptAndStoreToken()
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
        await this.removeToken()
        break
    }
  }

  private async promptAndStoreToken(): Promise<VerifiedAccess | undefined> {
    const token = await vscode.window.showInputBox({
      title: "Runtz token",
      prompt: "Paste a token created in API Keys. VS Code will store it securely.",
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

    const normalizedToken = token.trim()
    const endpoint = this.getEndpoint()
    try {
      const verification = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Window,
          title: "Runtz: validating access…",
        },
        () => verifyToken(endpoint, normalizedToken)
      )
      await this.context.secrets.store(TOKEN_SECRET_KEY, normalizedToken)
      await this.context.secrets.store(TOKEN_ENDPOINT_SECRET_KEY, endpoint)
      await this.context.globalState.update(
        ACCESS_WORKSPACE_STATE_KEY,
        verification.workspace.name
      )
      void vscode.window.setStatusBarMessage(
        `$(pass) Runtz connected to ${verification.workspace.name}`,
        4_000
      )
      return { token: normalizedToken, endpoint }
    } catch (error) {
      await vscode.window.showErrorMessage(friendlyError(error))
      return undefined
    }
  }

  private async testConnection(): Promise<void> {
    const token = await this.getToken()
    if (!token) {
      await this.promptAndStoreToken()
      return
    }
    const endpoint = this.getEndpoint()
    try {
      const result = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Window,
          title: "Runtz: testing connection…",
        },
        () => verifyToken(endpoint, token)
      )
      await this.context.globalState.update(
        ACCESS_WORKSPACE_STATE_KEY,
        result.workspace.name
      )
      await this.context.secrets.store(TOKEN_ENDPOINT_SECRET_KEY, endpoint)
      await vscode.window.showInformationMessage(
        `Connected to workspace “${result.workspace.name}”.`
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

    const token = await this.getToken()
    if (token) {
      try {
        await verifyToken(endpoint, token)
      } catch (error) {
        await vscode.window.showErrorMessage(
          `The environment was not changed. ${friendlyError(error)}`
        )
        return
      }
    }

    const configuration = vscode.workspace.getConfiguration("runtz")
    await configuration.update(
      "endpoint",
      endpoint,
      vscode.ConfigurationTarget.Global
    )
    if (token) {
      await this.context.secrets.store(TOKEN_ENDPOINT_SECRET_KEY, endpoint)
    }
    await configuration.update(
      "platformUrl",
      platformUrl,
      vscode.ConfigurationTarget.Global
    )
    this.changeEmitter.fire()
    void vscode.window.setStatusBarMessage("$(pass) Runtz environment updated", 3_000)
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

  private async removeToken(): Promise<void> {
    const selected = await vscode.window.showWarningMessage(
      "Remove the Runtz token from this VS Code installation?",
      { modal: true },
      "Remove access"
    )
    if (selected !== "Remove access") {
      return
    }
    await this.context.secrets.delete(TOKEN_SECRET_KEY)
    await this.context.secrets.delete(TOKEN_ENDPOINT_SECRET_KEY)
    await this.context.globalState.update(ACCESS_WORKSPACE_STATE_KEY, undefined)
    void vscode.window.setStatusBarMessage("Runtz: access removed", 3_000)
  }
}

async function verifyToken(endpoint: string, token: string): Promise<VerifyResponse> {
  let response: Response
  try {
    response = await fetch(`${endpoint}/api/v1/keys/verify`, {
      method: "GET",
      redirect: "error",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(15_000),
    })
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") {
      throw new Error("The Runtz engine did not respond in time.")
    }
    throw new Error("Could not reach the Runtz engine.")
  }

  const body = await readJson(response)
  if (!response.ok) {
    const message = readErrorMessage(body)
    if (response.status === 401 || response.status === 403) {
      throw new Error(message || "Runtz rejected the token.")
    }
    if (response.status === 404 || response.status === 405) {
      throw new Error("This engine does not support token verification. Update Runtz and try again.")
    }
    throw new Error(message || `Runtz responded with status ${response.status}.`)
  }

  if (!isVerifyResponse(body)) {
    throw new Error("The engine returned an invalid authentication response.")
  }
  return body
}

async function readJson(response: Response): Promise<unknown> {
  try {
    const text = await readLimitedBody(response, 64 * 1024)
    return text ? JSON.parse(text) : undefined
  } catch {
    return undefined
  }
}

async function readLimitedBody(response: Response, limit: number): Promise<string> {
  if (!response.body) {
    return ""
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let total = 0
  let body = ""
  while (true) {
    const { done, value } = await reader.read()
    if (done) {
      return body + decoder.decode()
    }
    total += value.byteLength
    if (total > limit) {
      await reader.cancel()
      throw new Error("The engine response is too large.")
    }
    body += decoder.decode(value, { stream: true })
  }
}

function readErrorMessage(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || !("error" in value)) {
    return undefined
  }
  return typeof value.error === "string" ? value.error : undefined
}

function isVerifyResponse(value: unknown): value is VerifyResponse {
  if (!value || typeof value !== "object" || !("workspace" in value)) {
    return false
  }
  const workspace = value.workspace
  return Boolean(
    workspace &&
      typeof workspace === "object" &&
      "name" in workspace &&
      typeof workspace.name === "string" &&
      workspace.name.trim()
  )
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
