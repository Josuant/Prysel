import { describe, expect, it } from 'vitest'
import { holdShape, sameHeld, type Held } from '../webview/src/holding.ts'

/**
 * La forma de la arquitectura mientras se construye se decide **una sola vez**: mientras llega el plan, filas;
 * con el plan entero (y lo que diga el JEV), se elige; y esa es hasta acabar, aunque el grafo de módulos siga
 * cambiando al pasar cada parte de lo planeado a lo escrito.
 */

type Judged = Parameters<typeof holdShape>[0]['judged']

/** Una construcción con plan, contada paso a paso: en cada uno, qué forma tendría el grafo por sí solo. */
function building(steps: readonly { judged: Judged; decidable: boolean; gone?: string[] }[]) {
  let held: Held | null = null
  return steps.map((step) => {
    held = holdShape({
      constructing: true,
      planning: true,
      decidable: step.decidable,
      held,
      judged: step.judged,
      alive: (title) => !(step.gone ?? []).includes(title),
    })
    return held ? `${held.shape}${held.anchor ? `:${held.anchor}` : ''}` : null
  })
}

describe('la forma, mientras se construye con un plan', () => {
  it('no baila: filas mientras llega el plan, y luego una sola forma hasta el final', () => {
    // Lo que pasó de verdad construyendo «Un algoritmo genético»: embudo, ciclo, centro y otra vez ciclo.
    const seen = building([
      { judged: { shape: 'embudo', anchor: 'Evaluar' }, decidable: false },
      { judged: { shape: 'ciclo', anchor: 'Bucle' }, decidable: false },
      // El plan ya está entero y el JEV ha dicho: ciclo.
      { judged: { shape: 'ciclo', anchor: 'Bucle' }, decidable: true },
      // Llega el código, y el grafo cambia: ya no se le hace caso.
      { judged: { shape: 'centro', anchor: 'Bucle' }, decidable: true },
      { judged: { shape: 'capas', anchor: null }, decidable: true },
      { judged: { shape: 'ciclo', anchor: 'Bucle' }, decidable: true },
    ])
    expect(seen).toEqual([
      'capas',
      'capas',
      'ciclo:Bucle',
      'ciclo:Bucle',
      'ciclo:Bucle',
      'ciclo:Bucle',
    ])
    // Una sola vez cambia de forma.
    expect(seen.filter((shape, at) => at > 0 && shape !== seen[at - 1]).length).toBe(1)
  })

  it('si lo que se decide es «en filas», también se queda', () => {
    const seen = building([
      { judged: { shape: 'capas', anchor: null }, decidable: true },
      { judged: { shape: 'embudo', anchor: 'Juntar' }, decidable: true },
    ])
    expect(seen).toEqual(['capas', 'capas'])
  })

  it('si el módulo de referencia desaparece (se rehízo esa parte), se vuelve a elegir', () => {
    const seen = building([
      { judged: { shape: 'ciclo', anchor: 'Bucle' }, decidable: true },
      { judged: { shape: 'centro', anchor: 'Menú' }, decidable: true, gone: ['Bucle'] },
      { judged: { shape: 'capas', anchor: null }, decidable: true },
    ])
    expect(seen).toEqual(['ciclo:Bucle', 'centro:Menú', 'centro:Menú'])
  })
})

describe('la forma, sin plan o sin construir', () => {
  const alive = () => true
  it('al acabar de construir no se mantiene nada: manda lo que el programa sea', () => {
    const held: Held = { shape: 'ciclo', anchor: 'Bucle', final: true }
    const now = { planning: true, decidable: true, held, alive }
    const judged = { shape: 'centro' as const, anchor: 'Menú' }
    expect(holdShape({ ...now, constructing: false, judged })).toBeNull()
  })

  it('sin plan, como siempre: la forma que haya, y si se cae a filas, la última que hubo', () => {
    const base = { constructing: true, planning: false, decidable: false, alive }
    const first = holdShape({ ...base, held: null, judged: { shape: 'centro', anchor: 'Menú' } })
    expect(first).toEqual({ shape: 'centro', anchor: 'Menú', final: false })
    const fallen = holdShape({ ...base, held: first, judged: { shape: 'capas', anchor: null } })
    expect(fallen).toEqual(first)
    // …y si luego hay otra de verdad, esa (sin plan no hay una decisión que guardar).
    const other = holdShape({ ...base, held: fallen, judged: { shape: 'ciclo', anchor: 'Bucle' } })
    expect(other).toMatchObject({ shape: 'ciclo', anchor: 'Bucle' })
  })

  it('dos veces lo mismo es lo mismo', () => {
    const one: Held = { shape: 'ciclo', anchor: 'Bucle', final: true }
    expect(sameHeld(one, { ...one })).toBe(true)
    expect(sameHeld(one, { ...one, final: false })).toBe(false)
    expect(sameHeld(null, null)).toBe(true)
    expect(sameHeld(one, null)).toBe(false)
  })
})
