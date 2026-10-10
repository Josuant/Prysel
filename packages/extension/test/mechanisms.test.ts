import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildProgram, createPythonParser, type Program } from '@prysel/python'
import { gistSize } from '@prysel/ui'
import { withLaunch } from '../src/gist/entry.ts'
import { functionsIn } from '../src/gist/facts.ts'
import { gistsOf, mixTracer, type Gist } from '../src/gist/gist.ts'
import { tracerCall, verifiedMechanisms } from '../src/gist/mechanisms.ts'
import { ruleTells } from '../src/gist/patterns.ts'
import type { Sample } from '../src/gist/sample.ts'
import { parseLiteral, type Value } from '../src/gist/value.ts'
import { Kernel } from '../src/kernel.ts'
import { sampleScene } from '../webview/src/gisting.ts'

/**
 * Las tarjetas de **mecanismo**: lo que una función hace con lo que recibe, enseñado con sus propios datos. Se
 * comprueba sobre un algoritmo genético ejecutado de verdad: cada mecanismo sale de la muestra y dice lo que
 * pasó, no lo que parece por el código.
 */

const require = createRequire(import.meta.url)
const wasmDir = path.dirname(require.resolve('@vscode/tree-sitter-wasm/wasm/tree-sitter.js'))
const python = process.env['PRYSEL_PYTHON'] ?? 'python'
const available = spawnSync(python, ['-c', 'import sys'], { stdio: 'ignore' }).status === 0
const fixture = (name: string) =>
  readFileSync(path.resolve(__dirname, `fixtures/arch/${name}.py`), 'utf8').replace(/\r\n/g, '\n')

let parse: (source: string) => Program
beforeAll(async () => {
  const parser = await createPythonParser({
    runtime: wasmDir,
    language: path.join(wasmDir, 'tree-sitter-python.wasm'),
  })
  parse = (source: string) => buildProgram(parser.parse(source), source)
}, 30_000)

