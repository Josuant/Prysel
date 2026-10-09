import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildProgram, createPythonParser, type Program } from '@prysel/python'
import type { AiProvider } from '../src/ai/provider.ts'
import { functionsIn } from '../src/gist/facts.ts'
import { GistCache, gistsOf, invent, unrunnable, validCall, withCall } from '../src/gist/gist.ts'
import { candidateRules, pickRule, testOf, verifiedRules } from '../src/gist/patterns.ts'
import { bestSample, samplesIn } from '../src/gist/sample.ts'
import {
  matrixOf,
  parseCall,
  parseLiteral,
  showValue,
  valueOf,
  type Value,
} from '../src/gist/value.ts'
import type { Decider } from '../src/jev/client.ts'
import { Kernel } from '../src/kernel.ts'
import { sampleScene } from '../webview/src/gisting.ts'
import type { Trace } from '../src/trace.ts'

/**
 * «Qué hace»: de cada función, una vez que se ejecutó de verdad. Lo que entra puede proponerlo una IA; lo que
 * sale lo dice el programa. Aquí la IA es de mentira y el Python es de verdad.
 */

const require = createRequire(import.meta.url)
const wasmDir = path.dirname(require.resolve('@vscode/tree-sitter-wasm/wasm/tree-sitter.js'))
const python = process.env['PRYSEL_PYTHON'] ?? 'python'
const available = spawnSync(python, ['-c', 'import sys'], { stdio: 'ignore' }).status === 0

let parse: (source: string) => Program
beforeAll(async () => {
  const parser = await createPythonParser({
    runtime: wasmDir,
    language: path.join(wasmDir, 'tree-sitter-python.wasm'),
  })
  parse = (source: string) => buildProgram(parser.parse(source), source)
}, 30_000)

const lines = (...rows: string[]) => `${rows.join('\n')}\n`
const must = <T>(value: T | null | undefined): T => {
  if (value === null || value === undefined) throw new Error('falta')
  return value
}
const shown = (value: Value | undefined) => (value === undefined ? undefined : showValue(value))

const TABLERO = lines(
  'def mostrar_tablero(tablero):',
  '    for fila in tablero:',
  '        linea = ""',
  '        for celda in fila:',
  '            if celda == 1:',
  '                linea += "*"',
  '            else:',
  '                linea += "."',
  '        print(linea)',
  '    print()',
)

const CALCULADORA = lines(
  'class Calculadora:',
  '    def sumar(self, a, b):',
  '        return a + b',
  '',
  '',
  'calculadora = Calculadora()',
  'print(calculadora.sumar(3, 4))',
)

const CAJERO = lines(
  'class Cajero:',
  '    def __init__(self):',
  '        self.estado = "Esperando Tarjeta"',
  '        self.intentos = 0',
  '',
  '    def insertar_tarjeta(self):',
  '        self.estado = "Pidiendo PIN"',
  '',
  '    def validar_pin(self, pin):',
  '        if self.estado == "Tarjeta Bloqueada":',
  '            return False',
  '        if pin == "1234":',
  '            self.estado = "Menú Principal"',
  '            self.intentos = 0',
  '            return True',
  '        self.intentos += 1',
  '        if self.intentos >= 3:',
  '            self.estado = "Tarjeta Bloqueada"',
  '        return False',
)

const ZOO = lines(
  'class Animal:',
  '    def __init__(self, nombre):',
  '        self.nombre = nombre',
  '',
  '',
  'class Perro(Animal):',
  '    def ladrar(self):',
  '        print("Guau")',
  '',
  '    def calcular_edad(self, anios):',
  '        return anios * 7',
  '',
  '',
  'perro = Perro("Toby")',
  'edad = perro.calcular_edad(3)',
  'print(edad)',
)

const UTILES = lines(
  'def ordenar(numeros):',
  '    numeros.sort()',
  '',
  '',
  'def pares(numeros):',
  '    return [n for n in numeros if n % 2 == 0]',
  '',
  '',
  'def dividir(a, b):',
  '    return a / b',
  '',
  '',
  'def saludar():',
  '    nombre = input("¿Cómo te llamas? ")',
  '    print("Hola", nombre)',
)

/** Lo mismo, sin la función que pide datos por teclado. */
const SIN_TECLADO = must(UTILES.split('def saludar')[0])

