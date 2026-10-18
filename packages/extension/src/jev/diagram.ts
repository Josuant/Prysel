import type { Decider } from './client.ts'
import { APPLY_THRESHOLD, partOf, type PlanPart } from './experts.ts'
import { ARCH_SHAPES, type ArchShapeId } from './plain.ts'

/**
 * **El auditor del diagrama**: el mismo experto interno que revisa el plan, mirando lo que de verdad se dibuja
 * al acabar. Quien usa Prysel no lee el código: lo entiende por el diagrama. Así que se revisa que la forma
 * (la topología), los nombres de las fases, sus números y sus flechas cuenten bien el programa.
 *
 * El diagrama lo dice el lienzo (es quien lo dibuja: ver `DiagramMessage`); el auditor (una IA) propone
 * correcciones cerradas; el JEV decide cuáles ayudan a entenderlo sin cambiar lo que hace; y quien dirige las
 * aplica (renombrar, unir, mover, la forma) o se las pide a la IA (una conexión que el código no deja ver).
 */

/** Una fase tal como se ve: su número en el esquema, su nombre, lo que dice que hace y su papel. */
export interface DiagramModule {
  /** El id del módulo (el de su etapa: `section:línea:columna`). */
  id: string
  /** El número que se ve en la fase. */
  n: string
  title: string
  subtitle?: string
  role?: string
}

/** Una flecha: de qué fase a cuál y qué dice (un dato que pasa, una función que se usa, o «luego»). */
export interface DiagramLink {
  from: string
  to: string
  kind: 'data' | 'call' | 'next'
  label?: string
}

/** Lo que el lienzo dibuja del programa. */
export interface Diagram {
  /** De qué texto del programa sale (`textKey`): así se sabe si es el de ahora. */
  key: string
  shape: string
  /** Las formas que el grafo tiene de verdad (la que se ve, entre ellas). */
  shapes: string[]
  modules: DiagramModule[]
  links: DiagramLink[]
}

/** Una huella corta de un texto: lo bastante para saber si dos son el mismo. */
export function textKey(raw: string): string {
  // (Los finales de línea no cuentan: el editor y el lienzo pueden guardarlos distintos.)
  const text = raw.replace(/\r/g, '')
  let hash = 5381
  for (let at = 0; at < text.length; at++) hash = ((hash * 33) ^ text.charCodeAt(at)) >>> 0
  return `${text.length}:${hash.toString(36)}`
}

/** Lo que el auditor propone cambiar en el diagrama (los números son los de las fases, desde 1). */
export type DiagramCorrection =
  | { kind: 'renombrar'; at: number; part: PlanPart; why: string }
  | { kind: 'unir'; at: number; with: number; part: PlanPart; why: string }
  | { kind: 'mover'; at: number; after: number; why: string }
  | { kind: 'forma'; shape: ArchShapeId; why: string }
  /** Una conexión que el código no deja ver: se le pide a la IA ese cambio. */
  | { kind: 'conectar'; fix: string; why: string }

export function diagramAuditSystem(): string {
  return [
    'Eres el AUDITOR INTERNO del diagrama de un programa en Python. Quien lo usa no lee el código: lo entiende por este diagrama. Tienes su forma, sus fases (con el número que se ve en cada una, su nombre, lo que dice que hace, su papel y lo que tiene en su primer nivel), sus flechas (de qué fase a cuál y qué dicen) y el código.',
    'Revisa que el diagrama ayude de verdad a entender el programa. TOPOLOGÍA: la forma cuenta cómo funciona (si otra de las posibles lo cuenta mejor, dila). NOMBRES: cada fase dice en pocas palabras lo que hace, se entiende sin saber programar, y no hay dos que se llamen igual o se confundan. NÚMEROS: el orden de las fases es el que se sigue al leerlo y al ejecutarlo (lo que prepara algo va antes que lo que lo usa). CONEXIONES: cada flecha dice algo verdadero y útil; ninguna fase queda suelta sin razón; no falta la que cuenta cómo pasan los datos de una fase a otra. CONTENIDO: cada fase tiene lo que dice su nombre; si tiene líneas que son de otra (por ejemplo, el arranque metido en «Mostrar ticket»), su papel y sus flechas engañan: esa fase parece la que manda.',
    'Si hay que corregir, una corrección por línea, como mucho cuatro:',
    '«RENOMBRAR N | Título: qué hace | por qué» · «UNIR N y M | Título: qué hace | por qué» (fases seguidas que hacen lo mismo) · «MOVER N tras M | por qué» (tras 0 es al principio) · «FORMA nombre | por qué» (una de las posibles) · «ARREGLAR | qué líneas llevar a qué fase, o qué cambiar en el código para que se vea cómo pasa el dato | por qué».',
    'En lo que escribas tras ARREGLAR, nombra las fases por su nombre entre comillas («Mostrar ticket»), nunca por su número: quien lo lea no ve los números. Lo que pidas no puede cambiar lo que hace el programa.',
    'El título, de dos a cuatro palabras; lo que hace, menos de diez. No propongas lo que ya está así. Si el diagrama ya se entiende bien, responde solo «BIEN».',
  ].join('\n')
}