describe.skipIf(!available)('los mecanismos de un algoritmo genético', () => {
  let kernel: Kernel
  let gists: Gist[]
  beforeAll(async () => {
    kernel = await Kernel.start({ python })
    const source = withLaunch(fixture('genetico'), 'algoritmo_genetico(8, 30)', true)
    const trace = await kernel.trace(source, 20_000, false, true, { seed: 7, finish: true })
    gists = gistsOf(parse(source), trace)
  }, 30_000)
  afterAll(() => {
    kernel.dispose()
  })
  const of = (name: string) => {
    const gist = gists.find((candidate) => candidate.name === name && !candidate.block)
    if (!gist) throw new Error(`sin tarjeta: ${name}`)
    return gist
  }
  const strips = (gist: Gist) => {
    const scene = sampleScene(gist)
    const piece = scene?.lanes.flat().find((found) => found.type === 'strips')
    if (!scene || piece?.type !== 'strips') throw new Error(`sin tiras: ${gist.name}`)
    return { scene, piece }
  }

  it('calcular la aptitud es comparar con un objetivo que no recibe: lo lee del programa', () => {
    const gist = of('calcular_aptitud')
    expect(gist.sample?.reads?.map((read) => read.name)).toContain('objetivo_texto')
    const rule = gist.rule
    if (rule?.kind !== 'match') throw new Error(`regla: ${rule?.kind}`)
    expect(rule.target).toMatchObject({ name: 'objetivo_texto', hidden: true })
    expect(rule.target.cells.join('')).toBe('hola mundo')
    // Lo que devuelve es justo cuántas letras coinciden.
    const same = rule.hits.filter(Boolean).length
    expect(gist.sample?.returned).toMatchObject({ kind: 'atom', text: String(same) })
    const { piece, scene } = strips(gist)
    expect(piece.strips.map((strip) => strip.name)).toEqual(['individuo', 'objetivo_texto'])
    expect(piece.strips[1]?.hidden).toBe(true)
    expect(piece.gauge).toMatchObject({ value: same, of: 10, says: 'coinciden' })
    // Se recorre letra a letra: el medidor va contando y acaba en lo que devuelve.
    expect(scene.beats).toBe(10)
    expect(piece).toMatchObject({ tour: 'columns', reveal: true })
    expect(piece.gauge?.running?.length).toBe(10)
    expect(piece.gauge?.running?.at(-1)).toBe(same)
    // El objetivo no se repite como entrada suelta: ya está en las tiras.
    const labels = scene.lanes
      .flat()
      .flatMap((found) => (found.type === 'datum' ? [found.label] : []))
    expect(labels.some((label) => label?.startsWith('objetivo_texto'))).toBe(false)
  })

  it('cruzar es mezclar: cada letra del hijo viene de un padre o del otro (o es nueva)', () => {
    const gist = of('cruzar_y_mutar')
    const rule = gist.rule
    if (rule?.kind !== 'mix') throw new Error(`regla: ${rule?.kind}`)
    expect([rule.a.name, rule.b.name]).toEqual(['padre1', 'padre2'])
    // Lo dicho de cada letra es verdad, una a una.
    for (const [at, origin] of rule.from.entries()) {
      const cell = rule.out[at]
      if (origin === 'a' || origin === 'both') expect(rule.a.cells[at]).toBe(cell)
      if (origin === 'b' || origin === 'both') expect(rule.b.cells[at]).toBe(cell)
      if (origin === 'new') expect([rule.a.cells[at], rule.b.cells[at]]).not.toContain(cell)
    }
    expect(rule.from).toContain('a')
    expect(rule.from).toContain('b')
    const { piece } = strips(gist)
    expect(piece.strips.map((strip) => strip.name)).toEqual(['padre1', 'padre2', 'devuelve'])
    expect(gist.sample?.chance).toBe(true)
  })

  it('seleccionar es un podio: los dos de mejor nota, con las notas que le dan aparte', () => {
    const gist = of('seleccionar_padres')
    const rule = gist.rule
    if (rule?.kind !== 'podium') throw new Error(`regla: ${rule?.kind}`)
    expect(rule).toMatchObject({ input: 'poblacion', scores: 'aptitudes', order: 'max' })
    const chosen = rule.ranked.filter((entry) => entry.place !== null)
    const out = rule.ranked.filter((entry) => entry.place === null)
    expect(chosen.length).toBe(2)
    const worst = Math.min(...chosen.map((entry) => Number(entry.score)))
    expect(Math.max(...out.map((entry) => Number(entry.score)))).toBeLessThanOrEqual(worst)
    const { piece, scene } = strips(gist)
    // Primero los elegidos, por su puesto; y lo que devuelve sigue a la vista.
    expect(piece.strips.slice(0, 2).map((strip) => strip.place)).toEqual([1, 2])
    expect(piece.strips.slice(2).every((strip) => strip.place === 0)).toBe(true)
    expect(
      scene.lanes.flat().some((found) => found.type === 'datum' && found.label === 'devuelve'),
    ).toBe(true)
  })

  it('generar y reemplazar van llenando una lista: se ve crecer', () => {
    for (const name of ['generar_poblacion', 'reemplazar_poblacion']) {
      const gist = of(name)
      const rule = gist.rule
      if (rule?.kind !== 'build') throw new Error(`${name}: ${rule?.kind}`)
      const sizes = rule.steps.map((step) => step.length)
      expect(sizes).toEqual([...sizes].sort((a, b) => a - b))
      expect(sizes[sizes.length - 1]).toBe(8)
      const { piece } = strips(gist)
      expect(piece.label).toMatch(/se va llenando$/)
    }
    expect(of('generar_poblacion').sample?.chance).toBe(true)
  })

  it('una función que el programa no llama lo dice en su tarjeta', () => {
    const gist = of('calcular_aptitud')
    expect(sampleScene(gist)?.unused).toBeUndefined()
    expect(sampleScene({ ...gist, unused: true })?.unused).toBe(true)
  })

  it('toda tarjeta mide algo razonable, con mecanismo o sin él', () => {
    for (const gist of gists.filter((candidate) => !candidate.block && candidate.sample)) {
      const scene = sampleScene(gist)
      if (!scene) continue
      const size = gistSize(scene)
      expect(size.w, gist.name).toBeGreaterThan(0)
      // (Una lista de textos largos ya era ancha antes de los mecanismos: eso no se mide aquí.)
      expect(size.w, gist.name).toBeLessThan(1200)
      // Lo que lee del programa va marcado, no con un rótulo largo que ensanche la tarjeta.
      for (const piece of scene.lanes.flat()) {
        if (piece.type === 'datum' && piece.hidden) expect(piece.label).not.toMatch(/programa/)
      }
    }
  })
})

