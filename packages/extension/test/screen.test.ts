import { spawnSync } from 'node:child_process'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { localDecider } from '../src/jev/local.ts'
import { codeSystem, judgeScreen, planSystem, SCREEN_GUIDE } from '../src/jev/plain.ts'
import { Kernel } from '../src/kernel.ts'
import { parseHostMessage, parseWebviewMessage } from '../src/protocol.ts'
import {
  EMPTY_SCREEN,
  applyScreen,
  keyLabel,
  keyMatches,
  restartScreen,
  usesScreen,
} from '../webview/src/screen.ts'

/**
 * La pantalla: lo que hace que un programa se **use de verdad** (suena, tiene botones y teclas, dibuja). En la
 * web se ve y se toca en su nodo; al mirarlo sin nadie delante, cada botón se pulsa una vez.
 */

const python = process.env['PRYSEL_PYTHON'] ?? 'python'
const available = spawnSync(python, ['-c', 'import sys'], { stdio: 'ignore' }).status === 0
const NL = String.fromCharCode(10)
const lines = (...rows: string[]) => rows.join(NL) + NL

const PIANO = lines(
  'import pantalla',
  '',
  '# Tocar una nota',
  'def tocar(nota):',
  '    def suena():',
  '        pantalla.sonar(nota, 0.4)',
  '        pantalla.texto("Suena", nota)',
  '    return suena',
  '',
  '# Poner el piano en marcha',
  'pantalla.titulo("Piano")',
  'for nota in ["do", "re", "mi"]:',
  '    pantalla.boton(nota, tocar(nota))',
  'pantalla.tecla("a", tocar("do"))',
  'pantalla.mostrar()',
)

describe.skipIf(!available)('al mirarlo sin nadie delante', () => {
  let kernel: Kernel
  beforeAll(async () => {
    kernel = await Kernel.start({ python })
  }, 30_000)
  afterAll(() => {
    kernel.dispose()
  })

  it('cada botón y cada tecla se pulsan una vez: se ve qué hace cada uno', async () => {
    const trace = await kernel.trace(PIANO, 20_000, false, false, { finish: true })
    expect(trace.error).toBeNull()
    expect(trace.output).toContain('[pulso «do»]')
    expect(trace.output).toContain('suena mi')
    expect(trace.output).toContain('[tecla «a»]')
    // Lo que hace al pulsar es código del programa: queda grabado (la función de dentro se ejecutó).
    expect(trace.events.some((event) => event.k === 'line' && event.l === 6)).toBe(true)
  }, 30_000)

  it('vale en modo seguro (no toca nada fuera), y empieza de cero cada vez', async () => {
    const first = await kernel.trace(PIANO, 20_000, true, false, { finish: true })
    expect(first.error).toBeNull()
    const second = await kernel.trace(PIANO, 20_000, true, false, { finish: true })
    // Si se acumularan los botones de antes, se pulsarían dos veces.
    expect(second.output.split('[pulso «do»]').length - 1).toBe(1)
  }, 30_000)

  it('los colores se dicen en español; uno que no existe es un error (no un lienzo negro)', async () => {
    const good = await kernel.trace(
      lines(
        'import pantalla',
        'pantalla.lienzo(100, 100, "blanco")',
        'pantalla.rect(0, 0, 10, 10, "azul claro")',
        'pantalla.mostrar()',
      ),
      20_000,
    )
    expect(good.error).toBeNull()
    const bad = await kernel.trace(
      lines('import pantalla', 'pantalla.rect(0, 0, 1, 1, "azulito")'),
      20_000,
    )
    expect(bad.error?.message).toContain('No conozco el color «azulito»')
  }, 30_000)

  it('lo dibujado se pulsa (zonas y el lienzo entero), y se dice qué ofrece la pantalla para usarla', async () => {
    const trace = await kernel.trace(
      lines(
        'import pantalla',
        'pantalla.lienzo(200, 100)',
        'pantalla.zona(0, 0, 50, 50, lambda: pantalla.sonar("do"))',
        'pantalla.al_tocar(lambda x, y: print("toque", x, y))',
        'pantalla.mostrar()',
      ),
      20_000,
    )
    expect(trace.output).toContain('suena do')
    expect(trace.output).toContain('toque 100 50')
    expect(trace.output).toContain('[pantalla: 0 botones, 0 teclas, 1 zonas, se toca el lienzo')
  }, 30_000)

  it('una nota que no existe se dice', async () => {
    const trace = await kernel.trace(lines('import pantalla', 'pantalla.sonar("dó#9x")'), 20_000)
    expect(trace.error?.name).toBe('ValueError')
    expect(trace.error?.message).toContain('No conozco la nota')
  }, 30_000)
})

