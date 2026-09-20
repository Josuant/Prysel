import type { ControlModel } from '@prysel/morphology'
import type { Node as TsNode } from '@vscode/tree-sitter-wasm'
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
      return Number.isFinite(value) ? { control: { kind: 'number', value }, ports: {} } : null
    }
    case 'string': {
      const value = stringContent(expression)
      if (value === null) return null
      return {
        control: { kind: 'text', value, multiline: value.includes('\n') || value.length > 40 },
        ports: {},
      }
    }
    case 'true':
    case 'false':
      return { control: { kind: 'boolean', value: expression.type === 'true' }, ports: {} }
    case 'list': {
      const items = named(expression)
      if (items.some((item) => item.type === 'list_splat' || item.type.endsWith('comprehension'))) {
        return null
      }
      return { control: { kind: 'list', items: items.map((item) => item.text) }, ports: {} }
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
        ? { control: { kind: 'dict', entries }, ports: {} }
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
  options: string[]
} | null {
  if (expression.type === 'binary_operator') {
    const left = field(expression, 'left')
    const right = field(expression, 'right')
    const operator = field(expression, 'operator')?.text
    return left && right && operator ? { left, right, operator, options: ARITHMETIC } : null
  }
  if (expression.type === 'comparison_operator') {
    const parts = named(expression)
    const operator = expression.childForFieldName('operators')?.text
    const [left, right] = parts
    if (parts.length !== 2 || !left || !right || !operator) return null
    return { left, right, operator: oneLine(operator), options: COMPARISON }
  }
  return null
}

function operation(expression: TsNode): Semantics | null {
  const parts = operands(expression)
  if (!parts) return null
  const { left, right, operator, options } = parts
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
  }
}

/** `numero2 < 0`: un campo, un operador y el valor con el que se compara. */
export function condition(expression: TsNode | null): Semantics | null {
  if (!expression || expression.type !== 'comparison_operator') return null
  const parts = operands(expression)
  if (!parts) return null
  const { left, right, operator, options } = parts
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
  }
}

function call(expression: TsNode, context: SemanticContext): Semantics | null {
  const callee = calleeName(expression)
  const list = field(expression, 'arguments')
  if (!callee || list?.type !== 'argument_list') return null
  const items = named(list).filter((item) => item.type !== 'comment')
  if (items.length === 0) return null

  // `print("mensaje")` no es una llamada con un argumento: es un mensaje. Se edita como texto.
  const only = items[0]
  if (callee === 'print' && items.length === 1 && only) {
    const message = stringContent(only)
    if (message !== null) {
      const ports: Record<string, string> = {}
      route(only, 'value', ports)
      return {
        control: { kind: 'text', value: message, multiline: true, placeholder: 'Mensaje' },
        ports,
      }
    }
  }

  const params = context.functions.get(callee)
  const single = SINGLE_ARGUMENT[callee] ?? 'valor'
  const args: { name: string; value: string }[] = []
  const ports: Record<string, string> = {}
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
  }
  return { control: { kind: 'args', target: callee, args }, ports }
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
      return call(expression, context)
    default:
      return null
  }
}

/** `total += n`: el mismo editor que una operación, con el operador de asignación. */
export function augmented(statement: TsNode): Semantics | null {
  const left = field(statement, 'left')
  const right = field(statement, 'right')
  const operator = field(statement, 'operator')?.text
  if (!left || !right || !operator) return null
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
  }
}

/** `for n in range(x)`: la variable y la secuencia que recorre. */
export function loop(variable: TsNode | null, iterable: TsNode | null): ControlModel | null {
  if (!variable || !iterable) return null
  return { kind: 'loop', variable: variable.text, iterable: iterable.text }
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

/** `import pandas as pd`. Sin alias no hay nada que editar: se enseña el código. */
export function moduleOf(statement: TsNode): ControlModel | null {
  if (statement.type !== 'import_statement') return null
  const imported = field(statement, 'name')
  if (imported?.type !== 'aliased_import') return null
  const module = field(imported, 'name')?.text
  const alias = field(imported, 'alias')?.text
  return module && alias ? { kind: 'module', module, alias } : null
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