/** Lo que una IA propondría para probar cada función. */
const PROPOSED: Record<string, string> = {
  mostrar_tablero: 'mostrar_tablero([[0, 1, 0], [1, 1, 0], [0, 0, 1]])',
  insertar_tarjeta: 'Cajero().insertar_tarjeta()',
  validar_pin: 'Cajero().validar_pin("1234")',
  ladrar: 'Perro("Luna").ladrar()',
  ordenar: 'ordenar([5, 3, 8, 1])',
  pares: '```python\npares([1, 2, 3, 4, 5, 6])\n```',
  dividir: 'dividir(1, 0)',
  fact: 'fact(4)',
}
const provider: AiProvider = {
  id: 'mentira',
  generate: (request) => {
    const name = /(?:función|método) «(\w+)»/.exec(request.prompt)?.[1] ?? ''
    return Promise.resolve(PROPOSED[name] ?? 'no sé')
  },
}

describe('leer un valor de Python con su forma', () => {
  it('una rejilla es una lista de listas del mismo largo', () => {
    const value = valueOf('[[0, 1, 0], [1, 1, 0]]')
    expect(matrixOf(value)?.map((row) => row.map((cell) => showValue(cell)))).toEqual([
      ['0', '1', '0'],
      ['1', '1', '0'],
    ])
    expect(matrixOf(valueOf('[[0, 1], [1]]'))).toBeNull()
    expect(matrixOf(valueOf({ l: [1, 2], n: 2, t: 'list' }))).toBeNull()
  })

  it('textos, diccionarios, tuplas, conjuntos y lo que el motor recortó', () => {
    expect(showValue(valueOf("{'a': 1, 'b': [True, None]}"))).toBe("{'a': 1, 'b': [True, None]}")
    expect(showValue(valueOf("('x', -2.5)"))).toBe("('x', -2.5)")
    expect(valueOf('{1, 2}')).toMatchObject({ kind: 'list', shape: 'set' })
    expect(valueOf('[0, 1, 2, ...]')).toMatchObject({ kind: 'list', more: true })
    expect(valueOf("'con, coma y ] dentro'")).toMatchObject({ kind: 'atom', type: 'text' })
  })

  it('lo que no es un literal entero no se adivina: queda como texto', () => {
    expect(valueOf('<__main__.Perro object at 0x10>')).toEqual({
      kind: 'opaque',
      text: '<__main__.Perro object at 0x10>',
    })
    expect(valueOf('[[0, 1, 0], [1, 1…')).toMatchObject({ kind: 'opaque' })
    expect(parseLiteral('[1, 2, ...]', true)).toBeNull()
  })
})

describe('la llamada de prueba solo puede llevar literales', () => {
  it('una función, o crear un objeto y llamar a su método', () => {
    expect(parseCall('f(1, [2, 3], modo="a")')).toMatchObject({ name: 'f' })
    expect(parseCall('Cajero().validar_pin("1234")')).toMatchObject({
      name: 'Cajero',
      method: 'validar_pin',
    })
  })

  it('ni nombres, ni otras llamadas, ni operaciones, ni dos sentencias', () => {
    for (const bad of [
      'f(x)',
      'f(open("a"))',
      'f(1 + 2)',
      'f(1); g(2)',
      'f(1)\nimport os',
      'a.b.c(1)',
      'f(__import__("os"))',
      'f(1).g(2).h(3)',
      'f(a == 1)',
      'print(1)',
    ])
      expect(
        validCall(bad, must(functionsIn(parse('def f(a):\n    return a\n'))[0])),
        bad,
      ).toBeNull()
  })

  it('tiene que ser la función que se pidió', () => {
    const sumar = must(functionsIn(parse(CALCULADORA))[0])
    expect(validCall('Calculadora().sumar(1, 2)', sumar)).toBe('Calculadora().sumar(1, 2)')
    expect(validCall('sumar(1, 2)', sumar)).toBeNull()
    expect(validCall('Otra().sumar(1, 2)', sumar)).toBeNull()
  })

  it('va al final del programa, en una línea que se conoce', () => {
    const { code, line } = withCall('a = 1\nb = 2\n\n', 'f(1)')
    expect(code.split('\n')[line - 1]).toBe('f(1)')
  })
})

