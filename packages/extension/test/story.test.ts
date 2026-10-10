import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildProgram, createPythonParser, type Program } from '@prysel/python'
import { withLaunch } from '../src/gist/entry.ts'
import { storyOf } from '../src/gist/story.ts'
import { layoutArchitecture } from '@prysel/spatial'
import { architectureOf, moduleGraph, toCanvasNodes, withSections, withStory } from '@prysel/ui'
import { moduleStory } from '../webview/src/outcome.ts'
import { Kernel } from '../src/kernel.ts'

/**
 * La historia de una ejecución: qué pasa en cada vuelta y en qué orden, qué se hizo antes de empezar, y qué
 * viaja de un paso al siguiente. Sale de la traza, no de quién llama a quién.
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

describe.skipIf(!available)('la historia de un programa que se repite', () => {
  let kernel: Kernel
  beforeAll(async () => {
    kernel = await Kernel.start({ python })
  }, 30_000)
  afterAll(() => {
    kernel.dispose()
  })

  const GENETICO = withLaunch(fixture('genetico'), 'algoritmo_genetico(8, 30)', true)

  it('el algoritmo genético: lo de antes, la vuelta en su orden, y lo que viaja', async () => {
    const trace = await kernel.trace(GENETICO, 20_000, false, true, { seed: 7, finish: true })
    const story = storyOf(parse(GENETICO), trace)
    expect(story).not.toBeNull()
    // El bucle que lo lleva es el de las generaciones, no el de dentro de «reemplazar».
    expect(story?.loop.head).toBe('for _ in range(generaciones)')
    expect(story?.loop.laps).toBeGreaterThan(1)
    // Generar la población ocurre una vez, antes: no es un paso de la vuelta.
    expect(story?.before).toEqual(['generar_poblacion'])
    // La vuelta, en el orden en que pasa de verdad: también lo que llama «reemplazar» por dentro.
    expect(story?.ring).toEqual([
      'evaluar_poblacion',
      'calcular_aptitud',
      'reemplazar_poblacion',
      'seleccionar_padres',
      'cruzar_y_mutar',
    ])
    const flows = (story?.flows ?? []).map((flow) => `${flow.from} → ${flow.to}: ${flow.name}`)
    // La población recién generada entra a evaluarse; las notas van a reponer; los padres, a cruzarse; y la
    // población nueva vuelve a evaluarse en la vuelta siguiente.
    expect(flows).toEqual(
      expect.arrayContaining([
        'generar_poblacion → evaluar_poblacion: poblacion',
        'evaluar_poblacion → reemplazar_poblacion: aptitudes',
        'seleccionar_padres → cruzar_y_mutar: padre1',
        'reemplazar_poblacion → evaluar_poblacion: poblacion',
      ]),
    )
    const population = story?.flows.find((flow) => flow.name === 'poblacion')
    expect(population?.size).toBe(8)
  })

  it('el diagrama la cuenta: un ciclo con sus pasos en orden, lo que viaja, y sin «quién llama a quién»', async () => {
    const program = parse(GENETICO)
    const trace = await kernel.trace(GENETICO, 20_000, false, true, { seed: 7, finish: true })
    const story = storyOf(program, trace)
    if (!story) throw new Error('sin historia')
    const all = withSections(toCanvasNodes(program.nodes), program.edges, program.sections ?? [])
    const { facts } = moduleGraph(all, all, program.edges)
    const architecture = architectureOf(all, all, program.edges)
    if (!architecture) throw new Error('sin arquitectura')
    const title = (id: string | undefined) => facts.find((fact) => fact.id === id)?.title ?? id
    const told = moduleStory(story, program.nodes, facts)
    if (!told) throw new Error('el bucle no cae en ningún módulo')
    expect(title(told.anchor)).toBe('Iterar hasta condición')
    expect(told.caption).toMatch(/^\d+ vueltas$/)

    const drawn = withStory(architecture, told)
    expect(drawn.shape).toBe('ciclo')
    // El anillo, en el orden en que pasa: evaluar (sus dos módulos), reponer, elegir, cruzar. Generar la
    // población ya no está en él.
    expect(drawn.order?.map(title)).toEqual([
      'Evaluar población',
      'Evaluar población',
      'Reemplazar población',
      'Seleccionar padres',
      'Cruzar y mutar',
    ])
    const said = drawn.links.map(
      (link) =>
        `${title(link.from)} ${link.kind === 'data' ? '→' : link.kind === 'next' ? '›' : '⇢'} ${title(link.to)}${link.label ? ` [${link.label}]` : ''}`,
    )
    // Lo que viaja lleva su nombre y, si es una colección, cuántos son.
    expect(said).toContain('Generar población inicial → Evaluar población [poblacion ×8]')
    expect(said).toContain('Evaluar población → Reemplazar población [aptitudes ×8]')
    expect(said).toContain('Seleccionar padres → Cruzar y mutar [padre1, padre2]')
    // Lo que una vuelta le deja a la siguiente pasa por la cabeza del ciclo.
    expect(said).toContain('Cruzar y mutar › Iterar hasta condición')
    // Ninguna flecha de «usa a», salvo que se pida.
    expect(drawn.links.some((link) => link.kind === 'call')).toBe(false)
    expect(
      withStory(architecture, told, { calls: true }).links.some((l) => l.kind === 'call'),
    ).toBe(true)

    // Y al colocarlo, el anillo respeta ese orden: en el sentido del reloj desde la cabeza, arriba.
    const sizes = new Map(drawn.modules.map((module) => [module.id, { w: 240, h: 96 }]))
    const { positions, figures } = layoutArchitecture(drawn, sizes)
    const at = (id: string) => positions.get(id) ?? { x: 0, y: 0 }
    const ring = [told.anchor, ...(drawn.order ?? [])]
    const top = Math.min(...ring.map((id) => at(id).y))
    expect(at(told.anchor).y).toBe(top)
    // El primero de la vuelta, a la derecha de la cabeza; el último, a su izquierda.
    expect(at(ring[1] ?? '').x).toBeGreaterThan(at(told.anchor).x)
    expect(at(ring[ring.length - 1] ?? '').x).toBeLessThan(at(told.anchor).x)
    expect(figures.find((figure) => figure.kind === 'ring')?.label).toBe(told.caption)
  })

  it('un programa que no se repite llamando a sus funciones no tiene esta historia', async () => {
    const source = fixture('informe')
    expect(storyOf(parse(source), await kernel.trace(source))).toBeNull()
  })

  it('el juego: cada vuelta lee, mueve y dibuja, en ese orden', async () => {
    const source = fixture('juego')
    const story = storyOf(parse(source), await kernel.trace(source))
    expect(story?.ring).toEqual(['leer_jugada', 'mover', 'dibujar'])
    expect(story?.before).toEqual([])
    expect(story?.loop).toMatchObject({ head: 'while posicion < meta', ended: 'done' })
  })
})
