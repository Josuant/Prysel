import type { WebDocument } from './host.ts'

/**
 * Las lecciones de ejemplo del repositorio (`examples/lecciones`): cada `.py` con su `.lesson.json`.
 * Van dentro de la web, así que se abren sin red.
 */

const programs = import.meta.glob<string>('../../../examples/lecciones/*.py', {
  query: '?raw',
  import: 'default',
  eager: true,
})
const lessons = import.meta.glob<string>('../../../examples/lecciones/*.lesson.json', {
  query: '?raw',
  import: 'default',
  eager: true,
})

export interface Example extends WebDocument {
  id: string
  title: string
  level: string | null
}

const nameOf = (path: string) => path.slice(path.lastIndexOf('/') + 1)

/** Lo que dice el guion de sí mismo (título y nivel), sin validarlo entero: eso lo hace el lienzo. */
function headerOf(raw: string | null): { title: string | null; level: string | null } {
  if (!raw) return { title: null, level: null }
  try {
    const parsed = JSON.parse(raw) as { title?: unknown; level?: unknown }
    return {
      title: typeof parsed.title === 'string' ? parsed.title : null,
      level: typeof parsed.level === 'string' ? parsed.level : null,
    }
  } catch {
    return { title: null, level: null }
  }
}

/** El orden en que se ofrecen: de lo más sencillo a lo más largo. */
const ORDER = ['factorial', 'burbuja', 'alias', 'flappy_ga']

export const EXAMPLES: Example[] = Object.entries(programs)
  .map(([path, text]) => {
    const name = nameOf(path)
    const id = name.replace(/\.py$/, '')
    const lesson = lessons[path.replace(/\.py$/, '.lesson.json')] ?? null
    const header = headerOf(lesson)
    return { id, name, text, lesson, title: header.title ?? name, level: header.level }
  })
  .sort((a, b) => {
    const rank = (id: string) => (ORDER.includes(id) ? ORDER.indexOf(id) : ORDER.length)
    return rank(a.id) - rank(b.id) || a.id.localeCompare(b.id)
  })

export const BLANK: WebDocument = {
  name: 'programa.py',
  text: '# Escribe Python aquí y mira el diagrama en la pestaña «Diagrama».\n\nnumeros = [3, 1, 2]\ntotal = 0\nfor n in numeros:\n    total = total + n\nprint(total)\n',
  lesson: null,
}
