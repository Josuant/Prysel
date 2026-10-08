import type { GistPiece, GistScene } from '@prysel/ui'
import type { Gist } from '../../src/gist/gist.ts'
import { bare, type Rule } from '../../src/gist/patterns.ts'
import type { Sample } from '../../src/gist/sample.ts'
import { showValue } from '../../src/gist/value.ts'

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

/** La regla, como pieza: `1 → *`, `otro → .`. Los textos van sin comillas; un espacio se enseña. */
function ruleOf(rule: Rule): GistPiece {
  const seen = (literal: string) => {
    const text = bare(literal)
    return text === '' ? '""' : text.replace(/ /g, '␣')
  }
  return {
    type: 'rule',
    label: rule.each ? `cada ${rule.subject}` : rule.subject,
    cases: rule.cases.map((entry) => ({
      when: entry.when === null ? 'otro' : seen(entry.when),
      gives: seen(entry.gives),
    })),
  }
}

/** La escena de una función con muestra; `null` si no la tiene (entonces se ve su diagrama, como siempre). */
export function sampleScene(gist: Gist): GistScene | null {
  if (gist.status !== 'ok' || !gist.sample) return null
  return {
    name: gist.owner ? `${gist.owner}.${gist.name}` : gist.name,
    ...(gist.title ? { title: gist.title } : {}),
    ...(gist.sample.invented ? { example: true } : {}),
    lanes: [
      entering(gist.sample),
      // Con regla, en medio va lo que la función hace con cada cosa: es su explicación.
      ...(gist.rule ? [[ruleOf(gist.rule)]] : []),
      leaving(gist.sample),
    ],
  }
}
