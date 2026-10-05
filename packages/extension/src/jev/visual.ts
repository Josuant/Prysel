/**
 * Ayudas visuales: nodos que **no son parte del programa** pero ayudan a entenderlo. Cuando una pieza usa
 * una función que se entiende mejor viéndola —una sigmoide, una ReLU, un error cuadrático—, la IA
 * generativa puede proponer su curva o una tabla de valores, y el lienzo la dibuja junto al nodo.
 *
 * Como todo lo demás, la ayuda vive en el código: una marca al final de la línea de su sentencia,
 * `# prysel:ver curva «Sigmoide» y = 1/(1+exp(-x)), x de -6 a 6`. Así no se pierde al cerrar el lienzo, se
 * deshace con lo demás y cualquiera la puede leer (o borrar) en el archivo.
 *
 * La fórmula la propone un modelo, así que **no se ejecuta**: se lee con un intérprete propio que solo
 * sabe de números, `x`, las operaciones de siempre y unas pocas funciones matemáticas. Lo que no entiende,
 * no se dibuja.
 */

export type Visual =
  | { kind: 'curva'; title: string; formula: string; from: number; to: number }
  | { kind: 'tabla'; title: string; formula: string; xs: number[] }

const MAX_TITLE = 40
const MAX_FORMULA = 120
const MAX_XS = 8

// ───────────────────────── leer una fórmula, sin ejecutar nada ─────────────────────────

const FUNCTIONS: Record<string, (...args: number[]) => number> = {
  exp: Math.exp,
  log: Math.log,
  ln: Math.log,
  sqrt: Math.sqrt,
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  tanh: Math.tanh,
  abs: Math.abs,
  max: Math.max,
  min: Math.min,
}
const CONSTANTS: Record<string, number> = { pi: Math.PI, e: Math.E }

type Token = { type: 'number'; value: number } | { type: 'name' | 'op'; value: string }

function tokenize(formula: string): Token[] | null {
  // `math.exp`, `np.exp`: el prefijo del módulo no dice nada aquí.
  const source = formula.replace(/\b(math|np|numpy)\./g, '')
  const tokens: Token[] = []
  const pattern = /\s*(?:(\d+\.?\d*(?:[eE][-+]?\d+)?|\.\d+)|([A-Za-z_]\w*)|(\*\*|[-+*/^(),]))/y
  let at = 0
  while (at < source.length) {
    if (/^\s*$/.test(source.slice(at))) break
    pattern.lastIndex = at
    const match = pattern.exec(source)
    if (!match) return null
    if (match[1] !== undefined) tokens.push({ type: 'number', value: Number(match[1]) })
    else if (match[2] !== undefined) tokens.push({ type: 'name', value: match[2] })
    else tokens.push({ type: 'op', value: match[3] ?? '' })
    at = pattern.lastIndex
  }
  return tokens
}

/** Lo que vale una fórmula en `x`. `null` si no se entiende o no da un número. */
export function evaluate(formula: string, x: number): number | null {
  const tokens = tokenize(formula)
  if (!tokens || tokens.length === 0 || tokens.length > 200) return null
  let at = 0
  const peek = () => tokens[at]
  const isOp = (value: string) => {
    const token = peek()
    return token?.type === 'op' && token.value === value
  }
  class Unreadable extends Error {}
  const fail = (): never => {
    throw new Unreadable()
  }
  const sum = (): number => {
    let value = product()
    for (;;) {
      if (isOp('+')) {
        at++
        value += product()
      } else if (isOp('-')) {
        at++
        value -= product()
      } else return value
    }
  }
  const product = (): number => {
    let value = unary()
    for (;;) {
      if (isOp('*')) {
        at++
        value *= unary()
      } else if (isOp('/')) {
        at++
        value /= unary()
      } else return value
    }
  }
  const unary = (): number => {
    if (isOp('-')) {
      at++
      return -unary()
    }
    if (isOp('+')) {
      at++
      return unary()
    }
    const base = atom()
    if (isOp('**') || isOp('^')) {
      at++
      return base ** unary()
    }
    return base
  }
  const atom = (): number => {
    const token = peek()
    if (!token) return fail()
    at++
    if (token.type === 'number') return token.value
    if (token.type === 'op') {
      if (token.value !== '(') return fail()
      const inner = sum()
      if (!isOp(')')) return fail()
      at++
      return inner
    }
    if (isOp('(')) {
      const fn = FUNCTIONS[token.value]
      if (!fn) return fail()
      at++
      const args = [sum()]
      while (isOp(',')) {
        at++
        args.push(sum())
      }
      if (!isOp(')')) return fail()
      at++
      return fn(...args)
    }
    if (token.value === 'x') return x
    const constant = CONSTANTS[token.value]
    return constant === undefined ? fail() : constant
  }
  try {
    const value = sum()
    return at === tokens.length && Number.isFinite(value) ? value : null
  } catch (error) {
    if (error instanceof Unreadable) return null
    throw error
  }
}

