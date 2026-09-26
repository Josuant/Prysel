import type { ChainStep, ControlModel } from '@prysel/morphology'
import type { Node as TsNode } from '@vscode/tree-sitter-wasm'
import type { Source } from './source.ts'
import { calleeName, field, named, readNames } from './tree.ts'

/**
 * De una expresión de Python a lo que un nodo debería mostrar en lugar de ella.
 *
 * Un nodo no enseña sintaxis: enseña lo que significa. `print("hola")` es un mensaje, `x = 5`
 * es un número, `a + b` son dos operandos y un operador. Aquí se decide qué editor le toca a
 * cada construcción y se recogen los datos que ese editor necesita.
 *
 * Regla de honestidad: solo se devuelve un modelo cuando dice **toda** la construcción.
 * Si algo se perdería por el camino (un `*args`, una cadena de comparaciones, un filtro con
 * receptor), se devuelve `null` y el nodo enseña el código tal cual. Un editor que oculta
 * información es peor que ninguno.
 */

export interface Semantics {
  control: ControlModel
  /** A qué campo del nodo entra cada nombre que la expresión lee: es lo que ubica los cables. */
  ports: Record<string, string>
  /**
   * De dónde sale cada campo en el texto, por su nombre. Solo están los que se pueden reescribir
   * sin descolocar nada; el resto de campos se ven pero no se editan.
   */
  sources?: Record<string, Source>
  /**
   * Los campos que reciben un valor de otro nodo y qué trozo del texto se sustituye al conectarlo,
   * por su puerto. Los de expresión salen de `sources`; aquí solo van los que no coinciden con él.
   */
  inputs?: Record<string, Source>
}

export interface SemanticContext {
  /** Funciones ya definidas, con sus parámetros posicionales: así cada argumento lleva su nombre. */
  functions: ReadonlyMap<string, string[]>
}

const ARITHMETIC = ['+', '-', '*', '/', '//', '%', '**']
const AUGMENTED = ['+=', '-=', '*=', '/=', '//=', '%=', '**=']
const COMPARISON = ['<', '<=', '>', '>=', '==', '!=', 'in', 'not in', 'is', 'is not']
const ERRORS = [
  'ValueError',
  'TypeError',
  'KeyError',
  'IndexError',
  'RuntimeError',
  'NotImplementedError',
]

/** Cómo se llama el argumento cuando la función solo recibe uno y no sabemos su parámetro. */
const SINGLE_ARGUMENT: Record<string, string> = { print: 'mensaje', input: 'mensaje' }

const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim()
const includes = (options: string[], current: string) =>
  options.includes(current) ? options : [...options, current]

const span = (node: TsNode, as: Source['as'], extra: Partial<Source> = {}): Source => ({
  start: node.startIndex,
  end: node.endIndex,
  as,
  ...extra,
})

/**
 * El contenido de una cadena, sin sus comillas: es lo que se reescribe al editar un mensaje.
 * Una cadena cruda o de bytes no se puede reescribir sin cambiar lo que significa (las barras
 * no se escapan igual), así que no se ofrece.
 */
