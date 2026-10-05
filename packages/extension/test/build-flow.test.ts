import { createRequire } from 'node:module'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { buildProgram, createPythonParser, type Program } from '@prysel/python'
import { applyEdits } from '@prysel/python/edits'
import type { AiProvider, AiRequest } from '../src/ai/provider.ts'
import type { Decider, JevAnswer } from '../src/jev/client.ts'
import { build, summaryOf, type Shown, type Stagehand } from '../src/jev/director.ts'
import { localDecider } from '../src/jev/local.ts'

/**
 * Construir, de punta a punta, con el flujo de «solo contenido»: a la IA se le pide una lista (el plan),
 * código (tal cual) y una frase por trozo; nunca un formato. El JEV reparte cada trozo en su parte del plan.
 * Y el diagrama crece en cuanto hay datos: cada sentencia se escribe al llegar su código, antes de que
 * exista su explicación.
 *
 * Un archivo en memoria hace de documento y de lienzo; la IA es de mentira y contesta a trozos.
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

interface Script {
  /** Lo que contesta cuando se le pide la lista de partes. */
  plan?: string
  /** Lo que contesta cuando se le pide el código. */
  code: string
  /** Lo que contesta cuando se le piden las frases de unas piezas (por defecto, una por pieza). */
  tell?: (pieces: string[]) => string
  /** La fórmula de una función. */
  formula?: string
}

/** Una IA de mentira: según lo que se le pida (lista, código, frase, fórmula), contesta lo suyo, a trozos. */
function ai(script: Script): AiProvider & { requests: { kind: string; request: AiRequest }[] } {
  const requests: { kind: string; request: AiRequest }[] = []
  const answer = (request: AiRequest) => {
    const kind = request.system.includes('Lista las partes')
      ? 'plan'
      : request.system.includes('solo el código')
        ? 'code'
        : request.system.includes('solo la fórmula')
          ? 'formula'
          : 'tell'
    requests.push({ kind, request })
    if (kind === 'plan') return script.plan ?? ''
    if (kind === 'code') return script.code
    if (kind === 'formula') return script.formula ?? ''
    const pieces = (
      request.prompt.split(/Las piezas que van a aparecer ahora \(\d+\):\n/).pop() ?? ''
    )
      .split(/^\[\d+\]\n/m)
      .filter((piece) => piece.trim() !== '')
      .map((piece) => piece.trimEnd())
    return script.tell
      ? script.tell(pieces)
      : pieces.map((piece, i) => `${i + 1}. Aquí va «${piece.split('\n').pop() ?? ''}».`).join('\n')
  }
  return {
    id: 'mentira',
    requests,
    generate: (request) => Promise.resolve(answer(request)),
    async stream(request, onText, signal) {
      const text = answer(request)
      for (let i = 0; i < text.length && !signal?.aborted; i += 7) {
        onText(text.slice(i, i + 7))
        await Promise.resolve()
      }
      return text
    },
  }
}

function stage(source: string, stopAfter?: number) {
  const control = new AbortController()
  const state = { text: source, frames: [] as string[], shown: [] as Shown[] }
  const host: Stagehand = {
    signal: control.signal,
    program: () => Promise.resolve(parse(state.text)),
    parses: (code) => !hasError(code),
    write(change) {
      if (change.edits.length === 0) return Promise.resolve(null)
      const next = applyEdits(state.text, change.edits)
      if (hasError(next)) return Promise.resolve('El siguiente paso no deja un programa válido.')
      state.text = next
      state.frames.push(next)
      return Promise.resolve(null)
    },
    show(event) {
      state.shown.push(event)
      const born = state.shown.filter(
        (item) => item.type === 'step' && item.effect === 'born',
      ).length
      if (stopAfter !== undefined && born >= stopAfter) control.abort()
      return Promise.resolve()
    },
    wait: () => Promise.resolve(),
  }
  return { host, state }
}

const steps = (state: { shown: Shown[] }) =>
  state.shown.flatMap((event) => (event.type === 'step' ? [event] : []))

/** El decisor local, pero repartiendo cada trozo en la etapa que diga la prueba (por lo que lleve su código). */
function assigning(stageOf: (code: string) => string | null): Decider {
  const local = localDecider()
  return {
    id: 'reparto',
    async decide(request) {
      const response = await local.decide(request)
      const answers: Record<string, JevAnswer> = { ...response.answers }
      if ('etapa' in request.questions) {
        const option = stageOf((request.state as { codigo?: string }).codigo ?? '')
        answers.etapa =
          option === null
            ? { type: 'choice', choice: 'e1', confidence: 0.1, probabilities: {} }
            : { type: 'choice', choice: option, confidence: 0.95, probabilities: {} }
      }
      return { answers, ms: response.ms }
    },
  }
}

