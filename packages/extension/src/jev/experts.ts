import type { AiProvider } from '../ai/provider.ts'
import type { Decider } from './client.ts'

/**
 * **Los expertos**: al acabar una orden, quien sabe de cada cosa audita lo que quedó y dice qué mejoraría.
 *
 * - **UI**: lo que se ve (la pantalla, lo que se imprime): que se lea, que esté ordenado, que se distinga.
 * - **UX**: que se pueda usar y se entienda qué hacer, y que haga lo que la persona pidió.
 * - **Código limpio**: nombres, funciones pequeñas, nada repetido ni sobrante, comentarios que digan algo.
 * - **Ingeniería**: la estructura (etapas, datos aparte de la lógica), que aguante (errores, casos raros) y
 *   que no gaste de más (lo que se repite sin parar, el estado global).
 *
 * Trabajan las dos IAs, cada una en lo suyo: la generativa mira el programa, lo que hace al ejecutarlo y su
 * pantalla, y **propone** hallazgos; el JEV **decide** de cada uno si es real y si toca arreglarlo ya
 * (dentro de lo pedido), si se deja como sugerencia o si se descarta. Quien lo usa elige cuánto está cada
 * experto: apagado, observa (solo dice), propone (con un botón para aplicarlo) o corrige (aplica solo lo que
 * el JEV confirma).
 */

export const EXPERT_IDS = ['ui', 'ux', 'codigo', 'ingenieria'] as const
export type ExpertId = (typeof EXPERT_IDS)[number]

/** Cuánto está un experto: 0 apagado, 1 observa, 2 propone, 3 corrige. */
export type Presence = 0 | 1 | 2 | 3
export type ExpertLevels = Record<ExpertId, Presence>

export const PRESENCE_NAMES: Record<Presence, string> = {
  0: 'Apagado',
  1: 'Observa',
  2: 'Propone',
  3: 'Corrige',
}

/** Lo de partida: los que miran lo que se usa, proponiendo; los del código, observando. */
export const DEFAULT_LEVELS: ExpertLevels = { ui: 2, ux: 2, codigo: 1, ingenieria: 1 }

export const EXPERTS: Record<ExpertId, { name: string; looks: string; asks: string }> = {
  ui: {
    name: 'Interfaz (UI)',
    looks: 'lo que se ve: que se lea, esté ordenado y se distinga lo importante',
    asks: 'Eres experto en INTERFAZ (UI). Miras solo lo que se ve: la pantalla (lo que dibuja, sus botones y textos) y lo que el programa escribe. ¿Se lee bien? ¿Está ordenado y alineado? ¿Los colores contrastan y dicen algo? ¿Lo importante se distingue? ¿Los textos son claros y en el idioma de quien lo usa?',
  },
  ux: {
    name: 'Experiencia (UX)',
    looks: 'que se pueda usar, se entienda qué hacer y haga lo pedido',
    asks: 'Eres experto en EXPERIENCIA DE USO (UX). Te pones en el lugar de quien lo pidió y lo va a usar. ¿Hace lo que pidió? ¿Se entiende qué hacer al verlo? ¿Responde a lo que se pulsa y se nota que respondió? ¿Hay algo que se espera y no está (empezar de nuevo, parar, saber qué pasó)? ¿Algo molesta (suena solo, va demasiado rápido, no se puede detener)?',
  },
  codigo: {
    name: 'Código limpio',
    looks: 'nombres, funciones pequeñas, nada repetido ni sobrante',
    asks: 'Eres experto en CÓDIGO LIMPIO. ¿Los nombres dicen qué son? ¿Cada función hace una cosa y es corta? ¿Hay código repetido que podría ser una función, números mágicos que deberían tener nombre, código que sobra o que no se usa? ¿Los comentarios dicen el porqué y no repiten el código?',
  },
  ingenieria: {
    name: 'Ingeniería de software',
    looks: 'la estructura, que aguante y que no gaste de más',
    asks: 'Eres experto en INGENIERÍA DE SOFTWARE. ¿Está bien partido en etapas, con los datos aparte de la lógica y del arranque? ¿Aguanta errores y casos raros (listas vacías, índices fuera de rango, valores inesperados)? ¿Usa estado global sin necesidad? ¿Gasta de más (algo que se repite sin parar aunque ya no haga falta, trabajo repetido)? ¿Sería fácil cambiarlo o ampliarlo?',
  },
}