function stringSpan(node: TsNode): Source | null {
  if (node.type !== 'string') return null
  const match = /^([a-zA-Z]{0,2})('''|"""|'|")([\s\S]*)\2$/.exec(node.text)
  if (!match) return null
  const prefix = match[1] ?? ''
  const quote = match[2] ?? '"'
  if (/[rRbB]/.test(prefix)) return null
  return {
    start: node.startIndex + prefix.length + quote.length,
    end: node.endIndex - quote.length,
    as: 'string',
    quote,
  }
}

/** El contenido de algo delimitado (`[…]`, `{…}`, `(…)`), sin los delimitadores: se reescribe entero. */
const inside = (node: TsNode): Source => ({
  start: node.startIndex + 1,
  end: node.endIndex - 1,
  as: 'list',
})

/**
 * Los campos de un editor que aceptan un cable: los de expresión (un operando, un argumento, la
 * secuencia de un bucle…), por su puerto. Un operador o un módulo no son valores: no reciben nada.
 * `extra` añade los que no son una expresión tal cual (el mensaje de un `print`).
 */
export function inputsOf(
  sources: Record<string, Source> | undefined,
  extra: Record<string, Source> = {},
): Record<string, Source> | undefined {
  const found: Record<string, Source> = { ...extra }
  for (const [path, source] of Object.entries(sources ?? {})) {
    if (source.as !== 'expression') continue
    if (path.startsWith('args.')) found[`arg:${path.slice(5)}`] ??= source
    else if (
      [
        'left',
        'right',
        'field',
        'value',
        'iterable',
        'context',
        'type',
        'bases',
        'destination',
        'receiver',
        // Lo que compara un `match` y la condición de un `case`. El patrón no: un nombre soltado ahí
        // pasaría a capturar (definir) en vez de comparar, y cambiaría lo que significa el caso.
        'subject',
        'guard',
      ].includes(path)
    ) {
      found[path] ??= source
    }
  }
  return Object.keys(found).length > 0 ? found : undefined
}

/** Registra en `ports` a qué campo entra cada nombre que lee `expression`. El primero manda. */
function route(expression: TsNode | null, port: string, ports: Record<string, string>) {
  for (const name of readNames(expression)) ports[name] ??= port
}

/** El texto de una cadena sin sus comillas ni su prefijo. Una f-string conserva sus `{huecos}`. */
export function stringContent(node: TsNode): string | null {
  if (node.type !== 'string') return null
  const match = /^[a-zA-Z]{0,2}('''|"""|'|")([\s\S]*)\1$/.exec(node.text)
  return match?.[2] ?? null
}

/** Los nombres de los parámetros posicionales de una función, en orden. */
export function positionalParams(parameters: TsNode | null): string[] {
  if (!parameters) return []
  return named(parameters).flatMap((param) => {
    if (param.type === 'identifier') return [param.text]
    if (param.type === 'default_parameter' || param.type === 'typed_default_parameter') {
      const name = field(param, 'name')?.text
      return name ? [name] : []
    }
    if (param.type === 'typed_parameter') {
      const name = named(param)[0]?.text
      return name ? [name] : []
    }
    return []
  })
}

function literal(expression: TsNode): Semantics | null {
  switch (expression.type) {
    case 'integer':
    case 'float': {
      const value = Number(expression.text.replace(/_/g, ''))
      return Number.isFinite(value)
        ? {
            control: { kind: 'number', value },
            ports: {},
            sources: { value: span(expression, 'number', { original: expression.text }) },
          }
        : null
    }
    case 'string': {
      const value = stringContent(expression)
      if (value === null) return null
      const at = stringSpan(expression)
      return {
        control: { kind: 'text', value, multiline: value.includes('\n') || value.length > 40 },
        ports: {},
        ...(at ? { sources: { value: at } } : {}),
      }
    }
    case 'true':
    case 'false':
      return {
        control: { kind: 'boolean', value: expression.type === 'true' },
        ports: {},
        sources: { value: span(expression, 'boolean') },
      }
    case 'list': {
      const items = named(expression)
      if (items.some((item) => item.type === 'list_splat' || item.type.endsWith('comprehension'))) {
        return null
      }
      return {
        control: { kind: 'list', items: items.map((item) => item.text) },
        ports: {},
        sources: { items: inside(expression) },
      }
    }
    case 'dictionary': {
      const pairs = named(expression)
      if (pairs.some((pair) => pair.type !== 'pair')) return null
      const entries = pairs.flatMap((pair): [string, string][] => {
        const key = field(pair, 'key')
        const value = field(pair, 'value')
        return key && value ? [[key.text, value.text]] : []
      })
      return entries.length === pairs.length
        ? {
            control: { kind: 'dict', entries },
            ports: {},
            sources: { entries: inside(expression) },
          }
        : null
    }
    default:
      return null
  }
}

/** Dos operandos y un operador. Una cadena (`a < b < c`) tiene más y no cabe en este editor. */
function operands(expression: TsNode): {
  left: TsNode
  right: TsNode
  operator: string
  at: TsNode
  options: string[]
} | null {
  if (expression.type === 'binary_operator') {
    const left = field(expression, 'left')
    const right = field(expression, 'right')
    const at = field(expression, 'operator')
    return left && right && at ? { left, right, operator: at.text, at, options: ARITHMETIC } : null
  }
  if (expression.type === 'comparison_operator') {
    const parts = named(expression)
    const at = expression.childForFieldName('operators')
    const [left, right] = parts
    if (parts.length !== 2 || !left || !right || !at) return null
    return { left, right, operator: oneLine(at.text), at, options: COMPARISON }
  }
  return null
}

function operation(expression: TsNode): Semantics | null {
  const parts = operands(expression)
  if (!parts) return null
  const { left, right, operator, at, options } = parts
  const ports: Record<string, string> = {}
  route(left, 'left', ports)
  route(right, 'right', ports)
  return {
    control: {
      kind: 'expression',
      left: left.text,
      operator,
      right: right.text,
      operators: includes(options, operator),
    },
    ports,
    sources: {
      left: span(left, 'expression'),
      operator: span(at, 'operator'),
      right: span(right, 'expression'),
    },
  }
}

/** `numero2 < 0`: un campo, un operador y el valor con el que se compara. */
export function condition(expression: TsNode | null): Semantics | null {
  if (!expression || expression.type !== 'comparison_operator') return null
  const parts = operands(expression)
  if (!parts) return null
  const { left, right, operator, at, options } = parts
  const ports: Record<string, string> = {}
  route(left, 'field', ports)
  route(right, 'value', ports)
  return {
    control: {
      kind: 'condition',
      field: left.text,
      operator,
      value: right.text,
      operators: includes(options, operator),
    },
    ports,
    sources: {
      field: span(left, 'expression'),
      operator: span(at, 'operator'),
      value: span(right, 'expression'),
    },
  }
}

function call(expression: TsNode, context: SemanticContext): Semantics | null {
  const callee = calleeName(expression)
  const list = field(expression, 'arguments')
  if (!callee || list?.type !== 'argument_list') return null
  const items = named(list).filter((item) => item.type !== 'comment')
  const callable = field(expression, 'function')
  // Una llamada sin argumentos a una función suelta (`main()`) también tiene editor: es donde se elige a quién llamar.
  if (items.length === 0 && (callable?.type !== 'identifier' || callee === 'print')) return null

  // `print("mensaje")` no es una llamada con un argumento: es un mensaje. Se edita como texto.
  const only = items[0]
  if (callee === 'print' && items.length === 1 && only) {
    const message = stringContent(only)
    if (message !== null) {
      const ports: Record<string, string> = {}
      route(only, 'value', ports)
      const at = stringSpan(only)
      return {
        // Un mensaje corto cabe en una fila; uno largo o de varias líneas crece.
        control: {
          kind: 'text',
          value: message,
          multiline: message.includes('\n') || message.length > 40,
          placeholder: 'Mensaje',
        },
        ports,
        ...(at ? { sources: { value: at } } : {}),
        // Conectar una variable a un mensaje lo sustituye entero: `print("Hola")` → `print(nombre)`.
        inputs: { value: span(only, 'string') },
      }
    }
  }

  const params = context.functions.get(callee)
  const single = SINGLE_ARGUMENT[callee] ?? 'valor'
  const args: { name: string; value: string }[] = []
  const ports: Record<string, string> = {}
  const sources: Record<string, Source> = {}
  let position = 0
  for (const item of items) {
    if (item.type === 'list_splat' || item.type === 'dictionary_splat') return null
    let name: string
    let value: TsNode | null
    if (item.type === 'keyword_argument') {
      name = field(item, 'name')?.text ?? ''
      value = field(item, 'value')
    } else {
      name = params?.[position] ?? (items.length === 1 ? single : `arg${position + 1}`)
      value = item
      position++
    }
    if (!name || !value) return null
    args.push({ name, value: value.text })
    route(value, `arg:${name}`, ports)
    sources[`args.${name}`] = span(value, 'expression')
  }
  // A quién se llama y la lista de argumentos como un todo: es lo que permite elegir otra función
  // (y con ella, sus parámetros) sin escribir el nombre a mano.
  if (callable) {
    sources['target'] = span(callable, 'expression')
    sources['argsList'] = inside(list)
  }
  return {
    control: { kind: 'args', target: callee, args },
    ports,
    sources,
    ...(callable ? { inputs: { callee: span(callable, 'expression') } } : {}),
  }
}

interface StepNode {
  kind: ChainStep['kind']
  node: TsNode
  /** El nombre del método o del atributo. */
  name?: TsNode
  /** Dónde empiezan y acaban los argumentos o el índice (sin los paréntesis ni los corchetes). */
  inner?: { start: number; end: number }
}

/** Sin los paréntesis que envuelven una expresión (`(df.a().b())`), que es como se escribe una cadena en varias líneas. */
export function unwrapParens(expression: TsNode): TsNode {
  let current = expression
  while (current.type === 'parenthesized_expression') {
    const inner = named(current).filter((child) => child.type !== 'comment')
    const only = inner.length === 1 ? inner[0] : undefined
    if (!only) break
    current = only
  }
  return current
}

/**
 * Una expresión de llamadas, índices y atributos encadenados, de la raíz hacia fuera. Los atributos
 * del principio (`os.path`, `self.model`) son el camino hasta el receptor, no pasos: por eso
 * `os.path.join(a, b)` es una sola llamada y `df.groupby("a").sum()` son dos pasos.
 */
function spineOf(expression: TsNode): { receiver: TsNode; steps: StepNode[] } | null {
  const steps: StepNode[] = []
  let current = expression
  for (;;) {
    if (current.type === 'call') {
      const callee = field(current, 'function')
      const list = field(current, 'arguments')
      if (callee?.type !== 'attribute') break
      // Un generador como único argumento (`f(x for x in y)`) no tiene paréntesis propios: no se representa.
      if (list?.type !== 'argument_list') return null
      const name = field(callee, 'attribute')
      const object = field(callee, 'object')
      if (!name || !object) return null
      steps.push({
        kind: 'call',
        node: current,
        name,
        inner: { start: list.startIndex + 1, end: list.endIndex - 1 },
      })
      current = object
    } else if (current.type === 'attribute') {
      const name = field(current, 'attribute')
      const object = field(current, 'object')
      if (!name || !object) return null
      steps.push({ kind: 'attr', node: current, name })
      current = object
    } else if (current.type === 'subscript') {
      const value = field(current, 'value')
      const open = current.children.find((child) => child?.type === '[')
      const close = [...current.children].reverse().find((child) => child?.type === ']')
      if (!value || !open || !close) return null
      steps.push({
        kind: 'index',
        node: current,
        inner: { start: open.endIndex, end: close.startIndex },
      })
      current = value
    } else {
      break
    }
  }
  steps.reverse()
  let lead = 0
  while (lead < steps.length && steps[lead]?.kind === 'attr') lead++
  const receiver = lead === 0 ? current : (steps[lead - 1]?.node ?? current)
  return { receiver, steps: steps.slice(lead) }
}

/** Lo que puede ser la cima de una cadena: una llamada, un índice o un atributo (`df["fecha"].dt.month`). */
const CHAINED: ReadonlySet<string> = new Set(['call', 'subscript', 'attribute'])

/** ¿Es una cadena de al menos dos pasos? Es lo que se enseña como pasos, cada uno con su vista previa. */
export function isChain(expression: TsNode | null): boolean {
  if (!expression) return false
  const inner = unwrapParens(expression)
  if (!CHAINED.has(inner.type)) return false
  return (spineOf(inner)?.steps.length ?? 0) >= 2
}

/**
 * `df.groupby("mes")["monto"].sum().reset_index()` como un receptor y una lista de pasos. Cada trozo de
 * texto que se puede reescribir sin descolocar nada tiene su sitio (`receiver`, `steps[i].name`,
 * `steps[i].args`), y la cadena entera también (`chain`): quitar, añadir o cambiar de tipo un paso
 * reescribe toda la cadena. Solo si cada trozo cabe en una línea; lo demás se enseña como código.
 */
function chain(expression: TsNode): Semantics | null {
  const whole = unwrapParens(expression)
  if (!CHAINED.has(whole.type)) return null
  const spine = spineOf(whole)
  if (!spine || spine.steps.length < 2) return null
  const { receiver, steps } = spine
  const texts = [receiver.text]
  const model: ChainStep[] = []
  const sources: Record<string, Source> = {
    receiver: span(receiver, 'expression'),
    chain: span(whole, 'expression'),
  }
  const ports: Record<string, string> = {}
  route(receiver, 'receiver', ports)
  for (const [i, step] of steps.entries()) {
    const args = step.inner
      ? whole.text.slice(step.inner.start - whole.startIndex, step.inner.end - whole.startIndex)
      : ''
    texts.push(step.name?.text ?? '', args)
    model.push({ kind: step.kind, name: step.name?.text ?? '', args })
    if (step.name) sources[`steps[${i}].name`] = span(step.name, 'expression')
    if (step.inner) {
      sources[`steps[${i}].args`] = {
        start: step.inner.start,
        end: step.inner.end,
        as: 'arguments',
      }
    }
  }
  if (texts.some((text) => /[\r\n]/.test(text))) return null
  return { control: { kind: 'chain', receiver: receiver.text, steps: model }, ports, sources }
}

/** Lo que enseña un nodo que calcula o guarda una expresión. `null` = mostrar el código. */
export function semanticsOf(expression: TsNode | null, context: SemanticContext): Semantics | null {
  if (!expression) return null
  const value = literal(expression)
  if (value) return value
  switch (expression.type) {
    case 'binary_operator':
    case 'comparison_operator':
      return operation(expression)
    case 'call':
      return chain(expression) ?? call(expression, context)
    case 'subscript':
    case 'attribute':
    case 'parenthesized_expression':
      return chain(expression)
    default:
      return null
  }
}

/** `total += n`: el mismo editor que una operación, con el operador de asignación. */
export function augmented(statement: TsNode): Semantics | null {
  const left = field(statement, 'left')
  const right = field(statement, 'right')
  const at = field(statement, 'operator')
  const operator = at?.text
  if (!left || !right || !at || !operator) return null
  const ports: Record<string, string> = {}
  route(left, 'left', ports)
  route(right, 'right', ports)
  return {
    control: {
      kind: 'expression',
      left: left.text,
      operator,
      right: right.text,
      operators: includes(AUGMENTED, operator),
    },
    ports,
    // Reescribir el objetivo (`total` en `total += n`) cambiaría qué variable se asigna.
    sources: { operator: span(at, 'operator'), right: span(right, 'expression') },
  }
}

/** `return a + b` es una operación; `return total`, un valor que sale. */
export function returned(value: TsNode | null): Semantics | null {
  if (!value) return null
  const op = operation(value)
  if (op) return op
  const ports: Record<string, string> = {}
  route(value, 'arg:valor', ports)
  return {
    control: { kind: 'args', target: '', args: [{ name: 'valor', value: value.text }] },
    ports,
    sources: { 'args.valor': span(value, 'expression') },
  }
}

/** `for n in range(x)`: la variable y la secuencia que recorre. */
export function loop(variable: TsNode | null, iterable: TsNode | null): ControlModel | null {
  if (!variable || !iterable) return null
  return { kind: 'loop', variable: variable.text, iterable: iterable.text }
}

/** La secuencia que recorre un bucle se puede reescribir; su variable no (se usa dentro del cuerpo). */
export function loopSources(iterable: TsNode | null): Record<string, Source> | undefined {
  return iterable ? { iterable: span(iterable, 'expression') } : undefined
}

/**
 * `with abre() as f:`: el recurso y el nombre con el que se usa dentro. Solo con un único elemento y un
 * nombre sencillo: `with a as x, b as y` o `as (x, y)` enseñan su código.
 */
export function withOf(context: TsNode | null, alias: TsNode | null): ControlModel | null {
  if (!context) return null
  if (alias && alias.type !== 'identifier') return null
  return { kind: 'with', context: context.text, name: alias?.text ?? '' }
}

/** El recurso de un `with` se puede reescribir; su nombre, por renombrado. */
export function withSources(context: TsNode | null): Record<string, Source> | undefined {
  return context ? { context: span(context, 'expression') } : undefined
}

/**
 * `except ValueError as e:`: qué error se atrapa (vacío: cualquiera) y el nombre con el que se usa dentro.
 * `group`: es un `except*` (atrapa los de ese tipo dentro de un grupo de errores).
 */
export function handlerOf(
  type: TsNode | null,
  alias: TsNode | null,
  group = false,
): ControlModel | null {
  if (alias && alias.type !== 'identifier') return null
  return {
    kind: 'handler',
    type: type?.text ?? '',
    name: alias?.text ?? '',
    ...(group ? { group: true } : {}),
  }
}

/** `match orden:`: lo que se compara. Solo si cabe en una línea (se edita en un campo). */
export function matchOf(subject: TsNode | null): ControlModel | null {
  if (!subject || /[\r\n]/.test(subject.text)) return null
  return { kind: 'match', subject: subject.text }
}

/** Lo que compara un `match` se puede reescribir. */
export function matchSources(subject: TsNode | null): Record<string, Source> | undefined {
  return subject && !/[\r\n]/.test(subject.text)
    ? { subject: span(subject, 'expression') }
    : undefined
}

/**
 * `case "sí" | "s" if listo:`: el patrón (uno o varios separados por comas, tal como se escribieron) y la
 * condición extra. Solo si cada uno cabe en una línea.
 */
export function caseOf(pattern: string, guard: TsNode | null): ControlModel | null {
  if (pattern === '' || /[\r\n]/.test(pattern) || (guard && /[\r\n]/.test(guard.text))) return null
  return { kind: 'case', pattern, guard: guard?.text ?? '' }
}

/** El patrón de un caso y su condición se pueden reescribir. */
export function caseSources(
  patterns: readonly TsNode[],
  guard: TsNode | null,
): Record<string, Source> | undefined {
  const first = patterns[0]
  const last = patterns[patterns.length - 1]
  if (!first || !last) return undefined
  return {
    pattern: { start: first.startIndex, end: last.endIndex, as: 'expression' },
    ...(guard ? { guard: span(guard, 'expression') } : {}),
  }
}

/** El tipo de error de un `except` se puede reescribir. */
export function handlerSources(type: TsNode | null): Record<string, Source> | undefined {
  return type ? { type: span(type, 'expression') } : undefined
}

/**
 * `class Perro(Animal):`: de quién hereda y qué recibe al crearse (los parámetros de su `__init__`,
 * sin `self`). Sin paréntesis, no hereda de nadie explícitamente.
 */
export function classOf(bases: TsNode | null, params: string[]): ControlModel {
  return {
    kind: 'class',
    bases: bases ? bases.text.slice(1, -1).trim() : '',
    params,
  }
}

/** Lo que hay entre los paréntesis de una clase se puede reescribir (y se lee, para enlazar lo que nombra). */
export function classSources(bases: TsNode | null): Record<string, Source> | undefined {
  if (!bases || bases.text.slice(1, -1).trim() === '') return undefined
  return { bases: { start: bases.startIndex + 1, end: bases.endIndex - 1, as: 'expression' } }
}

/**
 * `destino = valor` cuando el valor no tiene editor propio: dos campos. Solo si cabe en una línea cada
 * uno (un valor de varias líneas no se puede escribir en un campo).
 */
export function assignOf(left: TsNode | null, right: TsNode | null): ControlModel | null {
  if (!left || !right || left.text.includes('\n') || right.text.includes('\n')) return null
  return { kind: 'assign', destination: left.text, value: right.text }
}

/**
 * De dónde sale cada campo. El valor siempre se puede reescribir; el destino solo si no es un nombre (un
 * nombre se renombra, que cambia todos sus usos).
 */
export function assignSources(
  left: TsNode | null,
  right: TsNode | null,
): Record<string, Source> | undefined {
  if (!left || !right) return undefined
  return {
    value: span(right, 'expression'),
    ...(left.type === 'identifier' ? {} : { destination: span(left, 'expression') }),
  }
}

/** `raise ValueError("mensaje")`: un tipo de error y su mensaje. */
export function signal(expression: TsNode | null): ControlModel | null {
  if (expression?.type !== 'call') return null
  const type = calleeName(expression)
  const list = field(expression, 'arguments')
  const args = list ? named(list) : []
  if (!type || args.length > 1) return null
  const message = args[0] ? stringContent(args[0]) : ''
  if (message === null) return null
  return { kind: 'signal', errorType: type, types: includes(ERRORS, type), message }
}

/** De dónde salen el tipo de error y el mensaje de un `raise`. */
export function signalSources(expression: TsNode | null): Record<string, Source> | undefined {
  if (expression?.type !== 'call') return undefined
  const sources: Record<string, Source> = {}
  const callee = field(expression, 'function')
  if (callee) sources['errorType'] = span(callee, 'expression')
  const list = field(expression, 'arguments')
  const message = list ? named(list)[0] : undefined
  const at = message ? stringSpan(message) : null
  if (at) sources['message'] = at
  return sources
}

/** `import pandas as pd`. Sin alias no hay nada que editar: se enseña el código. */
export function moduleOf(statement: TsNode): ControlModel | null {
  if (statement.type !== 'import_statement') return null
  const imported = field(statement, 'name')
  if (imported?.type !== 'aliased_import') return null
  const module = field(imported, 'name')?.text
  const alias = field(imported, 'alias')?.text
  return module && alias ? { kind: 'module', module, alias } : null
}

/** De dónde sale el nombre del módulo (el alias se renombra aparte: hay que cambiar sus usos). */
export function moduleSources(statement: TsNode): Record<string, Source> | undefined {
  if (statement.type !== 'import_statement') return undefined
  const imported = field(statement, 'name')
  if (imported?.type !== 'aliased_import') return undefined
  const module = field(imported, 'name')
  return module ? { module: span(module, 'expression') } : undefined
}

/** Los parámetros de una función con su valor por defecto. `null` si hay `*args` o `**kwargs`. */
export function signatureOf(parameters: TsNode | null): ControlModel | null {
  if (!parameters) return { kind: 'signature', params: [] }
  const params: { name: string; value: string }[] = []
  for (const param of named(parameters)) {
    if (param.type === 'identifier') {
      params.push({ name: param.text, value: '' })
    } else if (param.type === 'default_parameter' || param.type === 'typed_default_parameter') {
      const name = field(param, 'name')?.text
      const value = field(param, 'value')?.text
      if (!name) return null
      params.push({ name, value: value ?? '' })
    } else if (param.type === 'typed_parameter') {
      const name = named(param)[0]?.text
      if (!name) return null
      params.push({ name, value: '' })
    } else {
      return null
    }
  }
  return { kind: 'signature', params }
}

/** Los valores por defecto de una función se pueden reescribir; los nombres de sus parámetros no. */
export function signatureSources(parameters: TsNode | null): Record<string, Source> | undefined {
  if (!parameters) return undefined
  const sources: Record<string, Source> = {}
  for (const param of named(parameters)) {
    if (param.type !== 'default_parameter' && param.type !== 'typed_default_parameter') continue
    const name = field(param, 'name')?.text
    const value = field(param, 'value')
    if (name && value) sources[`params.${name}`] = span(value, 'expression')
  }
  // Añadir o quitar parámetros reescribe la lista entera. Solo si ningún parámetro lleva anotación
  // de tipo: se volvería a escribir sin ella, y eso es perder información del usuario.
  const typed = named(parameters).some(
    (param) => param.type === 'typed_parameter' || param.type === 'typed_default_parameter',
  )
  if (!typed) sources['paramsList'] = inside(parameters)
  return Object.keys(sources).length > 0 ? sources : undefined
}

/** El nombre de cada parámetro, por su camino en el editor (`params[0].name`), con el nodo del nombre. */
export function parameterNames(parameters: TsNode | null): { path: string; node: TsNode }[] {
  if (!parameters) return []
  return named(parameters).flatMap((param, index) => {
    const node =
      param.type === 'identifier'
        ? param
        : param.type === 'typed_parameter'
          ? (named(param)[0] ?? null)
          : field(param, 'name')
    return node ? [{ path: `params[${index}].name`, node }] : []
  })
}