const LINK_SAID: Record<DiagramLink['kind'], (label?: string) => string> = {
  data: (label) => (label ? `le pasa «${label}»` : 'le pasa un dato'),
  call: (label) => (label ? `usa «${label}»` : 'la usa'),
  next: () => 'luego',
}

export function diagramAuditPrompt(
  command: string,
  diagram: Diagram,
  source: string,
  /** Lo que ya se corrigió en una vuelta anterior: no se deshace. */
  applied: readonly string[] = [],
  /** Lo que tiene cada fase en su primer nivel (la primera línea de cada sentencia), por su id. */
  contents: ReadonlyMap<string, readonly string[]> = new Map(),
): string {
  const at = new Map(diagram.modules.map((module, index) => [module.id, index + 1]))
  const shapeSaid = (shape: string) =>
    shape in ARCH_SHAPES ? `${shape} (${ARCH_SHAPES[shape as ArchShapeId]})` : shape
  const others = diagram.shapes.filter((shape) => shape !== diagram.shape)
  const linked = new Set(diagram.links.flatMap((link) => [link.from, link.to]))
  const loose = diagram.modules.filter((module) => !linked.has(module.id))
  return [
    `Lo que se pidió: ${command}`,
    '',
    `La forma: ${shapeSaid(diagram.shape)}.`,
    others.length > 0
      ? `Otras posibles: ${others.map(shapeSaid).join('; ')}.`
      : 'No hay otra posible.',
    '',
    'Las fases:',
    ...diagram.modules.flatMap((module, index) => {
      const has = contents.get(module.id) ?? []
      const shown =
        has.slice(0, 6).join(' · ') + (has.length > 6 ? ` · (y ${has.length - 6} más)` : '')
      return [
        `${index + 1}. ${module.title}${module.subtitle ? `: ${module.subtitle}` : ''}${module.role ? ` (${module.role})` : ''}`,
        ...(has.length > 0 ? [`   tiene: ${shown}`] : []),
      ]
    }),
    '',
    'Las flechas:',
    ...(diagram.links.length > 0
      ? diagram.links.flatMap((link) => {
          const [from, to] = [at.get(link.from), at.get(link.to)]
          return from && to ? [`${from} → ${to}: ${LINK_SAID[link.kind](link.label)}`] : []
        })
      : ['(ninguna)']),
    ...(loose.length > 0
      ? [`Fases sin ninguna flecha: ${loose.map((module) => at.get(module.id)).join(', ')}.`]
      : []),
    ...(applied.length > 0 ? ['', `Ya se corrigió (no lo deshagas): ${applied.join('; ')}.`] : []),
    '',
    'El código:',
    source,
  ].join('\n')
}