/** Lo que dice un experto de una cosa que vio. */
export interface Finding {
  /** `grave`: impide usarlo o hacer lo pedido, o es un fallo; `mejora`: lo haría mejor. */
  severity: 'grave' | 'mejora'
  /** Qué pasa, en una frase. */
  what: string
  /** Qué hacer, en una frase imperativa (es la orden que se daría para arreglarlo). */
  fix: string
  /** Lo que decidió el JEV: arreglarlo ya, dejarlo como sugerencia o descartarlo. */
  verdict: 'aplicar' | 'sugerir' | 'descartar'
  /** Ya se aplicó (con el experto en «corrige»). */
  applied?: boolean
}

export interface ExpertReport {
  id: ExpertId
  level: Presence
  /** Lo que vio (sin lo descartado). */
  findings: Finding[]
  /** No pudo mirarlo (la IA no contestó o no se entendió). */
  silent?: boolean
}

/** Cuántos hallazgos dice cada experto, como mucho: los que más importan. */
export const MAX_FINDINGS = 3

/**
 * `guide`: lo que tiene que saber de las herramientas que usa el programa (la pantalla de Prysel), para no
 * dar por fallo lo que funciona (una nota «do5» existe; las notas seguidas ya forman melodía).
 */
export function expertSystem(id: ExpertId, guide?: string): string {
  return [
    EXPERTS[id].asks,
    ...(guide
      ? [
          `El programa usa esto, que funciona así (no lo des por fallo):
${guide}`,
        ]
      : []),
    'Te doy lo que se pidió, el programa en Python y lo que hace al ejecutarlo sin nadie delante (y lo que ofrece su pantalla, si la tiene).',
    `Di como mucho ${MAX_FINDINGS} cosas, las que más importan, SOLO de lo tuyo. Una por línea, así: «GRAVE | qué pasa | qué hacer» o «MEJORA | qué pasa | qué hacer». GRAVE es lo que impide usarlo, hacer lo pedido o es un fallo; MEJORA, lo que lo haría mejor.`,
    '«Qué hacer» es una orden corta e imperativa que se le podría dar a quien programa («Usa colores en español que existan», «Añade un botón para empezar de nuevo»).',
    'No pidas cosas que cambien lo que se pidió ni añadidos grandes. Si en lo tuyo está bien, responde solo «BIEN».',
  ].join('\n')
}

export function expertPrompt(command: string, source: string, ran?: string): string {
  return `Lo que se pidió: ${command}\n\nEl programa:\n${source}${ran ? `\n\n${ran}` : ''}`
}

/** Lee lo que dijo un experto: sus hallazgos, o ninguno si dice que está bien. `null`: no se entiende. */
export function findingsOf(text: string): Omit<Finding, 'verdict'>[] | null {
  const found: Omit<Finding, 'verdict'>[] = []
  for (const line of text.split('\n')) {
    const parts = line
      .replace(/^\s*[-*•\d.)]+\s*/, '')
      .split('|')
      .map((part) => part.trim().replace(/^[«"]|[»"]$/g, ''))
    if (parts.length < 3) continue
    const kind = (parts[0] ?? '').toUpperCase()
    if (kind !== 'GRAVE' && kind !== 'MEJORA') continue
    const what = parts[1] ?? ''
    const fix = parts.slice(2).join(' | ')
    if (what.length < 4 || fix.length < 4) continue
    found.push({
      severity: kind === 'GRAVE' ? 'grave' : 'mejora',
      what,
      fix: fix.replace(/[.]$/, ''),
    })
  }
  if (found.length > 0) return found.slice(0, MAX_FINDINGS)
  return /\bBIEN\b/i.test(text) ? [] : null
}

/** Con cuánta certeza del JEV un hallazgo se arregla ya (y no se deja como sugerencia). */
export const APPLY_THRESHOLD = 0.6