describe.skipIf(!available)('la muestra que se enseña es la que mejor cuenta el mecanismo', () => {
  let kernel: Kernel
  beforeAll(async () => {
    kernel = await Kernel.start({ python })
  }, 30_000)
  afterAll(() => {
    kernel.dispose()
  })
  const lines = (...rows: string[]) => rows.join('\n') + '\n'

  it('una mutación que casi nunca cambia nada se enseña con una vez en que sí cambió', async () => {
    const source = lines(
      'import random',
      '',
      '# Mutar: cambia algún gen, de vez en cuando',
      'def mutar(cromosoma, probabilidad):',
      '    return [1 - gen if random.random() < probabilidad else gen for gen in cromosoma]',
      '',
      '# Probar: muchas veces',
      'for _ in range(30):',
      '    mutar([0, 1, 1, 0, 1, 0, 0, 1], 0.06)',
    )
    const trace = await kernel.trace(source, 20_000, false, true, { seed: 3 })
    const gist = gistsOf(parse(source), trace).find((found) => found.name === 'mutar')
    // De las treinta veces, la mayoría no cambió nada; se enseña una en la que se ve el retoque.
    expect(gist?.rule).toMatchObject({ kind: 'tweak', input: 'cromosoma' })
    const changed = gist?.rule?.kind === 'tweak' ? gist.rule.changed.filter(Boolean).length : 0
    expect(changed).toBeGreaterThan(0)
    const scene = gist ? sampleScene(gist) : null
    // Y se recorre posición a posición: lo que sale llega cuando le toca.
    expect(scene?.beats).toBe(8)
    const piece = scene?.lanes.flat().find((found) => found.type === 'strips')
    expect(piece).toMatchObject({ tour: 'columns' })
    expect(piece?.type === 'strips' && piece.strips[1]?.arrives).toBe(true)
  })

  it('una mezcla de dos padres que se parecen se vuelve a ver con datos trazadores', async () => {
    const source = lines(
      '# Cruzar: el principio de uno y el final del otro',
      'def cruzar(padre, madre, punto):',
      '    return padre[:punto] + madre[punto:]',
      '',
      'hijo = cruzar([1, 1, 0, 1, 1, 1, 0, 1], [1, 1, 1, 1, 1, 0, 0, 1], 3)',
      'print(hijo)',
    )
    const program = parse(source)
    const trace = await kernel.trace(source, 20_000, false, true)
    const gist = gistsOf(program, trace).find((found) => found.name === 'cruzar')
    const rule = gist?.rule
    if (!gist || rule?.kind !== 'mix' || !gist.sample) throw new Error(`regla: ${rule?.kind}`)
    // En la muestra, casi todo es «de cualquiera de los dos».
    expect(rule.from.filter((origin) => origin === 'both').length).toBeGreaterThanOrEqual(5)
    // La llamada trazadora: los dos padres, del todo distintos; lo demás, igual.
    expect(tracerCall('cruzar', gist.sample, rule)).toBe(
      'cruzar([1, 1, 1, 1, 1, 1, 1, 1], [0, 0, 0, 0, 0, 0, 0, 0], 3)',
    )
    const [facts] = functionsIn(program)
    if (!facts) throw new Error('sin función')
    const tracer = await mixTracer(program, facts, gist, (code) => kernel.trace(code))
    // Ejecutada de verdad: ahí sí se ve dónde corta.
    expect(tracer?.from).toEqual(['a', 'a', 'a', 'b', 'b', 'b', 'b', 'b'])
    const scene = sampleScene({ ...gist, ...(tracer ? { tracer } : {}) })
    const labels = scene?.lanes
      .flat()
      .flatMap((found) => (found.type === 'strips' ? [found.label] : []))
    expect(labels).toEqual(['mezcla', 'otra vez, con datos que se distinguen'])
    // Una mezcla que ya se deja ver no necesita trazadores.
    const clear = {
      ...rule,
      from: rule.from.map((origin, at) => (at < 3 ? 'a' : 'b') as typeof origin),
    }
    expect(tracerCall('cruzar', gist.sample, clear)).toBeNull()
  })

  it('cuánto enseña una regla: nada, algo, o más cuanto más deja ver', () => {
    const mix = (from: string) => ({
      kind: 'mix' as const,
      input: 'a',
      a: { name: 'a', cells: [...from] },
      b: { name: 'b', cells: [...from] },
      out: [...from],
      from: [...from].map(
        (letter) => (letter === 'a' ? 'a' : letter === 'b' ? 'b' : 'both') as 'a' | 'b' | 'both',
      ),
    })
    expect(ruleTells(null)).toBe(0)
    expect(ruleTells(mix('aaabbb'))).toBeGreaterThan(ruleTells(mix('a....b')))
  })
})

