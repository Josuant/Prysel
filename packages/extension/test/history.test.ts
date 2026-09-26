import { describe, expect, it } from 'vitest'
import { applyEdits } from '@prysel/python/edits'
import { EditHistory } from '../src/history.ts'

/**
 * El deshacer propio del lienzo: solo lo que hizo el lienzo, y solo si el documento sigue como lo
 * dejó (si se escribió en el editor entre medias, se olvida en vez de pisar lo escrito).
 */

describe('deshacer y rehacer lo que se cambió desde el lienzo', () => {
  const edit = [{ start: 8, end: 9, text: '10' }]

  it('deshace lo último, y lo deshecho se puede rehacer', () => {
    const history = new EditHistory()
    const v0 = 'total = 0\n'
    const v1 = applyEdits(v0, edit)
    history.applied(v0, edit, 2)
    expect(history.sizes).toEqual({ undo: 1, redo: 0 })

    const undo = history.nextUndo(2)
    expect(undo).not.toBeNull()
    const v2 = applyEdits(v1, undo ?? [])
    expect(v2).toBe(v0)
    history.undone(v1, 3)
    expect(history.sizes).toEqual({ undo: 0, redo: 1 })

    const redo = history.nextRedo(3)
    expect(applyEdits(v2, redo ?? [])).toBe(v1)
    history.redone(v2, 4)
    expect(history.sizes).toEqual({ undo: 1, redo: 0 })
  })

  it('un cambio nuevo del lienzo olvida lo que se podía rehacer', () => {
    const history = new EditHistory()
    history.applied('total = 0\n', edit, 2)
    history.undone('total = 10\n', 3)
    history.applied('total = 0\n', edit, 4)
    expect(history.sizes).toEqual({ undo: 1, redo: 0 })
  })

  it('si se escribió en el editor entre medias, no se deshace nada y la historia se olvida', () => {
    const history = new EditHistory()
    history.applied('total = 0\n', edit, 2)
    // El documento va por la versión 5: alguien tecleó en el editor.
    expect(history.nextUndo(5)).toBeNull()
    expect(history.sizes).toEqual({ undo: 0, redo: 0 })
  })

  it('guarda como mucho un tope de pasos: lo más antiguo se olvida', () => {
    const history = new EditHistory(2)
    for (let v = 1; v <= 5; v++) history.applied('x = 0\n', [{ start: 4, end: 5, text: `${v}` }], v)
    expect(history.sizes.undo).toBe(2)
  })
})
