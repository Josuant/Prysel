import type { ControlModel, NodeKindId } from '@prysel/morphology'
import type { Channel, Relation, SemanticEdge } from '@prysel/spatial'
import type { Node as TsNode, Tree } from '@vscode/tree-sitter-wasm'
import {
  augmented,
  condition as conditionOf,
  loop,
  moduleOf,
  positionalParams,
  returned,
  semanticsOf,
  signal,
  signatureOf,
  type SemanticContext,
} from './semantics.ts'
import { calleeName, field, findFirst, firstLine, readNames } from './tree.ts'

/**
 * Del árbol de tree-sitter al grafo semántico.
 *
 * Dos pasadas: la primera reconoce qué es cada sentencia y qué nombre deja definido;
 * la segunda resuelve los nombres que usa para tender las conexiones. Es un análisis de
 * flujo de datos deliberadamente modesto — lo que no entiende lo marca como opaco en vez
 * de inventárselo, que es la regla de la gramática de nodos.
 */

export interface ProgramNode {
  id: string
  kind: NodeKindId
  label: string
  /** El fragmento de Python que representa. */
  code: string
  /** Línea en el archivo (base 1). */
  line: number
  /** Nodos del cuerpo, para las construcciones que contienen otras. */
  contains?: string[]
  /** Operaciones que encapsula. */
  ops?: number
  /**
   * Lo que el nodo enseña en lugar del código: un mensaje, un número, dos operandos y un
   * operador. Solo existe cuando dice toda la sentencia; sin él, el nodo enseña el código.
   */
  control?: ControlModel
  /** Si el nodo llama a una función definida en el archivo: el id de esa definición. */
  calls?: string
}

export interface Program {
  nodes: ProgramNode[]
  edges: SemanticEdge[]
  /** Construcciones que el análisis no entiende, con su motivo. */
  unsupported: { line: number; type: string }[]
}

/** Llamadas que tocan el mundo exterior: son un efecto, no una transformación. */
const IO_CALLS = [
  'open',
  'read_csv',
  'read_json',
  'read_excel',
  'to_csv',
  'to_json',
  'requests.get',
  'requests.post',
  'print',
  'input',
  'urlopen',
  'connect',
  'execute',
]

/** El nombre que un humano le daría a la acción, no el identificador de Python. */
const ACTION_LABELS: Record<string, string> = {
  print: 'Imprimir',
  input: 'Pedir dato',
  display: 'Mostrar',
}

/** Llamadas cuyo resultado está hecho para mirarse. */
const DISPLAY_CALLS = ['display', 'show', 'plot', 'imshow', 'plt.show']

function endsWith(name: string, candidates: string[]): boolean {
  const tail = name.split('.').pop() ?? name
  return candidates.some((c) => c === name || c === tail || name.endsWith(`.${c}`))
}

/** Qué tipo de nodo le corresponde a una expresión. */
function kindOfExpression(expression: TsNode | null): NodeKindId {
  if (!expression) return 'opaque.code'
  switch (expression.type) {
    case 'integer':
    case 'float':
      return 'value.number'
    case 'string':
    case 'concatenated_string':
      return 'value.str'
    case 'true':
    case 'false':
      return 'value.bool'
    case 'none':
      return 'value.none'
    case 'list':
    case 'tuple':
    case 'set':
      return 'data.list'
    case 'dictionary':
      return 'data.dict'
    case 'list_comprehension':
    case 'dictionary_comprehension':
    case 'set_comprehension':
    case 'generator_expression':
      return 'transform.comprehension'
    case 'lambda':
      return 'transform.lambda'
    case 'binary_operator':
    case 'comparison_operator':
    case 'boolean_operator':
    case 'unary_operator':
      return 'transform.operation'
    case 'subscript':
      // `df[df.amount > X]` es un filtro: una condición, no un acceso cualquiera.
      return expression.text.includes('>') ||
        expression.text.includes('<') ||
        expression.text.includes('==')
        ? 'control.condition'
        : 'transform.call'
    case 'call': {
      const name = calleeName(expression)
      if (endsWith(name, DISPLAY_CALLS)) return 'output.display'
      if (endsWith(name, IO_CALLS)) return 'effect.io'
      return 'transform.call'
    }
    case 'attribute':
    case 'identifier':
      return 'transform.call'
    default:
      return 'opaque.code'
  }
}

