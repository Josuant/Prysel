import { describe, expect, it } from 'vitest'
import { judgeConfig } from '../src/jev/plain.ts'
import { localDecider } from '../src/jev/local.ts'
import { parseHostMessage, parseWebviewMessage } from '../src/protocol.ts'
import {
  dialRange,
  kindGuess,
  kindOptions,
  knobShown,
  knobWritten,
  knobsOf,
  literalOf,
  literalText,
  type Knob,
} from '../webview/src/knobs.ts'

/**
 * Los mandos de un programa: los valores con los que se puede jugar sin tocar el código. Salen de lo que ya
 * está escrito (sus constantes y los datos con los que arranca); cada uno se maneja como pide su dato, y
 * moverlo cambia justo ese valor.
 */

const lines = (...rows: string[]) => `${rows.join('\n')}\n`

const SOURCE = lines(
  '# Parámetros',
  'LONGITUD = 8',
  'PROBABILIDAD = 0.1',
  'NOMBRE = "prueba"  # el que sale',
  'MOSTRAR = True',
  "COLOR = '#ff8800'",
  'FONDO = (20, 30, 40)',
  'PESOS = [1, 2, 3]',
  '',
  '# Evolucionar',
  'def evolucionar(tamano, generaciones):',
  '    limite = 3',
  '    return tamano * generaciones',
  '',
  '# Arrancar',
  'mejor = evolucionar(12, generaciones=40)',
  'print(mejor)',
)
const FUNCTIONS = [{ name: 'evolucionar', params: ['tamano', 'generaciones'] }]

const value = (knob: Knob) => SOURCE.slice(knob.start, knob.end)

describe('los mandos de un programa', () => {
  const knobs = knobsOf(SOURCE, FUNCTIONS)

  it('son sus constantes (de cualquier dato escrito tal cual) y los valores con los que arranca', () => {
    expect(knobs.map((knob) => `${knob.name}=${knob.text} (${knob.from})`)).toEqual([
      'tamano=12 (launch)',
      'generaciones=40 (launch)',
      'LONGITUD=8 (constant)',
      'PROBABILIDAD=0.1 (constant)',
      'NOMBRE="prueba" (constant)',
      'MOSTRAR=True (constant)',
      "COLOR='#ff8800' (constant)",
      'FONDO=(20, 30, 40) (constant)',
      'PESOS=[1, 2, 3] (constant)',
    ])
    // Lo que una función guarda por dentro, no.
    expect(knobs.some((knob) => knob.name === 'limite')).toBe(false)
  })

  it('cada uno sabe dónde está escrito: cambiarlo es cambiar justo eso (y el comentario se queda)', () => {
    for (const knob of knobs) expect(value(knob)).toBe(knob.text)
    const size = knobs.find((knob) => knob.name === 'tamano')
    if (!size) throw new Error('sin perilla')
    const changed = SOURCE.slice(0, size.start) + '20' + SOURCE.slice(size.end)
    expect(changed).toContain('mejor = evolucionar(20, generaciones=40)')
    expect(knobsOf(changed, FUNCTIONS)[0]).toMatchObject({ name: 'tamano', text: '20' })
    const name = knobs.find((knob) => knob.name === 'NOMBRE')
    if (!name) throw new Error('sin perilla')
    const renamed = SOURCE.slice(0, name.start) + '"otro"' + SOURCE.slice(name.end)
    expect(renamed).toContain('NOMBRE = "otro"  # el que sale')
  })

  it('cada dato se maneja a su manera: perilla, interruptor, texto, color o lista', () => {
    const kinds = Object.fromEntries(knobs.map((knob) => [knob.name, kindGuess(knob)]))
    expect(kinds).toEqual({
      tamano: 'cantidad',
      generaciones: 'cantidad',
      LONGITUD: 'cantidad',
      PROBABILIDAD: 'proporcion',
      NOMBRE: 'texto',
      MOSTRAR: 'interruptor',
      COLOR: 'color',
      FONDO: 'color',
      PESOS: 'lista',
    })
    // El JEV elige solo entre lo que el dato admite: un texto no es una perilla; una tasa puede serlo.
    expect(kindOptions(literalOf('"hola"') ?? { type: 'bool', value: true })).toEqual(['texto'])
    expect(kindOptions(literalOf('0.3') ?? { type: 'bool', value: true })).toEqual([
      'proporcion',
      'medida',
      'cantidad',
    ])
    expect(kindOptions(literalOf('250') ?? { type: 'bool', value: true })).toEqual([
      'cantidad',
      'medida',
    ])
  })

  it('lo que se le da a cada mando se escribe en Python, con la forma que tenía', () => {
    const find = (name: string) => {
      const knob = knobs.find((one) => one.name === name)
      if (!knob) throw new Error(`sin ${name}`)
      return knob
    }
    expect(knobWritten(find('LONGITUD'), 'cantidad', 12.6)).toBe('13')
    expect(knobWritten(find('PROBABILIDAD'), 'proporcion', 0.25)).toBe('0.25')
    expect(knobWritten(find('PROBABILIDAD'), 'proporcion', 1)).toBe('1.0')
    expect(knobWritten(find('MOSTRAR'), 'interruptor', false)).toBe('False')
    expect(knobWritten(find('NOMBRE'), 'texto', 'dice "hola"')).toBe('"dice \\"hola\\""')
    expect(knobWritten(find('COLOR'), 'color', '#00ff00')).toBe("'#00ff00'")
    expect(knobWritten(find('FONDO'), 'color', '#0a0b0c')).toBe('(10, 11, 12)')
    expect(knobWritten(find('PESOS'), 'lista', '4, 5')).toBe('[4, 5]')
    // Lo que no vale para ese dato no se escribe.
    expect(knobWritten(find('LONGITUD'), 'cantidad', 'mucho')).toBeNull()
    expect(knobWritten(find('PESOS'), 'lista', '[1, ')).toBeNull()
    expect(knobShown(find('FONDO'))).toMatchObject({ color: '#141e28' })
  })

  it('la perilla de un número gira de cero a unas veces lo que vale, en cifras redondas', () => {
    expect(dialRange(8, 'cantidad')).toEqual({ min: 0, max: 50, step: 1 })
    expect(dialRange(100, 'cantidad')).toEqual({ min: 0, max: 500, step: 5 })
    expect(dialRange(0.1, 'proporcion')).toEqual({ min: 0, max: 1, step: 0.01 })
    expect(dialRange(-3, 'cantidad')).toMatchObject({ min: -10, max: 10 })
  })

  it('sin valores que tocar no hay mandos; y con muchos, solo unos pocos', () => {
    expect(knobsOf(lines('def f(x):', '    return x', 'print(f(x))'), [])).toEqual([])
    const many = lines(...Array.from({ length: 12 }, (_, at) => `N${at} = ${at}`))
    expect(knobsOf(many).length).toBe(8)
  })

  it('un valor que el programa va cambiando (un contador, una lista que llena) no es un ajuste', () => {
    const source = lines(
      'TOPE = 10',
      'pasadas = 0',
      'vistos = []',
      'tablero = [0, 0, 0]',
      'while pasadas < TOPE:',
      '    pasadas += 1',
      '    vistos.append(pasadas)',
      '    tablero[0] = pasadas',
      'print(vistos, tablero)',
    )
    expect(knobsOf(source).map((knob) => knob.name)).toEqual(['TOPE'])
  })

  it('lo que monta la pantalla (qué hace cada botón) no es con qué arranca', () => {
    const source = lines(
      'import pantalla',
      'def tocar(nota):',
      '    return lambda: pantalla.sonar(nota)',
      'pantalla.boton("Do", tocar("do"))',
      'pantalla.tecla("a", tocar("do"))',
    )
    expect(knobsOf(source, [{ name: 'tocar', params: ['nota'] }])).toEqual([])
  })

  it('una llamada a algo que no es del programa no da mandos', () => {
    const source = lines('import random', 'x = random.randint(1, 6)', 'print(max(3, x))')
    expect(knobsOf(source, FUNCTIONS)).toEqual([])
  })

  it('los valores escritos se leen y se vuelven a escribir igual', () => {
    for (const text of ['8', '-2.5', 'True', '"a\\"b"', "'x'", '[1, "dos", 3.0]', '(1, 2)', '[]']) {
      const literal = literalOf(text)
      expect(literal).not.toBeNull()
      if (literal) expect(literalText(literal)).toBe(text)
    }
    // Ni dos textos, ni un número entre paréntesis, ni listas de listas: eso no es un valor suelto.
    for (const text of ['"a" + "b"', '(3)', '[[1], [2]]', 'x', 'f(2)']) {
      expect(literalOf(text)).toBeNull()
    }
  })
})

