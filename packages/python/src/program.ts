import type { ControlModel, NodeKindId } from '@prysel/morphology'
import type { Channel, Relation, SemanticEdge } from '@prysel/spatial'
import type { Node as TsNode, Tree } from '@vscode/tree-sitter-wasm'
import type { NodeRange, Source, Span } from './source.ts'
import {
  assignOf,
  assignSources,
  isChain,
  unwrapParens,
  augmented,
  caseOf,
  caseSources,
  classOf,
  classSources,
  condition as conditionOf,
  handlerOf,
  handlerSources,
  loop,
  inputsOf,
  loopSources,
  matchOf,
  matchSources,
  withOf,
  withSources,
  moduleOf,
  moduleSources,
  parameterNames,
  positionalParams,
  returned,
  semanticsOf,
  signal,
  signalSources,
  signatureOf,
  signatureSources,
  stringContent,
  type Semantics,
  type SemanticContext,
} from './semantics.ts'
import { linkCallees } from './callees.ts'
import {
  blockHeadings,
  openSection,
  type BlockItem,
  type Heading,
  type ProgramSection,
} from './sections.ts'
import {
  calleeName,
  field,
  findFirst,
  firstLine,
  named,
  readIdentifiers,
  readNames,
} from './tree.ts'

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
  /** Última línea de la sentencia (base 1): en una compuesta, la última de su cuerpo. */
  lineEnd?: number
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
  /**
   * Todas las funciones, clases y métodos del archivo a los que llama su texto (en una compuesta, su
   * cabecera), en orden: también dentro de una comprensión, anidadas o por un objeto (`pajaro.decidir`).
   * Son sus subprocesos: lo que se puede abrir desde él (ver `callees.ts`).
   */
  callees?: string[]
  /**
   * De dónde sale cada campo del editor en el texto, por nombre. Es lo que hace el editor
   * escribible: solo aparecen los campos que se pueden reescribir sin descolocar nada.
   */
  sources?: Record<string, Source>
  /** Dónde está la sentencia entera en el texto: es lo que permite eliminarla, duplicarla o poner algo al lado. */
  range?: NodeRange
  /** El texto que se edita como código: la sentencia, o su cabecera si es compuesta (`if x:`). */
  text?: string
  /**
   * Cada sitio donde aparece un nombre que este nodo define, por nombre: su declaración y todos los
   * usos que se resuelven a ella. Es lo que hace posible **renombrar sin romper nada**.
   */
  names?: Record<string, Span[]>
  /** Qué campos del editor son nombres que se pueden renombrar (por camino) y cómo se llaman ahora. */
  renames?: Record<string, string>
  /** El nombre que este nodo deja definido: lo que sale por su puerto de salida (`total` en `total = 0`). */
  provides?: string
  /**
   * Los nombres que deja definidos una asignación de varios valores (`a, b = f()`), en orden: cada uno
   * sale por su propio puerto (`result:a`) y se ofrece como chip. Con un solo nombre, es `provides`.
   */
  results?: string[]
  /**
   * Dónde empieza la cadena de pasos de este nodo, si lo es: la línea del archivo (base 1) y la columna
   * en bytes de UTF-8, que es como la cuenta el intérprete de Python. Es lo que ata lo que se observó al
   * ejecutar (la vista previa de cada paso) a este nodo.
   */
  anchor?: { line: number; col: number }
  /** En una función, sus parámetros: cada uno es un puerto de salida hacia lo que hay dentro. */
  params?: string[]
  /**
   * Qué campos aceptan un cable, por su puerto, y qué trozo del texto se sustituye por el nombre
   * del nodo de origen al conectarlo.
   */
  inputs?: Record<string, Source>
  /** Los nombres que este nodo puede leer: lo que hay definido justo antes de él, en su ámbito. */
  scope?: string[]
  /**
   * Lo que el código dice de sí mismo: los comentarios que lo acompañan (en línea o justo encima)
   * y, en una función, su docstring y los comentarios que la explican. Nada se pierde en silencio.
   */
  note?: string
  /**
   * La pieza se puso con una orden y su contenido aún se está escribiendo: lleva la marca
   * `# prysel:gen:<id>` en su primera línea (este es su `<id>`). La marca no es una nota: es estado, y vive
   * en el código para que no se pierda si el lienzo se cierra a medias.
   */
  generating?: string
  /**
   * Una ayuda visual que acompaña a la sentencia sin ser parte del programa (la curva de una función, una
   * tabla de valores): lo que dice su marca `# prysel:ver …`, tal cual. El lienzo la dibuja al lado.
   */
  aid?: string
  /**
   * En una decisión: el `elif` en el que sigue su camino falso, si lo hay. Lo que se quiera poner al
   * principio de ese camino va en los puertos de ese `elif`, no en los de esta decisión.
   */
  continues?: string
}

export interface Program {
  /** El texto que se analizó: los desplazamientos de cada nodo valen para él. */
  source: string
  nodes: ProgramNode[]
  edges: SemanticEdge[]
  /** Construcciones que el análisis no entiende, con su motivo. */
  unsupported: { line: number; type: string }[]
  /**
   * Las etapas: los tramos de un bloque que abre un comentario de sección (ver `sections.ts`). No son
   * sentencias: agrupan las que ya están en `nodes`, sin cambiar nada de ellas.
   */
  sections?: ProgramSection[]
}

/** La marca de una pieza cuyo contenido se está generando, ya sin la almohadilla: `prysel:gen:<id>`. */
const GENERATING = /^prysel:gen:([a-z0-9]{1,24})$/
/** La marca de una ayuda visual (una curva, una tabla) que acompaña a la sentencia: `prysel:ver …`. */
const AID = /^prysel:ver\s+(.+)$/

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
    case 'parenthesized_expression':
      // Una cadena en varias líneas, entre paréntesis: es lo que es la cadena.
      return isChain(expression) ? kindOfExpression(unwrapParens(expression)) : 'opaque.code'
    case 'subscript':
      if (isChain(expression)) return 'transform.call'
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

const COMPOUND = new Set([
  'if_statement',
  'for_statement',
  'while_statement',
  'function_definition',
  'with_statement',
  'try_statement',
  'except_clause',
  'else_clause',
  'finally_clause',
  'class_definition',
  'match_statement',
  'case_clause',
  'elif_clause',
])

class Builder {
  constructor(readonly source: string) {}

  /**
   * El `else` de un bucle, pendiente de visitar: va detrás del bucle, en el mismo bloque (no dentro de él,
   * que se repite), así que se visita donde se sabe de quién es ese bloque (`visitBlock`).
   */
  readonly loopElse = new Map<string, TsNode>()

  readonly nodes: ProgramNode[] = []
  readonly edges: SemanticEdge[] = []
  readonly unsupported: Program['unsupported'] = []
  readonly sections: ProgramSection[] = []
  /** Qué nodo define cada nombre y, si es un parámetro, por qué puerto de la función sale. */
  private readonly scope = new Map<string, { id: string; port?: string }>()
  /** Los nombres visibles ahora, ya calculados: los nodos consecutivos comparten la misma lista. */
  private visible: string[] | null = null
  /**
   * De dónde sigue la ejecución cuando termina una sentencia, si no es ella misma: una decisión sigue
   * desde el final de cada uno de sus caminos (y desde ella si no tiene `else`).
   */
  readonly tails = new Map<string, string[]>()
  /** Los bucles que envuelven lo que se está recorriendo, del más interno al más externo: a quién apuntan un `break` o un `continue`. */
  readonly loops: string[] = []
  /** Funciones definidas hasta ahora y sus parámetros: nombran los argumentos de cada llamada. */
  readonly functions = new Map<string, string[]>()
  /** Y el nodo que las define: es lo que permite ir de una llamada a su cuerpo. */
  readonly functionIds = new Map<string, string>()