const SUM = lines(
  'numero_1 = 3',
  'numero_2 = 5',
  '',
  'def sumar(a, b):',
  '    return a + b',
  '',
  'resultado = sumar(numero_1, numero_2)',
  'print(resultado)',
)
const SUM_TEXT = lines(
  'numero_1 = 3',
  'numero_2 = 5',
  'def sumar(a, b):',
  '    return a + b',
  'resultado = sumar(numero_1, numero_2)',
  'print(resultado)',
)
const small = {
  command: 'una función que sume dos números',
  gen: 'g1',
  place: {},
  where: 'al final del programa',
  outline: false,
}

describe('algo pequeño: el código, tal cual, y cada sentencia en cuanto llega', () => {
  it('a la IA se le pide código y nada más; aquí se trocea y se escribe pieza a pieza', async () => {
    const provider = ai({ code: SUM })
    const { host, state } = stage('')
    const outcome = await build(host, { decider: localDecider(), provider }, small)
    expect(state.text).toBe(SUM_TEXT)
    // Seis piezas: cada sentencia, y dentro de la función, su cabecera y su cuerpo por separado.
    expect(
      steps(state)
        .filter((event) => event.effect === 'born')
        .map((event) => event.line),
    ).toEqual([1, 2, 3, 4, 5, 6])
    expect(state.frames[2]).toBe('numero_1 = 3\nnumero_2 = 5\ndef sumar(a, b):\n    pass\n')
    expect(outcome).toMatchObject({ written: 6, stopped: false, trouble: null })
    expect(summaryOf(outcome)).toBe('Hecho, en 6 pasos.')
    // Ninguna petición le pide un formato: ni JSON ni etiquetas.
    for (const { request } of provider.requests) {
      expect(request.system).not.toMatch(/JSON|"code"|NIVEL:|CODIGO:/)
    }
    expect(provider.requests.map((item) => item.kind)).toEqual([
      'code',
      'tell',
      'tell',
      'tell',
      'tell',
      'tell',
    ])
  })

  it('cada pieza aparece con su frase, y la siguiente espera a que se haya dicho', async () => {
    const provider = ai({ code: SUM })
    const control: { waits: number[] } = { waits: [] }
    const { host, state } = stage('')
    const paced: Stagehand = {
      ...host,
      wait: (ms) => {
        control.waits.push(ms)
        return Promise.resolve()
      },
    }
    await build(paced, { decider: localDecider(), provider }, small)
    // Seis piezas, seis frases: ninguna aparece muda, ni siquiera lo de dentro de la función.
    expect(steps(state).map((event) => `${event.effect} L${event.line}: ${event.say}`)).toEqual([
      'born L1: Aquí va «numero_1 = 3».',
      'born L2: Aquí va «numero_2 = 5».',
      'born L3: Aquí va «def sumar(a, b):».',
      'born L4: Aquí va «return a + b».',
      'born L5: Aquí va «resultado = sumar(numero_1, numero_2)».',
      'born L6: Aquí va «print(resultado)».',
    ])
    // Tras cada pieza se espera lo que tarda en decirse su frase (no unas décimas): el diagrama crece despacio.
    const spoken = control.waits.filter((ms) => ms >= 600)
    expect(spoken).toHaveLength(6)
    // Las frases de un trozo se piden juntas, con sus piezas numeradas, antes de enseñarlo.
    const fn = provider.requests.filter((item) => item.kind === 'tell')[2]
    expect(fn?.request.prompt).toContain(
      'Las piezas que van a aparecer ahora (2):\n[1]\ndef sumar(a, b):\n[2]\nreturn a + b',
    )
  })

  it('si la IA da menos frases de las pedidas (o ninguna), las piezas siguen apareciendo, a su ritmo', async () => {
    const provider = ai({
      code: SUM,
      tell: (pieces) => (pieces.length > 1 ? '"La **función** que suma."' : ''),
    })
    const waits: number[] = []
    const { host, state } = stage('')
    await build(
      {
        ...host,
        wait: (ms) => {
          waits.push(ms)
          return Promise.resolve()
        },
      },
      { decider: localDecider(), provider },
      small,
    )
    expect(state.text).toBe(SUM_TEXT)
    expect(steps(state).map((event) => event.say)).toEqual([
      '',
      '',
      'La función que suma.',
      '',
      '',
      '',
    ])
    // Sin frase, una pausa corta: tampoco entonces se vuelca todo de golpe.
    expect(waits.filter((ms) => ms === 900)).toHaveLength(5)
  })

  it('lo que el modelo escriba alrededor del código (una frase, unas vallas) no llega al programa', async () => {
    const provider = ai({
      code: lines(
        'Claro, aquí tienes el código:',
        '',
        '```python',
        'a = 1',
        'b = a + 1',
        '```',
        '',
        'Espero que te sirva.',
      ),
    })
    const { host, state } = stage('')
    const outcome = await build(host, { decider: localDecider(), provider }, small)
    expect(state.text).toBe('a = 1\nb = a + 1\n')
    expect(outcome.written).toBe(2)
  })

  it('lo que no se arma por partes (un try, un if con elif) se escribe entero, y es válido', async () => {
    const code = lines(
      'texto = "12"',
      'try:',
      '    valor = int(texto)',
      'except ValueError:',
      '    valor = 0',
      'if valor > 10:',
      '    print("grande")',
      'elif valor > 5:',
      '    print("mediano")',
      'else:',
      '    print("pequeño")',
    )
    const { host, state } = stage('')
    const outcome = await build(host, { decider: localDecider(), provider: ai({ code }) }, small)
    expect(state.text).toBe(code)
    expect(outcome).toMatchObject({ written: 3, trouble: null })
  })

  it('si la IA no escribe código, se dice qué contestó; nunca «hecho, en 0 pasos»', async () => {
    const { host } = stage('')
    const outcome = await build(
      host,
      { decider: localDecider(), provider: ai({ code: 'No sé hacer eso.' }) },
      small,
    )
    expect(outcome.written).toBe(0)
    expect(summaryOf(outcome)).toContain('La IA no escribió código')
    expect(summaryOf(outcome)).toContain('No sé hacer eso.')
  })

  it('se puede detener a mitad, y un trozo que no es seguro detiene la construcción', async () => {
    const stopped = stage('', 3)
    const first = await build(
      stopped.host,
      { decider: localDecider(), provider: ai({ code: SUM }) },
      small,
    )
    expect(first.stopped).toBe(true)
    expect(hasError(stopped.state.text)).toBe(false)
    expect(stopped.state.text).toContain('def sumar(a, b):')

    const risky = stage('')
    const second = await build(
      risky.host,
      {
        decider: localDecider(),
        provider: ai({ code: 'a = 1\nimport os\nos.remove("datos.txt")\nb = 2\n' }),
      },
      small,
    )
    expect(risky.state.text).toBe('a = 1\nimport os\n')
    expect(second.trouble).toContain('no da por seguro')
  })
})

