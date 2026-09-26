import { invertEdits, type TextEdit } from '@prysel/python/edits'

/**
 * El «deshacer» propio del lienzo: lo que se cambió desde el diagrama se puede deshacer y rehacer desde
 * el diagrama (en un webview, Ctrl+Z no llega al editor de texto). Solo lo que hizo el lienzo, y solo si
 * el documento sigue tal como lo dejó: si se escribió en el editor entre medias, deshacer desde aquí
 * pisaría eso, así que la historia se olvida (el editor tiene la suya, con Ctrl+Z allí).
 *
 * Puro: no sabe de `vscode`. Quien aplica las ediciones le cuenta qué hizo y en qué versión quedó.
 */

interface Entry {
  /** Lo que hay que aplicar para volver atrás (o adelante). */
  edits: TextEdit[]
  /** La versión del documento en la que esas ediciones valen: la que dejó la última escritura del lienzo. */
  version: number
}

export class EditHistory {
  private undos: Entry[] = []
  private redos: Entry[] = []

  constructor(private readonly limit = 100) {}

  get sizes(): { undo: number; redo: number } {
    return { undo: this.undos.length, redo: this.redos.length }
  }

  /** El lienzo aplicó `edits` sobre `before` y el documento quedó en `version`. Lo rehecho se olvida. */
  applied(before: string, edits: readonly TextEdit[], version: number) {
    this.undos.push({ edits: invertEdits(before, edits), version })
    if (this.undos.length > this.limit) this.undos.shift()
    this.redos = []
  }

  /** Lo que desharía el último cambio del lienzo, si el documento sigue en `version` (si no, se olvida todo). */
  nextUndo(version: number): TextEdit[] | null {
    return this.peek(this.undos, version)
  }

  /** Ya se deshizo (sobre `before`, y el documento quedó en `version`): pasa a poder rehacerse. */
  undone(before: string, version: number) {
    const entry = this.undos.pop()
    if (entry) this.redos.push({ edits: invertEdits(before, entry.edits), version })
  }

  nextRedo(version: number): TextEdit[] | null {
    return this.peek(this.redos, version)
  }

  redone(before: string, version: number) {
    const entry = this.redos.pop()
    if (entry) this.undos.push({ edits: invertEdits(before, entry.edits), version })
  }

  clear() {
    this.undos = []
    this.redos = []
  }

  private peek(stack: Entry[], version: number): TextEdit[] | null {
    const top = stack[stack.length - 1]
    if (!top) return null
    // Algo cambió el documento desde fuera del lienzo: las ediciones guardadas ya no casan con el texto.
    if (top.version !== version) {
      this.clear()
      return null
    }
    return top.edits
  }
}
