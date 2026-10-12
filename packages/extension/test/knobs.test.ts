import { describe, expect, it } from 'vitest'
import { knobMoved, knobStep, knobText, knobsOf } from '../webview/src/knobs.ts'

/**
 * Las perillas: los números del programa con los que se puede jugar sin tocar el código. Salen de lo que ya
 * está escrito (sus constantes y los datos con los que arranca), y moverlas cambia justo ese número.
 */

const lines = (...rows: string[]) => `${rows.join('\n')}\n`

const SOURCE = lines(
  '# Parámetros',
  'LONGITUD = 8',
  'PROBABILIDAD = 0.1',
  'NOMBRE = "prueba"',
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

describe('las perillas de un programa', () => {
  const knobs = knobsOf(SOURCE, FUNCTIONS)

  it('son sus constantes numéricas y los números con los que arranca, con su nombre', () => {
    expect(knobs.map((knob) => `${knob.name}=${knob.value} (${knob.from})`)).toEqual([
      'tamano=12 (launch)',
      'generaciones=40 (launch)',
      'LONGITUD=8 (constant)',
      'PROBABILIDAD=0.1 (constant)',
    ])
    // Ni un texto, ni lo que una función guarda por dentro.
    expect(knobs.some((knob) => knob.name === 'NOMBRE' || knob.name === 'limite')).toBe(false)
  })

  it('cada una sabe dónde está escrito su número: cambiarlo es cambiar justo eso', () => {
    for (const knob of knobs) {
      expect(Number(SOURCE.slice(knob.start, knob.end))).toBe(knob.value)
    }
    const size = knobs.find((knob) => knob.name === 'tamano')
    if (!size) throw new Error('sin perilla')
    const changed = SOURCE.slice(0, size.start) + '20' + SOURCE.slice(size.end)
    expect(changed).toContain('mejor = evolucionar(20, generaciones=40)')
    // Y con el programa cambiado, la perilla dice lo nuevo.
    expect(knobsOf(changed, FUNCTIONS)[0]).toMatchObject({ name: 'tamano', value: 20 })
  })

  it('se mueven a su paso: de uno en uno lo pequeño, a saltos lo grande, a décimas lo decimal', () => {
    const step = (value: number, decimal = false) => knobStep({ value, decimal })
    expect([step(8), step(40), step(250), step(5000)]).toEqual([1, 5, 10, 100])
    expect([step(0.1, true), step(2.5, true)]).toEqual([0.05, 0.5])
    const chance = knobs.find((knob) => knob.name === 'PROBABILIDAD')
    if (!chance) throw new Error('sin perilla')
    expect(knobText(chance, knobMoved(chance, 1))).toBe('0.15')
    expect(knobText(chance, knobMoved(chance, -1))).toBe('0.05')
    // Un número entero se escribe entero; uno decimal conserva que lo es.
    expect(knobText({ decimal: false }, 12.4)).toBe('12')
    expect(knobText({ decimal: true }, 2)).toBe('2.0')
    // Un tamaño no baja de cero.
    expect(knobMoved({ ...chance, value: 0, decimal: false }, -1)).toBe(0)
  })

  it('sin números que tocar no hay perillas; y con muchos, solo unas pocas', () => {
    expect(knobsOf(lines('def f(x):', '    return x', 'print(f("a"))'), [])).toEqual([])
    const many = lines(...Array.from({ length: 12 }, (_, at) => `N${at} = ${at}`))
    expect(knobsOf(many).length).toBe(6)
  })

  it('un número que el programa va cambiando (un contador) no es una perilla', () => {
    const source = lines(
      'TOPE = 10',
      'pasadas = 0',
      'total = 0',
      'while pasadas < TOPE:',
      '    pasadas += 1',
      '    total = total + pasadas',
      'print(total)',
    )
    expect(knobsOf(source).map((knob) => knob.name)).toEqual(['TOPE'])
  })

  it('una llamada a algo que no es del programa no da perillas', () => {
    const source = lines('import random', 'x = random.randint(1, 6)', 'print(max(3, x))')
    expect(knobsOf(source, FUNCTIONS)).toEqual([])
  })
})