describe('las reglas que deja leer el código', () => {
  it('una decisión cuyas ramas hacen lo mismo con un literal distinto', () => {
    expect(candidateRules(TABLERO)).toEqual([
      {
        subject: 'celda',
        cases: [
          { when: '1', gives: '"*"' },
          { when: null, gives: '"."' },
        ],
      },
    ])
    const three = lines(
      'if n == 1:',
      '    print("uno", end="")',
      'elif n == 2:',
      '    print("dos", end="")',
      'else:',
      '    print("muchos", end="")',
    )
    expect(candidateRules(three)[0]?.cases.map((entry) => entry.gives)).toEqual([
      '"uno"',
      '"dos"',
      '"muchos"',
    ])
  })

  it('una condición sencilla se sabe evaluar; lo demás, no se adivina', () => {
    expect(testOf('n % 2 == 0')?.('4')).toBe(true)
    expect(testOf('n % 2 == 0')?.('-3')).toBe(false)
    expect(testOf('x > 3')?.('3')).toBe(false)
    expect(testOf('celda == 1')?.('1')).toBe(true)
    expect(testOf("letra != 'a'")?.('b')).toBe(true)
    expect(testOf('not x')?.('0')).toBe(true)
    expect(testOf('es_primo(n)')).toBeNull()
    expect(testOf('a > 1 and a < 5')).toBeNull()
  })

  it('si las ramas no hacen lo mismo, o hacen más de una cosa, no es una regla', () => {
    expect(candidateRules(lines('if a == 1:', '    x = 1', 'else:', '    y = 2'))).toEqual([])
    expect(
      candidateRules(lines('if a == 1:', '    x = 1', '    z = 3', 'else:', '    x = 2')),
    ).toEqual([])
    expect(candidateRules(lines('if a == 1:', '    x = 1'))).toEqual([])
  })
})

describe('lo que se sabe de una función sin ejecutarla', () => {
  it('qué recibe, qué deja y de quién es', () => {
    const facts = functionsIn(parse(ZOO))
    expect(facts.map((f) => [f.owner, f.name, f.takes, f.returns, f.prints])).toEqual([
      ['Perro', 'ladrar', [], false, true],
      ['Perro', 'calcular_edad', ['anios'], true, false],
    ])
  })

  it('cambia de resumen cuando cambia su texto, y solo entonces', () => {
    const [a] = functionsIn(parse(TABLERO))
    const [b] = functionsIn(parse(`# otra cosa\n${TABLERO}`))
    const [c] = functionsIn(parse(TABLERO.replace('"*"', '"#"')))
    expect(b?.hash).toBe(a?.hash)
    expect(c?.hash).not.toBe(a?.hash)
  })

  it('un programa que pide datos por teclado no se ejecuta solo', () => {
    expect(unrunnable(UTILES)).toBe('Pide datos por teclado.')
    expect(unrunnable('import os\n')).not.toBeNull()
    expect(unrunnable('print("input(")\n')).toBeNull()
  })
})

