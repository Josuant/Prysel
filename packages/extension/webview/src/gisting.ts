import type { GistPiece, GistScene, GistStrip, LapCell, NetRow } from '@prysel/ui'
import type { Gist } from '../../src/gist/gist.ts'
import type { Mechanism } from '../../src/gist/mechanisms.ts'
import { bare, type FoldRule, type Rule } from '../../src/gist/patterns.ts'
import type { Sample } from '../../src/gist/sample.ts'
import type { Laps } from '../../src/gist/laps.ts'
import type { Net, NetPart } from '../../src/gist/net.ts'
import { showValue, type Value } from '../../src/gist/value.ts'

/**
 * De lo que se sabe de una función (su muestra ejecutada) a la escena que se dibuja en su tarjeta «Qué
 * hace»: a la izquierda lo que entró, a la derecha lo que salió. Es la plantilla de base, la que vale para
 * cualquier función; no interpreta nada, solo coloca lo que pasó.
 */

/** Cuántas cosas que lee del programa se enseñan junto a lo que recibe. */
const MAX_READS_SHOWN = 2

/**
 * Lo que entró: sus argumentos (y nada más: el objeto de un método se enseña al otro lado, con su cambio) y,
 * marcado, lo que usa sin recibirlo (un objetivo, un tamaño que lee del programa): sin ello no se entiende
 * por qué da lo que da. `skip`: lo que ya se enseña en otra parte de la tarjeta.
 */
function entering(sample: Sample, skip: readonly string[] = []): GistPiece[] {
  const reads = (sample.reads ?? [])
    .filter((read) => !skip.includes(read.name))
    .slice(0, MAX_READS_SHOWN)
    .map((read): GistPiece => ({
      type: 'datum',
      label: read.name,
      value: read.value,
      hidden: true,
    }))
  const inputs = sample.inputs
    .filter((input) => !skip.includes(input.name))
    .map((input): GistPiece => ({ type: 'datum', label: input.name, value: input.value }))
  if (inputs.length + reads.length === 0)
    return skip.length > 0 ? [] : [{ type: 'note', text: 'sin entrada' }]
  return [...inputs, ...reads]
}

/**
 * El azar, dicho: si con las mismas entradas otras veces dio otra cosa, esas otras veces (es la prueba); si
 * solo se sabe que su código lo usa, que lo usa.
 */
function chance(sample: Sample): GistPiece[] {
  if (sample.rolls && sample.rolls.length > 0)
    return [
      {
        type: 'strips',
        label: sample.chance
          ? 'al azar · con lo mismo, otras veces dio'
          : 'con lo mismo, otras veces dio',
        strips: sample.rolls.map((roll) => ({ name: '', cells: [{ text: showValue(roll) }] })),
      },
    ]
  return sample.chance ? [{ type: 'note', text: 'usa el azar: es una de las veces posibles' }] : []
}

const isMechanism = (rule: Rule): rule is Mechanism =>
  rule.kind === 'mix' || rule.kind === 'match' || rule.kind === 'podium' || rule.kind === 'build'

/** Cuántos candidatos de un podio se enseñan: los elegidos y los que les siguen. */
const MAX_PODIUM = 7

/**
 * La escena de una función con **mecanismo**: lo que no entra en él → sus tiras (de dónde viene cada cosa, qué
 * coincide, quién gana, cómo crece) → lo demás que deja. Todo es de la muestra.
 */