/**
 * De cada hallazgo, lo decide el JEV: ¿es real en ESTE programa y conviene arreglarlo ya, dentro de lo que
 * se pidió (`aplicar`)? ¿Es real pero opcional (`sugerir`)? ¿O no es real, o cambiaría lo pedido
 * (`descartar`)? Si no está seguro, se queda como sugerencia: decide quien lo usa.
 */
export async function judgeFindings(
  decider: Decider,
  command: string,
  expert: ExpertId,
  findings: readonly Omit<Finding, 'verdict'>[],
): Promise<{ verdicts: Finding['verdict'][]; ms: number }> {
  if (findings.length === 0) return { verdicts: [], ms: 0 }
  const { answers, ms } = await decider.decide({
    state: {
      orden: command,
      experto: EXPERTS[expert].name,
      hallazgos: findings.map((one) => one.what),
    },
    questions: Object.fromEntries(
      findings.map((finding, at) => [
        `hallazgo${at}`,
        {
          type: 'choice' as const,
          instructions: `Se pidió un programa en Python con la \`orden\`. Un experto en ${EXPERTS[expert].name} lo revisa y dice: «${finding.what}». Propone: «${finding.fix}». ¿Qué se hace con eso?`,
          criteria: {
            aplicar:
              'Es real en este programa y conviene arreglarlo ya: es un fallo o impide usarlo o hacer lo pedido, y arreglarlo no cambia lo que se pidió.',
            sugerir:
              'Es real pero opcional: lo mejoraría, y quien lo usa puede decidir si lo quiere.',
            descartar: 'No es real en este programa, es de gusto, o cambiaría lo que se pidió.',
          },
        },
      ]),
    ),
  })
  return {
    verdicts: findings.map((_, at) => {
      const answer = answers[`hallazgo${at}`]
      if (answer?.type !== 'choice') return 'sugerir'
      if (answer.choice === 'descartar' && answer.confidence >= APPLY_THRESHOLD) return 'descartar'
      if (answer.choice === 'aplicar' && answer.confidence >= APPLY_THRESHOLD) return 'aplicar'
      return 'sugerir'
    }),
    ms,
  }
}

/**
 * Lo que dice un experto, ya decidido por el JEV: le pregunta a la IA (con su papel) y pasa cada hallazgo
 * por el JEV. Lo descartado no se cuenta.
 */
export async function consult(
  provider: AiProvider,
  decider: Decider,
  expert: ExpertId,
  level: Presence,
  request: { command: string; source: string; ran?: string; guide?: string },
): Promise<{ report: ExpertReport; ms: number }> {
  let raw: string
  try {
    raw = await provider.generate({
      system: expertSystem(expert, request.guide),
      prompt: expertPrompt(request.command, request.source, request.ran),
      maxTokens: 400,
    })
  } catch {
    return { report: { id: expert, level, findings: [], silent: true }, ms: 0 }
  }
  const findings = findingsOf(raw)
  if (findings === null) return { report: { id: expert, level, findings: [], silent: true }, ms: 0 }
  const judged = await judgeFindings(decider, request.command, expert, findings).catch(() => null)
  const verdicts = judged?.verdicts ?? findings.map(() => 'sugerir' as const)
  return {
    report: {
      id: expert,
      level,
      findings: findings
        .map((finding, at) => ({ ...finding, verdict: verdicts[at] ?? 'sugerir' }))
        .filter((finding) => finding.verdict !== 'descartar'),
    },
    ms: judged?.ms ?? 0,
  }
}

/** Los niveles guardados, leídos con cuidado (lo que no valga, el de partida). */
export function levelsFrom(value: unknown): ExpertLevels {
  const given = (value ?? {}) as Partial<Record<ExpertId, unknown>>
  return Object.fromEntries(
    EXPERT_IDS.map((id) => {
      const level = given[id]
      return [
        id,
        level === 0 || level === 1 || level === 2 || level === 3 ? level : DEFAULT_LEVELS[id],
      ]
    }),
  ) as ExpertLevels
}
