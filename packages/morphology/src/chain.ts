import type { ChainStep } from './controls.ts'

/**
 * Lo que hace falta para editar una cadena de pasos sin saber Python: escribir un paso nuevo como
 * texto y cambiar dos de sitio. Puro: el editor lo usa, y el analizador reescribe el código a partir
 * del modelo resultante.
 */

const NAME = /^[\p{L}_][\p{L}\p{N}_]*$/u

/**
 * Un paso escrito como texto:
 * - `head(3)` o `.head(3)`: una llamada (`head` sin más también lo es: lo normal es llamar a un método);
 * - `["monto"]`: un índice;
 * - `.T` (con punto y sin paréntesis): un atributo.
 * `null` si no es ninguna de las tres (o si ocupa varias líneas).
 */
export function parseChainStep(text: string): ChainStep | null {
  const typed = text.trim()
  if (typed === '' || /[\r\n]/.test(typed)) return null
  if (typed.startsWith('[')) {
    return typed.endsWith(']') && typed.length > 2
      ? { kind: 'index', name: '', args: typed.slice(1, -1).trim() }
      : null
  }
  const dotted = typed.startsWith('.')
  const body = dotted ? typed.slice(1) : typed
  const open = body.indexOf('(')
  if (open < 0) {
    if (!NAME.test(body)) return null
    return dotted ? { kind: 'attr', name: body, args: '' } : { kind: 'call', name: body, args: '' }
  }
  const name = body.slice(0, open).trim()
  if (!NAME.test(name) || !body.endsWith(')')) return null
  return { kind: 'call', name, args: body.slice(open + 1, -1).trim() }
}

/** Los pasos con el de `from` puesto donde estaba el de `to`. Fuera de rango, sin cambios. */
export function moveStep<T>(steps: readonly T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= steps.length || to >= steps.length) {
    return [...steps]
  }
  const next = [...steps]
  const [moved] = next.splice(from, 1)
  if (moved !== undefined) next.splice(to, 0, moved)
  return next
}

/** Un paso escrito como se escribiría en el código (para los títulos y las ayudas). */
export function chainStepText(step: ChainStep): string {
  if (step.kind === 'index') return `[${step.args}]`
  return step.kind === 'call' ? `.${step.name}(${step.args})` : `.${step.name}`
}
