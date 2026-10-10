/**
 * Las **perillas** de un programa: los números con los que se puede jugar sin tocar el código. El tamaño de
 * la población, cuántas generaciones, la probabilidad de mutar… Se leen del propio programa:
 *
 * - las **constantes** que define en su primer nivel con un número (`LONGITUD = 8`), y
 * - los números con los que **arranca** (los de la llamada a una de sus funciones, también en su primer nivel:
 *   `algoritmo_genetico(12, 40)`), con el nombre de lo que esa función recibe.
 *
 * Mover una perilla escribe ese número en el programa (es su código: se puede deshacer) y el programa se
 * vuelve a ejecutar. No se inventa nada: solo se ofrece cambiar lo que ya estaba escrito.
 */
export interface Knob {
  /** Cómo se llama: el nombre de la constante, o de lo que la función recibe. */
  name: string
  value: number
  /** Dónde está escrito su número en el programa (de dónde a dónde, en caracteres). */
  start: number
  end: number
  line: number
  /** Es un número con decimales: se mueve de poco en poco. */
  decimal: boolean
  /** De dónde sale: una constante del programa, o un dato con el que se arranca. */
  from: 'constant' | 'launch'
}

/** Cuántas perillas se ofrecen: más son un panel de mandos, no una ayuda. */
export const MAX_KNOBS = 6

const NUMBER = String.raw`-?\d+(?:\.\d+)?`
const CONSTANT = new RegExp(String.raw`^([A-Za-z_]\w*)\s*=\s*(${NUMBER})\s*(?:#.*)?$`)

/** Las perillas del programa. `functions`: sus funciones, con lo que recibe cada una. */
export function knobsOf(
  source: string,
  functions: readonly { name: string; params: readonly string[] }[] = [],
): Knob[] {
  const knobs: Knob[] = []
  const byName = new Map(functions.map((fn) => [fn.name, fn.params]))
  let offset = 0
  for (const [at, row] of source.split('\n').entries()) {
    const line = row.replace(/\r$/, '')
    const indented = /^\s/.test(line)
    if (!indented && line.trim() !== '' && !line.startsWith('#')) {
      const constant = CONSTANT.exec(line)
      if (constant) {
        const [, name = '', text = ''] = constant
        const start = offset + line.indexOf(text, name.length)
        knobs.push(knob(name, text, start, at + 1, 'constant'))
      } else {
        // Una llamada a una función del programa, con números escritos: los datos con los que arranca.
        for (const call of line.matchAll(/\b([A-Za-z_]\w*)\(([^()]*)\)/g)) {
          const params = byName.get(call[1] ?? '')
          if (!params) continue
          const inside = call[2] ?? ''
          let cursor = offset + (call.index ?? 0) + (call[1] ?? '').length + 1
          for (const [index, part] of inside.split(',').entries()) {
            const text = part.trim()
            // Un dato con nombre (`tamano=20`) se llama como dice; uno suelto, como lo que la función recibe.
            const named = /^([A-Za-z_]\w*)\s*=\s*(.+)$/.exec(text)
            const value = named ? (named[2] ?? '') : text
            if (new RegExp(`^${NUMBER}$`).test(value)) {
              const start = cursor + part.lastIndexOf(value)
              knobs.push(
                knob(
                  named?.[1] ?? params[index] ?? `dato ${index + 1}`,
                  value,
                  start,
                  at + 1,
                  'launch',
                ),
              )
            }
            cursor += part.length + 1
          }
        }
      }
    }
    offset += row.length + 1
  }
  // Primero con lo que se arranca (es lo que más se quiere cambiar); luego las constantes.
  return [
    ...knobs.filter((entry) => entry.from === 'launch'),
    ...knobs.filter((entry) => entry.from === 'constant'),
  ].slice(0, MAX_KNOBS)
}

function knob(name: string, text: string, start: number, line: number, from: Knob['from']): Knob {
  return {
    name,
    value: Number(text),
    start,
    end: start + text.length,
    line,
    decimal: text.includes('.'),
    from,
  }
}

/** De cuánto en cuánto se mueve: de uno en uno lo pequeño, a saltos lo grande, y a décimas lo que tiene decimales. */
export function knobStep(entry: Pick<Knob, 'value' | 'decimal'>): number {
  const size = Math.abs(entry.value)
  if (entry.decimal) return size < 1 ? 0.05 : 0.5
  return size < 20 ? 1 : size < 100 ? 5 : size < 1000 ? 10 : 100
}

/** El número, escrito como va en el programa: sin colas de decimales, y entero si lo era. */
export function knobText(entry: Pick<Knob, 'decimal'>, value: number): string {
  if (!entry.decimal) return String(Math.round(value))
  const text = String(Math.round(value * 1000) / 1000)
  return text.includes('.') ? text : `${text}.0`
}

/** El valor siguiente al mover la perilla un paso (un tamaño o unas vueltas no bajan de cero). */
export function knobMoved(entry: Knob, way: 1 | -1): number {
  const next = entry.value + way * knobStep(entry)
  return entry.value >= 0 ? Math.max(0, next) : next
}
