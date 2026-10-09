import { readFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { buildProgram, createPythonParser, type Program } from '@prysel/python'
import { applyEdits } from '@prysel/python/edits'
import type { AiProvider } from '../src/ai/provider.ts'
import { modify, type Shown, type Stagehand } from '../src/jev/director.ts'
import { localDecider } from '../src/jev/local.ts'
import {
  changesBetween,
  dedent,
  echoEdits,
  indentationOk,
  lostBlocks,
  opOf,
  restoreLost,
  topBlocks,
} from '../src/jev/modify.ts'

/**
 * Cambiar un programa pequeño reescribiéndolo: a la IA se le pide el programa entero con el cambio hecho
 * (código, sin formato), se comprueba y se escribe de una vez. Sale de una prueba real («modifica el
 * validador del PIN…») en la que los cambios línea a línea dejaron el código con la sangría rota.
 */

const require = createRequire(import.meta.url)
const wasmDir = path.dirname(require.resolve('@vscode/tree-sitter-wasm/wasm/tree-sitter.js'))

let parse: (source: string) => Program
let hasError: (source: string) => boolean
beforeAll(async () => {
  const parser = await createPythonParser({
    runtime: wasmDir,
    language: path.join(wasmDir, 'tree-sitter-python.wasm'),
  })
  parse = (source: string) => buildProgram(parser.parse(source), source)
  hasError = (source: string) => parser.parse(source).rootNode.hasError
}, 30_000)

const lines = (...rows: string[]) => `${rows.join('\n')}\n`

const CAJERO = lines(
  'class CajeroAutomatico:',
  '    def __init__(self):',
  '        self.estado = "Esperando Tarjeta"',
  '',
  '    def insertar_tarjeta(self):',
  '        self.estado = "Pidiendo PIN"',
  '',
  '    def validar_pin(self, pin):',
  "        if pin == '1234':",
  "            self.estado = 'Menú Principal'",
)

const CAJERO_CON_BLOQUEO = lines(
  'class CajeroAutomatico:',
  '    def __init__(self):',
  '        self.estado = "Esperando Tarjeta"',
  '        self.intentos_fallidos = 0',
  '',
  '    def insertar_tarjeta(self):',
  '        self.estado = "Pidiendo PIN"',
  '',
  '    def validar_pin(self, pin):',
  "        if self.estado == 'Tarjeta Bloqueada':",
  '            return',
  "        if pin == '1234':",
  "            self.estado = 'Menú Principal'",
  '            self.intentos_fallidos = 0',
  '        else:',
  '            self.intentos_fallidos += 1',
  '            if self.intentos_fallidos >= 3:',
  "                self.estado = 'Tarjeta Bloqueada'",
)

/** Así quedó de verdad el archivo en la prueba, con los cambios línea a línea. */
const ROTO = lines(
  'class CajeroAutomatico:',
  '    def __init__(self):',
  '        self.estado = "Esperando Tarjeta"',
  '                self.intentos_fallidos = 0',
  '',
  '    def insertar_tarjeta(self):',
  '        self.estado = "Pidiendo PIN"',
)

function stage(source: string) {
  const state = { text: source, writes: 0, frames: [] as string[], shown: [] as Shown[] }
  const host: Stagehand = {
    signal: new AbortController().signal,
    program: () => Promise.resolve(parse(state.text)),
    parses: (code) => !hasError(code),
    write(change) {
      if (change.edits.length === 0) return Promise.resolve(null)
      state.text = applyEdits(state.text, change.edits)
      state.frames.push(state.text)
      state.writes++
      return Promise.resolve(null)
    },
    show(event) {
      state.shown.push(event)
      return Promise.resolve()
    },
    wait: () => Promise.resolve(),
    settle: () => Promise.resolve(),
  }
  return { host, state }
}

/** Una IA de mentira: al pedirle el programa cambiado devuelve `program`; si no, una frase. */
function ai(program: string): AiProvider & { systems: string[] } {
  const systems: string[] = []
  return {
    id: 'mentira',
    systems,
    generate(request) {
      systems.push(request.system)
      return Promise.resolve(
        request.system.includes('programa ENTERO') ? program : 'Ahora cuenta los fallos y bloquea.',
      )
    },
  }
}

const ORDER = {
  command: "Modifica el validador del PIN. Si se equivoca 3 veces, pasa a 'Tarjeta Bloqueada'.",
  whole: true,
}

describe('cambiar un programa pequeño: el programa entero, de una vez', () => {
  it('la IA devuelve el programa cambiado; entra por tramos, y ningún estado intermedio queda roto', async () => {
    const { host, state } = stage(CAJERO)
    const provider = ai(CAJERO_CON_BLOQUEO)
    const outcome = await modify(host, { decider: localDecider(), provider }, ORDER)
    expect(outcome.trouble).toBeNull()
    expect(state.text).toBe(CAJERO_CON_BLOQUEO)
    // Entra por tramos (se ve crecer), pero cada estado por el que pasa el archivo es un programa válido.
    expect(state.writes).toBeGreaterThan(1)
    for (const frame of state.frames) {
      expect(hasError(frame), frame).toBe(false)
      expect(indentationOk(frame), frame).toBe(true)
    }
    // Y se ve cada tramo, donde quedó: lo que solo añade, nace.
    const changed = state.shown.flatMap((event) => (event.type === 'step' ? [event] : []))
    expect(changed.map((event) => `${event.effect} L${event.line}`)).toEqual([
      'born L4',
      'born L10',
      'born L14',
    ])
    // Una frase al margen de lo que se hizo; a la IA no se le pide ningún formato.
    expect(state.shown.some((event) => event.type === 'say' && event.aside)).toBe(true)
    for (const system of provider.systems) expect(system).not.toMatch(/JSON|"op"|linea/)
  })

  it('con la valla de código alrededor también vale', async () => {
    const { host, state } = stage(CAJERO)
    await modify(
      host,
      { decider: localDecider(), provider: ai(`\`\`\`python\n${CAJERO_CON_BLOQUEO}\`\`\``) },
      ORDER,
    )
    expect(state.text).toBe(CAJERO_CON_BLOQUEO)
  })

  it('si lo que devuelve no es un programa válido (la sangría rota), no se toca nada', async () => {
    const { host, state } = stage(CAJERO)
    const outcome = await modify(host, { decider: localDecider(), provider: ai(ROTO) }, ORDER)
    expect(outcome.trouble).toContain('no toco nada')
    expect(state.text).toBe(CAJERO)
    expect(state.writes).toBe(0)
  })

  it('si devuelve lo mismo, se dice; y lo que el JEV no da por seguro no se escribe', async () => {
    const same = stage(CAJERO)
    const nothing = await modify(
      same.host,
      { decider: localDecider(), provider: ai(CAJERO) },
      ORDER,
    )
    expect(nothing.trouble).toContain('ningún cambio')
    const risky = stage(CAJERO)
    const refused = await modify(
      risky.host,
      {
        decider: localDecider(),
        provider: ai(`import os\nos.remove("datos.csv")\n${CAJERO}`),
      },
      ORDER,
    )
    expect(refused.trouble).toContain('no toco nada')
    expect(risky.state.text).toBe(CAJERO)
  })
})

describe('la sangría de un programa', () => {
  it('el analizador da por bueno lo que Python no: por eso se comprueba aparte', () => {
    expect(hasError(ROTO)).toBe(false)
    expect(indentationOk(ROTO)).toBe(false)
    expect(indentationOk(CAJERO)).toBe(true)
    expect(indentationOk(CAJERO_CON_BLOQUEO)).toBe(true)
  })

  it('no confunde lo que sigue en la línea de abajo con un bloque', () => {
    expect(
      indentationOk(
        lines(
          'total = sumar(',
          '    1,',
          '    2,',
          ')',
          'texto = """',
          '      con sangría dentro',
          '"""',
          'datos = {',
          '    "a": 1,',
          '}',
          'if (total > 2 and',
          '        total < 9):',
          '    print(texto)  # un comentario: con dos puntos',
          'largo = 1 + \\',
          '    2',
        ),
      ),
    ).toBe(true)
    expect(indentationOk(lines('x = 1', '    y = 2'))).toBe(false)
    expect(indentationOk(lines('    x = 1'))).toBe(false)
  })

  it('todos los ejemplos del repositorio la tienen bien', () => {
    const root = path.resolve(import.meta.dirname, '../../../examples')
    const files = readdirSync(root, { recursive: true, encoding: 'utf8' }).filter((file) =>
      file.endsWith('.py'),
    )
    expect(files.length).toBeGreaterThan(3)
    for (const file of files) {
      expect(indentationOk(readFileSync(path.join(root, file), 'utf8')), file).toBe(true)
    }
  })

  it('un cambio que viene con la sangría del archivo se escribe sin ella', () => {
    expect(dedent('        self.intentos_fallidos = 0')).toBe('self.intentos_fallidos = 0')
    expect(dedent('    def f(self):\n        return 1')).toBe('def f(self):\n    return 1')
    expect(opOf({ op: 'añadir', tras: 3, code: '        self.x = 0', say: '' })).toMatchObject({
      code: 'self.x = 0',
    })
  })
})

describe('qué cambia entre dos versiones de un programa', () => {
  it('los tramos distintos, con la línea donde quedan en la nueva', () => {
    const { hunks } = changesBetween(CAJERO, CAJERO_CON_BLOQUEO)
    expect(hunks).toEqual([
      { line: 4, added: 1, removed: 0 },
      { line: 10, added: 2, removed: 0 },
      { line: 14, added: 5, removed: 0 },
    ])
    expect(changesBetween(CAJERO, CAJERO).hunks).toEqual([])
    expect(changesBetween('a = 1\nb = 2\n', 'a = 1\n').hunks).toEqual([
      { line: 2, added: 0, removed: 1 },
    ])
  })
})

describe('lo que la IA se deja fuera al reescribir', () => {
  // De una sesión real: se pegó este programa, se pidió «hay algo raro con el total, arréglalo», y la IA
  // devolvió las tres funciones (con el arreglo bien hecho) sin los datos de arriba ni el programa de abajo.
  const PEDIDOS = lines(
    'pedidos = [',
    '    {"cliente": "Ana", "articulos": [12, 5, 8]},',
    '    {"cliente": "Luis", "articulos": [20, 3]},',
    ']',
    '',
    '',
    'def t(p):',
    '    return sum(p["articulos"])',
    '',
    '',
    'def r(ps):',
    '    x = []',
    '    acc = 0',
    '    for p in ps:',
    '        for a in p["articulos"]:',
    '            acc = acc + a',
    '        x.append((p["cliente"], acc))',
    '    return x',
    '',
    '',
    'for c, tot in r(pedidos):',
    '    print(c, tot)',
    'print("Mejor:", t(pedidos[0]))',
  )
  const SOLO_FUNCIONES = lines(
    'def t(p):',
    '    return sum(p["articulos"])',
    '',
    '',
    'def r(ps):',
    '    x = []',
    '    for p in ps:',
    '        acc = 0',
    '        for a in p["articulos"]:',
    '            acc = acc + a',
    '        x.append((p["cliente"], acc))',
    '    return x',
  )

  it('se sabe qué trozos del programa faltan en la versión nueva', () => {
    expect(topBlocks(PEDIDOS).map((block) => block.key)).toEqual([
      'pedidos =',
      'def t',
      'def r',
      'for c, tot in r(pedidos):',
      'print("Mejor:", t(pedidos[0]))',
    ])
    expect(lostBlocks(PEDIDOS, SOLO_FUNCIONES).map((block) => block.head)).toEqual([
      'pedidos = [',
      'for c, tot in r(pedidos):',
      'print("Mejor:", t(pedidos[0]))',
    ])
    expect(lostBlocks(PEDIDOS, PEDIDOS)).toEqual([])
  })

  it('vuelven a su sitio, y lo que sí cambió se queda cambiado', () => {
    const restored = restoreLost(PEDIDOS, SOLO_FUNCIONES)
    expect(lostBlocks(PEDIDOS, restored)).toEqual([])
    expect(restored.startsWith('pedidos = [')).toBe(true)
    expect(restored.trimEnd().endsWith('print("Mejor:", t(pedidos[0]))')).toBe(true)
    // El arreglo (el acumulador, dentro del bucle) sigue ahí.
    expect(restored).toContain('    for p in ps:\n        acc = 0')
    expect(hasError(restored)).toBe(false)
  })

  it('si la orden no pedía quitar nada, el programa no pierde sus datos ni su programa principal', async () => {
    const { host, state } = stage(PEDIDOS)
    const outcome = await modify(
      host,
      { decider: localDecider(), provider: ai(SOLO_FUNCIONES) },
      { command: 'hay algo raro con el total, arréglalo', whole: true },
    )
    expect(outcome.trouble).toBeNull()
    expect(state.text).toContain('pedidos = [')
    expect(state.text).toContain('for c, tot in r(pedidos):')
    expect(state.text).toContain('        acc = 0\n        for a in p["articulos"]:')
  })

  it('lo que cambia de nombre no se ha perdido: al renombrar no vuelve la versión vieja', () => {
    // Lo que pasó de verdad tras «ponle nombres más claros»: la IA renombró bien, y la versión vieja de cada
    // función «volvía a su sitio», duplicando el programa.
    const renamed = PEDIDOS.replace(/\bt\(/g, 'total_articulos(')
      .replace(/\br\(/g, 'resumen_pedidos(')
      .replace(/\bacc\b/g, 'acumulado')
    expect(lostBlocks(PEDIDOS, renamed)).toEqual([])
    expect(restoreLost(PEDIDOS, renamed).trimEnd()).toBe(
      topBlocks(renamed)
        .map((block) => block.text)
        .join('\n\n'),
    )
  })

  it('lo que pasa a estar dentro de otra cosa no se ha perdido: no vuelve duplicado', () => {
    // De una sesión real: «que tenga solo 7 intentos». La IA cambió el mensaje final por un si/si no (bien
    // hecho), y el mensaje viejo «volvía a su sitio»: el juego decía «¡Correcto!» siempre.
    const antes = lines(
      'intentos = 7',
      'while intentos > 0:',
      '    intentos -= 1',
      '',
      '# Finalizar partida',
      'print("¡Correcto! El número era", numero_secreto)',
    )
    const despues = lines(
      'intentos = 7',
      'while intentos > 0:',
      '    intentos -= 1',
      '',
      '# Finalizar partida',
      'if intento == numero_secreto:',
      '    print("¡Correcto! El número era", numero_secreto)',
      'else:',
      '    print("Se acabaron los intentos.")',
    )
    expect(lostBlocks(antes, despues)).toEqual([])
    expect(restoreLost(antes, despues).match(/Correcto/g)).toHaveLength(1)
  })

  it('si la orden sí pedía quitarlo, se quita', async () => {
    const { host, state } = stage(PEDIDOS)
    await modify(
      host,
      { decider: localDecider(), provider: ai(SOLO_FUNCIONES) },
      { command: 'quita los datos de ejemplo y lo que los imprime', whole: true },
    )
    expect(state.text).not.toContain('pedidos = [')
  })
})

describe('el comentario que repite al rótulo de su etapa', () => {
  const clean = (source: string) => applyEdits(source, echoEdits(source))

  it('se quita la segunda línea cuando dice lo mismo que el rótulo', () => {
    // Tal como quedó en una sesión real.
    const source = lines(
      '# Entrada de datos: pedir gastos al usuario',
      '# Pedir gastos al usuario',
      'gastos = []',
      '',
      '# Cálculo de total: sumar los gastos',
      '# Calcular el total',
      'total = sum(gastos)',
      '',
      '# Finalizar partida: mensaje de acierto o fin',
      '# Finalizar partida',
      'print(total)',
    )
    expect(clean(source)).toBe(
      lines(
        '# Entrada de datos: pedir gastos al usuario',
        'gastos = []',
        '',
        '# Cálculo de total: sumar los gastos',
        'total = sum(gastos)',
        '',
        '# Finalizar partida: mensaje de acierto o fin',
        'print(total)',
      ),
    )
  })

  it('un comentario que dice otra cosa, o que no va bajo un rótulo, se queda', () => {
    const source = lines(
      '# Preparar: los datos de entrada',
      '# Ojo: los precios van sin impuestos',
      'precios = [1, 2]',
      '# Un comentario suelto',
      '# y su segunda línea',
      'x = 1',
    )
    expect(clean(source)).toBe(source)
  })
})
