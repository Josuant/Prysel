import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Control, type ControlModel } from '../src/index.ts'

/**
 * Un elemento suelto de una lista se edita en su sitio (sin quitarlo y volverlo a añadir al final, que le
 * cambiaría el orden). Solo cuando la lista se puede escribir: si no, se lee.
 */

const list: ControlModel = { kind: 'list', items: ['3', '1', '2'] }

describe('editar un elemento de una lista', () => {
  it('con la lista escribible, cada elemento es un botón que abre su campo', () => {
    const html = renderToStaticMarkup(
      <Control model={list} level="full" onChange={() => undefined} />,
    )
    for (const item of ['3', '1', '2']) expect(html).toContain(`aria-label="Editar ${item}"`)
  })

  it('de solo lectura (sin onChange, o sin poder escribir sus elementos), no', () => {
    expect(renderToStaticMarkup(<Control model={list} level="full" />)).not.toContain('Editar')
    const frozen = renderToStaticMarkup(
      <Control model={list} level="full" onChange={() => undefined} editable={[]} />,
    )
    expect(frozen).not.toContain('Editar')
  })
})