class Builder {
  readonly nodes: ProgramNode[] = []
  readonly edges: SemanticEdge[] = []
  readonly unsupported: Program['unsupported'] = []
  private readonly scope = new Map<string, string>()
  /** Funciones definidas hasta ahora y sus parámetros: nombran los argumentos de cada llamada. */
  readonly functions = new Map<string, string[]>()
  /** Y el nodo que las define: es lo que permite ir de una llamada a su cuerpo. */
  readonly functionIds = new Map<string, string>()

  add(node: ProgramNode, binds?: string): string {
    this.nodes.push(node)
    if (binds) this.scope.set(binds, node.id)
    return node.id
  }

  bind(name: string, id: string) {
    this.scope.set(name, id)
  }

  /**
   * Abre un ámbito anidado. Lo que se defina dentro desaparece al cerrarlo, para que
   * un `total` local no se confunda con el `total` del módulo.
   */
  pushScope(): () => void {
    const saved = new Map(this.scope)
    return () => {
      this.scope.clear()
      for (const [name, id] of saved) this.scope.set(name, id)
    }
  }

  resolve(name: string): string | undefined {
    return this.scope.get(name)
  }

  link(
    from: string,
    to: string,
    relation: Relation,
    toPort?: string,
    label?: string,
    channel?: Channel,
  ) {
    if (from === to) return
    const exists = this.edges.some(
      (e) => e.from === from && e.to === to && e.toPort === toPort && e.relation === relation,
    )
    if (exists) return
    this.edges.push({
      from,
      to,
      relation,
      ...(toPort === undefined ? {} : { toPort }),
      ...(label === undefined ? {} : { label }),
      ...(channel === undefined ? {} : { channel }),
    })
  }
}

/** Tiende las conexiones desde los nombres que lee una expresión hacia el nodo que la usa. */
function linkReads(
  builder: Builder,
  target: string,
  expression: TsNode | null,
  ports?: Record<string, string>,
) {
  const names = readNames(expression)
  names.forEach((name, index) => {
    const source = builder.resolve(name)
    if (!source) return
    // El primero es la entrada principal (el receptor); el resto, dependencias con nombre.
    const relation: Relation = index === 0 ? 'transform' : 'dependency'
    builder.link(source, target, relation, ports?.[name])
  })
}

/**
 * Los nombres que un import deja definidos. `import pandas as pd` define `pd`;
 * `import os.path` define `os`; `from x import a, b` define `a` y `b`.
 */
function importedNames(statement: TsNode): string[] {
  const names: string[] = []
  const collect = (node: TsNode) => {
    if (node.type === 'aliased_import') {
      const alias = field(node, 'alias')?.text
      if (alias) names.push(alias)
      return
    }
    if (node.type === 'dotted_name') {
      const head = node.namedChildren[0]?.text ?? node.text
      names.push(head)
      return
    }
    if (node.type === 'identifier') {
      names.push(node.text)
      return
    }
    for (const child of node.namedChildren) if (child) collect(child)
  }

  if (statement.type === 'import_from_statement') {
    // De `from pandas import read_csv` interesan los nombres importados, no el módulo.
    const moduleName = field(statement, 'module_name')
    for (const child of statement.namedChildren) {
      if (child && child !== moduleName) collect(child)
    }
  } else {
    collect(statement)
  }
  return names.length > 0 ? names : [statement.text]
}

function statementId(node: TsNode, prefix: string): string {
  return `${prefix}:${node.startIndex}`
}

export function buildProgram(tree: Tree): Program {
  const builder = new Builder()
  visitBlock(builder, tree.rootNode)
  return { nodes: builder.nodes, edges: builder.edges, unsupported: builder.unsupported }
}

function visitBlock(builder: Builder, block: TsNode): string[] {
  const produced: string[] = []
  for (const statement of block.namedChildren) {
    if (!statement) continue
    const id = visitStatement(builder, statement)
    if (id) produced.push(id)
  }
  return produced
}