describe('algo grande: una lista de partes, y el JEV reparte el código entre ellas', () => {
  const PLAN = lines(
    'Estas son las partes:',
    '1. Preparar las notas: guarda las notas de la clase.',
    '2. Calcular la media: suma las notas y divide.',
    '3. Mostrar el resultado: imprime la media.',
  )
  const CODE = lines(
    'notas = [7, 4, 9]',
    'total = 0',
    'for nota in notas:',
    '    total = total + nota',
    'media = total / len(notas)',
    'print(media)',
  )
  const byStage = (code: string) =>
    code.startsWith('notas')
      ? 'e1'
      : code.startsWith('print')
        ? 'e3'
        : code.startsWith('total')
          ? 'e2'
          : null
  const request = {
    command: 'un programa que calcule la media de unas notas',
    gen: 'g1',
    place: {},
    where: 'al final del programa',
    outline: true,
  }

  it('primero se ve el plan entero, en cajas; luego cada trozo va a su caja', async () => {
    const provider = ai({ plan: PLAN, code: CODE })
    const { host, state } = stage('')
    const outcome = await build(host, { decider: assigning(byStage), provider }, request)
    // El plan, antes de que exista una línea de código.
    expect(state.frames[2]).toBe(
      lines(
        '# Preparar las notas: guarda las notas de la clase',
        '...  # prysel:gen:g1s0',
        '',
        '# Calcular la media: suma las notas y divide',
        '...  # prysel:gen:g1s1',
        '',
        '# Mostrar el resultado: imprime la media',
        '...  # prysel:gen:g1s2',
      ),
    )
    // El código se pidió de una vez, con el plan delante; el reparto lo hizo el JEV.
    expect(provider.requests.filter((item) => item.kind === 'code')).toHaveLength(1)
    expect(provider.requests.find((item) => item.kind === 'code')?.request.prompt).toContain(
      '2. Calcular la media: suma las notas y divide.',
    )
    expect(state.text).toBe(
      lines(
        '# Preparar las notas: guarda las notas de la clase',
        'notas = [7, 4, 9]',
        '',
        '# Calcular la media: suma las notas y divide',
        'total = 0',
        'for nota in notas:',
        '    total = total + nota',
        'media = total / len(notas)',
        '',
        '# Mostrar el resultado: imprime la media',
        'print(media)',
      ),
    )
    expect(outcome).toMatchObject({ written: 6, trouble: null })
    // «media = …» no tenía etapa clara: se quedó en la que se estaba.
  })

  it('el código va hacia delante: un trozo no vuelve a una parte anterior', async () => {
    const provider = ai({ plan: PLAN, code: 'total = 0\nnotas = [1]\nprint(total)\n' })
    const { host, state } = stage('')
    await build(host, { decider: assigning(byStage), provider }, request)
    // «notas = [1]» diría «parte 1», pero ya se estaba en la 2: se queda en la 2.
    expect(state.text).toContain(
      '# Calcular la media: suma las notas y divide\ntotal = 0\nnotas = [1]\n',
    )
  })

  it('una parte del plan a la que no fue ningún código se quita, con su rótulo', async () => {
    const provider = ai({ plan: PLAN, code: 'notas = [7, 4, 9]\nprint(notas)\n' })
    const { host, state } = stage('')
    await build(host, { decider: assigning(byStage), provider }, request)
    expect(state.text).not.toContain('Calcular la media')
    expect(state.text).not.toContain('prysel:gen')
    expect(state.text).not.toContain('...')
    expect((parse(state.text).sections ?? []).map((section) => section.title)).toEqual([
      'Preparar las notas',
      'Mostrar el resultado',
    ])
    expect(hasError(state.text)).toBe(false)
  })

  it('una lista de una sola parte no es un plan: se escribe el código sin cajas', async () => {
    const provider = ai({ plan: 'Sumar dos números\n', code: SUM })
    const { host, state } = stage('')
    await build(host, { decider: localDecider(), provider }, request)
    expect(state.text).toBe(SUM_TEXT)
  })

  it('detenido a mitad, ningún hueco se queda marcado como en marcha', async () => {
    const provider = ai({ plan: PLAN, code: CODE })
    const { host, state } = stage('', 5)
    const outcome = await build(host, { decider: assigning(byStage), provider }, request)
    expect(outcome.stopped).toBe(true)
    expect(state.text).not.toContain('prysel:gen')
    expect(hasError(state.text)).toBe(false)
  })
})

