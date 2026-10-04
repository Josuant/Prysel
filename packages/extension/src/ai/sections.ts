import type { Program, ProgramNode } from '@prysel/python'
import { anchorKey, anchorNode } from '../anchor.ts'
import { extractJson } from './json.ts'
import type { AiProvider } from './provider.ts'

/**
 * La IA **propone las etapas** de un código que no las tiene: dónde empieza cada fase de un bloque largo y
 * cómo se llama. No escribe nada por sí misma: lo que propone se valida aquí (cada ancla es una sentencia de
 * verdad de un bloque que lo necesita, al menos dos por bloque) y luego se enseña al usuario como una
 * edición que acepta o descarta (la vista previa de refactorización de VS Code). Lo que queda son
 * comentarios de sección normales: el código sigue siendo el suyo.
 *
 * Puro salvo por `provider.generate`: se prueba con un proveedor de mentira.
 */

/** Un bloque del programa que merece etapas: sus sentencias directas, en orden, y cómo se llama. */
export interface SectionBlock {
  /** Qué bloque es: su dueño y, en una decisión, qué camino. */
  key: string
  /** Cómo se le dice al modelo: «el cuerpo de la función `entrenar`». */
  title: string
  statements: ProgramNode[]
}

/** Una etapa que se escribirá: la sentencia con la que empieza y su título. */
export interface SectionChoice {
  id: string
  title: string
}

export type SectionsResult =
  | { ok: true; sections: SectionChoice[]; attempts: number }
  | { ok: false; error: string; attempts: number; raw?: string }

/** Menos sentencias que estas no se parten: se leen de un vistazo. */
export const MIN_BLOCK = 4
/** Etapas por bloque, como mucho: más ya no son un esquema. */
export const MAX_PER_BLOCK = 7
export const MAX_ATTEMPTS = 3
const MAX_TITLE = 80

const isDefinition = (node: ProgramNode) =>
  node.kind === 'abstraction.collapsed' || node.kind === 'abstraction.class'

/**
 * Los bloques que merecen etapas: los que no tienen ya ninguna y tienen al menos `MIN_BLOCK` sentencias que
 * hacen algo (una definición no cuenta: su cuerpo es otro bloque).
 */
export function sectionBlocks(program: Program): SectionBlock[] {
  const byId = new Map(program.nodes.map((node) => [node.id, node]))
  const groups = new Map<string, ProgramNode[]>()
  for (const node of program.nodes) {
    const range = node.range
    if (!range || range.block === 99) continue
    const owner = range.owner === undefined ? undefined : byId.get(range.owner)
    // Una decisión tiene dos bloques con el mismo dueño: el «sí» (hasta `yesEnd`) y su `else`.
    const side =
      owner?.range?.yesEnd !== undefined && range.start >= owner.range.yesEnd ? 'no' : 'sí'
    const key = `${range.owner ?? ''}|${side}|${range.indent}`
    groups.set(key, [...(groups.get(key) ?? []), node])
  }
  const opened = new Set((program.sections ?? []).map((section) => section.members[0]))
  const blocks: SectionBlock[] = []
  for (const [key, statements] of groups) {
    statements.sort((a, b) => (a.range?.start ?? 0) - (b.range?.start ?? 0))
    if (statements.some((node) => opened.has(node.id))) continue
    if (statements.filter((node) => !isDefinition(node)).length < MIN_BLOCK) continue
    const ownerId = key.split('|')[0] ?? ''
    const owner = byId.get(ownerId)
    const side = key.split('|')[1]
    blocks.push({ key, title: blockTitle(owner, side === 'no'), statements })
  }
  return blocks.sort(
    (a, b) => (a.statements[0]?.range?.start ?? 0) - (b.statements[0]?.range?.start ?? 0),
  )
}

function blockTitle(owner: ProgramNode | undefined, otherwise: boolean): string {
  if (!owner) return 'el programa (lo que hay fuera de toda función)'
  const head = anchorKey(owner)
  switch (owner.kind) {
    case 'abstraction.collapsed':
      return `el cuerpo de la función «${owner.label}»`
    case 'control.loop':
      return `el cuerpo del bucle «${head}»`
    case 'control.condition':
      return otherwise ? `el camino «no» (else) de «${head}»` : `el camino «sí» de «${head}»`
    default:
      return `el cuerpo de «${head}»`
  }
}