  add(node: ProgramNode, binds?: string): string {
    node.scope = this.names()
    const chainAt = node.control?.kind === 'chain' ? node.sources?.['chain']?.start : undefined
    if (chainAt !== undefined) node.anchor = this.anchorAt(chainAt)
    this.nodes.push(node)
    if (binds) {
      this.bind(binds, node.id)
      node.provides = binds
    }
    return node.id
  }

  /** La línea (base 1) y la columna en bytes de UTF-8 de una posición del texto. */
  private anchorAt(offset: number): { line: number; col: number } {
    const before = this.source.slice(0, offset)
    const lineStart = before.lastIndexOf('\n') + 1
    return {
      line: before.split('\n').length,
      col: new TextEncoder().encode(before.slice(lineStart)).length,
    }
  }

  bind(name: string, id: string, port?: string) {
    this.scope.set(name, port === undefined ? { id } : { id, port })
    this.visible = null
  }

  /** Lo que el nodo deja definido (su puerto de salida). El primer nombre manda. */
  provide(id: string, name: string) {
    const node = this.nodes.find((n) => n.id === id)
    if (node) node.provides ??= name
  }

  /** Los nombres que deja definidos una asignación de varios (`a, b = f()`): cada uno, un chip. */
  results(id: string, names: string[]) {
    const node = this.nodes.find((n) => n.id === id)
    if (node) node.results = names
  }

  /** Un parámetro de función: existe dentro de ella y sale por su propio puerto. */
  bindParam(name: string, id: string) {
    this.bind(name, id, `param:${name}`)
    const node = this.nodes.find((n) => n.id === id)
    if (node) (node.params ??= []).push(name)
  }

  /** Los identificadores visibles ahora (los más recientes): lo que se puede escribir en un campo. */
  private names(): string[] {
    this.visible ??= [...this.scope.keys()].filter((name) => IDENTIFIER.test(name)).slice(-80)
    return this.visible
  }

  /** Anota un sitio donde aparece un nombre que define este nodo (su declaración o un uso). */
  recordName(id: string, name: string, at: TsNode) {
    const node = this.nodes.find((n) => n.id === id)
    if (!node) return
    const names = (node.names ??= {})
    const spans = (names[name] ??= [])
    if (!spans.some((sp) => sp.start === at.startIndex)) {
      spans.push({ start: at.startIndex, end: at.endIndex })
    }
  }

  /** Marca un campo del editor como un nombre que se puede renombrar. */
  rename(id: string, path: string, name: string) {
    const node = this.nodes.find((n) => n.id === id)
    if (node) (node.renames ??= {})[path] = name
  }

  /**
   * Dónde está la sentencia en el texto, y qué texto se edita como código. Se coloca al recorrer
   * el bloque porque ahí se sabe quién es su dueño y qué comentarios lleva pegados.
   */
  place(id: string, statement: TsNode, extra: { owner?: string; lead?: number }) {
    const node = this.nodes.find((n) => n.id === id)
    if (!node) return
    // Con decoradores (`@property`), la sentencia empieza en ellos pero lo compuesto es la definición.
    const core =
      statement.type === 'decorated_definition'
        ? (field(statement, 'definition') ?? statement)
        : statement
    const compound = COMPOUND.has(core.type)
    const colon = compound ? core.children.find((c) => c?.type === ':') : undefined
    const decision = core.type === 'if_statement' || core.type === 'elif_clause'
    const body = compound
      ? (field(core, decision ? 'consequence' : 'body') ??
        // Las cláusulas de un try (except, finally) llevan su bloque sin nombre de campo.
        core.namedChildren.find((c) => c?.type === 'block') ??
        null)
      : null
    const first = body?.namedChildren.find((c) => c && c.type !== 'comment')
    const indent = statement.startPosition.column
    // Una decisión: dónde acaba cada camino, para poder meter algo al principio del que se quiera. Su
    // `else` es el que la sigue: el del `if` si no tiene ningún `elif`; si no, el del último `elif`.
    // Un bucle también puede tener `else` (lo que se hace al acabar sin salir con `break`).
    const nextClause = (clause: TsNode): TsNode | null => {
      let next = clause.nextNamedSibling
      while (next?.type === 'comment') next = next.nextNamedSibling
      return next
    }
    const orElse =
      core.type === 'if_statement'
        ? core.namedChildren.some((c) => c?.type === 'elif_clause')
          ? undefined
          : core.namedChildren.find((c) => c?.type === 'else_clause')
        : core.type === 'elif_clause'
          ? nextClause(core)?.type === 'else_clause'
            ? nextClause(core)
            : undefined
          : core.type === 'for_statement' || core.type === 'while_statement'
            ? field(core, 'alternative')
            : undefined
    const elseBody = orElse ? field(orElse, 'body') : null
    const elseColon = orElse?.children.find((c) => c?.type === ':')
    node.range = {
      start: statement.startIndex,
      end: statement.endIndex,
      indent,
      block: 1,
      ...(colon ? { head: colon.endIndex } : {}),
      ...(compound
        ? {
            bodyEnd:
              core.type === 'if_statement'
                ? statement.endIndex
                : (body?.endIndex ?? statement.endIndex),
            bodyIndent: first?.startPosition.column ?? indent + 4,
          }
        : {}),
      ...(decision && body ? { yesEnd: body.endIndex } : {}),
      ...(orElse && elseColon && elseBody
        ? { elseAt: orElse.startIndex, elseHead: elseColon.endIndex, elseEnd: elseBody.endIndex }
        : {}),
      ...(extra.lead === undefined ? {} : { lead: extra.lead }),
      ...(extra.owner === undefined ? {} : { owner: extra.owner }),
    }
    node.lineEnd = statement.endPosition.row + 1
    node.text = this.source.slice(statement.startIndex, colon?.endIndex ?? statement.endIndex)
  }

  /**
   * Añade un comentario a un nodo. Lo que precede al código va antes y separado por un párrafo
   * (es su explicación); lo que le sigue en la misma línea va después, como una apostilla.
   */
  annotate(id: string, text: string, where: 'before' | 'after' = 'after') {
    const node = this.nodes.find((n) => n.id === id)
    if (!node) return
    // La marca de «generándose» no es prosa: se apunta en el nodo y no entra en su nota.
    const prose = text.split('\n').filter((line) => {
      const mark = GENERATING.exec(line.trim())
      if (mark?.[1]) node.generating = mark[1]
      const aid = AID.exec(line.trim())
      if (aid?.[1]) node.aid = aid[1]
      return !mark && !aid
    })
    const clean = prose.join('\n').trim()
    if (!clean) return
    node.note =
      node.note === undefined
        ? clean
        : where === 'before'
          ? `${clean}\n\n${node.note}`
          : `${node.note}\n${clean}`
  }

  /**
   * Abre un ámbito anidado. Lo que se defina dentro desaparece al cerrarlo, para que
   * un `total` local no se confunda con el `total` del módulo.
   */
  pushScope(): () => void {
    const saved = new Map(this.scope)
    return () => {
      this.scope.clear()
      for (const [name, at] of saved) this.scope.set(name, at)
      this.visible = null
    }
  }