describe('un mecanismo solo vale si la muestra lo confirma', () => {
  const value = (text: string): Value => parseLiteral(text) ?? { kind: 'opaque', text }
  const sample = (
    inputs: Record<string, string>,
    returned: string,
    more: Partial<Sample> = {},
  ): Sample => ({
    inputs: Object.entries(inputs).map(([name, text]) => ({ name, value: value(text) })),
    returned: value(returned),
    steps: 10,
    lines: 4,
    invented: false,
    ...more,
  })
  const kinds = (code: string, taken: Sample) =>
    verifiedMechanisms(code, taken).map((rule) => rule.kind)

  it('una mezcla necesita que aporten los dos, y que lo nuevo sea poco', () => {
    const code = 'def cruzar(a, b):\n    return a[:2] + b[2:]'
    expect(kinds(code, sample({ a: '[1, 1, 1, 1]', b: '[0, 0, 0, 0]' }, '[1, 1, 0, 0]'))).toEqual([
      'mix',
    ])
    // Una copia de uno de los dos no es una mezcla.
    expect(kinds(code, sample({ a: '[1, 1, 1, 1]', b: '[0, 0, 0, 0]' }, '[1, 1, 1, 1]'))).toEqual(
      [],
    )
    // Si casi nada viene de ellos, tampoco.
    expect(kinds(code, sample({ a: '[1, 1, 1, 1]', b: '[0, 0, 0, 0]' }, '[1, 7, 8, 0]'))).toEqual(
      [],
    )
  })

  it('una comparación necesita que el número cuadre y que el código compare', () => {
    const code = 'def aciertos(x, y):\n    return sum(1 for a, b in zip(x, y) if a == b)'
    const taken = sample({ x: "'casa'", y: "'cosa'" }, '3')
    expect(kinds(code, taken)).toEqual(['match'])
    // Otro número no es «cuántas coinciden».
    expect(kinds(code, sample({ x: "'casa'", y: "'cosa'" }, '2'))).toEqual([])
    // Y sin comparar nada, que cuadre es casualidad.
    expect(kinds('def f(x, y):\n    return len(x) - 1', taken)).toEqual([])
    // Las que no coinciden, si eso es lo que cuenta.
    const distance = 'def distancia(x, y):\n    return sum(1 for a, b in zip(x, y) if a != b)'
    const [found] = verifiedMechanisms(distance, sample({ x: "'casa'", y: "'cosa'" }, '1'))
    expect(found).toMatchObject({ kind: 'match', counts: 'different' })
  })

  it('un podio necesita que los elegidos sean de verdad los mejores', () => {
    const code = 'def mejores(xs):\n    return sorted(xs)[-2:]'
    expect(kinds(code, sample({ xs: '[3, 9, 1, 7]' }, '[7, 9]'))).toEqual(['podium'])
    // Dos cualesquiera no son un podio.
    expect(kinds(code, sample({ xs: '[3, 9, 1, 7]' }, '[3, 1]'))).toEqual(['podium'])
    expect(verifiedMechanisms(code, sample({ xs: '[3, 9, 1, 7]' }, '[3, 1]'))[0]).toMatchObject({
      order: 'min',
    })
    expect(kinds(code, sample({ xs: '[3, 9, 1, 7]' }, '[3, 9]'))).toEqual([])
    // Si se devuelven todos, no hay nadie a quien ganar.
    expect(kinds(code, sample({ xs: '[3, 9]' }, '[3, 9]'))).toEqual([])
  })

  it('las notas de un podio pueden ser las que la función calcula dentro', () => {
    const code =
      'def seleccion(poblacion, cantidad):\n    notas = [sum(x) for x in poblacion]\n    ...'
    const inputs = { poblacion: '[[0, 1], [1, 1], [0, 0]]', cantidad: '2' }
    const taken = sample(inputs, '[[1, 1], [0, 1]]', {
      made: [{ name: 'notas', value: value('[1, 2, 0]') }],
    })
    const [found] = verifiedMechanisms(code, taken)
    expect(found).toMatchObject({
      kind: 'podium',
      input: 'poblacion',
      scores: 'notas',
      order: 'max',
    })
    expect(found?.kind === 'podium' && found.ranked.map((entry) => entry.place)).toEqual([
      2,
      1,
      null,
    ])
    // Sin esas notas no hay manera de comprobar que son los mejores: no se dice.
    expect(kinds(code, sample(inputs, '[[1, 1], [0, 1]]'))).toEqual([])
  })

  it('un retoque cambia unos pocos elementos de lo único que recibe', () => {
    const code = 'def mutar(cromosoma, probabilidad): ...'
    const taken = sample(
      { cromosoma: '[0, 1, 1, 0, 1, 0]', probabilidad: '0.1' },
      '[0, 1, 0, 0, 1, 0]',
    )
    const [found] = verifiedMechanisms(code, taken)
    expect(found).toMatchObject({
      kind: 'tweak',
      input: 'cromosoma',
      changed: [false, false, true, false, false, false],
    })
    // Sin cambios es una copia; con casi todo cambiado, otra cosa.
    const same = sample({ cromosoma: '[0, 1, 1, 0]', probabilidad: '0.1' }, '[0, 1, 1, 0]')
    expect(kinds(code, same)).toEqual([])
    const other = sample({ cromosoma: '[0, 1, 1, 0]', probabilidad: '0.9' }, '[1, 0, 0, 1]')
    expect(kinds(code, other)).toEqual([])
  })

  it('una lista que crece necesita crecer siempre sin tocar lo que ya tenía', () => {
    const steps = (texts: string[]) => texts.map(value)
    const grown = sample({ n: '3' }, '[1, 2, 3]', {
      built: { name: 'lista', steps: steps(['[]', '[1]', '[1, 2]', '[1, 2, 3]']) },
    })
    expect(kinds('def f(n): ...', grown)).toEqual(['build'])
    const shuffled = sample({ n: '3' }, '[3, 1, 2]', {
      built: { name: 'lista', steps: steps(['[1]', '[2, 1]', '[3, 1, 2]']) },
    })
    expect(kinds('def f(n): ...', shuffled)).toEqual([])
  })
})
