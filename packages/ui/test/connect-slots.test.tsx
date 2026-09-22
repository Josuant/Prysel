import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Control, type ControlModel } from '../src/index.ts'

/**
 * Todo campo que el análisis marca como receptor de un cable (`inputs`) tiene que exponer su
 * `data-slot` en el DOM: es lo único que mira `slotAt()` al soltar un chip. Un campo con el
 * atributo que falta se arrastra "sin razón visible" — no hay verdicto que rechace nada, el
 * chip simplemente no encuentra dónde caer.
 */

const editable = (model: ControlModel) =>
  renderToStaticMarkup(<Control model={model} level="full" onChange={() => undefined} />)

describe('el mensaje de un print (o un input) de una sola línea', () => {
  it('expone su casilla igual que la versión de varias líneas: se puede arrastrar un chip encima', () => {
    const short = editable({ kind: 'text', value: 'Hola', multiline: false })
    const long = editable({ kind: 'text', value: 'Hola', multiline: true })
    expect(short).toContain('data-slot="value"')
    expect(long).toContain('data-slot="value"')
  })
})