function mechanismScene(sample: Sample, rule: Mechanism): Pick<GistScene, 'lanes'> {
  let strips: GistPiece
  let shown: string[]
  // Lo que devuelve ya se ve en las tiras de una mezcla, de una comparación o de una lista que crece.
  let told = true
  if (rule.kind === 'mix') {
    shown = [rule.a.name, rule.b.name]
    const fresh = rule.from.filter((origin) => origin === 'new').length
    strips = {
      type: 'strips',
      label: 'mezcla',
      strips: [
        { name: rule.a.name, cells: rule.a.cells.map((text) => ({ text, tone: 'a' as const })) },
        { name: rule.b.name, cells: rule.b.cells.map((text) => ({ text, tone: 'b' as const })) },
        {
          name: 'devuelve',
          cells: rule.out.map((text, at) => ({ text, tone: rule.from[at] ?? ('both' as const) })),
        },
      ],
      ...(fresh > 0
        ? {
            foot: `${fresh} ${fresh === 1 ? 'no viene' : 'no vienen'} de ninguno: ${fresh === 1 ? 'es nuevo' : 'son nuevos'}`,
          }
        : {}),
    }
  } else if (rule.kind === 'match') {
    shown = [rule.input, rule.target.name]
    const tone = (at: number) => (rule.hits[at] ? ('hit' as const) : ('miss' as const))
    const same = rule.hits.filter(Boolean).length
    strips = {
      type: 'strips',
      label: 'compara, posición a posición',
      strips: [
        { name: rule.input, cells: rule.cells.map((text, at) => ({ text, tone: tone(at) })) },
        {
          name: rule.target.name,
          ...(rule.target.hidden ? { hidden: true } : {}),
          cells: rule.target.cells.map((text, at) => ({ text, tone: tone(at) })),
        },
      ],
      gauge:
        rule.counts === 'same'
          ? { value: same, of: rule.hits.length, says: 'coinciden' }
          : { value: rule.hits.length - same, of: rule.hits.length, says: 'no coinciden' },
    }
  } else if (rule.kind === 'podium') {
    shown = rule.scores ? [rule.input, rule.scores] : [rule.input]
    told = false
    const better = (x: number, y: number) => (rule.order === 'max' ? y - x : x - y)
    // Como un podio: primero los elegidos, por su puesto; luego los demás, del mejor al peor.
    const ordered = [...rule.ranked].sort((x, y) =>
      x.place !== null && y.place !== null
        ? x.place - y.place
        : x.place !== null
          ? -1
          : y.place !== null
            ? 1
            : better(Number(x.score), Number(y.score)),
    )
    const rows = ordered.slice(0, MAX_PODIUM)
    const left = ordered.length - rows.length
    const winners = rule.ranked.filter((entry) => entry.place !== null).length
    strips = {
      type: 'strips',
      label: `${winners === 1 ? 'el' : `los ${winners}`} de ${rule.order === 'max' ? 'mayor' : 'menor'} ${rule.scores ?? 'valor'}`,
      strips: rows.map((entry): GistStrip => ({
        name: '',
        place: entry.place ?? 0,
        cells: [{ text: entry.text, ...(entry.place !== null ? { tone: 'hit' as const } : {}) }],
        note: entry.score,
      })),
      ...(left > 0 ? { foot: `… y ${left} más, por debajo` } : {}),
    }
  } else {
    shown = []
    // Elementos cortos, se leen en su celda; largos, la celda solo cuenta y lo que entra se dice al lado.
    const short = rule.steps.every((step) => step.every((cell) => cell.length <= 3))
    const rows: GistStrip[] = rule.steps.map((step, at) => {
      const before = rule.steps[at - 1]?.length ?? 0
      const added = step.slice(before)
      return {
        name: `${at === rule.steps.length - 1 && rule.skipped > 0 ? '…' : ''}${step.length}`,
        cells: step.map((text, k) => ({
          text: short ? text : '',
          ...(k >= before && at > 0 ? { tone: 'new' as const } : {}),
        })),
        ...(short || added.length === 0 || at === 0
          ? {}
          : { note: `+ ${added[added.length - 1] ?? ''}` }),
      }
    })
    strips = {
      type: 'strips',
      label: `${rule.input} se va llenando`,
      strips: rows,
      ...(rule.skipped > 0 ? { foot: `… ${rule.skipped} pasos más entre medias` } : {}),
    }
  }
  const before = entering(sample, shown)
  const after = leaving(sample).filter(
    (piece) => !(told && piece.type === 'datum' && piece.label === 'devuelve'),
  )
  const rest = after.length === 1 && after[0]?.type === 'note' ? [] : after
  return {
    lanes: [...(before.length > 0 ? [before] : []), [strips], ...(rest.length > 0 ? [rest] : [])],
  }
}

