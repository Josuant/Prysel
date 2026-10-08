import type { GistPiece, GistScene } from '@prysel/ui'
import type { Gist } from '../../src/gist/gist.ts'
import { bare, type FoldRule, type Rule } from '../../src/gist/patterns.ts'
import type { Sample } from '../../src/gist/sample.ts'
import { showValue, type Value } from '../../src/gist/value.ts'

/**
 * De lo que se sabe de una función (su muestra ejecutada) a la escena que se dibuja en su tarjeta «Qué
 * hace»: a la izquierda lo que entró, a la derecha lo que salió. Es la plantilla de base, la que vale para
 * cualquier función; no interpreta nada, solo coloca lo que pasó.
 */

/** Lo que entró: sus argumentos (y nada más: el objeto de un método se enseña al otro lado, con su cambio). */
function entering(sample: Sample): GistPiece[] {
  if (sample.inputs.length === 0) return [{ type: 'note', text: 'sin entrada' }]
  return sample.inputs.map((input) => ({ type: 'datum', label: input.name, value: input.value }))
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

/** La escena de una función con muestra; `null` si no la tiene (entonces se ve su diagrama, como siempre). */
export function sampleScene(gist: Gist): GistScene | null {
  if (gist.status !== 'ok' || !gist.sample) return null
  return {
    name: gist.owner ? `${gist.owner}.${gist.name}` : gist.name,
    ...(gist.title ? { title: gist.title } : {}),
    ...(gist.sample.invented ? { example: true } : {}),
    // Con regla, en medio va lo que la función hace con cada cosa: es su explicación.
    ...(gist.rule
      ? ruleScene(gist.sample, gist.rule)
      : { lanes: [entering(gist.sample), leaving(gist.sample)] }),
  }
}