describe('entender un tema, y las ayudas visuales', () => {
  it('a la IA se le pide que enseñe el tema: el plan, el código y cada frase', async () => {
    const provider = ai({
      plan: lines(
        'Las células que se unen: un óvulo y un espermatozoide.',
        'La fecundación: se unen en una sola célula.',
      ),
      code: 'cromosomas_ovulo = 23\ncigoto = cromosomas_ovulo + 23\n',
    })
    const { host, state } = stage('')
    const decider = assigning((code) => (code.startsWith('cigoto') ? 'e2' : 'e1'))
    const outcome = await build(
      host,
      { decider, provider },
      {
        command: 'Explícame cómo funciona la reproducción humana',
        gen: 'g1',
        place: {},
        where: 'al final del programa',
        outline: true,
        teach: true,
      },
    )
    expect(outcome.written).toBe(2)
    for (const { request } of provider.requests)
      expect(request.system).toMatch(/ENTENDER un tema|explicando un tema/)
    expect(state.text).toBe(
      lines(
        '# Las células que se unen: un óvulo y un espermatozoide',
        'cromosomas_ovulo = 23',
        '',
        '# La fecundación: se unen en una sola célula',
        'cigoto = cromosomas_ovulo + 23',
      ),
    )
  })

  it('el JEV decide que una función merece su curva; a la IA se le pide solo la fórmula', async () => {
    const provider = ai({
      code: lines('import math', 'def sigmoide(x):', '    return 1 / (1 + math.exp(-x))'),
      formula: '```\ny = 1/(1+exp(-x))\n```',
    })
    const { host, state } = stage('')
    await build(
      host,
      { decider: localDecider(), provider },
      { ...small, command: 'la función sigmoide' },
    )
    expect(state.text).toBe(
      'import math\ndef sigmoide(x):  # prysel:ver curva «Sigmoide» y = 1/(1+exp(-x)), x de -6 a 6\n    return 1 / (1 + math.exp(-x))\n',
    )
    expect(parse(state.text).nodes.find((n) => n.label === 'sigmoide')?.aid).toBe(
      'curva «Sigmoide» y = 1/(1+exp(-x)), x de -6 a 6',
    )
    // Una fórmula que no se puede dibujar no deja marca.
    const odd = stage('')
    await build(
      odd.host,
      {
        decider: localDecider(),
        provider: ai({ code: 'def raiz(x):\n    return x ** 0.5\n', formula: 'no lo sé' }),
      },
      small,
    )
    expect(odd.state.text).toBe('def raiz(x):\n    return x ** 0.5\n')
  })
})