// ───────────────────────── de lo que propone la IA a la marca del código, y vuelta ─────────────────────────

const clean = (text: string, max: number) =>
  text
    .replace(/[«»#\r\n]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)

const finite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value)

/** ¿Se puede dibujar? La fórmula se entiende y da números en lo que se va a enseñar. */
export function drawable(visual: Visual): boolean {
  const xs =
    visual.kind === 'curva' ? [visual.from, (visual.from + visual.to) / 2, visual.to] : visual.xs
  return xs.filter((x) => evaluate(visual.formula, x) !== null).length >= Math.min(2, xs.length)
}

/** Lee la ayuda que propone la IA en un paso (`"ver": {…}`). `null` si no vale. */
export function visualOf(value: unknown): Visual | null {
  if (typeof value !== 'object' || value === null) return null
  const raw = value as Record<string, unknown>
  const title = clean(typeof raw.titulo === 'string' ? raw.titulo : '', MAX_TITLE)
  const formula = clean(typeof raw.y === 'string' ? raw.y : '', MAX_FORMULA).replace(
    /^y\s*=\s*/,
    '',
  )
  if (title === '' || formula === '') return null
  let visual: Visual
  if (raw.tipo === 'tabla') {
    const xs = Array.isArray(raw.x) ? raw.x.filter(finite).slice(0, MAX_XS) : []
    if (xs.length < 2) return null
    visual = { kind: 'tabla', title, formula, xs }
  } else {
    const from = finite(raw.desde) ? raw.desde : -5
    const to = finite(raw.hasta) ? raw.hasta : 5
    if (to <= from) return null
    visual = { kind: 'curva', title, formula, from, to }
  }
  return drawable(visual) ? visual : null
}

const short = (value: number) => String(Number(value.toPrecision(6)))

/** La marca de una ayuda, como va en el código (sin la almohadilla). */
export function formatVisual(visual: Visual): string {
  const where =
    visual.kind === 'curva'
      ? `x de ${short(visual.from)} a ${short(visual.to)}`
      : `x en ${visual.xs.map(short).join(' ')}`
  return `prysel:ver ${visual.kind} «${visual.title}» y = ${visual.formula}, ${where}`
}

/** Lee la marca de una ayuda (lo que el analizador deja en `ProgramNode.aid`). */
export function parseVisual(text: string): Visual | null {
  const match = /^(curva|tabla)\s+«([^»]*)»\s+y\s*=\s*(.+),\s*x\s+(de|en)\s+(.+)$/.exec(text.trim())
  if (!match) return null
  const [, kind, title = '', formula = '', , rest = ''] = match
  if (kind === 'curva') {
    const range = /^(-?[\d.eE+-]+)\s+a\s+(-?[\d.eE+-]+)$/.exec(rest.trim())
    const from = Number(range?.[1])
    const to = Number(range?.[2])
    if (!range || !Number.isFinite(from) || !Number.isFinite(to) || to <= from) return null
    return { kind: 'curva', title, formula: formula.trim(), from, to }
  }
  const xs = rest.trim().split(/\s+/).map(Number).filter(Number.isFinite).slice(0, MAX_XS)
  return xs.length < 2 ? null : { kind: 'tabla', title, formula: formula.trim(), xs }
}

/** Añade la marca de una ayuda al final de la línea de la sentencia de un paso (si no lleva ya un comentario). */
export function withVisual(code: string, visual: Visual): string {
  const lines = code.split('\n')
  const at = lines.findIndex((line) => line.trim() !== '' && !line.trimStart().startsWith('#'))
  const line = lines[at]
  if (at < 0 || line === undefined || line.includes('#')) return code
  lines[at] = `${line}  # ${formatVisual(visual)}`
  return lines.join('\n')
}

/** Los puntos de una curva: `n` valores de la fórmula entre sus extremos (los que no dan número se saltan). */
export function curveOf(
  visual: Extract<Visual, { kind: 'curva' }>,
  n = 64,
): { at: number[]; values: number[]; n: number } {
  const at: number[] = []
  const values: number[] = []
  for (let i = 0; i < n; i++) {
    const y = evaluate(visual.formula, visual.from + ((visual.to - visual.from) * i) / (n - 1))
    if (y === null) continue
    at.push(i)
    values.push(y)
  }
  return { at, values, n }
}

/** Las filas de una tabla de valores: cada `x` con su `y`. */
export function tableOf(visual: Extract<Visual, { kind: 'tabla' }>): (string | number)[][] {
  return visual.xs.map((x) => {
    const y = evaluate(visual.formula, x)
    return [short(x), y === null ? '—' : short(y)]
  })
}
