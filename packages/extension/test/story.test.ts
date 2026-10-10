import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildProgram, createPythonParser, type Program } from '@prysel/python'
import { withLaunch } from '../src/gist/entry.ts'
import { storyOf } from '../src/gist/story.ts'
import { layoutArchitecture } from '@prysel/spatial'
import {
  architectureOf,
  beatsOf,
  ideaOf,
  moduleGraph,
  RESULT_BEAT,
  toCanvasNodes,
  withSections,
  withStory,
} from '@prysel/ui'
import { exitOf, lapsSaid, moduleStory } from '../webview/src/outcome.ts'
import { sayBeat } from '../webview/src/Transport.tsx'
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
    // Solo lo que se pasa de mano en mano. Un hijo que acaba evaluándose en la vuelta siguiente (dentro de la
    // población nueva) o unas notas que «reponer» le pasa a su vez a «elegir» no son otro paso de la historia.
    expect(flows).not.toContain('cruzar_y_mutar → calcular_aptitud: individuo')
    expect(flows).not.toContain('evaluar_poblacion → seleccionar_padres: aptitudes')
    expect(flows.length).toBeLessThanOrEqual(5)
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
    // Lo que una vuelta le deja a la siguiente se lo da la cabeza del ciclo: nada va contra el sentido del
    // anillo ni lo cruza por el centro.
    expect(said).toContain('Cruzar y mutar › Iterar hasta condición')
    expect(said).toContain('Iterar hasta condición → Evaluar población [poblacion ×8]')
    expect(said).not.toContain('Reemplazar población → Evaluar población [poblacion ×8]')
    const turn = [told.anchor, ...(drawn.order ?? [])]
    for (const link of drawn.links) {
      const from = turn.indexOf(link.from)
      const to = turn.indexOf(link.to)
      if (from < 0 || to < 0) continue
      // Hacia delante, o el cierre de la vuelta (a la cabeza).
      expect(to === 0 || to > from, `${title(link.from)} → ${title(link.to)}`).toBe(true)
    }
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

    // Y se puede ver pasar: lo de antes, la cabeza, cada paso en su orden con lo que recibe, el cierre de la
    // vuelta y el resultado.
    const beats = beatsOf(drawn, [told.anchor])
    expect(beats.map((beat) => `${beat.phase}: ${title(beat.at)}`)).toEqual([
      'before: Generar población inicial',
      'lap: Iterar hasta condición',
      'lap: Evaluar población',
      'lap: Evaluar población',
      'lap: Reemplazar población',
      'lap: Seleccionar padres',
      'lap: Cruzar y mutar',
      'again: Iterar hasta condición',
      `result: ${RESULT_BEAT}`,
    ])
    // Cada flecha que se enciende existe en el diagrama, y llega al módulo del paso.
    const drawnLinks = new Set(drawn.links.map((link) => `${link.from}>${link.to}`))
    for (const beat of beats.filter((step) => step.phase !== 'result')) {
      for (const link of beat.links) {
        expect(drawnLinks.has(link), link).toBe(true)
        expect(link.endsWith(`>${beat.at}`)).toBe(true)
      }
    }
    // A evaluar le llega la población (la recién generada y la que le da la cabeza); a reponer, las notas.
    const carried = (at: number) =>
      (beats[at]?.links ?? []).flatMap(
        (link) => drawn.links.find((l) => `${l.from}>${l.to}` === link)?.label ?? [],
      )
    expect(carried(2)).toEqual(['poblacion ×8', 'poblacion ×8'])
    expect(carried(4)).toContain('aptitudes ×8')
    // El cierre de la vuelta enciende la flecha que vuelve a la cabeza.
    expect(beats[7]?.links.length).toBe(1)
    const first = beats[2]
    if (!first) throw new Error('sin pasos')
    // Lo mismo por dos flechas se dice una vez.
    expect(sayBeat(first, 'Evaluar población', ['poblacion ×8', 'poblacion ×8'], story.loop)).toBe(
      'Evaluar población · recibe poblacion ×8',
    )
    // Aunque no se sepa qué módulo lo escribe, la reproducción acaba en el resultado.
    expect(beatsOf(drawn, []).at(-1)).toEqual({ at: RESULT_BEAT, links: [], phase: 'result' })
    expect(beatsOf(drawn).at(-1)?.phase).toBe('again')
    // Y de más lejos, la idea: lo que guarda, lo de antes, lo que se repite (con lo que recibe cada paso, y
    // los dos trozos de «Evaluar población» como una sola línea) y lo demás.
    const idea = ideaOf(drawn, facts)
    const line = (step: { title: string; says?: string; brings?: string }) =>
      `${step.title}${step.says ? ` (${step.says})` : ''}${step.brings ? ` ← ${step.brings}` : ''}`
    expect(idea.before.map(line)).toEqual([
      'Generar población inicial (crea individuos aleatorios)',
    ])
    expect(idea.loop?.title).toBe('Iterar hasta condición')
    expect(idea.loop?.steps.map(line)).toEqual([
      'Evaluar población (calcula la aptitud de cada individuo) ← poblacion ×8',
      'Reemplazar población (forma la nueva generación) ← aptitudes ×8',
      'Seleccionar padres',
      'Cruzar y mutar (genera descendencia con variación) ← padre1, padre2',
    ])
    expect(idea.loop?.steps[0]?.also.length).toBe(1)
    // Lo que no es ni de antes ni de la vuelta: lo que el programa guarda («con»), o lo demás.
    expect([...idea.uses, ...idea.parts].map(line)).toEqual([
      'Definir el problema (establece objetivo, genes y aptitud)',
      'Arrancar (prueba con un ejemplo)',
    ])
    // Sin historia, sus partes en el orden del programa.
    const flat = ideaOf(architecture, facts)
    expect(flat.loop).toBeNull()
    expect(flat.before).toEqual([])
    expect(flat.parts.map((step) => step.title)).toContain('Iterar hasta condición')
    // Sin historia no hay nada que reproducir.
    expect(beatsOf(architecture)).toEqual([])
    // Cómo se salió, con palabras: va en la marca de salida.
    expect(told.exit).toBe(exitOf(story.loop))
    expect(told.exit).toMatch(/^sale /)
  })

  it('cómo se sale de un ciclo, dicho con palabras', () => {
    const loop = { line: 1, head: '', laps: 7 }
    expect(exitOf({ ...loop, kind: 'for', ended: 'done' })).toBe('sale al acabar sus vueltas')
    expect(exitOf({ ...loop, kind: 'while', ended: 'done' })).toBe(
      'sale cuando deja de cumplirse su condición',
    )
    expect(exitOf({ ...loop, kind: 'for', ended: 'break' })).toBe(
      'sale antes de acabar, en la vuelta 7',
    )
    // Si no se le vio salir, no se promete cuántas dio ni cómo acabó.
    const cut = { ...loop, kind: 'while' as const, ended: 'cut' as const }
    expect(exitOf(cut)).toBe('siguió dando vueltas: aquí se dejó de mirar')
    expect(lapsSaid(cut)).toBe('más de 7')
    expect(lapsSaid({ ...loop, kind: 'for', ended: 'done' })).toBe('7')
    const again = { at: 'x', links: [], phase: 'again' as const }
    expect(sayBeat(again, '', [], cut)).toBe('Y otra vez: así más de 7 vueltas')
  })

  it('lo que viaja también se sigue cuando es algo más grande que una lista de valores sueltos', async () => {
    const source = [
      '# Crear: los grupos de partida',
      'def crear(n):',
      '    return [[i, i + 1] for i in range(n)]',
      '',
      '# Puntuar: la nota de cada grupo',
      'def puntuar(grupos):',
      '    return [sum(par) for par in grupos]',
      '',
      '# Mejorar: sube cada grupo',
      'def mejorar(grupos, notas):',
      '    return [[a + 1, b] for a, b in grupos]',
      '',
      '# Repetir: tres rondas',
      'grupos = crear(4)',
      'for _ in range(3):',
      '    notas = puntuar(grupos)',
      '    grupos = mejorar(grupos, notas)',
      'print(grupos)',
      '',
    ].join('\n')
    const story = storyOf(parse(source), await kernel.trace(source))
    expect(story?.ring).toEqual(['puntuar', 'mejorar'])
    expect(story?.loop).toMatchObject({ kind: 'for', laps: 3, ended: 'done' })
    const flows = (story?.flows ?? []).map((flow) => `${flow.from} → ${flow.to}: ${flow.name}`)
    // Una lista de listas no es una fila de valores sueltos, pero se le sigue la pista igual.
    expect(flows).toEqual([
      'crear → puntuar: grupos',
      'puntuar → mejorar: notas',
      'mejorar → puntuar: grupos',
    ])
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
    // La cuenta que lleva el bucle: dónde estaba al empezar cada vuelta, y al salir.
    expect(story?.loop.kind).toBe('while')
    expect(story?.loop.series?.name).toBe('posicion')
    const values = story?.loop.series?.values ?? []
    expect(values[0]).toBe(0)
    expect(values.length).toBe((story?.loop.laps ?? 0) + 1)
    expect(values[values.length - 1]).toBeGreaterThanOrEqual(5)
  })
})