describe('lo que enseña la pantalla en el lienzo', () => {
  it('se construye con las órdenes del programa', () => {
    let state = restartScreen(EMPTY_SCREEN)
    for (const command of [
      { op: 'title', text: 'Piano' },
      { op: 'button', id: 1, label: 'do' },
      { op: 'button', id: 2, label: 're', color: 'pink' },
      { op: 'key', id: 3, key: 'espacio' },
      { op: 'text', text: 'Hola' },
      { op: 'draw', shape: 'circle', x: 10, y: 10, r: 5, color: 'red' },
      { op: 'timer', id: 4, secs: 0.5 },
      { op: 'nada' },
    ]) {
      state = applyScreen(state, command)
    }
    expect(state.title).toBe('Piano')
    expect(state.buttons).toEqual([
      { id: 1, label: 'do' },
      { id: 2, label: 're', color: 'pink' },
    ])
    expect(state.lines).toEqual(['Hola'])
    // Dibujar sin pedir un lienzo pone uno de tamaño normal.
    expect(state.canvas).toMatchObject({ w: 400, h: 300, shapes: [{ shape: 'circle', r: 5 }] })
    expect(state.timers).toEqual([{ id: 4, secs: 0.5 }])
    const touchable = applyScreen(
      applyScreen(state, { op: 'zone', id: 5, x: 0, y: 0, w: 10, h: 10 }),
      { op: 'touch', id: 6 },
    )
    expect(touchable.zones).toEqual([{ id: 5, x: 0, y: 0, w: 10, h: 10 }])
    expect(touchable.touch).toBe(6)
    expect(applyScreen(state, { op: 'stop' }).timers).toEqual([])
    expect(applyScreen(state, { op: 'clear' }).canvas?.shapes).toEqual([])
    expect(restartScreen(state)).toMatchObject({
      phase: 'loading',
      buttons: [],
      run: state.run + 1,
    })
  })

  it('las teclas se reconocen por su nombre en español', () => {
    expect(keyMatches('espacio', ' ')).toBe(true)
    expect(keyMatches('izquierda', 'ArrowLeft')).toBe(true)
    expect(keyMatches('a', 'A')).toBe(true)
    expect(keyMatches('a', 's')).toBe(false)
    expect(keyLabel('derecha')).toBe('→')
    expect(keyLabel('a')).toBe('a')
  })

  it('se sabe si un programa la usa', () => {
    expect(usesScreen(PIANO)).toBe(true)
    expect(usesScreen('from pantalla import sonar\n')).toBe(true)
    expect(usesScreen('# import pantalla\nprint(1)\n')).toBe(false)
  })
})

describe('lo que se pide para usarlo se hace con la pantalla', () => {
  it('lo decide el JEV (sin modelo, por las palabras)', async () => {
    const piano = await judgeScreen(localDecider(), 'Un piano que suene y se pueda tocar')
    const media = await judgeScreen(localDecider(), 'Calcula la media de unas notas de examen')
    expect(piano.uses).toBeGreaterThan(0.6)
    expect(media.uses).toBeLessThan(0.6)
  })

  it('y entonces la IA sabe cómo: en el plan y en el código', () => {
    expect(codeSystem(false, true)).toContain(SCREEN_GUIDE)
    expect(codeSystem(false)).not.toContain('pantalla.boton')
    expect(planSystem(false, true)).toContain('pantalla.mostrar()')
  })

  it('las órdenes de la pantalla viajan entre el lienzo y quien lo aloja', () => {
    expect(parseHostMessage({ type: 'screen', action: 'press', id: 3, tick: true })).toEqual({
      type: 'screen',
      action: 'press',
      id: 3,
      args: [],
      tick: true,
    })
    expect(parseHostMessage({ type: 'screen', action: 'press' })).toBeNull()
    expect(parseHostMessage({ type: 'screen', action: 'start' })).toEqual({
      type: 'screen',
      action: 'start',
    })
    expect(
      parseWebviewMessage({ type: 'screened', ev: 'screen', command: { op: 'sound', hz: 440 } }),
    ).toEqual({ type: 'screened', ev: 'screen', command: { op: 'sound', hz: 440 } })
    expect(parseWebviewMessage({ type: 'screened', ev: 'error', name: 'X', message: 'y' })).toEqual(
      {
        type: 'screened',
        ev: 'error',
        name: 'X',
        message: 'y',
        line: null,
      },
    )
    expect(parseWebviewMessage({ type: 'screened', ev: 'otra' })).toBeNull()
  })
})
