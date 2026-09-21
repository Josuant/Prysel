import type { ControlModel } from '@prysel/morphology'
import type { Program, ProgramNode } from '@prysel/python'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PATIENCE_MS, createWriteBack } from '../webview/src/writeBack.ts'

/**
 * La cola que hay entre confirmar un campo y ver el archivo reescrito. Es donde una edición
 * se puede perder o mandarse dos veces, así que se prueba sin React ni editor: con un programa
 * mínimo y un «anfitrión» que solo anota lo que se le manda.
 */

const number = (value: number): ControlModel => ({ kind: 'number', value })

/** Un nodo con un número en la columna `at` de un texto de una sola línea. */
const node = (id: string, value: number, at: number): ProgramNode => ({
  id,
  kind: 'value.number',
  label: id,
  code: `${id} = ${value}`,
  line: 1,
  control: number(value),
  sources: {
    value: { start: at, end: at + String(value).length, as: 'number', original: String(value) },
  },
})

const program = (...nodes: ProgramNode[]): Program => ({ nodes, edges: [], unsupported: [] })

let posted: {
  type: string
  version: number
  edits: { start: number; end: number; text: string }[]
}[]
let pending: Record<string, ControlModel>
const make = () =>
  createWriteBack({
    post: (message) => {
      posted.push(message as (typeof posted)[number])
    },
    onPending: (next) => {
      pending = next
    },
  })

