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
 * experto: apagado, observa (solo dice), propone (con un botón para aplicarlo) o corrige (aplica lo que el
 * JEV no descarta: es lo de partida). Al corregir se vuelve a mirar, unas pocas rondas, hasta que no queda
 * nada o se nota que dan vueltas (un arreglo que deshace otro, o el programa que vuelve a como estaba).
 *
 * Y antes de escribir nada, **el auditor del plan** (un experto interno) mira las partes del plan: que sean
 * congruentes entre sí y con lo pedido, y que cada una aporte algo.
 */

/** Los expertos que miran lo construido. */
export const EXPERT_IDS = ['ui', 'ux', 'codigo', 'ingenieria'] as const
export type ExpertId = (typeof EXPERT_IDS)[number]
/** Y los que se configuran en el panel: ellos y el auditor del plan (`plan`), que mira antes de construir. */
export const ADVISOR_IDS = [...EXPERT_IDS, 'plan'] as const
export type AdvisorId = (typeof ADVISOR_IDS)[number]

/** Cuánto está un experto: 0 apagado, 1 observa, 2 propone, 3 corrige. */
export type Presence = 0 | 1 | 2 | 3
export type ExpertLevels = Record<AdvisorId, Presence>

export const PRESENCE_NAMES: Record<Presence, string> = {
  0: 'Apagado',
  1: 'Observa',
  2: 'Propone',
  3: 'Corrige',
}

/** Lo de partida: todos corrigen (lo que recomiendan se aplica, salvo que se note que dan vueltas). */
export const DEFAULT_LEVELS: ExpertLevels = { ui: 3, ux: 3, codigo: 3, ingenieria: 3, plan: 3 }

/** Cómo se llama y qué mira cada uno, en el panel (también el auditor del plan). */
export const ADVISORS: Record<AdvisorId, { name: string; looks: string }> = {
  ui: {
    name: 'Interfaz (UI)',
    looks: 'lo que se ve: que se lea, esté ordenado y se distinga lo importante',
  },
  ux: {
    name: 'Experiencia (UX)',
    looks: 'que se pueda usar, se entienda qué hacer y haga lo pedido',
  },
  codigo: {
    name: 'Código limpio',
    looks: 'nombres, funciones pequeñas, nada repetido ni sobrante',
  },
  ingenieria: {
    name: 'Ingeniería de software',
    looks: 'la estructura, que aguante y que no gaste de más',
  },
  plan: {
    name: 'Auditor del plan y del diagrama',
    looks:
      'antes de escribir, que las partes encajen y aporten algo; al acabar, que la forma, los nombres, los números y las flechas del diagrama ayuden a entenderlo',
  },
}

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
  /**
   * Lo que decidió el JEV: arreglarlo ya, dejarlo como sugerencia, descartarlo, o `vuelta`: deshace o vuelve a
   * pedir un arreglo de antes (se está dando vueltas: no se aplica).
   */
  verdict: 'aplicar' | 'sugerir' | 'descartar' | 'vuelta'
  /** Ya se aplicó (con el experto en «corrige»). */
  applied?: boolean
}