describe.skipIf(!available)('la muestra: lo que pasó al ejecutarla de verdad', () => {
  let kernel: Kernel
  beforeAll(async () => {
    kernel = await Kernel.start({ python })
  }, 30_000)
  afterAll(() => {
    kernel.dispose()
  })
  const port = () => ({ provider, trace: (code: string): Promise<Trace> => kernel.trace(code) })
  const one = (program: Program, name: string) =>
    must(functionsIn(program).find((f) => f.name === name))

  it('lo que el programa ya llama sale de su propia traza: entra, devuelve, imprime', async () => {
    const program = parse(ZOO)
    const gists = gistsOf(program, await kernel.trace(ZOO))
    const edad = gists.find((gist) => gist.name === 'calcular_edad')
    expect(edad?.status).toBe('ok')
    expect(edad?.sample?.invented).toBe(false)
    expect(edad?.sample?.inputs.map((i) => [i.name, showValue(i.value)])).toEqual([['anios', '3']])
    expect(shown(edad?.sample?.returned)).toBe('21')
    // A `ladrar` no la llama nadie.
    expect(gists.find((gist) => gist.name === 'ladrar')).toMatchObject({
      status: 'sin-muestra',
      why: 'Nadie la llama.',
    })
  })

  it('una rejilla entra y sale lo que de verdad se imprimió', async () => {
    const program = parse(TABLERO)
    const gist = await invent(program, one(program, 'mostrar_tablero'), port())
    expect(gist.status).toBe('ok')
    expect(gist.sample?.invented).toBe(true)
    expect(gist.sample?.call).toBe(PROPOSED['mostrar_tablero'])
    expect(matrixOf(must(gist.sample?.inputs[0]).value)).toHaveLength(3)
    expect(gist.sample?.printed).toBe('.*.\n**.\n..*\n\n')
    expect(gist.sample?.returned).toBeUndefined()
  })

  it('en modo ancho, una rejilla de 5×5 llega entera (y sin él, recortada, como siempre)', async () => {
    const source = lines(
      'def ver(tablero):',
      '    return len(tablero)',
      '',
      'ver([[0, 0, 0, 0, 0], [0, 0, 1, 0, 0], [0, 0, 1, 0, 0], [0, 0, 1, 0, 0], [0, 0, 0, 0, 0]])',
    )
    const program = parse(source)
    const grid = (trace: Trace) =>
      matrixOf(must(bestSample(samplesIn(trace, one(program, 'ver')))?.inputs[0]).value)
    expect(grid(await kernel.trace(source))).toBeNull()
    expect(grid(await kernel.trace(source, 20_000, false, true))).toHaveLength(5)
  })

  it('la regla del tablero se lee del código y la muestra la confirma', async () => {
    const program = parse(TABLERO)
    const gist = await invent(program, one(program, 'mostrar_tablero'), port())
    expect(gist.rule).toEqual({
      kind: 'cases',
      via: [1, 0, 1, 0, 0, 1, 1, 1, 0],
      subject: 'celda',
      cases: [
        { when: '1', gives: '"*"' },
        { when: null, gives: '"."' },
      ],
      input: 'tablero',
      each: true,
    })
    expect(sampleScene(gist)?.lanes.map((lane) => lane.map((piece) => piece.type))).toEqual([
      ['datum'],
      ['rule'],
      ['console'],
    ])
  })

  it('también escrita en una línea, y devolviendo en vez de imprimir', async () => {
    const source = lines(
      'def simbolos(celdas):',
      '    return ["#" if celda == 1 else " " for celda in celdas]',
    )
    const program = parse(source)
    const gist = await invent(program, one(program, 'simbolos'), {
      ...port(),
      provider: { id: 'm', generate: () => Promise.resolve('simbolos([1, 0, 1])') },
    })
    expect(gist.rule?.kind === 'cases' && gist.rule.cases).toEqual([
      { when: '1', gives: '"#"' },
      { when: null, gives: '" "' },
    ])
  })

  it('una regla que no explica lo que salió no se enseña', async () => {
    // Las ramas dan un símbolo, pero luego la línea se invierte: la regla sola no da la salida.
    const source = TABLERO.replace('print(linea)', 'print(linea[::-1])')
    const program = parse(source)
    const gist = await invent(program, one(program, 'mostrar_tablero'), port())
    expect(gist.status).toBe('ok')
    expect(gist.rule).toBeUndefined()
    expect(sampleScene(gist)?.lanes).toHaveLength(2)
  })

  const ruled = async (source: string, name: string, call: string) => {
    const program = parse(source)
    return invent(program, one(program, name), {
      ...port(),
      provider: { id: 'm', generate: () => Promise.resolve(call) },
    })
  }

  it('quedarse con algunos: lo que sale es parte de lo que entró, y se sabe cuáles', async () => {
    const gist = await ruled(SIN_TECLADO, 'pares', 'pares([1, 2, 3, 4, 5, 6])')
    expect(gist.rule).toEqual({
      kind: 'filter',
      input: 'numeros',
      condition: 'n % 2 == 0',
      keeps: [false, true, false, true, false, true],
    })
    // El recorrido: cada elemento pasa la prueba, y los que se quedan aparecen en la salida a su paso.
    const scene = sampleScene(gist)
    expect(scene?.beats).toBe(6)
    expect(scene?.lanes[1]).toMatchObject([{ type: 'test', text: 'n % 2 == 0' }])
    expect(scene?.lanes[2]).toMatchObject([{ type: 'datum', beats: [1, 3, 5], arrives: true }])
  })

  it('sumar, contar los que cumplen algo, y el mayor: la cuenta que se va llevando', async () => {
    const source = lines(
      'def total(precios):',
      '    suma = 0',
      '    for precio in precios:',
      '        suma += precio',
      '    return suma',
      '',
      '',
      'def contar_vivas(tablero):',
      '    vivas = 0',
      '    for fila in tablero:',
      '        for celda in fila:',
      '            if celda == 1:',
      '                vivas += 1',
      '    return vivas',
      '',
      '',
      'def mayor(numeros):',
      '    mejor = numeros[0]',
      '    for n in numeros:',
      '        if n > mejor:',
      '            mejor = n',
      '    return mejor',
    )
    const total = await ruled(source, 'total', 'total([3, 4, 5])')
    expect(total.rule).toMatchObject({ kind: 'fold', op: 'sum', running: ['3', '7', '12'] })
    const vivas = await ruled(source, 'contar_vivas', 'contar_vivas([[0, 1, 0], [1, 1, 0]])')
    expect(vivas.rule).toMatchObject({
      kind: 'fold',
      op: 'count-if',
      condition: '== 1',
      running: ['0', '1', '1', '2', '3', '3'],
      counts: [false, true, false, true, true, false],
    })
    // Escrito largo (`total = total + 1`), como lo escribió una IA de verdad: es la misma cuenta.
    const long = source
      .replace('vivas += 1', 'vivas = vivas + 1')
      .replace('suma += precio', 'suma = suma + precio')
    expect(
      (await ruled(long, 'contar_vivas', 'contar_vivas([[0, 1], [1, 1]])')).rule,
    ).toMatchObject({
      op: 'count-if',
      running: ['0', '1', '2', '3'],
    })
    expect((await ruled(long, 'total', 'total([3, 4])')).rule).toMatchObject({ op: 'sum' })
    const mayor = await ruled(source, 'mayor', 'mayor([3, 9, 2, 7])')
    expect(mayor.rule).toMatchObject({ kind: 'fold', op: 'max', running: ['3', '9', '9', '9'] })
    expect(sampleScene(mayor)?.lanes[2]).toMatchObject([{ beats: [3], arrives: true }])
  })

  it('con varias reglas que la muestra confirma por igual, elige el JEV', async () => {
    // De una lista de un solo elemento, su suma es también su mayor: los datos no deciden.
    const source = lines(
      'def raro(numeros):',
      '    mejor = 0',
      '    for n in numeros:',
      '        if n > mejor:',
      '            mejor += n - mejor',
      '    return mejor',
    )
    const gist = await ruled(source, 'raro', 'raro([5])')
    const rules = verifiedRules(must(functionsIn(parse(source))[0]).code, must(gist.sample))
    expect(rules.map((rule) => rule.kind === 'fold' && rule.op)).toEqual(['sum', 'max'])
    const asked: string[] = []
    const jev = (choice: string, confidence: number): Decider => ({
      id: 'grabado',
      decide: (request) => {
        const question = request.questions['regla']
        asked.push(...Object.values(question?.type === 'choice' ? question.criteria : {}))
        return Promise.resolve({
          ms: 1,
          answers: { regla: { type: 'choice', choice, confidence, probabilities: {} } },
        })
      },
    })
    const fn = { name: 'raro', code: source }
    expect(await pickRule(jev('r2', 0.9), fn, rules)).toMatchObject({ op: 'max' })
    expect(asked).toEqual(['Suma todos los elementos.', 'Busca el mayor.'])
    // Si duda, queda la primera, que también es verdad.
    expect(await pickRule(jev('r2', 0.3), fn, rules)).toMatchObject({ op: 'sum' })
  })

  it('el recorrido del tablero: cada celda por su caso, y su símbolo en su sitio', async () => {
    const program = parse(TABLERO)
    const scene = sampleScene(await invent(program, one(program, 'mostrar_tablero'), port()))
    expect(scene?.beats).toBe(9)
    expect(scene?.lanes[0]).toMatchObject([{ type: 'datum', beats: [0, 1, 2, 3, 4, 5, 6, 7, 8] }])
    expect(scene?.lanes[1]).toMatchObject([{ type: 'rule', via: [1, 0, 1, 0, 0, 1, 1, 1, 0] }])
    // El `print()` del final deja una línea en blanco: no descuadra el recorrido.
    expect(scene?.lanes[2]).toMatchObject([{ type: 'console', beats: true }])
  })

  it('calcular_siguiente: la traza dice por qué camino fue cada celda, y eso es su regla', async () => {
    const source = lines(
      'def contar_vecinos_vivos(tablero, fila, columna):',
      '    vivos = 0',
      '    for df in (-1, 0, 1):',
      '        for dc in (-1, 0, 1):',
      '            f, c = fila + df, columna + dc',
      '            if (df or dc) and 0 <= f < len(tablero) and 0 <= c < len(tablero[0]):',
      '                vivos += tablero[f][c]',
      '    return vivos',
      '',
      '',
      'def esta_viva(tablero, f, c):',
      '    return tablero[f][c] == 1',
      '',
      '',
      'def debe_sobrevivir(vecinos):',
      '    return vecinos == 2 or vecinos == 3',
      '',
      '',
      'def debe_nacer(vecinos):',
      '    return vecinos == 3',
      '',
      '',
      'def calcular_siguiente(tablero):',
      '    filas = len(tablero)',
      '    columnas = len(tablero[0])',
      '    nuevo = [[0] * columnas for _ in range(filas)]',
      '    for f in range(filas):',
      '        for c in range(columnas):',
      '            vecinos = contar_vecinos_vivos(tablero, f, c)',
      '            if esta_viva(tablero, f, c):',
      '                if debe_sobrevivir(vecinos):',
      '                    nuevo[f][c] = 1',
      '            else:',
      '                if debe_nacer(vecinos):',
      '                    nuevo[f][c] = 1',
      '    return nuevo',
    )
    const program = parse(source)
    const blinker =
      '[[0, 0, 0, 0, 0], [0, 0, 1, 0, 0], [0, 0, 1, 0, 0], [0, 0, 1, 0, 0], [0, 0, 0, 0, 0]]'
    const gist = await invent(program, one(program, 'calcular_siguiente'), {
      provider: { id: 'm', generate: () => Promise.resolve(`calcular_siguiente(${blinker})`) },
      trace: (code) => kernel.trace(code, 20_000, false, true),
    })
    expect(shown(gist.sample?.returned)).toBe(
      '[[0, 0, 0, 0, 0], [0, 0, 0, 0, 0], [0, 1, 1, 1, 0], [0, 0, 0, 0, 0], [0, 0, 0, 0, 0]]',
    )
    expect(gist.sample?.paths).toHaveLength(25)
    const rule = gist.rule
    expect(rule?.kind === 'cases' && rule.spoken).toBe(true)
    expect(rule?.kind === 'cases' && rule.cases).toEqual([
      { when: 'no esta_viva y no debe_nacer', gives: '0' },
      { when: 'esta_viva y no debe_sobrevivir', gives: '0' },
      { when: 'no esta_viva y debe_nacer', gives: '1' },
      { when: 'esta_viva y debe_sobrevivir', gives: '1' },
    ])
    // Cada celda, por su camino; y su resultado, en su sitio de la rejilla que sale.
    const scene = sampleScene(gist)
    expect(scene?.beats).toBe(25)
    expect(scene?.lanes[1]).toMatchObject([{ type: 'rule', label: 'cada elemento, según' }])
    expect(scene?.lanes[2]).toMatchObject([{ type: 'datum', arrives: true }])
  })

  it('si el mismo camino da resultados distintos, el camino no es la regla', async () => {
    const source = lines(
      'def dobles(numeros):',
      '    salida = []',
      '    for n in numeros:',
      '        if n > 0:',
      '            salida.append(n * 2)',
      '        else:',
      '            salida.append(0)',
      '    return salida',
    )
    const gist = await ruled(source, 'dobles', 'dobles([1, -2, 3])')
    expect(gist.sample?.paths).toHaveLength(3)
    expect(gist.rule).toBeUndefined()
  })

  it('un método enseña el objeto antes y después', async () => {
    const program = parse(CAJERO)
    const gist = await invent(program, one(program, 'validar_pin'), port())
    expect(shown(gist.sample?.returned)).toBe('True')
    expect(gist.sample?.self?.cls).toBe('Cajero')
    expect(shown(gist.sample?.self?.before['estado'])).toBe("'Esperando Tarjeta'")
    expect(shown(gist.sample?.self?.after['estado'])).toBe("'Menú Principal'")
  })

  it('lo que recibe y deja cambiado, y un error, también son la verdad', async () => {
    const source = SIN_TECLADO
    const program = parse(source)
    const ordenar = await invent(program, one(program, 'ordenar'), port())
    expect(ordenar.sample?.changed?.map((c) => [showValue(c.before), showValue(c.after)])).toEqual([
      ['[5, 3, 8, 1]', '[1, 3, 5, 8]'],
    ])
    const pares = await invent(program, one(program, 'pares'), port())
    expect(shown(pares.sample?.returned)).toBe('[2, 4, 6]')
    const dividir = await invent(program, one(program, 'dividir'), port())
    expect(dividir.sample?.error).toContain('ZeroDivisionError')
    expect(dividir.sample?.returned).toBeUndefined()
  })

  it('de una recursión, la muestra es la llamada de fuera', async () => {
    const source = lines(
      'def fact(n):',
      '    if n <= 1:',
      '        return 1',
      '    return n * fact(n - 1)',
      '',
      'print(fact(4))',
    )
    const program = parse(source)
    const trace = await kernel.trace(source)
    const samples = samplesIn(trace, one(program, 'fact'))
    expect(samples).toHaveLength(1)
    expect(shown(bestSample(samples)?.returned)).toBe('24')
  })

  it('entre varias llamadas, la que más enseña sin dejar de ser pequeña', async () => {
    const source = lines(
      'def fact(n):',
      '    if n <= 1:',
      '        return 1',
      '    return n * fact(n - 1)',
      '',
      'total = 0',
      'for i in range(1, 4):',
      '    total += fact(i)',
    )
    const program = parse(source)
    const best = bestSample(samplesIn(await kernel.trace(source), one(program, 'fact')))
    // `fact(1)` acaba en el primer `return`: se prefiere la que da la vuelta.
    expect(best?.inputs.map((input) => showValue(input.value))).toEqual(['3'])
    expect(shown(best?.returned)).toBe('6')
  })

  it('lo que pide datos por teclado no se prueba; lo que la IA no acierta, tampoco', async () => {
    const program = parse(UTILES)
    expect(await invent(program, one(program, 'pares'), port())).toMatchObject({
      status: 'no-ejecutable',
    })
    const other = parse('def raro(x):\n    return x\n')
    expect(await invent(other, one(other, 'raro'), port())).toMatchObject({
      status: 'sin-muestra',
      why: 'No hubo un ejemplo válido.',
    })
  })

  it('lo calculado vale mientras la función no cambie', async () => {
    const program = parse(TABLERO)
    const cache = new GistCache()
    cache.set(await invent(program, one(program, 'mostrar_tablero'), port()))
    expect(cache.get(one(parse(`x = 1\n${TABLERO}`), 'mostrar_tablero'))?.status).toBe('ok')
    const changed = parse(TABLERO.replace('"*"', '"#"'))
    expect(cache.get(one(changed, 'mostrar_tablero'))).toBeUndefined()
  })

  it('medida: de cuántas funciones del corpus se consigue una muestra', async () => {
    const lesson = (name: string) =>
      readFileSync(path.join(__dirname, '../../../examples/lecciones', name), 'utf8')
    const corpus = [
      TABLERO,
      CALCULADORA,
      CAJERO,
      ZOO,
      SIN_TECLADO,
      lesson('factorial.py'),
      lesson('alias.py'),
      lesson('burbuja.py'),
    ]
    const count = { total: 0, own: 0, invented: 0, none: 0 }
    for (const source of corpus) {
      const program = parse(source)
      for (const gist of gistsOf(program, await kernel.trace(source))) {
        count.total++
        if (gist.status === 'ok') count.own++
        else {
          const facts = must(functionsIn(program).find((f) => f.id === gist.id))
          if ((await invent(program, facts, port())).status === 'ok') count.invented++
          else count.none++
        }
      }
    }
    console.log(
      `«Qué hace»: ${count.total} funciones · ${count.own} con muestra del programa · ` +
        `${count.invented} con muestra propuesta · ${count.none} sin muestra`,
    )
    expect(count.total).toBeGreaterThanOrEqual(10)
    expect(count.none).toBe(0)
  }, 60_000)
})