function visitStatement(builder: Builder, statement: TsNode): string | null {
  const line = statement.startPosition.row + 1
  const code = firstLine(statement.text)

  switch (statement.type) {
    case 'import_statement':
    case 'import_from_statement': {
      const id = statementId(statement, 'import')
      const bound = importedNames(statement)
      const control = moduleOf(statement)
      builder.add({
        id,
        kind: 'external.import',
        label: bound[0] ?? 'import',
        code,
        line,
        ...(control ? { control } : {}),
      })
      // Un import puede dejar definidos varios nombres, y todos apuntan al mismo nodo.
      for (const name of bound) builder.bind(name, id)
      return id
    }

    case 'expression_statement': {
      const inner = statement.namedChildren[0]
      if (!inner) return null
      if (inner.type === 'assignment' || inner.type === 'augmented_assignment') {
        return visitAssignment(builder, inner, line, code)
      }
      const id = statementId(statement, 'expr')
      const sem = semanticsOf(inner, context(builder))
      builder.add({
        id,
        kind: kindOfExpression(inner),
        label: describe(inner),
        code,
        line,
        ...(sem ? { control: sem.control } : {}),
        ...calling(builder, inner),
      })
      linkReads(builder, id, inner, sem?.ports)
      return id
    }

    case 'for_statement': {
      const id = statementId(statement, 'for')
      const iterable = field(statement, 'right')
      const variable = field(statement, 'left')
      const control = loop(variable, iterable)
      builder.add({
        id,
        kind: 'control.loop',
        label: `cada ${variable?.text ?? 'elemento'}`,
        code,
        line,
        ...(control ? { control } : {}),
      })
      linkReads(builder, id, iterable, iterablePorts(iterable))
      if (variable) builder.bind(variable.text, id)

      const body = field(statement, 'body')
      const inside = body ? visitBlock(builder, body) : []
      if (inside.length > 0) {
        const first = inside[0]
        const last = inside[inside.length - 1]
        if (first) builder.link(id, first, 'transform', undefined, undefined, 'control')
        // El retorno cierra el bucle: es la única conexión que va contra el tiempo.
        if (last) builder.link(last, id, 'feedback')
        const node = builder.nodes.find((n) => n.id === id)
        if (node) {
          node.contains = inside
          node.ops = inside.length
        }
      }
      return id
    }

    case 'while_statement': {
      const id = statementId(statement, 'while')
      builder.add({ id, kind: 'control.loop', label: 'mientras', code, line })
      linkReads(builder, id, field(statement, 'condition'))
      const body = field(statement, 'body')
      const inside = body ? visitBlock(builder, body) : []
      const last = inside[inside.length - 1]
      if (inside[0]) builder.link(id, inside[0], 'transform', undefined, undefined, 'control')
      if (last) builder.link(last, id, 'feedback')
      return id
    }

    case 'if_statement': {
      const id = statementId(statement, 'if')
      const condition = field(statement, 'condition')
      const sem = conditionOf(condition)
      builder.add({
        id,
        kind: 'control.condition',
        label: `¿${describe(condition)}?`,
        code,
        line,
        ...(sem ? { control: sem.control } : {}),
      })
      linkReads(builder, id, condition, sem?.ports ?? conditionPorts(condition))

      const body = field(statement, 'consequence')
      const yes = body ? visitBlock(builder, body) : []
      if (yes[0]) builder.link(id, yes[0], 'branch', undefined, 'verdadero')

      for (const clause of statement.namedChildren) {
        if (!clause || (clause.type !== 'else_clause' && clause.type !== 'elif_clause')) continue
        const clauseBody = field(clause, 'body')
        const no = clauseBody ? visitBlock(builder, clauseBody) : []
        if (no[0]) builder.link(id, no[0], 'branch', undefined, 'falso')
      }
      return id
    }

    case 'function_definition': {
      const id = statementId(statement, 'def')
      const name = field(statement, 'name')?.text ?? 'función'
      const params = field(statement, 'parameters')
      const signature = signatureOf(params)
      builder.add(
        {
          id,
          kind: 'abstraction.collapsed',
          label: name,
          code,
          line,
          ...(signature ? { control: signature } : {}),
        },
        name,
      )
      builder.functions.set(name, positionalParams(params))
      builder.functionIds.set(name, id)
      const restore = builder.pushScope()
      // Los parámetros existen solo dentro: se resuelven al propio nodo de la función.
      if (params) {
        for (const param of params.namedChildren) {
          if (!param) continue
          const paramName = param.type === 'identifier' ? param.text : field(param, 'name')?.text
          if (paramName) builder.bind(paramName, id)
        }
      }
      const body = field(statement, 'body')
      // Todo lo que nace dentro del `def` es suyo, a cualquier profundidad: las ramas de un
      // `if` o el cuerpo de un bucle también están indentados dentro de la función.
      const before = builder.nodes.length
      if (body) visitBlock(builder, body)
      const inside = builder.nodes.slice(before).map((n) => n.id)
      restore()
      const node = builder.nodes.find((n) => n.id === id)
      if (node && inside.length > 0) {
        node.contains = inside
        node.ops = inside.length
      }
      return id
    }

    case 'return_statement': {
      const id = statementId(statement, 'return')
      const value = statement.namedChildren[0] ?? null
      const sem = returned(value)
      builder.add({
        id,
        kind: 'control.return',
        label: 'devolver',
        code,
        line,
        ...(sem ? { control: sem.control } : {}),
      })
      linkReads(builder, id, value, sem?.ports)
      return id
    }

    case 'raise_statement': {
      const id = statementId(statement, 'raise')
      const raised = statement.namedChildren[0] ?? null
      const control = signal(raised)
      builder.add({
        id,
        kind: 'control.raise',
        label: 'error',
        code,
        line,
        ...(control ? { control } : {}),
      })
      linkReads(builder, id, raised)
      return id
    }

    case 'comment':
      return null

    default: {
      // No se inventa: lo que no se entiende se muestra tal cual.
      const id = statementId(statement, 'opaque')
      builder.unsupported.push({ line, type: statement.type })
      builder.add({ id, kind: 'opaque.code', label: statement.type.replace(/_/g, ' '), code, line })
      return id
    }
  }
}