/** Lo que salió: lo que devolvió, lo que imprimió, lo que dejó cambiado, o el error con el que acabó. */
function leaving(sample: Sample): GistPiece[] {
  const pieces: GistPiece[] = []
  if (sample.error !== undefined) pieces.push({ type: 'error', text: sample.error })
  if (sample.returned !== undefined)
    pieces.push({ type: 'datum', label: 'devuelve', value: sample.returned })
  for (const change of sample.changed ?? [])
    pieces.push({
      type: 'datum',
      label: `${change.name} queda`,
      value: change.after,
      changed: true,
    })
  if (sample.self) {
    const { before, after, cls } = sample.self
    const rows = Object.entries(after).map(([name, value]) => {
      const was = before[name]
      const changed = was === undefined || showValue(was) !== showValue(value)
      return {
        name,
        after: value,
        changed,
        ...(was !== undefined && changed ? { before: was } : {}),
      }
    })
    // Un objeto que no cambió solo se enseña si no hay otra cosa que enseñar.
    if (rows.some((row) => row.changed) || pieces.length === 0)
      if (rows.length > 0) pieces.push({ type: 'state', cls, rows })
  }
  if (sample.printed !== undefined) pieces.push({ type: 'console', text: sample.printed })
  if (pieces.length === 0) pieces.push({ type: 'note', text: 'no deja nada' })
  return pieces
}

/** Un literal como se enseña: sin comillas, y un espacio, visible. */
const seen = (literal: string) => {
  const text = bare(literal)
  return text === '' ? '""' : text.replace(/ /g, '␣')
}

/** Con más pasos que estos, el recorrido no se cuenta: sería un parpadeo, no una explicación. */
const MAX_BEATS = 96

/** Cuántos valores sueltos lleva un valor (una rejilla, celda a celda). */
const count = (value: Value): number =>
  value.kind === 'list' ? value.items.reduce((sum, item) => sum + count(item), 0) : 1

const FOLDS: Record<FoldRule['op'], { label: string; symbol: string }> = {
  sum: { label: 'suma', symbol: 'Σ' },
  count: { label: 'cuenta', symbol: '#' },
  'count-if': { label: 'cuenta si', symbol: '#' },
  max: { label: 'el mayor', symbol: '↑' },
  min: { label: 'el menor', symbol: '↓' },
}

/**
 * La escena de una función con regla: lo que entró → la regla → lo que salió, y el **recorrido** que las
 * une (qué le pasa a cada elemento, en orden). Todo sale de la muestra: no se anima nada que no pasara.
 */