  resolve(name: string): { id: string; port?: string } | undefined {
    return this.scope.get(name)
  }

  link(
    from: string,
    to: string,
    relation: Relation,
    toPort?: string,
    label?: string,
    channel?: Channel,
    fromPort?: string,
  ) {
    if (from === to) return
    const exists = this.edges.some(
      (e) =>
        e.from === from &&
        e.to === to &&
        e.toPort === toPort &&
        e.fromPort === fromPort &&
        e.relation === relation,
    )
    if (exists) return
    this.edges.push({
      from,
      to,
      relation,
      ...(fromPort === undefined ? {} : { fromPort }),
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
  // Cada aparición de un nombre es un uso que hay que poder encontrar al renombrar, aunque la
  // conexión solo se tienda una vez por nombre.
  for (const at of readIdentifiers(expression)) {
    const source = builder.resolve(at.text)
    if (source) builder.recordName(source.id, at.text, at)
  }
  names.forEach((name, index) => {
    const source = builder.resolve(name)
    if (!source) return
    // El primero es la entrada principal (el receptor); el resto, dependencias con nombre.
    const relation: Relation = index === 0 ? 'transform' : 'dependency'
    builder.link(source.id, target, relation, ports?.[name], undefined, undefined, source.port)
  })
}

/** Los nombres que un patrón de asignación deja definidos (`clave, valor`, `(a, b)`, `[x, *resto]`). */
function patternNames(pattern: TsNode): string[] {
  return patternIdentifiers(pattern).map((each) => each.text)
}

/** Los nombres de un patrón, cada uno con su sitio en el texto: un atributo o un elemento (`self.a`) no define ninguno. */
function patternIdentifiers(pattern: TsNode): TsNode[] {
  if (pattern.type === 'identifier') return [pattern]
  if (!PATTERNS.has(pattern.type)) return []
  return pattern.namedChildren.flatMap((child) => (child ? patternIdentifiers(child) : []))
}

const PATTERNS: ReadonlySet<string> = new Set([
  'pattern_list',
  'tuple_pattern',
  'list_pattern',
  'list_splat_pattern',
])

/** Un nombre que Python admite para una variable o una función. */
const IDENTIFIER = /^[\p{L}_][\p{L}\p{N}_]*$/u

/** Una lista de nombres separados por comas (`a, b`, `x, y, z`), sin nada más. */
const NAME_LIST = /^[\p{L}_][\p{L}\p{N}_]*(\s*,\s*[\p{L}_][\p{L}\p{N}_]*)+$/u

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

/**
 * Un id por línea y columna, no por posición en el texto: editar dentro de una línea no mueve
 * ninguna sentencia de sitio, así que el diagrama no se re-anima entero con cada tecla.
 */
function statementId(node: TsNode, prefix: string): string {
  return `${prefix}:${node.startPosition.row + 1}:${node.startPosition.column}`
}

/** El texto de un comentario, sin la almohadilla. `null` para lo que no es prosa (shebang, codificación). */
function commentText(node: TsNode): string | null {
  const raw = node.text
  const row = node.startPosition.row
  if (row === 0 && raw.startsWith('#!')) return null
  if (row <= 1 && /^#.*coding[:=]/.test(raw)) return null
  return raw.replace(/^#+\s?/, '').trimEnd()
}

/**
 * Los comentarios que cuelgan directamente de una sentencia compuesta, entre su firma y su
 * cuerpo. Los de la línea de la cabecera son de la sentencia; los de después de esa línea
 * preceden a lo primero que hay dentro (en una función, en cambio, todos son su explicación).
 */
function ownComments(statement: TsNode): { header: string[]; after: BlockItem[] } {
  const header: string[] = []
  const after: BlockItem[] = []
  for (const child of statement.namedChildren) {
    if (child?.type !== 'comment') continue
    const text = commentText(child)
    if (text === null) continue
    if (child.startPosition.row === statement.startPosition.row) header.push(text)
    else after.push(commentItem(child))
  }
  return { header, after }
}

/** Un comentario con su sitio: lo que necesita la búsqueda de rótulos de etapa. */
function commentItem(node: TsNode): BlockItem {
  return {
    kind: 'comment',
    row: node.startPosition.row,
    endRow: node.endPosition.row,
    col: node.startPosition.column,
    start: node.startIndex,
    end: node.endIndex,
    raw: commentText(node) === null ? null : node.text,
  }
}

/** Los textos de unos comentarios (sin la almohadilla), para una nota. */
const textsOf = (items: readonly BlockItem[]): string[] =>
  items.flatMap((item) => (item.raw ? [item.raw.replace(/^#+\s?/, '').trimEnd()] : []))

/** Un docstring sin comillas y sin la sangría que le da el código que lo rodea. */
export function cleanDoc(raw: string): string {
  const lines = raw.replace(/\r\n/g, '\n').split('\n')
  const [first = '', ...rest] = lines
  const indents = rest.filter((l) => l.trim()).map((l) => l.length - l.trimStart().length)
  const margin = indents.length > 0 ? Math.min(...indents) : 0
  return [first.trim(), ...rest.map((l) => l.slice(margin).trimEnd())].join('\n').trim()
}

/** El docstring de un cuerpo: su primera sentencia, si es una cadena (no una f-string). */
function docstringOf(body: TsNode | null): { text: string; at: number } | null {
  const first = body?.namedChildren.find((child) => child?.type !== 'comment')
  const inner = first?.type === 'expression_statement' ? first.namedChildren[0] : null
  if (inner?.type !== 'string') return null
  const start = field(inner, 'string_start')?.text ?? inner.namedChildren[0]?.text ?? ''
  if (/[fF]/.test(start.replace(/["']+$/, ''))) return null
  const content = stringContent(inner)
  return content === null || !first ? null : { text: cleanDoc(content), at: first.startIndex }
}

export function buildProgram(tree: Tree, source?: string): Program {
  // Sin el texto original, se reconstruye del árbol (rellenando lo que quede antes del primer token).
  const text = source ?? ' '.repeat(tree.rootNode.startIndex) + tree.rootNode.text
  const builder = new Builder(text)
  // El docstring del archivo no es una sentencia: es la explicación de lo que viene detrás.
  const doc = docstringOf(tree.rootNode)
  visitBlock(builder, tree.rootNode, {
    skip: new Set(doc ? [doc.at] : []),
    leading: doc ? [doc.text] : [],
  })
  // Las llamadas se resuelven con todo el archivo visto: una función puede estar definida más abajo.
  linkCallees(tree.rootNode, builder.nodes)
  return {
    source: text,
    nodes: builder.nodes,
    edges: builder.edges,
    unsupported: builder.unsupported,
    // Las de dentro se cierran antes que las de fuera: en el orden del archivo se leen mejor.
    sections: [...builder.sections].sort((a, b) => a.line - b.line),
  }
}

interface BlockOptions {
  /** La sentencia dueña del bloque (`undefined` = el archivo). */
  owner?: string
  /** Sentencias que ya se han consumido de otra forma (un docstring). */
  skip?: ReadonlySet<number>
  /** Comentarios que ya esperan a la primera sentencia. */
  leading?: string[]
  /**
   * Comentarios de la cabecera de una sentencia compuesta que tree-sitter cuelga de ella y no del bloque
   * (los que van entre `for …:` y la primera sentencia), con su sitio: pueden ser el rótulo de una etapa.
   */
  leadingAt?: BlockItem[]
  /**
   * En una función, esos comentarios son su explicación (van en su nodo, no en la primera sentencia): los
   * que no abren una etapa no se tocan aquí, y los que sí se apuntan en este conjunto (por dónde empiezan)
   * para que la función no los repita.
   */
  headingsFrom?: Set<number>
}

/**
 * Recorre las sentencias de un bloque y coloca cada comentario donde pertenece:
 * en la misma línea que una sentencia, es suyo; solo en su línea, explica la que viene detrás;
 * y si no viene ninguna, cierra la anterior. Ninguno se pierde.
 */
function visitBlock(builder: Builder, block: TsNode, options: BlockOptions = {}): string[] {
  const produced: string[] = []
  const pending = [...(options.leading ?? [])]
  /** Dónde están los comentarios de bloque que esperan a la siguiente sentencia. */
  const comments: { start: number; row: number; endRow: number }[] = []
  let last: { id: string; row: number } | null = null
  /** De dónde sigue la ejecución: la sentencia anterior (o los finales de los caminos de una decisión). */
  let flow: string[] = []
  /** Cuántas sentencias tiene el bloque: cuentan también las que no son nodos (un docstring, un `pass`). */
  let statements = 0

  // Las etapas del bloque: los comentarios de sección que abren cada una (ver `sections.ts`). Si el bloque
  // no tiene, no cambia nada: cada comentario sigue siendo la nota de su sentencia.
  const headingOf = new Map<number, Heading>()
  for (const heading of blockHeadings(blockItems(block, options))) {
    for (const start of heading.comments) headingOf.set(start, heading)
  }
  /** El rótulo que espera a la sentencia con la que empieza su etapa. */
  let upcoming: Heading | null = null
  /** La etapa abierta: lo que venga detrás es suyo hasta el siguiente rótulo. */
  let section: ProgramSection | null = null
  const sections: ProgramSection[] = []
  for (const comment of options.leadingAt ?? []) {
    const heading = headingOf.get(comment.start)
    if (heading) {
      options.headingsFrom?.add(comment.start)
      if (heading.start === comment.start) upcoming = heading
    } else if (!options.headingsFrom) pending.push(...textsOf([comment]))
  }

  for (const statement of block.namedChildren) {
    if (!statement) continue
    if (statement.type !== 'comment') statements++
    if (options.skip?.has(statement.startIndex)) continue

    if (statement.type === 'comment') {
      // Un rótulo de etapa no es la nota de nadie: es el título de lo que viene.
      const heading = headingOf.get(statement.startIndex)
      if (heading) {
        if (heading.start === statement.startIndex) upcoming = heading
        continue
      }
      const text = commentText(statement)
      if (text === null) continue
      if (last && statement.startPosition.row === last.row) builder.annotate(last.id, text)
      else {
        pending.push(text)
        comments.push({
          start: statement.startIndex,
          row: statement.startPosition.row,
          endRow: statement.endPosition.row,
        })
      }
      continue
    }

    const id = visitStatement(builder, statement)
    if (!id) continue

    // Los comentarios pegados justo encima (sin línea en blanco) son de esta sentencia: van con
    // ella al eliminarla. Los separados por un hueco son de otra cosa (un título de sección).
    let lead: number | undefined
    let row = statement.startPosition.row
    for (let i = comments.length - 1; i >= 0; i--) {
      const comment = comments[i]
      if (!comment || comment.endRow !== row - 1) break
      lead = comment.start
      row = comment.row
    }
    comments.length = 0
    builder.place(id, statement, {
      ...(options.owner === undefined ? {} : { owner: options.owner }),
      ...(lead === undefined ? {} : { lead }),
    })

    if (pending.length > 0) {
      builder.annotate(id, pending.join('\n'), 'before')
      pending.length = 0
    }
    produced.push(id)
    last = { id, row: statement.endPosition.row }
    if (upcoming) {
      section = openSection(upcoming, options.owner, id)
      sections.push(section)
      upcoming = null
    } else section?.members.push(id)

    // El orden: cada sentencia a continuación de la anterior. Una definición no se ejecuta aquí (solo
    // dice qué es la función), y tras un `return`, `raise`, `break` o `continue` no sigue nada.
    const node = builder.nodes.find((n) => n.id === id)
    if (node?.kind !== 'abstraction.collapsed') {
      for (const from of flow) builder.link(from, id, 'sequence')
      flow = builder.tails.get(id) ?? (node && JUMPS.has(node.kind) ? [] : [id])
    }

    // El `else` de un bucle va justo detrás de él, en este mismo bloque: se hace una vez, al acabar el
    // bucle sin salir con `break` (no en cada vuelta, así que no va dentro de su territorio).
    const orElse = builder.loopElse.get(id)
    if (orElse) {
      builder.loopElse.delete(id)
      const clauseId = visitClause(builder, orElse, options.owner, 'loop')
      builder.link(id, clauseId, 'sequence')
      flow = [clauseId]
      // Va con su bucle: si el bucle es de una etapa, su `else` también.
      section?.members.push(clauseId)
    }
  }
  if (last && pending.length > 0) builder.annotate(last.id, pending.join('\n'))
  // Un rótulo sin nada detrás (solo un `pass`) no abre ninguna etapa, pero no se pierde.
  if (last && upcoming) builder.annotate(last.id, upcoming.text)
  for (const id of produced) {
    const node = builder.nodes.find((n) => n.id === id)
    if (node?.range) node.range.block = statements
  }
  for (const found of sections) {
    const tail = builder.nodes.find((n) => n.id === found.members[found.members.length - 1])
    found.lineEnd = tail?.lineEnd ?? tail?.line ?? found.line
  }
  builder.sections.push(...sections)
  return produced
}

/** Lo que hay en un bloque, con su sitio: lo que mira la búsqueda de rótulos de etapa. */
function blockItems(block: TsNode, options: BlockOptions): BlockItem[] {
  return [
    ...(options.leadingAt ?? []),
    ...block.namedChildren.flatMap((child): BlockItem[] => {
      if (!child) return []
      if (child.type === 'comment') return [commentItem(child)]
      return [
        {
          kind: 'statement',
          row: child.startPosition.row,
          endRow: child.endPosition.row,
          col: child.startPosition.column,
          start: child.startIndex,
          end: child.endIndex,
          ...(options.skip?.has(child.startIndex) ? { skip: true } : {}),
        },
      ]
    }),
  ]
}

/** Las cláusulas de un `try`, además de su cuerpo. */
const CLAUSES = new Set(['except_clause', 'else_clause', 'finally_clause'])

/** ¿Es la condición del idioma `__name__ == "__main__"` (en cualquier orden de los dos lados)? */
function isMainGuard(condition: TsNode | null): boolean {
  if (!condition || condition.type !== 'comparison_operator') return false
  const parts = named(condition)
  const operator = condition.childForFieldName('operators')
  if (parts.length !== 2 || operator?.text !== '==') return false
  const [a, b] = parts
  const isName = (node: TsNode | undefined) =>
    node?.type === 'identifier' && node.text === '__name__'
  const isMain = (node: TsNode | undefined) =>
    node !== undefined && stringContent(node) === '__main__'
  return (isName(a) && isMain(b)) || (isName(b) && isMain(a))
}

/**
 * El cuerpo de `if __name__ == "__main__":` como un único camino, sin bifurcación: como un `with`, pero
 * sin nada que abrir. Es lo que se ejecuta al lanzar el archivo, y así se lee.
 */
function entryPoint(
  builder: Builder,
  statement: TsNode,
  id: string,
  code: string,
  line: number,
): string {
  builder.add({ id, kind: 'control.entrypoint', label: 'Programa principal', code, line })
  const own = ownComments(statement)
  builder.annotate(id, own.header.join('\n'))
  const body = field(statement, 'consequence')
  const before = builder.nodes.length
  const inside = body ? visitBlock(builder, body, { leadingAt: own.after, owner: id }) : []
  if (inside[0]) builder.link(id, inside[0], 'transform', undefined, undefined, 'control')
  contain(builder, id, before)
  return id
}

/**
 * Los nombres que captura un patrón de `case` (`[x, y]`, `Punto(x=a)`, `{"k": v}`, `_ as todo`): los que
 * quedan definidos dentro del caso. Un nombre con puntos (`Color.ROJO`) no captura: compara con un valor.
 */
function capturedNames(pattern: TsNode): string[] {
  const names: string[] = []
  const walk = (node: TsNode) => {
    if (node.type === 'dotted_name') {
      const parts = node.namedChildren.filter((c) => c?.type === 'identifier')
      if (parts.length === 1 && parts[0] && parts[0].text !== '_') names.push(parts[0].text)
      return
    }
    // Los argumentos con nombre de un patrón de clase (`x=a`): la clave no captura, el valor sí.
    if (node.type === 'keyword_pattern') {
      const value = node.namedChildren[node.namedChildren.length - 1]
      if (value) walk(value)
      return
    }
    // `… as nombre`: el alias captura lo que encaje.
    if (node.type === 'as_pattern') {
      const target = node.namedChildren[node.namedChildren.length - 1]
      if (target?.type === 'identifier') names.push(target.text)
    }
    for (const child of node.namedChildren) if (child) walk(child)
  }
  walk(pattern)
  return [...new Set(names)]
}

/**
 * Un `case` de un `match`: un territorio con su patrón (y su condición, si la lleva) en la cabecera, y
 * su cuerpo dentro. Los nombres que el patrón captura quedan definidos dentro, como el alias de un
 * `except` o la variable de un bucle.
 */
function visitCase(builder: Builder, clause: TsNode, owner: string): string {
  const line = clause.startPosition.row + 1
  const code = firstLine(clause.text)
  const id = statementId(clause, 'case')
  const patterns = clause.namedChildren.filter(
    (c): c is TsNode => c !== null && c.type === 'case_pattern',
  )
  const guardClause = field(clause, 'guard')
  const guard = guardClause?.namedChildren[0] ?? null
  const first = patterns[0]
  const last = patterns[patterns.length - 1]
  const pattern = first && last ? builder.source.slice(first.startIndex, last.endIndex) : ''
  const control = caseOf(pattern, guard)
  const wildcard = pattern.trim() === '_' && !guard
  builder.add({
    id,
    kind: 'control.case',
    label: wildcard ? 'en otro caso' : `caso ${pattern}`,
    code,
    line,
    ...(control ? { control } : {}),
    ...(control ? sourcesOf(caseSources(patterns, guard)) : {}),
    ...(control ? inputsIn(inputsOf(caseSources(patterns, guard))) : {}),
  })
  builder.place(id, clause, { owner })
  const placed = builder.nodes.find((n) => n.id === id)
  // Como una cláusula de un `try`: quitarla no deja un `pass` en su lugar.
  if (placed?.range) placed.range.block = 99
  if (guard) linkReads(builder, id, guard, portsOf(guard, 'guard'))
  for (const pattern of patterns) {
    for (const name of capturedNames(pattern)) builder.bindParam(name, id)
  }
  const body = field(clause, 'consequence')
  const before = builder.nodes.length
  const inside = body ? visitBlock(builder, body, { owner: id }) : []
  if (inside[0]) builder.link(id, inside[0], 'transform', undefined, undefined, 'control')
  contain(builder, id, before)
  return id
}

/** Todo lo que nace dentro de un nodo es suyo, a cualquier profundidad. */
function contain(builder: Builder, id: string, before: number) {
  const nested = builder.nodes.slice(before).map((n) => n.id)
  const node = builder.nodes.find((n) => n.id === id)
  if (node && nested.length > 0) {
    node.contains = nested
    node.ops = nested.length
  }
}

/** A qué campo entra cada nombre que lee una expresión. */
function portsOf(expression: TsNode | null, port: string): Record<string, string> {
  const ports: Record<string, string> = {}
  for (const name of readNames(expression)) ports[name] = port
  return ports
}

/** El nombre que abre un `with` o atrapa un `except`: un puerto del nodo, hacia lo de dentro. */
function bindAlias(
  builder: Builder,
  id: string,
  alias: TsNode | null,
  editable: boolean,
  single: boolean,
) {
  if (!alias) return
  if (alias.type === 'identifier') {
    builder.bindParam(alias.text, id)
    if (single) builder.provide(id, alias.text)
    builder.recordName(id, alias.text, alias)
    if (editable) builder.rename(id, 'name', alias.text)
    return
  }
  for (const name of patternNames(alias)) builder.bindParam(name, id)
}

/**
 * `except X as e:`, `else:` y `finally:` de un `try` (cada una es un territorio con su cuerpo dentro), o
 * el `else:` de un bucle (`of` = `'loop'`), que va detrás del bucle en su mismo bloque.
 */
function visitClause(
  builder: Builder,
  clause: TsNode,
  owner: string | undefined,
  of: 'try' | 'loop' = 'try',
): string {
  const line = clause.startPosition.row + 1
  const code = firstLine(clause.text)
  const isExcept = clause.type === 'except_clause'
  const id = statementId(
    clause,
    isExcept ? 'except' : clause.type === 'else_clause' ? 'else' : 'finally',
  )
  let type: TsNode | null = null
  let alias: TsNode | null = null
  if (isExcept) {
    const value = clause.namedChildren.find((c) => c && c.type !== 'block' && c.type !== 'comment')
    if (value?.type === 'as_pattern') {
      type = value.namedChildren[0] ?? null
      const target = field(value, 'alias')
      alias = target?.namedChildren[0] ?? target
    } else type = value ?? null
  }
  // `except*`: la misma cláusula con un `*` suelto tras `except` (atrapa dentro de un grupo de errores).
  const group = isExcept && clause.children.some((child) => child?.type === '*')
  const control = isExcept ? handlerOf(type, alias, group) : null
  builder.add({
    id,
    kind: isExcept ? 'control.except' : 'control.clause',
    label: isExcept
      ? `si falla${group ? ' alguno de' : ''}${type ? `: ${type.text}` : ''}`
      : clause.type === 'else_clause'
        ? of === 'loop'
          ? 'al acabar sin salir'
          : 'si no falla'
        : 'al final',
    code,
    line,
    ...(control ? { control } : {}),
    ...(control ? sourcesOf(handlerSources(type)) : {}),
    ...(control ? inputsIn(inputsOf(handlerSources(type))) : {}),
  })
  builder.place(id, clause, owner === undefined ? {} : { owner })
  const placed = builder.nodes.find((n) => n.id === id)
  // Una cláusula no es una sentencia suelta de un bloque: quitarla no deja un `pass`.
  if (placed?.range) placed.range.block = 99
  if (isExcept) {
    linkReads(builder, id, type, portsOf(type, 'type'))
    bindAlias(builder, id, alias, control !== null, true)
  }
  const body =
    field(clause, 'body') ?? clause.namedChildren.find((c) => c?.type === 'block') ?? null
  const before = builder.nodes.length
  const inside = body ? visitBlock(builder, body, { owner: id }) : []
  if (inside[0]) builder.link(id, inside[0], 'transform', undefined, undefined, 'control')
  contain(builder, id, before)
  return id
}

/** Las sentencias tras las que la ejecución no sigue con la siguiente del bloque. */
/**
 * El retorno de un bucle: vuelve a empezar desde **cada final** de su cuerpo, igual que el orden sale de cada
 * final de un `if` — el último paso de cada camino, o la propia decisión si le falta el `else` (su camino
 * «no»). Un cuerpo que acaba en un salto (`break`, `return`) no vuelve.
 */
function closeLoop(builder: Builder, last: string | undefined, loop: string) {
  if (last === undefined) return
  const node = builder.nodes.find((n) => n.id === last)
  const ends = builder.tails.get(last) ?? (node && JUMPS.has(node.kind) ? [] : [last])
  for (const end of ends) builder.link(end, loop, 'feedback')
}

const JUMPS: ReadonlySet<string> = new Set([
  'control.return',
  'control.raise',
  'control.break',
  'control.continue',
])

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
        ...(control ? sourcesOf(moduleSources(statement)) : {}),
      })
      // Un import puede dejar definidos varios nombres, y todos apuntan al mismo nodo.
      for (const name of bound) builder.bind(name, id)
      if (bound[0]) builder.provide(id, bound[0])
      const imported = statement.type === 'import_statement' ? field(statement, 'name') : null
      const alias = imported?.type === 'aliased_import' ? field(imported, 'alias') : null
      if (alias) {
        builder.recordName(id, alias.text, alias)
        builder.rename(id, 'alias', alias.text)
      }
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
        ...fromSemantics(sem),
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
        ...(control ? sourcesOf(loopSources(iterable)) : {}),
        ...(control ? inputsIn(inputsOf(loopSources(iterable))) : {}),
      })
      linkReads(builder, id, iterable, iterablePorts(iterable))
      // La variable de iteración es un puerto del bucle, como un parámetro lo es de una función:
      // de ahí salen los cables hacia lo que hay dentro.
      if (variable?.type === 'identifier') {
        builder.bindParam(variable.text, id)
        builder.provide(id, variable.text)
      } else if (variable) {
        // `for clave, valor in …`: cada nombre del patrón es un puerto propio.
        const names = patternNames(variable)
        if (names.length === 0) builder.bind(variable.text, id)
        for (const name of names) builder.bindParam(name, id)
      }
      if (variable?.type === 'identifier') {
        builder.recordName(id, variable.text, variable)
        builder.rename(id, 'variable', variable.text)
      }
      const own = ownComments(statement)
      builder.annotate(id, own.header.join('\n'))

      const body = field(statement, 'body')
      const before = builder.nodes.length
      const orElse = field(statement, 'alternative')
      if (orElse) builder.loopElse.set(id, orElse)
      builder.loops.push(id)
      const inside = body ? visitBlock(builder, body, { leadingAt: own.after, owner: id }) : []
      builder.loops.pop()
      if (inside.length > 0) {
        const first = inside[0]
        const last = inside[inside.length - 1]
        if (first) builder.link(id, first, 'transform', undefined, undefined, 'control')
        // El retorno cierra el bucle: es la única conexión que va contra el tiempo.
        closeLoop(builder, last, id)
        // Todo lo que nace dentro es suyo, a cualquier profundidad (las ramas de un `if` incluidas).
        const nested = builder.nodes.slice(before).map((n) => n.id)
        const node = builder.nodes.find((n) => n.id === id)
        if (node) {
          node.contains = nested
          node.ops = nested.length
        }
      }
      return id
    }

    case 'while_statement': {
      const id = statementId(statement, 'while')
      const condition = field(statement, 'condition')
      const control = condition
        ? ({ kind: 'loop', variable: '', iterable: condition.text, while: true } as const)
        : null
      builder.add({
        id,
        kind: 'control.loop',
        label: 'mientras',
        code,
        line,
        ...(control ? { control } : {}),
        ...(control ? sourcesOf(loopSources(condition)) : {}),
        ...(control ? inputsIn(inputsOf(loopSources(condition))) : {}),
      })
      linkReads(builder, id, condition, iterablePorts(condition))
      const own = ownComments(statement)
      builder.annotate(id, own.header.join('\n'))
      const body = field(statement, 'body')
      const before = builder.nodes.length
      const orElse = field(statement, 'alternative')
      if (orElse) builder.loopElse.set(id, orElse)
      builder.loops.push(id)
      const inside = body ? visitBlock(builder, body, { leadingAt: own.after, owner: id }) : []
      builder.loops.pop()
      const last = inside[inside.length - 1]
      if (inside[0]) builder.link(id, inside[0], 'transform', undefined, undefined, 'control')
      closeLoop(builder, last, id)
      const nested = builder.nodes.slice(before).map((n) => n.id)
      const node = builder.nodes.find((n) => n.id === id)
      if (node && nested.length > 0) {
        node.contains = nested
        node.ops = nested.length
      }
      return id
    }

    // `break` sale del bucle más cercano y `continue` salta a su siguiente vuelta: cada uno se
    // conecta al puerto del bucle que afecta, así se ve a cuál.
    case 'break_statement':
    case 'continue_statement': {
      const isBreak = statement.type === 'break_statement'
      const id = statementId(statement, isBreak ? 'break' : 'continue')
      builder.add({
        id,
        kind: isBreak ? 'control.break' : 'control.continue',
        label: isBreak ? 'salir' : 'siguiente',
        code,
        line,
      })
      const loop = builder.loops[builder.loops.length - 1]
      if (loop) builder.link(id, loop, 'transform', isBreak ? 'exit' : 'next', undefined, 'control')
      return id
    }

    // Una definición con decoradores (`@property`, `@dataclass`): es la misma definición, con sus decoradores dentro de su sentencia.
    case 'decorated_definition': {
      const definition = field(statement, 'definition')
      return definition ? visitStatement(builder, definition) : null
    }

    // `class`: un territorio como una función. Sus atributos son chips de su cajita y sus métodos, funciones dentro.
    case 'class_definition': {
      const id = statementId(statement, 'class')
      const name = field(statement, 'name')?.text ?? 'clase'
      const bases = field(statement, 'superclasses')
      const body = field(statement, 'body')
      const known = new Set(builder.functions.keys())
      // Se olvida el `__init__` de una clase anterior: solo vale el de esta.
      builder.functions.delete('__init__')
      builder.add(
        {
          id,
          kind: 'abstraction.class',
          label: name,
          code,
          line,
          control: classOf(bases, []),
          ...sourcesOf(classSources(bases)),
          ...inputsIn(inputsOf(classSources(bases))),
        },
        name,
      )
      const nameNode = field(statement, 'name')
      if (nameNode) builder.recordName(id, name, nameNode)
      // De quién hereda se lee fuera de la clase.
      linkReads(builder, id, bases, portsOf(bases, 'bases'))
      const restore = builder.pushScope()
      const outerLoops = builder.loops.splice(0)
      const doc = docstringOf(body)
      const own = ownComments(statement)
      builder.annotate(
        id,
        [[...own.header, ...textsOf(own.after)].join('\n'), doc?.text ?? '']
          .filter((part) => part.trim())
          .join('\n\n'),
      )
      const before = builder.nodes.length
      if (body) visitBlock(builder, body, { skip: new Set(doc ? [doc.at] : []), owner: id })
      const inside = builder.nodes.slice(before).map((n) => n.id)
      builder.loops.push(...outerLoops)
      restore()
      // Lo que recibe al crearse son los parámetros de su `__init__` (sin `self`).
      const init = (builder.functions.get('__init__') ?? []).slice(1)
      // Los métodos solo se llaman a través de una instancia: no se conocen como funciones sueltas.
      for (const key of [...builder.functions.keys()]) {
        if (!known.has(key)) {
          builder.functions.delete(key)
          builder.functionIds.delete(key)
        }
      }
      builder.functions.set(name, init)
      builder.functionIds.set(name, id)
      const node = builder.nodes.find((n) => n.id === id)
      if (node) {
        node.control = classOf(bases, init)
        if (inside.length > 0) {
          node.contains = inside
          node.ops = inside.length
        }
      }
      return id
    }

    // `with`: un territorio como el bucle, pero sin repetir nada. El nombre que abre es un puerto propio.
    case 'with_statement': {
      const id = statementId(statement, 'with')
      const clause = statement.namedChildren.find((c) => c?.type === 'with_clause')
      const items = (clause?.namedChildren ?? []).filter((c) => c?.type === 'with_item')
      const parsed = items.map((item) => {
        const value = item ? field(item, 'value') : null
        if (value?.type === 'as_pattern') {
          const target = field(value, 'alias')
          return {
            context: value.namedChildren[0] ?? null,
            alias: target?.namedChildren[0] ?? target,
          }
        }
        return { context: value, alias: null }
      })
      const only = parsed.length === 1 ? parsed[0] : undefined
      const control = only ? withOf(only.context, only.alias) : null
      builder.add({
        id,
        kind: 'control.with',
        label: `con ${only?.alias?.text ?? (only?.context ? describe(only.context) : 'varios')}`,
        code,
        line,
        ...(control ? { control } : {}),
        ...(control ? sourcesOf(withSources(only?.context ?? null)) : {}),
        ...(control ? inputsIn(inputsOf(withSources(only?.context ?? null))) : {}),
      })
      // Lo que abre se lee antes de que el nombre exista.
      for (const item of parsed)
        linkReads(builder, id, item.context, portsOf(item.context, 'context'))
      for (const item of parsed)
        bindAlias(builder, id, item.alias, control !== null, parsed.length === 1)
      const own = ownComments(statement)
      builder.annotate(id, own.header.join('\n'))
      const body = field(statement, 'body')
      const before = builder.nodes.length
      const inside = body ? visitBlock(builder, body, { leadingAt: own.after, owner: id }) : []
      if (inside[0]) builder.link(id, inside[0], 'transform', undefined, undefined, 'control')
      contain(builder, id, before)
      return id
    }

    // `try`: un territorio con lo que se intenta y, dentro, cada cláusula en su propio marco.
    case 'try_statement': {
      const id = statementId(statement, 'try')
      builder.add({ id, kind: 'control.try', label: 'intento', code, line })
      const own = ownComments(statement)
      builder.annotate(id, own.header.join('\n'))
      const body = field(statement, 'body')
      const before = builder.nodes.length
      const inside = body ? visitBlock(builder, body, { leadingAt: own.after, owner: id }) : []
      if (inside[0]) builder.link(id, inside[0], 'transform', undefined, undefined, 'control')
      // Las cláusulas se leen en el orden del archivo: la última sentencia del intento, y cada una tras la anterior.
      let previous = inside[inside.length - 1]
      for (const clause of statement.namedChildren) {
        if (!clause || !CLAUSES.has(clause.type)) continue
        const clauseId = visitClause(builder, clause, id)
        if (previous) builder.link(previous, clauseId, 'sequence')
        previous = clauseId
      }
      contain(builder, id, before)
      return id
    }

    // `match`: un territorio con lo que se compara en la cabecera y, dentro, cada caso en su propio marco
    // (como las cláusulas de un `try`), en el orden en que Python los prueba.
    case 'match_statement': {
      const id = statementId(statement, 'match')
      const subject = field(statement, 'subject')
      const control = matchOf(subject)
      builder.add({
        id,
        kind: 'control.match',
        label: `según ${subject?.text ?? ''}`.trim(),
        code,
        line,
        ...(control ? { control } : {}),
        ...(control ? sourcesOf(matchSources(subject)) : {}),
        ...(control ? inputsIn(inputsOf(matchSources(subject))) : {}),
      })
      const own = ownComments(statement)
      builder.annotate(id, own.header.join('\n'))
      linkReads(builder, id, subject, portsOf(subject, 'subject'))
      const body = field(statement, 'body')
      const before = builder.nodes.length
      let previous: string | undefined
      for (const clause of body?.namedChildren ?? []) {
        if (!clause || clause.type !== 'case_clause') continue
        const caseId = visitCase(builder, clause, id)
        if (previous) builder.link(previous, caseId, 'sequence')
        else builder.link(id, caseId, 'transform', undefined, undefined, 'control')
        previous = caseId
      }
      contain(builder, id, before)
      return id
    }

    case 'if_statement': {
      const id = statementId(statement, 'if')
      const condition = field(statement, 'condition')
      // `if __name__ == "__main__":` sin más cláusulas: el idioma de entrada de un script. Prysel traza
      // el archivo como `__main__`, así que esta condición vale siempre — se dibuja como un único
      // camino (como un `with`), no como una decisión con una salida que en la práctica nunca se toma.
      const hasClause = statement.namedChildren.some(
        (clause) => clause?.type === 'else_clause' || clause?.type === 'elif_clause',
      )
      if (!hasClause && isMainGuard(condition))
        return entryPoint(builder, statement, id, code, line)
      const sem = conditionOf(condition)
      builder.add({
        id,
        kind: 'control.condition',
        label: `¿${describe(condition)}?`,
        code,
        line,
        ...fromSemantics(sem),
      })
      linkReads(builder, id, condition, sem?.ports ?? conditionPorts(condition))
      const own = ownComments(statement)
      builder.annotate(id, own.header.join('\n'))

      const body = field(statement, 'consequence')
      const yes = body ? visitBlock(builder, body, { leadingAt: own.after, owner: id }) : []
      if (yes[0]) builder.link(id, yes[0], 'branch', undefined, 'verdadero')

      // Por dónde sigue la ejecución al acabar: el final de cada camino que no salta, y la propia
      // decisión si no hay `else` (el camino en el que no se cumple).
      const tails: string[] = []
      const endOf = (ids: string[]) => {
        const last = ids[ids.length - 1]
        const node = builder.nodes.find((n) => n.id === last)
        if (last !== undefined && node && !JUMPS.has(node.kind)) tails.push(last)
      }
      endOf(yes)
      if (yes.length === 0) tails.push(id)
      // Cada `elif` es una decisión propia en el camino falso de la anterior (`if a … elif b … else …`
      // es `if a … else: if b … else …`): con su condición a la vista y editable, y sus dos caminos con
      // sus propios puertos. El `else` final es el camino falso del último.
      let decision = id
      let hasElse = false
      for (const clause of statement.namedChildren) {
        if (!clause || (clause.type !== 'else_clause' && clause.type !== 'elif_clause')) continue
        if (clause.type === 'elif_clause') {
          const elifId = statementId(clause, 'elif')
          const elifCondition = field(clause, 'condition')
          const elifSem = conditionOf(elifCondition)
          builder.add({
            id: elifId,
            kind: 'control.condition',
            label: `¿${describe(elifCondition)}?`,
            code: firstLine(clause.text),
            line: clause.startPosition.row + 1,
            ...fromSemantics(elifSem),
          })
          linkReads(builder, elifId, elifCondition, elifSem?.ports ?? conditionPorts(elifCondition))
          builder.place(elifId, clause, { owner: id })
          const placed = builder.nodes.find((n) => n.id === elifId)
          // Como una cláusula: no es una sentencia suelta, ni se mueve sola.
          if (placed?.range) placed.range.block = 99
          const previous = builder.nodes.find((n) => n.id === decision)
          if (previous) previous.continues = elifId
          builder.link(decision, elifId, 'branch', undefined, 'falso')
          const elifBody = field(clause, 'consequence')
          const elifYes = elifBody ? visitBlock(builder, elifBody, { owner: elifId }) : []
          if (elifYes[0]) builder.link(elifId, elifYes[0], 'branch', undefined, 'verdadero')
          endOf(elifYes)
          if (elifYes.length === 0) tails.push(elifId)
          decision = elifId
          continue
        }
        hasElse = true
        const clauseBody = field(clause, 'body')
        // El `else` es de la última decisión de la cadena (el `if`, si no hay ningún `elif`).
        const no = clauseBody ? visitBlock(builder, clauseBody, { owner: decision }) : []
        if (no[0]) builder.link(decision, no[0], 'branch', undefined, 'falso')
        endOf(no)
        if (no.length === 0) tails.push(decision)
      }
      if (!hasElse) tails.push(decision)
      builder.tails.set(id, [...new Set(tails)])
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
          ...(signature ? sourcesOf(signatureSources(params)) : {}),
        },
        name,
      )
      builder.functions.set(name, positionalParams(params))
      builder.functionIds.set(name, id)
      const nameNode = field(statement, 'name')
      if (nameNode) builder.recordName(id, name, nameNode)
      // Un valor por defecto se evalúa fuera de la función: lee de donde se define, no de dentro.
      for (const param of params?.namedChildren ?? []) {
        if (param?.type !== 'default_parameter' && param?.type !== 'typed_default_parameter')
          continue
        linkReads(builder, id, field(param, 'value'))
      }
      const restore = builder.pushScope()
      // Un `break` dentro de una función no afecta a un bucle que la rodea.
      const outerLoops = builder.loops.splice(0)
      // Los parámetros existen solo dentro: se resuelven al propio nodo de la función.
      if (params) {
        for (const param of params.namedChildren) {
          if (!param) continue
          const paramName =
            param.type === 'identifier'
              ? param.text
              : (field(param, 'name') ?? param.namedChildren[0])?.text
          if (paramName) builder.bindParam(paramName, id)
        }
        for (const { path, node } of parameterNames(params)) {
          builder.recordName(id, node.text, node)
          builder.rename(id, path, node.text)
        }
      }
      const body = field(statement, 'body')
      // Lo que la función dice de sí misma: los comentarios entre su firma y su cuerpo y su docstring.
      // Es su explicación, así que va en su nodo; el docstring no es una sentencia más del cuerpo.
      const doc = docstringOf(body)
      const own = ownComments(statement)
      // Todo lo que nace dentro del `def` es suyo, a cualquier profundidad: las ramas de un
      // `if` o el cuerpo de un bucle también están indentados dentro de la función.
      const before = builder.nodes.length
      // Sin docstring, el comentario de justo debajo de la firma puede ser el rótulo de la primera etapa
      // (si el cuerpo tiene más): entonces es de la etapa, no la explicación de la función.
      const headings = new Set<number>()
      if (body) {
        visitBlock(builder, body, {
          skip: new Set(doc ? [doc.at] : []),
          owner: id,
          ...(doc ? {} : { leadingAt: own.after, headingsFrom: headings }),
        })
      }
      builder.annotate(
        id,
        [
          [...own.header, ...textsOf(own.after.filter((c) => !headings.has(c.start)))].join('\n'),
          doc?.text ?? '',
        ]
          .filter((part) => part.trim())
          .join('\n\n'),
      )
      const inside = builder.nodes.slice(before).map((n) => n.id)
      builder.loops.push(...outerLoops)
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
        ...fromSemantics(sem),
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
        ...(control ? sourcesOf(signalSources(raised)) : {}),
      })
      linkReads(builder, id, raised)
      return id
    }

    // `pass` no dice nada del programa: un cuerpo con solo un `pass` no tiene nada que dibujar.
    case 'pass_statement':
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
  // Lo que no tiene editor propio (`y = x`, `self.a = b`, `z = a and b`) se enseña como destino y valor.
  const generic =
    !sem && !isAugmented && kind !== 'control.condition' ? assignOf(left, right) : null

  builder.add({
    id,
    kind,
    label: name,
    code,
    line,
    ...fromSemantics(sem),
    ...(generic
      ? {
          control: generic,
          ...sourcesOf(assignSources(left, right)),
          ...inputsIn(inputsOf(assignSources(left, right))),
        }
      : {}),
    ...calling(builder, right),
  })
  linkReads(
    builder,
    id,
    isAugmented ? assignment : right,
    sem?.ports ??
      (generic
        ? portsOf(right, 'value')
        : kind === 'control.condition'
          ? conditionPorts(right)
          : callPorts(right)),
  )
  // Un destino que lee (`self.x`, `xs[i]`) usa los nombres que hay en él antes de asignar.
  if (generic && left && left.type !== 'identifier') {
    linkReads(builder, id, left, portsOf(left, 'destination'))
  }
  builder.bind(name, id)
  if (left?.type === 'identifier') {
    builder.recordName(id, name, left)
    builder.provide(id, name)
    if (generic) builder.rename(id, 'destination', name)
  } else if (
    left?.type === 'pattern_list' ||
    left?.type === 'tuple_pattern' ||
    left?.type === 'list_pattern'
  ) {
    // `a, b = f()`: cada nombre del patrón lo define este nodo (`self.x = …` no define `self`), y
    // cada uno sale por su propio puerto (`result:a`): es un chip que se lleva por separado.
    const names = patternIdentifiers(left)
    for (const each of names) {
      builder.bind(each.text, id, `result:${each.text}`)
      builder.recordName(id, each.text, each)
    }
    // Solo cuando el destino es una lista de nombres limpia (`a, b`, sin `*resto` ni paréntesis).
    if (names.length >= 2 && NAME_LIST.test(left.text))
      builder.results(
        id,
        names.map((n) => n.text),
      )
  }
  return id
}

const sourcesOf = (sources: Record<string, Source> | undefined) => (sources ? { sources } : {})
const inputsIn = (inputs: Record<string, Source> | undefined) => (inputs ? { inputs } : {})

/** El editor de un nodo y de dónde sale cada campo, si la sentencia se pudo representar. */
function fromSemantics(
  sem: Semantics | null | undefined,
): Pick<ProgramNode, 'control' | 'sources' | 'inputs'> {
  if (!sem) return {}
  return {
    control: sem.control,
    ...(sem.sources ? { sources: sem.sources } : {}),
    ...inputsIn(inputsOf(sem.sources, sem.inputs)),
  }
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
