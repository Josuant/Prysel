import type { Program } from '@prysel/python'
import { reachesOutside } from '../jev/safety.ts'

/**
 * Lo que se sabe de una función sin ejecutarla: qué recibe y qué deja (devuelve, imprime), de quién es si es
 * un método, y si se puede probar sola. Sale del análisis del programa; no se le pregunta a ninguna IA.
 */
export interface Facts {
  /** El id de su nodo en el programa. */
  id: string
  name: string
  /** La clase de la que es método, si lo es. */
  owner: string | null
  line: number
  lineEnd: number
  /** Lo que recibe, sin `self` ni `cls`. */
  takes: string[]
  /** Devuelve un valor (tiene un `return` con algo). */
  returns: boolean
  prints: boolean
  /** Pide algo por teclado: no se puede probar sola. */
  asks: boolean
  /** Tiene con qué tocar archivos, la red o el sistema: no se ejecuta sin permiso. */
  reaches: boolean
  /** Lo que el código dice de ella (su docstring o su comentario). */
  note: string | null
  code: string
  /** Cambia cuando cambia su texto: lo que se sabía de ella deja de valer. */
  hash: string
}

/**
 * Si el código tiene con qué salir del programa. Definir un método especial (`__init__`, `__str__`), llamar
 * al del padre o mirar `__name__` no lo es: es lo normal en cualquier clase.
 */
export function reaches(code: string): boolean {
  return reachesOutside(
    code
      .replace(/\bdef\s+__\w+__/g, 'def especial')
      .replace(/\.__init__\s*\(/g, '.init(')
      .replace(/__name__|__main__/g, 'nombre'),
  )
}

/** Un resumen corto de un texto: para saber si es el mismo de antes, no para nada más. */
export function hashOf(text: string): string {
  let hash = 5381
  for (let i = 0; i < text.length; i++) hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0
  return (hash >>> 0).toString(36)
}

/** Las funciones y métodos del programa de los que se puede enseñar qué hacen. */
export function functionsIn(program: Program): Facts[] {
  const rows = program.source.split(/\r?\n/)
  const spanned = program.nodes
    .filter((node) => node.kind === 'abstraction.collapsed' || node.kind === 'abstraction.class')
    .map((node) => ({ node, from: node.line, to: node.lineEnd ?? node.line }))
  const facts: Facts[] = []
  for (const { node, from, to } of spanned) {
    if (node.kind !== 'abstraction.collapsed') continue
    // Lo que la envuelve, de fuera adentro: una función dentro de otra no se enseña aparte.
    const around = spanned
      .filter((other) => other.node.id !== node.id && other.from <= from && other.to >= to)
      .sort((a, b) => a.from - b.from)
    if (around.some((other) => other.node.kind === 'abstraction.collapsed')) continue
    // Los métodos especiales (`__init__`, `__str__`) se ven a través de los demás.
    if (/^__\w+__$/.test(node.label)) continue
    const owner = around.at(-1)?.node.label ?? null
    const code = rows.slice(from - 1, to).join('\n')
    const body = code.replace(/"[^"\n]*"|'[^'\n]*'/g, '""').replace(/#.*$/gm, '')
    const params = (node.params ?? []).filter(
      (name, index) => !(owner !== null && index === 0 && (name === 'self' || name === 'cls')),
    )
    facts.push({
      id: node.id,
      name: node.label,
      owner,
      line: from,
      lineEnd: to,
      takes: params,
      returns: /^\s*return[ \t]+(?!None\b)\S/m.test(body),
      prints: /\bprint\s*\(/.test(body),
      asks: /\binput\s*\(/.test(body),
      reaches: reaches(code),
      note: node.note?.split('\n')[0]?.trim() || null,
      code,
      hash: hashOf(code),
    })
  }
  return facts
}
