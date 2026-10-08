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
  /** El comentario de entrada. */
  intro?: string
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
          : request.system.includes('Antes de empezar')
            ? 'intro'
            : 'tell'
    requests.push({ kind, request })
    if (kind === 'plan') return script.plan ?? ''
    if (kind === 'code') return script.code
    if (kind === 'formula') return script.formula ?? ''
    if (kind === 'intro') return script.intro ?? ''
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
    settle: () => Promise.resolve(),
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

  it('cada respuesta de un modelo se nota: llega el código, el JEV da el visto bueno', async () => {
    const { host, state } = stage('')
    await build(host, { decider: localDecider(), provider: ai({ code: SUM }) }, small)
    const notes = state.shown.flatMap((event) => (event.type === 'progress' ? [event.text] : []))
    expect(notes).toContain('Llegó código: numero_1 = 3 · lo mira el JEV…')
    expect(notes.filter((text) => text.startsWith('JEV ✓')).length).toBeGreaterThanOrEqual(4)
  })

  it('un trozo que no se escribe corta la preparación de los siguientes', async () => {
    const provider = ai({ code: `import os\nos.remove("datos.csv")\n${SUM}` })
    const { host } = stage('')
    const outcome = await build(host, { decider: localDecider(), provider }, small)
    expect(outcome.trouble).toContain('no da por seguro')
    // No se le pidió a la IA que contara nada de lo que venía detrás.
    expect(provider.requests.filter((item) => item.kind === 'tell').length).toBeLessThanOrEqual(1)
  })

  it('al ritmo de la IA: las piezas entran sin esperar a la voz, y cada trozo se comenta al margen', async () => {
    const provider = ai({ code: SUM })
    const { host, state } = stage('')
    let waited = 0
    const outcome = await build(
      {
        ...host,
        settle: () => {
          waited++
          return Promise.resolve()
        },
      },
      { decider: localDecider(), provider },
      { ...small, flow: 'stream' },
    )
    // Queda escrito lo mismo, pero nadie esperó a que se dijera nada.
    expect(state.text).toBe(SUM_TEXT)
    expect(outcome).toMatchObject({ written: 6, trouble: null })
    expect(waited).toBe(0)
    expect(steps(state).every((event) => event.say === '')).toBe(true)
    // De cada trozo (no de cada línea) se pide una frase, y sale como comentario al margen.
    const asides = state.shown.filter((event) => event.type === 'say' && event.aside)
    expect(asides.length).toBeGreaterThanOrEqual(4)
    for (const { request } of provider.requests.filter((item) => item.kind === 'tell')) {
      expect(request.prompt).toContain('Las piezas que van a aparecer ahora (1):')
    }
  })

  it('si lo construido es una sola función o clase, al acabar se entra en ella', async () => {
    const code = lines(
      'class Animal:',
      '    def __init__(self, nombre):',
      '        self.nombre = nombre',
    )
    const one = stage(lines('x = 1'))
    const built = await build(
      one.host,
      { decider: localDecider(), provider: ai({ code }) },
      { ...small, command: 'una clase animal', flow: 'stream' },
    )
    expect(built.trouble).toBeNull()
    // La cabecera de la clase quedó en la línea 2: ahí entra la vista.
    expect(built.enter).toBe(2)
    // Varias cosas sueltas no son un sitio donde entrar.
    const many = stage('')
    expect(
      (await build(many.host, { decider: localDecider(), provider: ai({ code: SUM }) }, small))
        .enter,
    ).toBeUndefined()
  })

  it('los rótulos de intención dentro de una función se conservan, y el lienzo los agrupa', async () => {
    const code = lines(
      'def actualizar(pajaro):',
      '    # Aplicar física',
      '    pajaro.velocidad = pajaro.velocidad + 1',
      '    pajaro.y = pajaro.y + pajaro.velocidad',
      '',
      '    # Comprobar choques',
      '    if pajaro.y > 100:',
      '        pajaro.vivo = False',
      '    pajaro.pasos = pajaro.pasos + 1',
    )
    const { host, state } = stage('')
    const outcome = await build(
      host,
      { decider: localDecider(), provider: ai({ code }) },
      { ...small, command: 'una función que actualice el pájaro', flow: 'stream' },
    )
    expect(outcome.trouble).toBeNull()
    expect(state.text).toBe(code)
    // Cada rótulo es una etapa del cuerpo de la función: un nodo de intención.
    expect(parse(state.text).sections?.map((section) => section.title)).toEqual([
      'Aplicar física',
      'Comprobar choques',
    ])
  })

  it('cada pieza aparece con su frase, y la siguiente espera a que se haya dicho', async () => {
    const provider = ai({ code: SUM })
    const control: { waits: number[] } = { waits: [] }
    const { host, state } = stage('')
    const paced: Stagehand = {
      ...host,
      // Tras cada pieza se espera a que su frase se haya dicho.
      settle: (ms) => {
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
    // Tras cada pieza se espera a que termine de decirse su frase: una espera por pieza, ni una menos.
    expect(control.waits).toHaveLength(6)
    // Lo que se le pasa es solo lo que se tardaría en leerla, por si no hay voz.
    expect(control.waits.every((ms) => ms >= 600)).toBe(true)
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
        'notas = [7, 4, 9]  # prysel:ver serie «notas» 7 4 9',
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

  it('una función dictada fuera de orden sí vuelve a su parte, y lo de debajo no se descoloca', async () => {
    // El modelo dicta la función al final, cuando ya se estaba en la parte 3; y aún sigue con la 3.
    const code = lines(
      'notas = [7, 4, 9]',
      'print(notas)',
      'def media_de(lista):',
      '    return sum(lista) / len(lista)',
      'print(media_de(notas))',
    )
    const stages = (chunk: string) =>
      chunk.startsWith('notas') ? 'e1' : chunk.startsWith('def') ? 'e2' : 'e3'
    const { host, state } = stage('')
    const outcome = await build(
      host,
      { decider: assigning(stages), provider: ai({ plan: PLAN, code }) },
      request,
    )
    expect(outcome.trouble).toBeNull()
    expect(state.text).toBe(
      lines(
        '# Preparar las notas: guarda las notas de la clase',
        'notas = [7, 4, 9]  # prysel:ver serie «notas» 7 4 9',
        '',
        '# Calcular la media: suma las notas y divide',
        'def media_de(lista):',
        '    return sum(lista) / len(lista)',
        '',
        '# Mostrar el resultado: imprime la media',
        'print(notas)',
        'print(media_de(notas))',
      ),
    )
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

describe('un bloque que se escribe entero (un if con sus elif) se explica rama a rama', () => {
  const CODE = lines(
    'notas = [8.5, 6.0, 9.2]',
    'pesos = [0.3, 0.3, 0.4]',
    'if len(notas) != len(pesos):',
    '    print("Error: distinta longitud")',
    'elif abs(sum(pesos) - 1.0) > 0.001:',
    '    print("Error: los pesos deben sumar 1")',
    'else:',
    '    final = sum(n * p for n, p in zip(notas, pesos))',
    '    print(final)',
  )

  it('se escribe de una vez, y luego se señala y se cuenta cada rama', async () => {
    const provider = ai({ code: CODE })
    const { host, state } = stage('')
    const outcome = await build(host, { decider: localDecider(), provider }, small)
    expect(state.text).toBe(
      CODE.replace('9.2]', '9.2]  # prysel:ver serie «notas» 8.5 6 9.2').replace(
        '0.4]',
        '0.4]  # prysel:ver serie «pesos» 0.3 0.3 0.4',
      ),
    )
    expect(outcome.trouble).toBeNull()
    // El bloque aparece una vez (born) y sus ramas se van contando (told), cada una en su línea.
    expect(
      steps(state)
        .slice(2)
        .map((event) => `${event.effect} L${event.line}`),
    ).toEqual(['born L3', 'told L4', 'told L5', 'told L6', 'told L8', 'told L9'])
    // A la IA se le pide una frase por rama, no una para todo el bloque.
    const tell = provider.requests.filter((item) => item.kind === 'tell').pop()
    expect(tell?.request.prompt).toContain('Las piezas que van a aparecer ahora (6):')
    expect(tell?.request.prompt).toContain('[3]\nelif abs(sum(pesos) - 1.0) > 0.001:')
    // El «else:» no dice nada por sí solo: no es un momento.
    expect(tell?.request.prompt).not.toContain(']\nelse:')
  })

  it('el JEV elige el trozo exacto que se subraya en cada frase', async () => {
    const provider = ai({
      code: CODE,
      tell: (pieces) =>
        pieces
          .map((piece) =>
            piece.startsWith('elif') ? 'Se calcula el valor absoluto de la diferencia.' : 'Sigue.',
          )
          .join('\n'),
    })
    const { host, state } = stage('')
    const local = localDecider()
    // Un JEV que, cuando la frase habla de «valor absoluto», elige la llamada a `abs(...)`.
    const decider: Decider = {
      id: 'subraya',
      async decide(request) {
        const response = await local.decide(request)
        const answers: Record<string, JevAnswer> = { ...response.answers }
        for (const [id, question] of Object.entries(request.questions)) {
          if (!/^m\d+$/.test(id) || question.type !== 'choice') continue
          const call = Object.entries(question.criteria).find(([, text]) =>
            (text ?? '').startsWith('abs(sum(pesos) - 1.0) —'),
          )
          answers[id] =
            call && question.instructions.includes('valor absoluto')
              ? { type: 'choice', choice: call[0], confidence: 0.9, probabilities: {} }
              : { type: 'choice', choice: 'ninguno', confidence: 0.9, probabilities: {} }
        }
        return { answers, ms: response.ms }
      },
    }
    await build(host, { decider, provider }, small)
    const marked = steps(state).filter((event) => event.mark !== undefined)
    expect(marked.map((event) => `L${event.line}: ${event.mark?.[0]}`)).toEqual([
      'L5: abs(sum(pesos) - 1.0)',
    ])
  })

  it('lo preparado y aún sin escribir se va diciendo: es la recámara, por si el usuario interrumpe', async () => {
    const provider = ai({ code: 'a = 1\nb = 2\nc = 3\n' })
    const { host } = stage('')
    const seen: string[][] = []
    await build(
      {
        ...host,
        buffer: (pending) => {
          seen.push([...pending])
        },
      },
      { decider: localDecider(), provider },
      small,
    )
    // Hubo momentos con algo esperando, y al final no queda nada.
    expect(seen.some((pending) => pending.length > 0)).toBe(true)
    expect(seen[seen.length - 1]).toEqual([])
  })
})

describe('seguir escribiendo detrás de lo que no deja un nodo («El paso anterior ya no está»)', () => {
  const run = async (code: string, plan?: string) => {
    const { host, state } = stage('')
    const decider = assigning((piece) => (piece.includes('resultado') ? 'e2' : 'e1'))
    const outcome = await build(
      host,
      { decider, provider: ai({ code, ...(plan ? { plan } : {}) }) },
      {
        command: 'x',
        gen: 'g1',
        place: {},
        where: 'al final del programa',
        outline: plan !== undefined,
      },
    )
    return { text: state.text, outcome }
  }

  it('una función con docstring: lo de después del docstring se escribe debajo', async () => {
    const code = lines(
      'def media(valores):',
      '    \"\"\"Devuelve la media de unos valores.\"\"\"',
      '    total = sum(valores)',
      '    return total / len(valores)',
      'print(media([1, 2, 3]))',
    )
    const { text, outcome } = await run(code)
    expect(text).toBe(code)
    expect(outcome.trouble).toBeNull()
  })

  it('un docstring de varias líneas, un pass y un global tampoco cortan', async () => {
    const code = lines(
      'contador = 0',
      'def contar():',
      '    \"\"\"Suma uno.',
      '',
      '    Usa la variable de fuera.',
      '    \"\"\"',
      '    global contador',
      '    contador = contador + 1',
      'def nada():',
      '    pass',
      'contar()',
    )
    const { text, outcome } = await run(code)
    expect(text).toBe(code)
    expect(outcome.trouble).toBeNull()
  })

  it('en una etapa del plan, un trozo que empieza con un comentario: lo siguiente va detrás de su sentencia', async () => {
    const { text, outcome } = await run(
      lines(
        '# Las notas de la clase',
        'notas = [7, 4]',
        'total = sum(notas)',
        '# Lo que sale',
        'resultado = total / 2',
        'print(resultado)',
      ),
      'Preparar los datos: las notas\nMostrar el resultado: la media\n',
    )
    expect(outcome.trouble).toBeNull()
    expect(text).toBe(
      lines(
        '# Preparar los datos: las notas',
        '# Las notas de la clase',
        'notas = [7, 4]',
        'total = sum(notas)',
        '',
        '# Mostrar el resultado: la media',
        '# Lo que sale',
        'resultado = total / 2',
        'print(resultado)',
      ),
    )
  })

  it('detrás de una función con decorador, y de una clase, se sigue escribiendo', async () => {
    const code = lines(
      'import functools',
      '@functools.cache',
      'def doble(n):',
      '    return n * 2',
      'valor = doble(4)',
      'class Punto:',
      '    x = 0',
      'p = Punto()',
    )
    const { text, outcome } = await run(code)
    expect(text).toBe(code)
    expect(outcome.trouble).toBeNull()
  })
})

describe('antes del plan, un comentario de entrada', () => {
  const request = {
    command: 'un programa que calcule la media de unas notas',
    gen: 'g1',
    place: {},
    where: 'al final del programa',
    outline: true,
  }
  const PLAN = 'Preparar las notas: las notas de la clase\nCalcular la media: suma y divide\n'

  it('primero se dice qué se va a hacer; luego aparece el plan, y de cada parte se dice solo su título', async () => {
    const provider = ai({
      intro:
        '"Vamos a calcular la media de unas notas: primero las guardamos y luego las promediamos."',
      plan: PLAN,
      code: 'notas = [7, 4, 9]\n',
    })
    const { host, state } = stage('')
    await build(host, { decider: localDecider(), provider }, request)
    const said = state.shown.flatMap((event) =>
      event.type === 'say'
        ? [`entrada: ${event.say}`]
        : event.type === 'step'
          ? [`paso: ${event.say}`]
          : [],
    )
    expect(said.slice(0, 3)).toEqual([
      'entrada: Vamos a calcular la media de unas notas: primero las guardamos y luego las promediamos.',
      'paso: Preparar las notas',
      'paso: Calcular la media',
    ])
    // Cuando se dice la entrada aún no hay nada escrito.
    expect(state.frames[0]).toContain('# Preparar las notas')
    expect(provider.requests.find((item) => item.kind === 'intro')?.request.prompt).toBe(
      'Lo que se pidió: un programa que calcule la media de unas notas',
    )
  })

  it('si la IA no da entrada, se sigue con el plan sin más', async () => {
    const provider = ai({ plan: PLAN, code: 'notas = [7, 4, 9]\n' })
    const { host, state } = stage('')
    const outcome = await build(host, { decider: localDecider(), provider }, request)
    expect(state.shown.some((event) => event.type === 'say')).toBe(false)
    expect(outcome.written).toBe(1)
  })

  it('a la IA se le piden frases muy cortas', () => {
    const provider = ai({ code: 'a = 1\n' })
    const { host } = stage('')
    return build(host, { decider: localDecider(), provider }, { ...request, outline: false }).then(
      () => {
        expect(provider.requests.find((item) => item.kind === 'tell')?.request.system).toContain(
          'como mucho doce palabras',
        )
      },
    )
  })
})

describe('entender un tema, y las ayudas visuales', () => {
  it('una lista de números lleva su dibujo: sale del propio código, sin preguntar a nadie', async () => {
    const provider = ai({ code: 'notas = [7, 4, 9]\nnombres = ["Ana", "Luis"]\npar = [1, 2]\n' })
    const { host, state } = stage('')
    await build(
      host,
      { decider: localDecider(), provider },
      {
        command: 'unas notas',
        gen: 'g1',
        place: {},
        where: 'al final del programa',
        outline: false,
      },
    )
    expect(state.text).toBe(
      'notas = [7, 4, 9]  # prysel:ver serie «notas» 7 4 9\nnombres = ["Ana", "Luis"]\npar = [1, 2]\n',
    )
    expect(parse(state.text).nodes.find((n) => n.label === 'notas')?.aid).toBe(
      'serie «notas» 7 4 9',
    )
  })

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
      expect(request.system).toMatch(/ENTENDER un tema|explicando un tema|entender un tema/)
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