function ruleScene(sample: Sample, rule: Rule): Pick<GistScene, 'lanes' | 'beats'> {
  if (isMechanism(rule)) return mechanismScene(sample, rule)
  const steps =
    rule.kind === 'cases'
      ? rule.via.length
      : rule.kind === 'filter'
        ? rule.keeps.length
        : rule.running.length
  const tour = steps > 1 && steps <= MAX_BEATS
  const each = Array.from({ length: steps }, (_, at) => at)
  // Lo que entra: el dato al que se aplica la regla recorre sus elementos; lo que no cuenta se apaga.
  const out = rule.kind === 'filter' ? rule.keeps : rule.kind === 'fold' ? rule.counts : null
  const fades = out && rule.kind !== 'fold' ? out.map((kept) => !kept) : null
  const dims =
    rule.kind === 'fold' && rule.op !== 'sum' && rule.op !== 'count'
      ? rule.counts.map((c) => !c)
      : fades
  const inputs = entering(sample).map((piece): GistPiece =>
    tour && piece.type === 'datum' && piece.label === rule.input
      ? { ...piece, beats: each, ...(dims ? { fades: dims } : {}) }
      : piece,
  )
  // La regla, en medio.
  let middle: GistPiece
  if (rule.kind === 'cases')
    middle = {
      type: 'rule',
      label: rule.spoken
        ? 'cada elemento, según'
        : rule.each
          ? `cada ${rule.subject}`
          : rule.subject,
      cases: rule.cases.map((entry) => ({
        // Un camino («esta_viva y no debe_nacer») se enseña tal cual; un valor, sin sus comillas.
        when: entry.when === null ? 'otro' : rule.spoken ? entry.when : seen(entry.when),
        gives: seen(entry.gives),
      })),
      ...(tour ? { via: rule.via } : {}),
    }
  else if (rule.kind === 'filter')
    middle = {
      type: 'test',
      label: 'se queda si',
      text: rule.condition ?? 'cumple la condición',
      ...(tour ? { verdicts: rule.keeps } : {}),
    }
  else
    middle = {
      type: 'fold',
      label: `${FOLDS[rule.op].label}${rule.condition ? ` ${rule.condition}` : ''}`,
      symbol: FOLDS[rule.op].symbol,
      ...(tour ? { running: rule.running } : {}),
    }
  // Lo que sale: cada resultado aparece cuando le toca al elemento del que viene.
  const kept = rule.kind === 'filter' ? each.filter((at) => rule.keeps[at]) : null
  const outputs = leaving(sample).map((piece): GistPiece => {
    if (!tour) return piece
    if (piece.type === 'console' && rule.kind === 'cases')
      return piece.text.replace(/\n/g, '').length === steps ? { ...piece, beats: true } : piece
    if (piece.type !== 'datum') return piece
    const size = count(piece.value)
    if (rule.kind === 'cases' && size === steps) return { ...piece, beats: each, arrives: true }
    if (kept && size === kept.length) return { ...piece, beats: kept, arrives: true }
    if (rule.kind === 'fold' && size === 1) return { ...piece, beats: [steps - 1], arrives: true }
    return piece
  })
  return { lanes: [inputs, [middle], outputs], ...(tour ? { beats: steps } : {}) }
}

/**
 * La cabecera de un bloque, dicha con palabras: `for x in xs` → «Para cada x de xs», `while c` → «Mientras
 * c», `if c` → «¿c?». Es lo que se lee cuando el programa no le da otro nombre (una etapa, un comentario).
 */