describe('qué es la configuración lo decide el JEV', () => {
  it('pregunta por cada constante entre las formas que su dato admite (y «no es un ajuste»)', async () => {
    const asked: Record<string, string[]> = {}
    const kinds = await judgeConfig(
      {
        id: 'prueba',
        decide(request) {
          for (const [id, question] of Object.entries(request.questions)) {
            if (question.type === 'choice') asked[id] = Object.keys(question.criteria)
          }
          return Promise.resolve({
            answers: {
              config0: { type: 'choice', choice: 'proporcion', confidence: 0.9 },
              config1: { type: 'choice', choice: 'no', confidence: 0.8 },
              // Una forma que su dato no admite no vale.
              config2: { type: 'choice', choice: 'cantidad', confidence: 0.9 },
            },
            ms: 0,
          })
        },
      },
      [
        {
          name: 'TASA',
          value: '0.2',
          use: 'if random.random() < TASA:',
          options: ['proporcion', 'medida'],
        },
        { name: 'tablero', value: '[0, 0]', use: 'tablero[i] = 1', options: ['lista'] },
        { name: 'OBJETIVO', value: '"hola"', use: '', options: ['texto'] },
      ],
    )
    expect(asked['config0']).toEqual(['no', 'proporcion', 'medida'])
    expect(kinds).toEqual(['proporcion', 'no', null])
  })

  it('sin un modelo que lea, no lo sabe: decide quien pregunta, por lo que se ve', async () => {
    const kinds = await judgeConfig(localDecider(), [
      { name: 'N', value: '3', use: '', options: ['cantidad', 'medida'] },
    ])
    expect(kinds).toEqual([null])
  })

  it('la pregunta y la respuesta viajan entre el lienzo y quien lo aloja', () => {
    const items = [{ name: 'N', value: '3', use: 'range(N)', options: ['cantidad'] }]
    expect(parseHostMessage({ type: 'config', key: 'k', items })).toEqual({
      type: 'config',
      key: 'k',
      items,
    })
    expect(parseHostMessage({ type: 'config', key: 'k', items: [] })).toBeNull()
    expect(
      parseWebviewMessage({ type: 'configured', key: 'k', kinds: ['cantidad', null] }),
    ).toEqual({ type: 'configured', key: 'k', kinds: ['cantidad', null] })
  })
})