function visitAssignment(builder: Builder, assignment: TsNode, line: number, code: string): string {
  const left = field(assignment, 'left')
  const right = field(assignment, 'right')
  const id = statementId(assignment, 'assign')
  const name = left?.text ?? 'valor'
  // `total += n` es una operación que también lee el `total` anterior.
  const isAugmented = assignment.type === 'augmented_assignment'
  const kind = isAugmented ? 'transform.operation' : kindOfExpression(right)
  const sem = isAugmented ? augmented(assignment) : semanticsOf(right, context(builder))

  builder.add({
    id,
    kind,
    label: name,
    code,
    line,
    ...(sem ? { control: sem.control } : {}),
    ...calling(builder, right),
  })
  linkReads(
    builder,
    id,
    isAugmented ? assignment : right,
    sem?.ports ?? (kind === 'control.condition' ? conditionPorts(right) : callPorts(right)),
  )
  builder.bind(name, id)
  return id
}

/** `{ calls }` si la expresión es una llamada a una función que este archivo define. */
function calling(builder: Builder, expression: TsNode | null): { calls?: string } {
  if (expression?.type !== 'call') return {}
  const calls = builder.functionIds.get(calleeName(expression))
  return calls === undefined ? {} : { calls }
}

function context(builder: Builder): SemanticContext {
  return { functions: builder.functions }
}

/** En una condición, el lado izquierdo es el dato y el derecho el valor con el que se compara. */
function conditionPorts(expression: TsNode | null): Record<string, string> {
  if (!expression) return {}
  const comparison = findFirst(expression, [
    'comparison_operator',
    'boolean_operator',
    'binary_operator',
  ])
  if (!comparison) return {}
  const ports: Record<string, string> = {}
  const [first, ...rest] = comparison.namedChildren.filter((c): c is TsNode => c !== null)
  for (const name of readNames(first ?? null)) ports[name] = 'field'
  for (const part of rest) for (const name of readNames(part)) ports[name] ??= 'value'
  return ports
}

/** En una llamada, cada argumento con nombre es un puerto propio. */
function callPorts(expression: TsNode | null): Record<string, string> {
  if (!expression || expression.type !== 'call') return {}
  const args = field(expression, 'arguments')
  if (!args) return {}
  const ports: Record<string, string> = {}
  for (const arg of args.namedChildren) {
    if (!arg || arg.type !== 'keyword_argument') continue
    const key = field(arg, 'name')?.text
    const value = field(arg, 'value')
    if (!key || !value) continue
    for (const name of readNames(value)) ports[name] = `arg:${key}`
  }
  return ports
}

function iterablePorts(expression: TsNode | null): Record<string, string> {
  const ports: Record<string, string> = {}
  for (const name of readNames(expression)) ports[name] = 'iterable'
  return ports
}

/** Una etiqueta corta y legible para una expresión. */
function describe(expression: TsNode | null): string {
  if (!expression) return 'expresión'
  if (expression.type === 'call') {
    const name = calleeName(expression)
    const tail = name.split('.').pop() ?? name
    return ACTION_LABELS[name] ?? tail
  }
  const text = firstLine(expression.text)
  return text.length > 28 ? `${text.slice(0, 27)}…` : text
}