export function spokenHead(head: string): string {
  const text = head.trim().replace(/:$/, '')
  const each = /^(?:async\s+)?for\s+(.+?)\s+in\s+(.+)$/.exec(text)
  if (each) return `Para cada ${each[1] ?? ''} de ${each[2] ?? ''}`
  if (/^while\s+True$/.test(text)) return 'Repetir hasta salir'
  const until = /^while\s+(.+)$/.exec(text)
  if (until) return `Mientras ${until[1] ?? ''}`
  const whether = /^if\s+(.+)$/.exec(text)
  if (whether) return `¿${whether[1] ?? ''}?`
  if (/^try\b/.test(text))
    return text.replace(/^try\s*·?\s*/, '') === ''
      ? 'Intentarlo'
      : `Intentarlo · ${text.replace(/^try\s*·\s*/, '')}`
  return text
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`

/** Por qué acabó un bucle, dicho para quien lo lee. */
function endOf(laps: Laps, head: string): string {
  const total = plural(laps.total, 'vuelta', 'vueltas')
  if (laps.ended === 'break') return `Salió con break en la vuelta ${laps.total}.`
  if (laps.ended === 'return')
    return `Devolvió algo en la vuelta ${laps.total} y salió de la función.`
  if (laps.ended === 'error') return `Falló en la vuelta ${laps.total}: ${laps.error ?? 'error'}`
  if (laps.ended === 'cut') return `${total}… y aquí se quedó: no acabó en esta ejecución.`
  const test = /^while\s+(.+)$/.exec(head)?.[1]
  return test
    ? `${total}; luego «${test}» dejó de cumplirse.`
    : `${total}; no quedaban más elementos.`
}

/** Una lista corta de valores sueltos se dibuja como celdas: así se ve qué posiciones cambiaron. */
const short = (value: Value): string[] | null =>
  value.kind === 'list' &&
  !value.more &&
  value.items.length <= 10 &&
  value.items.every((item) => item.kind === 'atom')
    ? value.items.map((item) => showValue(item))
    : null

/** Una celda de una tabla que se llena fila a fila: el valor, o sus elementos con los que cambiaron. */
function cell(value: Value, was: Value | undefined): LapCell {
  const items = short(value)
  if (!items) return showValue(value)
  const before = was ? short(was) : null
  return {
    items,
    changed: items.map(
      (item, at) => before !== null && before.length === items.length && before[at] !== item,
    ),
  }
}

/**
 * La escena de un bucle: sus vueltas, una a una, como una tabla que se llena. Lo que toma la cabecera en cada
 * vuelta, cómo van quedando las variables que lleva, lo que imprime, y por qué acaba.
 */
export function loopScene(gist: Gist): GistScene | null {
  const laps = gist.laps
  if (gist.status !== 'ok' || !laps || laps.laps.length === 0) return null
  const takes = laps.laps[0]?.takes.map((take) => take.name) ?? []
  const carried = laps.laps[0]?.leaves.map((leave) => leave.name) ?? []
  const prints = laps.laps.some((lap) => lap.printed)
  const columns = [...takes, ...carried, ...(prints ? ['imprime'] : [])]
  const start =
    laps.carried.length > 0
      ? [
          ...takes.map(() => ''),
          ...carried.map((name): LapCell => {
            const was = laps.carried.find((c) => c.name === name)
            return was ? cell(was.value, undefined) : '—'
          }),
          ...(prints ? [''] : []),
        ]
      : undefined
  const previous = (k: number, name: string): Value | undefined =>
    k === 0
      ? laps.carried.find((c) => c.name === name)?.value
      : laps.laps[k - 1]?.leaves.find((leave) => leave.name === name)?.value
  const rows = laps.laps.map((lap, k) => ({
    cells: [
      ...lap.takes.map((take): LapCell => showValue(take.value)),
      ...lap.leaves.map((leave) => cell(leave.value, previous(k, leave.name))),
      ...(prints ? [lap.printed ?? ''] : []),
    ],
    changed: [
      ...lap.takes.map(() => false),
      ...lap.leaves.map((leave) => leave.changed),
      ...(prints ? [Boolean(lap.printed)] : []),
    ],
    ...(lap.exit ? { exit: lap.exit } : {}),
  }))
  return {
    name: spokenHead(gist.name),
    code: gist.name,
    block: 'loop',
    title:
      carried.length > 0
        ? `Repite ${plural(laps.total, 'vez', 'veces')}, llevando ${carried.join(', ')}`
        : `Repite ${plural(laps.total, 'vez', 'veces')}`,
    beats: rows.length,
    stepMs: 650,
    lanes: [
      [
        {
          type: 'laps',
          label: 'vuelta a vuelta',
          columns,
          takes: takes.length,
          ...(start ? { start } : {}),
          rows,
          ...(laps.skipped ? { skipped: laps.skipped } : {}),
          end: endOf(laps, gist.name),
        },
      ],
    ],
  }
}

/**
 * La escena de una clase: la vida de uno de sus objetos, como una tabla que se llena llamada a llamada. Cómo se
 * llamó cada método, cómo quedaron los campos del objeto (lo que cambió se enciende) y qué devolvió.
 */
export function classScene(gist: Gist): GistScene | null {
  const life = gist.life
  if (gist.status !== 'ok' || !life || life.visits.length === 0) return null
  const returns = life.visits.some((visit) => visit.returned || visit.error)
  const methods = new Set(life.visits.map((visit) => visit.method).filter((m) => m !== '__init__'))
  const rows = life.visits.map((visit, k) => ({
    cells: [
      visit.call,
      ...visit.fields.map((value, at): LapCell => {
        if (!value) return '—'
        return cell(value, k > 0 ? life.visits[k - 1]?.fields[at] : undefined)
      }),
      ...(returns
        ? [visit.error ? `✗ ${visit.error}` : visit.returned ? showValue(visit.returned) : '']
        : []),
    ],
    changed: [
      false,
      ...visit.changed,
      ...(returns ? [Boolean(visit.returned || visit.error)] : []),
    ],
  }))
  const others = life.objects - 1
  return {
    name: life.cls,
    block: 'class',
    title: `El plano de ${life.cls}: ${plural(methods.size, 'método', 'métodos')} en uso, ${plural(life.total, 'llamada', 'llamadas')}`,
    beats: rows.length,
    stepMs: 700,
    lanes: [
      [
        {
          type: 'laps',
          label: 'la vida de un objeto, llamada a llamada',
          columns: ['llamada', ...life.fields, ...(returns ? ['devuelve'] : [])],
          takes: 1,
          counter: '#',
          rows,
          ...(life.skipped ? { skipped: life.skipped } : {}),
          end:
            others > 0
              ? `${plural(life.objects, `objeto ${life.cls}`, `objetos ${life.cls}`)}: este es el que más se usó.`
              : `Un objeto ${life.cls}, de principio a fin.`,
        },
      ],
    ],
  }
}

/** Cómo se nombra cada brazo de un `if` en la tarjeta. */
const armPart = (kind: 'if' | 'elif' | 'else') =>
  kind === 'if' ? 'si' : kind === 'elif' ? 'si no, si' : 'si no'

/**
 * La escena de un `if`: las agujas del tren. Una fila por brazo; en cada visita, las condiciones con los valores
 * de ese momento, lo que dieron y por dónde siguió; y cuántas veces fue por cada brazo.
 */
export function conditionScene(gist: Gist): GistScene | null {
  const result = gist.branches
  if (gist.status !== 'ok' || !result || result.visits.length === 0) return null
  const counted = [
    ...result.arms.flatMap((arm, k) =>
      (result.totals[k] ?? 0) > 0 ? [`${result.totals[k]} por «${armPart(arm.kind)}»`] : [],
    ),
    ...(result.none > 0 ? [`${result.none} de largo`] : []),
  ]
  const used = result.totals.filter((count) => count > 0).length + (result.none > 0 ? 1 : 0)
  const title =
    result.total === 1
      ? 'Comprueba y elige un camino'
      : used === 1
        ? `Pasó ${plural(result.total, 'vez', 'veces')}, siempre por el mismo camino`
        : `Pasó ${plural(result.total, 'vez', 'veces')} y repartió por ${used} caminos`
  return {
    name: spokenHead(gist.name),
    code: gist.name,
    block: 'condition',
    title,
    beats: result.visits.length,
    stepMs: 800,
    lanes: [
      [
        {
          type: 'switch',
          label:
            result.total > result.visits.length
              ? `las primeras ${result.visits.length} veces`
              : 'cada vez',
          arms: result.arms.map((arm) => ({ part: armPart(arm.kind), head: arm.head })),
          visits: result.visits,
          totals: result.totals,
          none: result.none,
          end: `${plural(result.total, 'vez', 'veces')}: ${counted.join(', ')}.`,
        },
      ],
    ],
  }
}

/** Lo que se cuenta debajo de una parte de un `try`: la línea que falló, o lo que hizo. */
function netDetail(part: NetPart): string | undefined {
  if (part.state === 'raised') return part.at ? `falla en: ${part.at}` : undefined
  if (part.state === 'skipped') return undefined
  const did = [
    ...(part.leaves ?? []).map((leave) => `${leave.name} = ${showValue(leave.value)}`),
    ...(part.printed ? [`imprime ${JSON.stringify(part.printed.replace(/\n+$/, ''))}`] : []),
  ]
  return did.length > 0 ? did.join(' · ') : undefined
}

/** Cómo acabaron todas las veces que se entró en el `try`, dicho en una frase. */
function tallyOf(net: Net): string {
  const { ok, caught, escaped } = net.tally
  const total = ok + caught + escaped
  if (total <= 1) {
    if (net.outcome === 'caught') return 'Saltó un error y la red lo atrapó: el programa siguió.'
    if (net.outcome === 'escaped')
      return 'Saltó un error y ninguna red lo atrapó: siguió hacia fuera.'
    if (net.outcome === 'cut') return 'La ejecución se cortó aquí dentro.'
    return 'No saltó ningún error: la red no hizo falta.'
  }
  const parts = [
    ok > 0 ? plural(ok, 'sin errores', 'sin errores') : null,
    caught > 0 ? `${plural(caught, 'cayó', 'cayeron')} en la red` : null,
    escaped > 0 ? `${plural(escaped, 'se escapó', 'se escaparon')}` : null,
  ].filter(Boolean)
  return `De ${total} veces: ${parts.join(', ')}.`
}

/**
 * La escena de un `try`: la red de seguridad. Lo que se intenta y cada cláusula, en orden; si saltó un error,
 * cae desde la línea que lo lanzó hasta el `except` que lo atrapa (o se escapa), y lo que hizo cada parte.
 */
export function tryScene(gist: Gist): GistScene | null {
  const net = gist.net
  if (gist.status !== 'ok' || !net) return null
  const rows: NetRow[] = net.parts.map((part) => {
    const detail = netDetail(part)
    return { part: part.kind, head: part.head, state: part.state, ...(detail ? { detail } : {}) }
  })
  const caughtAt = net.parts.findIndex((part) => part.state === 'caught')
  const title =
    net.outcome === 'caught'
      ? 'Si algo falla, lo atrapa y sigue'
      : net.outcome === 'escaped'
        ? 'Falló y la red no lo atrapó'
        : 'Lo intenta: si fallara, tiene una red'
  return {
    name: spokenHead(gist.name),
    code: gist.name,
    block: 'try',
    title,
    beats: rows.length,
    stepMs: 750,
    lanes: [
      [
        {
          type: 'net',
          label: 'qué pasó',
          rows,
          ...(net.error ? { fall: { error: net.error, to: caughtAt >= 0 ? caughtAt : null } } : {}),
          end: tallyOf(net),
        },
      ],
    ],
  }
}

/** La escena de una función con muestra; `null` si no la tiene (entonces se ve su diagrama, como siempre). */
/**
 * Una función que no recibe nada y solo escribe en pantalla (un menú, un «mostrar») no gana nada con una
 * tarjeta: enseñaría un trozo de la misma sesión que ya está entera en «Al ejecutarlo». Su historia se
 * cuenta allí (y pinchando sus líneas se llega a ella).
 */
export function onlyTalks(sample: Sample): boolean {
  return (
    sample.inputs.length === 0 &&
    sample.returned === undefined &&
    sample.error === undefined &&
    (sample.changed ?? []).length === 0 &&
    sample.self === undefined
  )
}

export function sampleScene(gist: Gist): GistScene | null {
  if (gist.block === 'loop') return loopScene(gist)
  if (gist.block === 'try') return tryScene(gist)
  if (gist.block === 'class') return classScene(gist)
  if (gist.block === 'condition') return conditionScene(gist)
  if (gist.status !== 'ok' || !gist.sample) return null
  if (onlyTalks(gist.sample)) return null
  // Con regla, en medio va lo que la función hace con cada cosa: es su explicación.
  const scene = gist.rule
    ? ruleScene(gist.sample, gist.rule)
    : { lanes: [entering(gist.sample), leaving(gist.sample)] }
  const dice = chance(gist.sample)
  const last = scene.lanes[scene.lanes.length - 1] ?? []
  return {
    name: gist.owner ? `${gist.owner}.${gist.name}` : gist.name,
    ...(gist.title ? { title: gist.title } : {}),
    ...(gist.sample.invented ? { example: true } : {}),
    ...(gist.sample.tried ? { mine: true } : {}),
    // Una función suelta que recibe algo se puede probar con otros datos (un método necesita su objeto).
    ...(gist.owner === null && (gist.sample.inputs.length > 0 || gist.sample.tried)
      ? { editable: true }
      : {}),
    ...(gist.unused ? { unused: true } : {}),
    ...scene,
    // El azar se dice al final de lo que sale: es parte de por qué salió eso.
    lanes: dice.length > 0 ? [...scene.lanes.slice(0, -1), [...last, ...dice]] : scene.lanes,
  }
}