/** Lee lo que dijo el auditor: sus correcciones (validadas contra el diagrama), o ninguna. `null`: no se entiende. */
export function diagramCorrectionsOf(text: string, diagram: Diagram): DiagramCorrection[] | null {
  const count = diagram.modules.length
  const out: DiagramCorrection[] = []
  const inRange = (n: number) => Number.isInteger(n) && n >= 1 && n <= count
  for (const line of text.split('\n')) {
    const parts = line
      .replace(/^\s*[-*•]\s*/, '')
      .split('|')
      .map((part) => part.trim())
    const head = (parts[0] ?? '').toUpperCase()
    const renombrar = /^RENOMBRAR\s+(\d+)$/.exec(head)
    const unir = /^UNIR\s+(\d+)\s*(?:Y|,|\+)\s*(\d+)$/.exec(head)
    const mover = /^MOVER\s+(\d+)\s+(?:TRAS|DESPU[ÉE]S\s+DE)\s+(\d+)$/.exec(head)
    const forma = /^FORMA\s+(\S+)$/.exec(head)
    if (renombrar) {
      const at = Number(renombrar[1])
      const part = partOf(parts[1] ?? '')
      const now = diagram.modules[at - 1]
      // Lo mismo que ya pone no es una corrección.
      if (part && inRange(at) && now && plain(part.title) !== plain(now.title)) {
        out.push({ kind: 'renombrar', at, part, why: parts[2] ?? '' })
      }
    } else if (unir) {
      const part = partOf(parts[1] ?? '')
      const [a, b] = [Number(unir[1]), Number(unir[2])]
      // Solo fases seguidas: unir dos que están lejos movería código, y eso es otra cosa.
      if (part && inRange(a) && inRange(b) && Math.abs(a - b) === 1) {
        out.push({
          kind: 'unir',
          at: Math.min(a, b),
          with: Math.max(a, b),
          part,
          why: parts[2] ?? '',
        })
      }
    } else if (mover) {
      const [at, after] = [Number(mover[1]), Number(mover[2])]
      if (inRange(at) && (after === 0 || inRange(after)) && at !== after && at !== after + 1) {
        out.push({ kind: 'mover', at, after, why: parts[1] ?? '' })
      }
    } else if (forma) {
      const shape = plain(forma[1] ?? '')
      if (shape in ARCH_SHAPES && shape !== diagram.shape && diagram.shapes.includes(shape)) {
        out.push({ kind: 'forma', shape: shape as ArchShapeId, why: parts[1] ?? '' })
      }
    } else if (/^(?:ARREGLAR|CONECTAR)$/.test(head) && (parts[1] ?? '').length >= 8) {
      out.push({ kind: 'conectar', fix: (parts[1] ?? '').slice(0, 300), why: parts[2] ?? '' })
    }
  }
  // Una sola fase se mueve por vuelta: varias a la vez cambiarían los números de las demás.
  const moved = out.findIndex((one) => one.kind === 'mover')
  const kept = out.filter((one, index) => one.kind !== 'mover' || index === moved)
  if (kept.length > 0) return kept.slice(0, 4)
  return /\bBIEN\b/i.test(text) ? [] : null
}

const plain = (text: string) => text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim()

const SHAPE_NAMES: Record<ArchShapeId, string> = {
  capas: 'por capas',
  tuberia: 'una tubería',
  centro: 'un centro que reparte',
  ciclo: 'un ciclo',
  embudo: 'un embudo',
  abanico: 'un abanico',
}

/** Cómo se dice una corrección, para enseñarla. */
export function diagramCorrectionSaid(correction: DiagramCorrection, diagram: Diagram): string {
  const name = (n: number) => `«${diagram.modules[n - 1]?.title ?? String(n)}»`
  switch (correction.kind) {
    case 'renombrar':
      return `Llamar ${name(correction.at)} «${correction.part.title}: ${correction.part.goal}»`
    case 'unir':
      return `Unir ${name(correction.at)} y ${name(correction.with)} en «${correction.part.title}»`
    case 'mover':
      return correction.after === 0
        ? `Poner ${name(correction.at)} la primera`
        : `Poner ${name(correction.at)} detrás de ${name(correction.after)}`
    case 'forma':
      return `Dibujarlo como ${SHAPE_NAMES[correction.shape]}`
    case 'conectar':
      return correction.fix.replace(/[.]$/, '')
  }
}

/**
 * El JEV decide de cada corrección si hace que el diagrama ayude más a entender el programa, sin cambiar lo
 * que hace. Con correcciones ya hechas en vueltas de antes, además, si esta las deshace o las repite (se
 * estarían dando vueltas). Si no está seguro, no se aplica.
 */
