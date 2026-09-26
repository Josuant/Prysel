import { NODE_KINDS, getKind, type Density, type NodeState } from '@prysel/morphology'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Control, MorphNode, STATE_META, matchesKind, type ControlModel } from '../src/index.ts'

const DENSITIES: Density[] = ['compact', 'normal', 'expanded']
const STATES: NodeState[] = ['dormant', 'running', 'success', 'warning', 'error', 'selected']

const count = (html: string, needle: string) => html.split(needle).length - 1

/** Un modelo de ejemplo por cada editor, para poder renderizar todos los tipos. */
export const SAMPLE_CONTROLS: Record<string, ControlModel> = {
  text: { kind: 'text', value: 'hola' },
  number: { kind: 'number', value: 5, min: 0, max: 10 },
  boolean: { kind: 'boolean', value: true },
  constant: { kind: 'constant', value: 'None', options: ['None', '0'] },
  list: { kind: 'list', items: ['1', '2'] },
  dict: { kind: 'dict', entries: [['a', '1']] },
  table: { kind: 'table', columns: ['a', 'b'], rows: [['1', '2']] },
  args: { kind: 'args', target: 'f', args: [{ name: 'x', value: '1' }] },
  expression: { kind: 'expression', left: 'a', operator: '+', right: 'b', operators: ['+', '-'] },
  condition: {
    kind: 'condition',
    field: 'x',
    operator: '>',
    value: '3',
    operators: ['>', '<'],
    hits: [1, 2],
  },
  loop: { kind: 'loop', iterable: 'xs', variable: 'x', current: 1, total: 3 },
  with: { kind: 'with', context: 'open("a")', name: 'f' },
  handler: { kind: 'handler', type: 'ValueError', name: 'e' },
  match: { kind: 'match', subject: 'orden' },
  case: { kind: 'case', pattern: '"ir" | "vamos"', guard: 'listo' },
  class: { kind: 'class', bases: 'Animal', params: ['nombre'] },
  signal: { kind: 'signal', errorType: 'ValueError', types: ['ValueError'], message: 'mal' },
  io: { kind: 'io', target: 'a.csv', mode: 'r', modes: ['r', 'w'] },
  stats: {
    kind: 'stats',
    metric: 'filas',
    value: '91',
    deltaPct: 12,
    range: '7d',
    ranges: ['7d', '30d'],
    series: [1, 3, 2, 5],
    rows: [{ label: 'total', value: '91' }],
  },
  module: { kind: 'module', module: 'pandas', alias: 'pd' },
  signature: { kind: 'signature', params: [{ name: 'path', value: '"a.csv"' }] },
  query: {
    kind: 'query',
    field: 'amount',
    operator: '>',
    value: '1000',
    operators: ['>'],
    hash: 'a3f9',
  },
  code: { kind: 'code', source: 'match x:\n  case 1: ...' },
}

const controlFor = (id: string): ControlModel | undefined => SAMPLE_CONTROLS[id]

