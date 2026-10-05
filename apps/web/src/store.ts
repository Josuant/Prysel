import type { WebDocument } from './host.ts'

/** El documento abierto se guarda en el navegador: al volver, sigue donde se dejó. */
const DOC = 'prysel.web.doc'

export function loadDocument(): WebDocument | null {
  try {
    const raw = localStorage.getItem(DOC)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<WebDocument>
    if (typeof parsed.name !== 'string' || typeof parsed.text !== 'string') return null
    return {
      name: parsed.name,
      text: parsed.text,
      lesson: typeof parsed.lesson === 'string' ? parsed.lesson : null,
    }
  } catch {
    return null
  }
}

export function saveDocument(doc: WebDocument) {
  try {
    localStorage.setItem(
      DOC,
      JSON.stringify({ name: doc.name, text: doc.text, lesson: doc.lesson }),
    )
  } catch {
    // Sin almacenamiento: no pasa nada, solo no se recuerda.
  }
}