/** Lo que el modelo tiene que cumplir, con el formato exacto. */
export function buildSectionsSystemPrompt(): string {
  return [
    'Propones las ETAPAS de un programa Python para Prysel, una extensión de VS Code que lo dibuja como un',
    'diagrama de flujo. Una etapa es un tramo de sentencias seguidas de un mismo bloque que hace una sola',
    'cosa con sentido (en un algoritmo genético: «Probar», «Juzgar», «Criar», «Relevo»). Se escribirá como',
    'un comentario de sección encima de la sentencia con la que empieza, y el diagrama la plegará en una',
    'tarjeta con ese título.',
    '',
    'Responde solo este JSON, sin explicación ni marcado:',
    '{ "sections": [ { "before": { "text": "…", "nth": 1 }, "title": "Título: lo que hace" } ] }',
    '',
    'Reglas, todas obligatorias:',
    '1. "before.text" es, letra por letra, una de las sentencias de la lista (sin el «L12:» del principio).',
    '   Si esa sentencia aparece repetida, "nth" dice cuál (la lista lo indica); si no, omite "nth".',
    '2. Solo sentencias de los bloques de la lista. Cada bloque que partas lleva entre 2 y 7 etapas; la',
    '   primera, en su primera sentencia. Puedes dejar un bloque sin partir si no tiene fases claras.',
    '3. "title": corto, en el idioma pedido, con la forma «Nombre: qué hace» (el nombre, una o dos palabras;',
    '   lo que hace, una frase breve). Sin almohadilla, sin numeración, en una sola línea.',
    '4. Nombra lo que la fase CONSIGUE (su propósito en el algoritmo), no cómo lo escribe el código.',
  ].join('\n')
}

/** El pedido: los bloques que merecen etapas, con sus sentencias. */
export function buildSectionsPrompt(
  program: Program,
  blocks: readonly SectionBlock[],
  lang = 'es',
): string {
  const counts = new Map<string, number>()
  const seen = new Map<string, number>()
  for (const node of program.nodes)
    counts.set(anchorKey(node), (counts.get(anchorKey(node)) ?? 0) + 1)
  const order = [...program.nodes].sort((a, b) => a.line - b.line)
  const nthOf = new Map<string, number>()
  for (const node of order) {
    const key = anchorKey(node)
    const n = (seen.get(key) ?? 0) + 1
    seen.set(key, n)
    nthOf.set(node.id, n)
  }
  const lines = [`Idioma de los títulos: ${lang}`, '']
  blocks.forEach((block, i) => {
    lines.push(`Bloque ${i + 1}: ${block.title}`)
    for (const node of block.statements) {
      const key = anchorKey(node)
      const repeated = (counts.get(key) ?? 0) > 1
      lines.push(
        `  L${node.line}: ${key}${repeated ? `   (repetida: "nth": ${nthOf.get(node.id) ?? 1})` : ''}`,
      )
    }
    lines.push('')
  })
  lines.push('Propón las etapas.')
  return lines.join('\n')
}