describe('MorphNode', () => {
  it.each(NODE_KINDS.map((k) => k.id))('%s se renderiza en toda densidad y estado', (id) => {
    const control = controlFor(getKind(id).control)
    for (const density of DENSITIES) {
      for (const state of STATES) {
        const html = renderToStaticMarkup(
          <MorphNode
            kind={id}
            label="nombre"
            code="x = 1"
            meta="meta"
            density={density}
            state={state}
            control={control}
          />,
        )
        expect(html).toContain(`data-kind="${id}"`)
        expect(html).toContain(`data-state="${state}"`)
        expect(html).not.toMatch(/NaN|undefined/)
      }
    }
  })

  it('el modelo de control de cada tipo coincide con el editor que declara', () => {
    for (const kind of NODE_KINDS) {
      if (kind.control === 'none') {
        expect(controlFor(kind.control), kind.id).toBeUndefined()
        continue
      }
      const model = controlFor(kind.control)
      expect(model, `falta un modelo de ejemplo para ${kind.control}`).toBeDefined()
      expect(model && matchesKind(kind.control, model), kind.id).toBe(true)
    }
  })

  it.each(NODE_KINDS.map((k) => k.id))('%s dibuja solo los puertos que su tipo permite', (id) => {
    const kind = getKind(id)
    const html = renderToStaticMarkup(<MorphNode kind={id} label="x" />)
    expect(count(html, 'data-port="in"')).toBe(kind.ports.in ? 1 : 0)
    expect(count(html, 'data-port="out"')).toBe(kind.ports.out ? 1 : 0)
  })

  it('la condición ofrece su segunda salida; los demás, no', () => {
    const alt = (id: 'control.condition' | 'transform.call') =>
      count(renderToStaticMarkup(<MorphNode kind={id} label="x" />), 'data-port="alt"')
    expect(alt('control.condition')).toBe(1)
    expect(alt('transform.call')).toBe(0)
  })

  it('es accesible: describe tipo y nombre, y el estado tiene su propio rol', () => {
    const html = renderToStaticMarkup(
      <MorphNode kind="transform.call" label="Filter" state="error" />,
    )
    expect(html).toContain('role="group"')
    expect(html).toContain('aria-label="Llamada: Filter"')
    expect(html).toContain('role="status"')
    expect(html).toContain('aria-label="Error"')
  })

  it('el estado nunca depende solo del color: cada uno tiene su propio icono', () => {
    const icons = STATES.map((s) => STATE_META[s].icon)
    expect(new Set(icons).size).toBe(STATES.length)
  })

  it('la sombra solo aparece bajo un relleno opaco y cuando algo la pide', () => {
    const shadow = (props: Partial<Parameters<typeof MorphNode>[0]>) =>
      renderToStaticMarkup(<MorphNode kind="transform.call" label="x" {...props} />).includes(
        'node__shadow',
      )
    expect(shadow({})).toBe(false)
    expect(shadow({ focused: true })).toBe(true)
    expect(shadow({ density: 'expanded' })).toBe(true)
    // Compacto es una píldora plana: en una fila de píldoras la sombra sería ruido.
    expect(shadow({ density: 'compact', focused: true })).toBe(false)
    // Vidrio: la sombra taparía justo lo que el desenfoque debe dejar entrever.
    expect(renderToStaticMarkup(<MorphNode kind="smart.ui" label="x" focused />)).not.toContain(
      'node__shadow',
    )
    // Ventana de resultado: elevada por naturaleza.
    expect(renderToStaticMarkup(<MorphNode kind="output.display" label="x" />)).toContain(
      'node__shadow',
    )
  })

  it('en compacto solo se ve icono, nombre y estado: es la referencia rápida', () => {
    const html = renderToStaticMarkup(
      <MorphNode
        kind="value.number"
        label="limit"
        code="limit = 1000"
        meta="int"
        density="compact"
        state="success"
        control={SAMPLE_CONTROLS['number']}
      />,
    )
    expect(html).toContain('node__glance')
    expect(html).not.toContain('node__code')
    expect(html).not.toContain('node__control')
    expect(html).not.toContain('slider')
    expect(html).toContain('limit')
  })

  it('en normal el editor sustituye a la línea de código; en expandido conviven', () => {
    const withControl = (density: Density) =>
      renderToStaticMarkup(
        <MorphNode
          kind="value.number"
          label="limit"
          code="limit = 1000"
          density={density}
          control={SAMPLE_CONTROLS['number']}
        />,
      )
    expect(withControl('normal')).not.toContain('node__code')
    expect(withControl('expanded')).toContain('node__code')
    // Sin editor que lo diga, el código sí se muestra.
    expect(
      renderToStaticMarkup(<MorphNode kind="space.for" label="x" code="for row in rows:" />),
    ).toContain('node__code')
  })

  it('el editor gráfico aparece en normal y crece en expandido', () => {
    const render = (density: Density) =>
      renderToStaticMarkup(
        <MorphNode
          kind="value.number"
          label="limit"
          density={density}
          control={SAMPLE_CONTROLS['number']}
        />,
      )
    expect(render('normal')).toContain('slider')
    expect(render('expanded')).toContain('slider')
    // El nivel `full` añade el rango; el resumen no lo muestra.
    expect(count(render('expanded'), 'type-field-label')).toBeGreaterThan(
      count(render('normal'), 'type-field-label'),
    )
  })

  it('los modificadores cambian el relleno o la opacidad, no el tipo', () => {
    const generating = renderToStaticMarkup(
      <MorphNode kind="smart.ui" label="x" modifier="generating" />,
    )
    expect(generating).toContain('data-fill="hatch"')
    expect(generating).toContain('data-kind="smart.ui"')
    expect(
      renderToStaticMarkup(<MorphNode kind="transform.call" label="x" modifier="dead" />),
    ).toContain('data-modifier="dead"')
  })
})

describe('Control', () => {
  it.each(Object.keys(SAMPLE_CONTROLS))('%s se renderiza en resumen y completo', (key) => {
    const model = SAMPLE_CONTROLS[key]
    if (!model) throw new Error(`sin modelo: ${key}`)
    for (const level of ['summary', 'full'] as const) {
      const html = renderToStaticMarkup(<Control model={model} level={level} />)
      expect(html.length, `${key}/${level}`).toBeGreaterThan(0)
      expect(html).not.toMatch(/NaN|undefined/)
    }
  })

  it('todo editor ofrece algún control real con el que interactuar', () => {
    for (const [key, model] of Object.entries(SAMPLE_CONTROLS)) {
      const html = renderToStaticMarkup(
        <Control model={model} level="full" onChange={() => undefined} />,
      )
      expect(/<(input|select|button|textarea)/.test(html), `${key} no es editable`).toBe(true)
    }
  })
})