export interface ExpertReport {
  id: AdvisorId
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
  /** Lo que se sabe de verdad del programa (lo que hizo al ejecutarlo): un hallazgo que lo contradiga no vale. */
  facts?: string,
  /** Lo que ya se arregló en rondas anteriores: si un hallazgo lo deshace o lo vuelve a pedir, se da vueltas. */
  applied: readonly string[] = [],
): Promise<{ verdicts: Finding['verdict'][]; ms: number }> {
  if (findings.length === 0) return { verdicts: [], ms: 0 }
  const { answers, ms } = await decider.decide({
    state: {
      orden: command,
      experto: EXPERTS[expert].name,
      hallazgos: findings.map((one) => one.what),
      ...(facts ? { hechos: facts } : {}),
      ...(applied.length > 0 ? { arreglado: [...applied] } : {}),
    },
    questions: Object.fromEntries(
      findings.flatMap((finding, at) => [
        ...(applied.length > 0
          ? [
              [
                `vuelta${at}`,
                {
                  type: 'noul' as const,
                  instructions: `En rondas anteriores ya se arregló lo de \`arreglado\`. Ahora un experto propone: «${finding.fix}». ¿Eso deshace, contradice o vuelve a pedir alguno de esos arreglos (se estaría dando vueltas)?`,
                  criteria: {
                    true: 'Sí: deshace o contradice un arreglo de antes, o pide otra vez lo mismo que ya se hizo.',
                    false: 'No: es algo nuevo, que no choca con lo ya arreglado.',
                  },
                },
              ] as const,
            ]
          : []),
        [
          `hallazgo${at}`,
          {
            type: 'choice' as const,
            instructions: `Se pidió un programa en Python con la \`orden\`. Un experto en ${EXPERTS[expert].name} lo revisa y dice: «${finding.what}». Propone: «${finding.fix}».${facts ? ' En `hechos` está lo que se sabe de verdad del programa al ejecutarlo: si lo que dice el experto lo contradice (da por inexistente o roto algo que funcionó), es una falsa alarma: descártalo.' : ''} ¿Qué se hace con eso?`,
            criteria: {
              aplicar:
                'Es real en este programa y conviene arreglarlo ya: es un fallo o impide usarlo o hacer lo pedido, y arreglarlo no cambia lo que se pidió.',
              sugerir:
                'Es real pero opcional: lo mejoraría, y quien lo usa puede decidir si lo quiere.',
              descartar:
                'No es real en este programa (contradice lo que se sabe de él), es de gusto, o cambiaría lo que se pidió.',
            },
          },
        ] as const,
      ]),
    ),
  })
  return {
    verdicts: findings.map((_, at) => {
      const loop = answers[`vuelta${at}`]
      if (loop?.type === 'noul' && loop.noul >= APPLY_THRESHOLD) return 'vuelta'
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
  request: {
    command: string
    source: string
    ran?: string
    guide?: string
    /** Lo ya arreglado en rondas anteriores (para notar si se dan vueltas). */
    applied?: readonly string[]
  },
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
  // El JEV juzga con los hechos delante: lo que hizo al ejecutarlo y cómo funciona lo que usa.
  const facts = [request.ran, request.guide].filter(Boolean).join('\n\n')
  const judged = await judgeFindings(
    decider,
    request.command,
    expert,
    findings,
    facts || undefined,
    request.applied ?? [],
  ).catch(() => null)
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
  const given = (value ?? {}) as Partial<Record<AdvisorId, unknown>>
  return Object.fromEntries(
    ADVISOR_IDS.map((id) => {
      const level = given[id]
      return [
        id,
        level === 0 || level === 1 || level === 2 || level === 3 ? level : DEFAULT_LEVELS[id],
      ]
    }),
  ) as ExpertLevels
}

// ───────────────────────── el auditor del plan ─────────────────────────

/** Una parte del plan, como la necesita el auditor (la misma forma que `Stage`). */
export interface PlanPart {
  title: string
  goal: string
  needs?: string[]
}

/** Lo que el auditor propone cambiar en el plan (los números son los de las partes, desde 1). */
export type PlanCorrection =
  | { kind: 'quitar'; at: number; why: string }
  | { kind: 'unir'; at: number; with: number; part: PlanPart; why: string }
  | { kind: 'cambiar'; at: number; part: PlanPart; why: string }
  | { kind: 'añadir'; after: number; part: PlanPart; why: string }
  /** El número de la parte (su orden) no es el que se sigue: va detrás de `after` (0: la primera). */
  | { kind: 'mover'; at: number; after: number; why: string }
  /** La parte `at` necesita lo que deja `from` (una flecha que falta)… */
  | { kind: 'conectar'; at: number; from: number; why: string }
  /** …o no lo necesita (una flecha que no dice nada verdadero). */
  | { kind: 'soltar'; at: number; from: number; why: string }

export function planAuditSystem(): string {
  return [
    'Eres el AUDITOR INTERNO de un plan. Alguien pidió un programa en Python, y antes de escribir nada se ha pensado este plan: sus partes, numeradas («Título: qué hace», y detrás de «<-» las partes que necesita). Cada parte será una fase del diagrama con el que quien lo usa entiende el programa: con ese número, ese nombre y una flecha por cada cosa que necesita.',
    'Revisa: CONGRUENCIA: cada parte hace algo distinto de las demás y todas van hacia lo pedido. VALOR: ninguna sobra, repite otra o está vacía, y no falta ninguna imprescindible (por ejemplo, la última que lo pone en marcha). NOMBRES: cada título dice lo que hace esa parte, se entiende sin saber programar y no se confunde con otro. NÚMEROS: el orden es el que se sigue al leerlo y al ejecutarlo (lo que prepara algo va antes de lo que lo usa). CONEXIONES: cada «<-» es verdad (esa parte usa lo que deja la otra) y no falta ninguna que cuente cómo pasan los datos.',
    'Si hay que corregir, una corrección por línea, como mucho cuatro:',
    '«QUITAR N | por qué» · «UNIR N y M | Título: qué hace | por qué» · «CAMBIAR N | Título: qué hace | por qué» · «AÑADIR tras N | Título: qué hace | por qué» (tras 0 es al principio) · «MOVER N tras M | por qué» · «CONECTAR N a M | por qué» (M necesita lo que deja N) · «SOLTAR N de M | por qué» (M no necesita nada de N).',
    'El título, de dos a cuatro palabras; lo que hace, menos de diez. Si el plan está bien, responde solo «BIEN».',
  ].join('\n')
}

export function planAuditPrompt(command: string, parts: readonly PlanPart[]): string {
  const listed = parts
    .map((part, at) => {
      const needs = part.needs && part.needs.length > 0 ? ` <- ${part.needs.join(', ')}` : ''
      return `${at + 1}. ${part.title}: ${part.goal}${needs}`
    })
    .join('\n')
  return `Lo que se pidió: ${command}\n\nEl plan:\n${listed}`
}

/** Una parte dicha como «Título: qué hace». */
export function partOf(text: string): PlanPart | null {
  const clean = text.trim().replace(/^[«"]+|[»"]+$/g, '')
  const found = /^([^:|]{2,48}):\s*(.{2,120})$/.exec(clean)
  if (!found) return null
  return { title: (found[1] ?? '').trim(), goal: (found[2] ?? '').trim().replace(/[.]$/, '') }
}

/** Lee lo que dijo el auditor: sus correcciones (validadas contra el plan), o ninguna. `null`: no se entiende. */
export function correctionsOf(text: string, count: number): PlanCorrection[] | null {
  const out: PlanCorrection[] = []
  const inRange = (n: number) => Number.isInteger(n) && n >= 1 && n <= count
  for (const line of text.split('\n')) {
    const parts = line
      .replace(/^\s*[-*•]\s*/, '')
      .split('|')
      .map((part) => part.trim())
    const head = (parts[0] ?? '').toUpperCase()
    const quitar = /^QUITAR\s+(\d+)$/.exec(head)
    const unir = /^UNIR\s+(\d+)\s*(?:Y|,|\+)\s*(\d+)$/.exec(head)
    const cambiar = /^CAMBIAR\s+(\d+)$/.exec(head)
    const anadir = /^A[ÑN]ADIR\s+TRAS\s+(\d+)$/.exec(head)
    const mover = /^MOVER\s+(\d+)\s+(?:TRAS|DESPU[ÉE]S\s+DE)\s+(\d+)$/.exec(head)
    const conectar = /^CONECTAR\s+(\d+)\s+(?:A|CON|Y)\s+(\d+)$/.exec(head)
    const soltar = /^SOLTAR\s+(\d+)\s+DE\s+(\d+)$/.exec(head)
    const why = (at: number) => parts[at] ?? ''
    if (mover) {
      const [at, after] = [Number(mover[1]), Number(mover[2])]
      if (inRange(at) && (after === 0 || inRange(after)) && at !== after && at !== after + 1) {
        out.push({ kind: 'mover', at, after, why: why(1) })
      }
    } else if (conectar || soltar) {
      const found = conectar ?? soltar
      const [from, at] = [Number(found?.[1]), Number(found?.[2])]
      if (inRange(from) && inRange(at) && from !== at) {
        out.push({ kind: conectar ? 'conectar' : 'soltar', at, from, why: why(1) })
      }
    } else if (quitar && inRange(Number(quitar[1]))) {
      out.push({ kind: 'quitar', at: Number(quitar[1]), why: parts[1] ?? '' })
    } else if (unir) {
      const part = partOf(parts[1] ?? '')
      const [at, other] = [Number(unir[1]), Number(unir[2])]
      if (part && inRange(at) && inRange(other) && at !== other) {
        const why = parts[2] ?? ''
        out.push({ kind: 'unir', at: Math.min(at, other), with: Math.max(at, other), part, why })
      }
    } else if (cambiar) {
      const part = partOf(parts[1] ?? '')
      if (part && inRange(Number(cambiar[1]))) {
        out.push({ kind: 'cambiar', at: Number(cambiar[1]), part, why: parts[2] ?? '' })
      }
    } else if (anadir) {
      const part = partOf(parts[1] ?? '')
      const after = Number(anadir[1])
      if (part && (after === 0 || inRange(after))) {
        out.push({ kind: 'añadir', after, part, why: parts[2] ?? '' })
      }
    }
  }
  if (out.length > 0) return out.slice(0, 4)
  return /\bBIEN\b/i.test(text) ? [] : null
}

/** Cómo se dice una corrección, para enseñarla. */
export function correctionSaid(correction: PlanCorrection, parts: readonly PlanPart[]): string {
  const name = (n: number) => `«${parts[n - 1]?.title ?? String(n)}»`
  switch (correction.kind) {
    case 'quitar':
      return `Quitar ${name(correction.at)}`
    case 'unir':
      return `Unir ${name(correction.at)} y ${name(correction.with)} en «${correction.part.title}»`
    case 'cambiar':
      return `Cambiar ${name(correction.at)} por «${correction.part.title}: ${correction.part.goal}»`
    case 'añadir':
      return correction.after === 0
        ? `Añadir «${correction.part.title}» al principio`
        : `Añadir «${correction.part.title}» tras ${name(correction.after)}`
    case 'mover':
      return correction.after === 0
        ? `Poner ${name(correction.at)} la primera`
        : `Poner ${name(correction.at)} detrás de ${name(correction.after)}`
    case 'conectar':
      return `Que ${name(correction.at)} use lo que deja ${name(correction.from)}`
    case 'soltar':
      return `Quitar la flecha de ${name(correction.from)} a ${name(correction.at)}`
  }
}

/**
 * El JEV decide de cada corrección del auditor si mejora el plan (más congruente, cada parte con su valor) sin
 * apartarse de lo pedido. Si no está seguro, el plan se queda como estaba.
 */
export async function judgePlan(
  decider: Decider,
  command: string,
  parts: readonly PlanPart[],
  corrections: readonly PlanCorrection[],
): Promise<{ accepted: boolean[]; ms: number }> {
  if (corrections.length === 0) return { accepted: [], ms: 0 }
  const { answers, ms } = await decider.decide({
    state: {
      orden: command,
      plan: parts.map((part, at) => `${at + 1}. ${part.title}: ${part.goal}`),
    },
    questions: Object.fromEntries(
      corrections.map((correction, at) => [
        `corregir${at}`,
        {
          type: 'noul' as const,
          instructions: `Para el programa que pide la \`orden\` se pensó el \`plan\`. El auditor propone: «${correctionSaid(correction, parts)}» (${correction.why || 'sin decir por qué'}). ¿Hace el plan más congruente, o hace que cada parte aporte algo, sin apartarse de lo pedido?`,
          criteria: {
            true: 'Sí: con eso el plan es más coherente, sin partes que sobren o se repitan, o con lo que le faltaba.',
            false: 'No: el plan ya estaba bien así, o eso lo aparta de lo pedido.',
          },
        },
      ]),
    ),
  })
  return {
    accepted: corrections.map((_, at) => {
      const answer = answers[`corregir${at}`]
      return answer?.type === 'noul' && answer.noul >= APPLY_THRESHOLD
    }),
    ms,
  }
}

/**
 * El plan con las correcciones hechas (los números se refieren al plan de antes). Lo que necesitaba una parte
 * que se cambia o se une a otra pasa a la nueva; lo que necesitaba una parte quitada, se olvida.
 */
export function correctedPlan(
  parts: readonly PlanPart[],
  corrections: readonly PlanCorrection[],
): PlanPart[] {
  const removed = new Set<number>()
  const replaced = new Map<number, PlanPart>()
  const inserted = new Map<number, PlanPart[]>()
  const needs = new Map(parts.map((part, index) => [index + 1, new Set(part.needs ?? [])]))
  /** El título que lleva ahora cada parte de antes (`null`: ya no está). */
  const renamed = new Map<string, string | null>()
  let order = parts.map((_, index) => index + 1)
  for (const correction of corrections) {
    const title = (n: number) => parts[n - 1]?.title ?? ''
    if (correction.kind === 'quitar') {
      removed.add(correction.at)
      renamed.set(title(correction.at), null)
    } else if (correction.kind === 'cambiar') {
      replaced.set(correction.at, correction.part)
      renamed.set(title(correction.at), correction.part.title)
    } else if (correction.kind === 'unir') {
      replaced.set(correction.at, correction.part)
      removed.add(correction.with)
      for (const need of needs.get(correction.with) ?? []) needs.get(correction.at)?.add(need)
      renamed.set(title(correction.at), correction.part.title)
      renamed.set(title(correction.with), correction.part.title)
    } else if (correction.kind === 'añadir') {
      inserted.set(correction.after, [...(inserted.get(correction.after) ?? []), correction.part])
    } else if (correction.kind === 'mover') {
      order = order.filter((n) => n !== correction.at)
      order.splice(
        correction.after === 0 ? 0 : order.indexOf(correction.after) + 1,
        0,
        correction.at,
      )
    } else if (correction.kind === 'conectar') {
      needs.get(correction.at)?.add(title(correction.from))
    } else {
      needs.get(correction.at)?.delete(title(correction.from))
    }
  }
  const out: PlanPart[] = [...(inserted.get(0) ?? [])]
  for (const at of order) {
    if (!removed.has(at) || replaced.has(at)) {
      const part = replaced.get(at) ?? parts[at - 1]
      if (part) out.push({ ...part, needs: [...(needs.get(at) ?? [])] })
    }
    out.push(...(inserted.get(at) ?? []))
  }
  // Lo que necesita cada parte, con los títulos de ahora y solo entre las que quedan (y ninguna a sí misma).
  const titles = new Set(out.map((part) => part.title))
  return out.map((part) => {
    const kept = [
      ...new Set(
        (part.needs ?? []).flatMap((need) => {
          const now = renamed.has(need) ? renamed.get(need) : need
          return now && titles.has(now) && now !== part.title ? [now] : []
        }),
      ),
    ]
    return kept.length > 0 ? { ...part, needs: kept } : { title: part.title, goal: part.goal }
  })
}
