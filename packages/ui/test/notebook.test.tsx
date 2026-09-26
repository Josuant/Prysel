import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AddNodeMenu, findTemplates, literalKind, SplitButton, StatusPill } from '../src/index.ts'
import { numberRange } from '../src/flow/ChipNode.tsx'

/**
 * El cuaderno 2D: lo que hace que el lienzo se lea como una frase (literales coloreados), que un parámetro se
 * pruebe con un deslizador, y que añadir un paso se encuentre escribiendo.
 */

describe('lo escrito en un campo se colorea por lo que es', () => {
  it('números, textos entre comillas y constantes de Python', () => {
    expect(literalKind('170')).toBe('number')
    expect(literalKind('-0.5')).toBe('number')
    expect(literalKind('1e-3')).toBe('number')
    expect(literalKind('"Nota: "')).toBe('string')
    expect(literalKind("f'{x}'")).toBe('string')
    expect(literalKind('True')).toBe('keyword')
    expect(literalKind('None')).toBe('keyword')
  })

  it('un nombre o una expresión no es un literal', () => {
    for (const text of ['total', 'media + 5', 'len(alturas)', '"abierta', '']) {
      expect(literalKind(text), text).toBeUndefined()
    }
  })
})

describe('el deslizador de un número', () => {
  it('va de cero a la siguiente potencia de diez, con cien pasos', () => {
    expect(numberRange(5)).toEqual({ min: 0, max: 10, step: 1 })
    expect(numberRange(170)).toEqual({ min: 0, max: 1000, step: 10 })
    expect(numberRange(0.01)).toEqual({ min: 0, max: 0.1, step: 0.001 })
    expect(numberRange(0.5)).toEqual({ min: 0, max: 1, step: 0.01 })
  })

  it('un cero se mueve entre 0 y 10, y un negativo cruza el cero', () => {
    expect(numberRange(0)).toEqual({ min: 0, max: 10, step: 1 })
    expect(numberRange(-3)).toEqual({ min: -10, max: 10, step: 1 })
  })
})

describe('la paleta de añadir', () => {
  it('encuentra por el nombre, por la frase que lo explica o por su palabra de Python, sin tildes', () => {
    expect(findTemplates('decision')).toContain('if')
    expect(findTemplates('mientras')).toEqual(['while'])
    expect(findTemplates('for')).toContain('for')
    expect(findTemplates('comillas')).toEqual(['text'])
  })

  it('sin nada escrito lo ofrece todo; con algo que no existe, nada', () => {
    expect(findTemplates('  ').length).toBeGreaterThan(15)
    expect(findTemplates('xyzzy')).toEqual([])
  })

  it('el botón dice dónde caerá lo que se añada', () => {
    const html = renderToStaticMarkup(
      <AddNodeMenu onAdd={() => undefined} where="Después de «total»" label="Añadir paso" />,
    )
    expect(html).toContain('Añadir paso')
    expect(html).toContain('Después de «total»')
  })
})

describe('la barra de la aplicación', () => {
  it('ejecutar es la acción principal, con sus variantes tras la flecha', () => {
    const html = renderToStaticMarkup(
      <SplitButton
        icon="play"
        label="Ejecutar"
        onClick={() => undefined}
        menuLabel="Más formas de ejecutar"
        actions={[{ label: 'Detener', onClick: () => undefined }]}
      />,
    )
    expect(html).toContain('data-variant="primary"')
    expect(html).toContain('aria-label="Más formas de ejecutar"')
    // El menú no está abierto hasta que se pulsa la flecha.
    expect(html).not.toContain('Detener')
  })

  it('el estado del motor lleva un tono además de su palabra', () => {
    const html = renderToStaticMarkup(<StatusPill tone="ready" label="Motor listo" />)
    expect(html).toContain('data-tone="ready"')
    expect(html).toContain('Motor listo')
  })
})
