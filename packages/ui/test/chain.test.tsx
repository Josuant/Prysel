import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Control, type ControlModel } from '../src/index.ts'
import type { StepInfo } from '../src/steps.ts'

/**
 * El editor de una cadena de pasos: una fila por paso con su vista previa, y las herramientas para
 * subir, bajar, quitar y añadir solo cuando la cadena entera se puede reescribir.
 */

const model: Extract<ControlModel, { kind: 'chain' }> = {
  kind: 'chain',
  receiver: 'df',
  steps: [
    { kind: 'call', name: 'groupby', args: '"mes"' },
    { kind: 'index', name: '', args: '"monto"' },
    { kind: 'attr', name: 'values', args: '' },
  ],
}

const html = (props: Partial<Parameters<typeof Control>[0]> = {}) =>
  renderToStaticMarkup(
    <Control model={model} level="summary" onChange={() => undefined} {...props} />,
  )

const count = (text: string, needle: string) => text.split(needle).length - 1

describe('las filas de una cadena', () => {
  it('el receptor y un paso por fila, cada uno con lo que le corresponde', () => {
    const out = html()
    expect(count(out, 'class="chain__row')).toBeGreaterThanOrEqual(4)
    // El receptor recibe un cable o un chip; los pasos, no.
    expect(count(out, 'data-slot="receiver"')).toBe(1)
    expect(out).toContain('value="groupby"')
    expect(out).toContain('value="&quot;mes&quot;"')
    expect(out).toContain('value="&quot;monto&quot;"')
    expect(out).toContain('value="values"')
  })

  it('una llamada lleva paréntesis; un índice, corchetes; un atributo, ninguno', () => {
    const out = html()
    expect(out).toContain('<span class="chain__glue">(</span>')
    expect(out).toContain('<span class="chain__glue">)</span>')
    expect(out).toContain('<span class="chain__glue">[</span>')
    expect(out).toContain('<span class="chain__glue">]</span>')
  })
})

describe('lo que se observó de cada paso', () => {
  const steps: StepInfo[] = [
    { short: 'DataFrame 12×5', long: 'columnas: mes, monto' },
    { short: 'DataFrameGroupBy' },
    { short: 'SeriesGroupBy', onView: () => undefined },
  ]

  it('se enseña junto a su paso, con su ayuda', () => {
    const out = html({ steps })
    expect(out).toContain('DataFrame 12×5')
    expect(out).toContain('title="columnas: mes, monto"')
    expect(out).toContain('DataFrameGroupBy')
  })

  it('solo se puede pulsar el que tiene algo que ver en un visor', () => {
    const out = html({ steps })
    const previews = out.match(/<button[^>]*class="chain__preview"[^>]*>/g) ?? []
    expect(previews).toHaveLength(3)
    expect(previews.filter((tag) => tag.includes('disabled'))).toHaveLength(2)
  })

  it('sin nada observado, no hay vistas previas', () => {
    expect(html()).not.toContain('chain__preview')
  })
})

describe('las herramientas de los pasos', () => {
  it('sin poder reescribir la cadena, no se ofrecen', () => {
    const out = html({ editable: ['receiver', 'steps[0].name'] })
    expect(out).not.toContain('chain__tools')
    expect(out).not.toContain('chain__add')
  })

  it('con la cadena entera editable, cada paso sube, baja y se quita, y hay dónde añadir', () => {
    const out = html({ editable: ['chain', 'receiver', 'steps[0].name'] })
    expect(count(out, 'class="chain__tools"')).toBe(3)
    expect(out).toContain('aria-label="Subir el paso 1"')
    expect(out).toContain('aria-label="Bajar el paso 3"')
    expect(out).toContain('aria-label="Quitar el paso 2"')
    expect(out).toContain('chain__add')
    // El primero no sube y el último no baja.
    expect(out).toMatch(/aria-label="Subir el paso 1"[^>]*disabled/)
    expect(out).toMatch(/aria-label="Bajar el paso 3"[^>]*disabled/)
  })

  it('con un solo paso no se puede quitar (la cadena dejaría de serlo)', () => {
    const one = { ...model, steps: model.steps.slice(0, 1) }
    const out = html({ model: one, editable: ['chain'] })
    expect(out).toMatch(/aria-label="Quitar el paso 1"[^>]*disabled/)
  })

  it('un campo cuya fuente no está entre las editables, no se puede escribir', () => {
    const out = html({ editable: ['receiver'] })
    expect(out).toMatch(/readOnly=""[^>]*value="groupby"/)
    expect(out).not.toMatch(/readOnly=""[^>]*value="df"/)
  })
})
