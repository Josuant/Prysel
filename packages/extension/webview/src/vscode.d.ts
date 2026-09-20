/** API mínima del webview de VS Code: @types/vscode no la declara porque es del lado web. */
interface VsCodeApi {
  postMessage(message: unknown): void
  getState(): unknown
  setState(state: unknown): void
}

declare function acquireVsCodeApi(): VsCodeApi

/** Los estilos se importan como efecto lateral; Vite los compila a CSS. */
declare module '*.css'