export async function judgeDiagram(
  decider: Decider,
  command: string,
  diagram: Diagram,
  corrections: readonly DiagramCorrection[],
  applied: readonly string[] = [],
): Promise<{ verdicts: ('aplicar' | 'descartar' | 'vuelta')[]; ms: number }> {
  if (corrections.length === 0) return { verdicts: [], ms: 0 }
  const said = corrections.map((correction) => diagramCorrectionSaid(correction, diagram))
  const { answers, ms } = await decider.decide({
    state: {
      orden: command,
      forma: diagram.shape,
      fases: diagram.modules.map(
        (module, index) =>
          `${index + 1}. ${module.title}${module.subtitle ? `: ${module.subtitle}` : ''}`,
      ),
      ...(applied.length > 0 ? { corregido: [...applied] } : {}),
    },
    questions: Object.fromEntries(
      corrections.flatMap((correction, at) => [
        ...(applied.length > 0
          ? [
              [
                `vuelta${at}`,
                {
                  type: 'noul' as const,
                  instructions: `En el diagrama ya se corrigió lo de \`corregido\`. Ahora se propone: «${said[at]}». ¿Eso deshace, contradice o repite alguna de esas correcciones?`,
                  criteria: {
                    true: 'Sí: deshace o contradice algo ya corregido, o lo vuelve a pedir.',
                    false: 'No: es algo nuevo, que no choca con lo ya corregido.',
                  },
                },
              ] as const,
            ]
          : []),
        [
          `diagrama${at}`,
          {
            type: 'noul' as const,
            instructions: `El programa que pide la \`orden\` se enseña como un diagrama (forma \`forma\`, fases \`fases\`). El auditor propone: «${said[at]}» (${correction.why || 'sin decir por qué'}). ¿Con eso el diagrama ayuda más a entender el programa (su forma, los nombres, el orden de sus números o sus flechas), sin cambiar lo que hace?`,
            criteria: {
              true: 'Sí: quien lo mire lo entiende mejor así, y el programa hace lo mismo.',
              false: 'No: ya se entendía igual o mejor, o eso cambiaría lo que hace el programa.',
            },
          },
        ] as const,
      ]),
    ),
  })
  return {
    verdicts: corrections.map((_, at) => {
      const loop = answers[`vuelta${at}`]
      if (loop?.type === 'noul' && loop.noul >= APPLY_THRESHOLD) return 'vuelta'
      const answer = answers[`diagrama${at}`]
      return answer?.type === 'noul' && answer.noul >= APPLY_THRESHOLD ? 'aplicar' : 'descartar'
    }),
    ms,
  }
}

/** Un tramo del archivo: dónde empieza y dónde acaba (sin incluir). */
export interface Span {
  start: number
  end: number
}

/**
 * El programa con una fase movida detrás de otra (`after`, 0: la primera). `blocks` son los tramos de las fases
 * de primer nivel, en orden y seguidos (cada uno, desde su rótulo hasta el rótulo de la siguiente). Lo que hay
 * antes de la primera (las importaciones) se queda donde está.
 */
export function movedSource(
  source: string,
  blocks: readonly Span[],
  at: number,
  after: number,
): string | null {
  if (at < 1 || at > blocks.length || after < 0 || after > blocks.length || at === after)
    return null
  const first = blocks[0]
  const last = blocks[blocks.length - 1]
  if (!first || !last) return null
  const texts = blocks.map((block) => {
    const text = source.slice(block.start, block.end)
    return text.endsWith('\n') ? text : `${text}\n`
  })
  const order = blocks.map((_, index) => index + 1).filter((n) => n !== at)
  order.splice(after === 0 ? 0 : order.indexOf(after) + 1, 0, at)
  // Entre fase y fase, una línea en blanco: es lo que hace que un comentario sea el rótulo de una etapa.
  const body = order.map((n) => texts[n - 1]?.replace(/\n+$/, '\n') ?? '').join('\n')
  return source.slice(0, first.start) + body + source.slice(last.end).replace(/^\n+/, '\n')
}

/**
 * El último diagrama que dijo el lienzo, para quien lo pida con el texto de ahora: si el que hay es de otro
 * texto (el lienzo aún no ha dibujado el último cambio), se espera un rato a que llegue el bueno.
 */
export class DrawnDiagram {
  private last: Diagram | null = null
  private readonly waiting = new Set<() => void>()

  put(diagram: Diagram): void {
    this.last = diagram
    for (const wake of this.waiting) wake()
    this.waiting.clear()
  }

  async of(text: string, patience = 6000): Promise<Diagram | null> {
    const key = textKey(text)
    const until = Date.now() + patience
    while (this.last?.key !== key && Date.now() < until) {
      await new Promise<void>((resolve) => {
        this.waiting.add(resolve)
        setTimeout(resolve, Math.max(0, Math.min(400, until - Date.now())))
      })
    }
    return this.last?.key === key ? this.last : null
  }
}

/**
 * Las funciones de primer nivel que nadie usa: su nombre no sale en ningún otro sitio del programa (ni llamada,
 * ni pasada a otra, como `pantalla.boton("Empezar", empezar)`). Un cambio que solo debía ordenar el diagrama no
 * puede dejar ninguna nueva.
 */
export function unusedFunctions(source: string): string[] {
  const names = [...source.matchAll(/^def\s+([A-Za-z_]\w*)\s*\(/gm)].map((found) => found[1] ?? '')
  return names.filter((name) => {
    const uses = source.match(new RegExp(`\\b${name}\\b`, 'g'))?.length ?? 0
    return uses <= 1
  })
}