/** Lo que propone el modelo, comprobado: cada ancla existe y es de un bloque que lo necesita. */
export function validateSections(
  program: Program,
  blocks: readonly SectionBlock[],
  raw: unknown,
): { ok: true; sections: SectionChoice[] } | { ok: false; error: string } {
  const list =
    typeof raw === 'object' && raw !== null ? (raw as { sections?: unknown }).sections : undefined
  if (!Array.isArray(list)) return { ok: false, error: 'Falta la lista "sections".' }
  const blockOf = new Map<string, SectionBlock>()
  for (const block of blocks) for (const node of block.statements) blockOf.set(node.id, block)
  const chosen: (SectionChoice & { block: string })[] = []
  for (const [i, item] of list.entries()) {
    const entry = item as { before?: { text?: unknown; nth?: unknown }; title?: unknown }
    const text = entry.before?.text
    if (typeof text !== 'string' || text.trim() === '') {
      return { ok: false, error: `Etapa ${i + 1}: falta "before.text".` }
    }
    const nth = typeof entry.before?.nth === 'number' ? entry.before.nth : undefined
    const node = anchorNode(program, { text, ...(nth === undefined ? {} : { nth }) })
    if (!node)
      return { ok: false, error: `Etapa ${i + 1}: «${text}» no es ninguna sentencia de la lista.` }
    const block = blockOf.get(node.id)
    if (!block) {
      return {
        ok: false,
        error: `Etapa ${i + 1}: «${text}» no es una sentencia directa de ninguno de los bloques de la lista.`,
      }
    }
    const title =
      typeof entry.title === 'string'
        ? entry.title
            .replace(/^#+\s*/, '')
            .replace(/\s+/g, ' ')
            .trim()
        : ''
    if (!title) return { ok: false, error: `Etapa ${i + 1}: falta "title".` }
    if (title.length > MAX_TITLE) {
      return { ok: false, error: `Etapa ${i + 1}: el título pasa de ${MAX_TITLE} caracteres.` }
    }
    if (chosen.some((other) => other.id === node.id)) {
      return { ok: false, error: `Etapa ${i + 1}: «${text}» ya empieza otra etapa.` }
    }
    chosen.push({ id: node.id, title, block: block.key })
  }
  if (chosen.length === 0) return { ok: false, error: 'No propone ninguna etapa.' }
  for (const block of blocks) {
    const own = chosen.filter((choice) => choice.block === block.key).length
    if (own === 1) {
      return {
        ok: false,
        error: `En ${block.title} hay una sola etapa: pon al menos dos, o ninguna.`,
      }
    }
    if (own > MAX_PER_BLOCK) {
      return {
        ok: false,
        error: `En ${block.title} hay ${own} etapas: como mucho ${MAX_PER_BLOCK}.`,
      }
    }
  }
  const lineOf = new Map(program.nodes.map((node) => [node.id, node.line]))
  return {
    ok: true,
    sections: chosen
      .sort((a, b) => (lineOf.get(a.id) ?? 0) - (lineOf.get(b.id) ?? 0))
      .map(({ id, title }) => ({ id, title })),
  }
}

/**
 * Pide las etapas al modelo y no se queda con nada que no pase la validación: si falla, le dice el motivo
 * exacto y le pide que lo corrija (como con las lecciones), hasta `MAX_ATTEMPTS` veces.
 */
export async function proposeSections(
  program: Program,
  provider: AiProvider,
  lang = 'es',
): Promise<SectionsResult> {
  const blocks = sectionBlocks(program)
  if (blocks.length === 0) {
    return { ok: false, error: 'No hay ningún bloque largo sin etapas.', attempts: 0 }
  }
  const system = buildSectionsSystemPrompt()
  const first = buildSectionsPrompt(program, blocks, lang)
  let prompt = first
  let lastError = 'El modelo no respondió.'
  let lastRaw = ''
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let raw: string
    try {
      raw = await provider.generate({ system, prompt, maxTokens: 2000 })
    } catch (error) {
      return {
        ok: false,
        error: `El modelo no respondió: ${error instanceof Error ? error.message : String(error)}`,
        attempts: attempt,
      }
    }
    lastRaw = raw
    const extracted = extractJson(raw)
    const checked = extracted.ok
      ? validateSections(program, blocks, extracted.value)
      : { ok: false as const, error: extracted.error }
    if (checked.ok) return { ok: true, sections: checked.sections, attempts: attempt }
    lastError = checked.error
    prompt = [
      first,
      '',
      'Tu respuesta anterior fue:',
      raw,
      '',
      `No vale: ${lastError}`,
      'Corrige solo eso y responde de nuevo con el JSON completo (las mismas reglas).',
    ].join('\n')
  }
  return { ok: false, error: lastError, attempts: MAX_ATTEMPTS, raw: lastRaw }
}