beforeEach(() => {
  posted = []
  pending = {}
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('una edición', () => {
  it('se manda con la versión del documento sobre la que se calculó', () => {
    const queue = make()
    queue.received(program(node('a', 5, 4)), 7)
    queue.change('a', number(9))
    expect(posted).toEqual([{ type: 'edit', version: 7, edits: [{ start: 4, end: 5, text: '9' }] }])
  })

  it('mientras no llega el texto reescrito, el campo enseña lo que el usuario escribió', () => {
    const queue = make()
    queue.received(program(node('a', 5, 4)), 1)
    queue.change('a', number(9))
    expect(pending).toEqual({ a: number(9) })
  })

  it('cuando el archivo ya lo refleja, deja de estar pendiente', () => {
    const queue = make()
    queue.received(program(node('a', 5, 4)), 1)
    queue.change('a', number(9))
    queue.received(program(node('a', 9, 4)), 2)
    expect(pending).toEqual({})
    expect(posted).toHaveLength(1)
  })

  it('sin programa todavía, no se manda nada: no hay a qué ponerle desplazamientos', () => {
    const queue = make()
    queue.change('a', number(9))
    expect(posted).toEqual([])
  })

  it('un cambio que no cambia nada no se manda', () => {
    const queue = make()
    queue.received(program(node('a', 5, 4)), 1)
    queue.change('a', number(5))
    expect(posted).toEqual([])
    expect(pending).toEqual({})
  })

  it('un valor que no se puede escribir (número inválido) no se manda', () => {
    const queue = make()
    queue.received(program(node('a', 5, 4)), 1)
    queue.change('a', number(Number.NaN))
    expect(posted).toEqual([])
  })
})

describe('dos ediciones seguidas', () => {
  it('solo hay una en vuelo: la segunda espera al texto nuevo', () => {
    const queue = make()
    queue.received(program(node('a', 5, 4), node('b', 6, 20)), 1)
    queue.change('a', number(50))
    queue.change('b', number(60))
    expect(posted).toHaveLength(1)
    expect(posted[0]?.edits[0]).toMatchObject({ start: 4, text: '50' })
  })

  it('la segunda se recalcula contra el texto nuevo: sus desplazamientos ya se movieron', () => {
    const queue = make()
    queue.received(program(node('a', 5, 4), node('b', 6, 20)), 1)
    queue.change('a', number(50))
    queue.change('b', number(60))
    // El archivo reescrito: `a` ocupa un carácter más, así que `b` está una columna más allá.
    queue.received(program(node('a', 50, 4), node('b', 6, 21)), 2)
    expect(posted).toHaveLength(2)
    expect(posted[1]).toEqual({
      type: 'edit',
      version: 2,
      edits: [{ start: 21, end: 22, text: '60' }],
    })
  })

  it('las dos acaban confirmadas y no queda nada pendiente', () => {
    const queue = make()
    queue.received(program(node('a', 5, 4), node('b', 6, 20)), 1)
    queue.change('a', number(50))
    queue.change('b', number(60))
    queue.received(program(node('a', 50, 4), node('b', 6, 21)), 2)
    queue.received(program(node('a', 50, 4), node('b', 60, 21)), 3)
    expect(pending).toEqual({})
  })

  it('el mismo campo cambiado dos veces: se envía lo último, no lo penúltimo', () => {
    const queue = make()
    queue.received(program(node('a', 5, 4)), 1)
    queue.change('a', number(7))
    queue.change('a', number(8))
    queue.received(program(node('a', 7, 4)), 2)
    expect(posted).toHaveLength(2)
    expect(posted[1]?.edits[0]).toMatchObject({ text: '8' })
  })
})

describe('cuando el anfitrión no acepta la edición', () => {
  it('si vuelve el texto sin cambiar, se abandona: no se reintenta en bucle', () => {
    const queue = make()
    queue.received(program(node('a', 5, 4)), 1)
    queue.change('a', number(9))
    // El anfitrión la rechazó (el texto había cambiado) y reenvió el estado tal cual.
    queue.received(program(node('a', 5, 4)), 2)
    expect(posted).toHaveLength(1)
    expect(pending).toEqual({})
  })

  it('si no contesta en absoluto, se da por perdida y el campo vuelve a lo que hay', () => {
    const queue = make()
    queue.received(program(node('a', 5, 4)), 1)
    queue.change('a', number(9))
    vi.advanceTimersByTime(PATIENCE_MS + 1)
    expect(pending).toEqual({})
  })

  it('tras esa espera se puede volver a editar', () => {
    const queue = make()
    queue.received(program(node('a', 5, 4)), 1)
    queue.change('a', number(9))
    vi.advanceTimersByTime(PATIENCE_MS + 1)
    queue.change('a', number(10))
    expect(posted).toHaveLength(2)
  })

  it('un nodo que ya no existe no se manda', () => {
    const queue = make()
    queue.received(program(node('a', 5, 4)), 1)
    queue.change('fantasma', number(9))
    expect(posted).toEqual([])
  })
})

describe('operaciones de estructura', () => {
  const change = (start: number, text: string, line?: number) => () => ({
    edits: [{ start, end: start, text }],
    ...(line === undefined ? {} : { select: { line } }),
  })

  it('se calculan contra el programa vigente y se mandan con su versión', () => {
    const queue = make()
    queue.received(program(node('a', 5, 4)), 3)
    queue.submit(change(0, 'x = 1\n'))
    expect(posted).toEqual([
      { type: 'edit', version: 3, edits: [{ start: 0, end: 0, text: 'x = 1\n' }] },
    ])
  })

  it('sin programa todavía esperan, y salen cuando llega', () => {
    const queue = make()
    queue.submit(change(0, 'x'))
    expect(posted).toEqual([])
    queue.received(program(), 1)
    expect(posted).toHaveLength(1)
  })

  it('con una en vuelo, la siguiente se recalcula con el texto nuevo', () => {
    const queue = make()
    queue.received(program(node('a', 5, 4)), 1)
    queue.submit(change(0, 'x'))
    const seen: number[] = []
    queue.submit((current) => {
      seen.push(current.nodes.length)
      return { edits: [{ start: 1, end: 1, text: 'y' }] }
    })
    expect(posted).toHaveLength(1)
    queue.received(program(node('a', 5, 4), node('b', 6, 20)), 2)
    expect(seen).toEqual([2])
    expect(posted[1]).toMatchObject({ version: 2 })
  })

  it('una operación sin ediciones no bloquea la cola', () => {
    const queue = make()
    queue.received(program(), 1)
    queue.submit(() => ({ edits: [] }))
    queue.submit(change(0, 'x'))
    expect(posted).toHaveLength(1)
  })

  it('avisa cuando lo creado ya está en el programa, con su línea', () => {
    const created: [number, number][] = []
    const queue = createWriteBack({
      post: (message) => {
        posted.push(message as (typeof posted)[number])
      },
      onPending: () => {},
      onCreated: (next, line) => created.push([next.nodes.length, line]),
    })
    queue.received(program(), 1)
    queue.submit(change(0, 'x = 1\n', 1))
    expect(created).toEqual([])
    queue.received(program(node('x', 1, 4)), 2)
    expect(created).toEqual([[1, 1]])
    // Una segunda respuesta ya no repite el aviso.
    queue.received(program(node('x', 1, 4)), 3)
    expect(created).toHaveLength(1)
  })

  it('si el anfitrión no contesta, se descartan también las que esperaban', () => {
    const queue = make()
    queue.received(program(), 1)
    queue.submit(change(0, 'x'))
    queue.submit(change(0, 'y'))
    vi.advanceTimersByTime(PATIENCE_MS + 1)
    queue.received(program(), 2)
    expect(posted).toHaveLength(1)
  })
})
