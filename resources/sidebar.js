const vscode = acquireVsCodeApi()

document.addEventListener("click", (event) => {
  const target = event.target instanceof Element
    ? event.target.closest("[data-command]")
    : null
  if (!(target instanceof HTMLElement)) {
    return
  }
  const command = target.dataset.command
  if (command) {
    const scanKey = target.dataset.scanKey
    vscode.postMessage(scanKey ? { command, scanKey } : { command })
  }
})
