import { WebHost } from './host.ts'

/**
 * El lienzo es el webview de la extensión tal cual: espera encontrar `acquireVsCodeApi()`, como dentro de
 * VS Code. Aquí se le da uno que habla con el anfitrión de la web y guarda su estado en el navegador.
 * Este módulo tiene que cargarse antes que el lienzo.
 */

export const host = new WebHost()

const STATE = 'prysel.web.canvas'

function readState(): unknown {
  try {
    const raw = localStorage.getItem(STATE)
    return raw ? (JSON.parse(raw) as unknown) : undefined
  } catch {
    return undefined
  }
}

const api = {
  postMessage(message: unknown) {
    host.receive(message)
  },
  getState: readState,
  setState(state: unknown) {
    try {
      localStorage.setItem(STATE, JSON.stringify(state))
    } catch {
      // Sin almacenamiento (modo privado): el lienzo funciona igual, solo no recuerda sus preferencias.
    }
    return state
  },
}

;(globalThis as unknown as { acquireVsCodeApi: () => typeof api }).acquireVsCodeApi = () => api
