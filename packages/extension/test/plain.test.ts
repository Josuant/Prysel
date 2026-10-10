import { describe, expect, it } from 'vitest'
import type { Decider, JevAnswer } from '../src/jev/client.ts'
import { localDecider } from '../src/jev/local.ts'
import { judgeCover, judgeDone } from '../src/jev/plain.ts'
import { bestMatch, locate } from '../webview/src/marking.ts'
import {
  CodeStream,
  LineStream,
  formulaOf,
  fragmentsOf,
  judgeChunk,
  judgeHeard,
  judgeInterruption,
  hinted,
  judgeMarks,
  partsOf,
  sentenceOf,
  stageFromLine,
  type Chunk,
} from '../src/jev/plain.ts'

/**
 * Pedir solo contenido: a la IA se le pide una lista, código, una frase o una fórmula, sin ningún formato.
 * La estructura se pone aquí (el código se trocea por sentencias) o la decide el JEV (a qué etapa va cada
 * trozo). Lo que se comprueba es que eso se lee bien venga como venga, y según llega.
 */

const lines = (...rows: string[]) => `${rows.join('\n')}\n`

/** Lee un texto como llega de una API: a trozos de unas pocas letras. */
function chunksOf(text: string, size = 6): Chunk[] {
  const stream = new CodeStream()
  const found: Chunk[] = []
  for (let i = 0; i < text.length; i += size) found.push(...stream.push(text.slice(i, i + size)))
  return [...found, ...stream.end()]
}

const shape = (chunk: Chunk) =>
  chunk.steps.map((step) => `${step.level}${step.whole ? '!' : ''} ${step.code}`)

describe('una lista: las etapas del plan', () => {
  it('una por línea, con o sin su explicación, con los adornos que traiga', () => {
    const read = (text: string) => {
      const stream = new LineStream(stageFromLine)
      return [...stream.push(text), ...stream.end()]
    }
    expect(
      read(
        lines(
          'Estas son las partes:',
          '',
          '1. **Partir de dos extraños**: dos personas que no se conocen.',
          '2. Acercarse — cada encuentro sube la familiaridad',
          '- Enamorarse',
        ) + '4) Decidir quedarse: el compromiso',
      ),
    ).toEqual([
      { title: 'Partir de dos extraños', goal: 'dos personas que no se conocen.' },
      { title: 'Acercarse', goal: 'cada encuentro sube la familiaridad' },
      { title: 'Enamorarse', goal: '' },
      { title: 'Decidir quedarse', goal: 'el compromiso' },
    ])
  })

  it('una frase larga sin separar: sus primeras palabras hacen de título', () => {
    const stage = stageFromLine(
      'La probabilidad de que surja amor depende de la proximidad física y de la frecuencia de encuentro',
    )
    expect(stage?.title).toBe('La probabilidad de que surja')
    expect(stage?.goal).toContain('frecuencia de encuentro')
  })
})

describe('código: de un texto que llega, a sentencias', () => {
  it('una sentencia sencilla sale al acabar su línea, sin esperar a la siguiente', () => {
    const stream = new CodeStream()
    expect(stream.push('numero_1 = 3')).toEqual([])
    expect(stream.push('\nnumero_2')).toMatchObject([{ code: 'numero_1 = 3' }])
    expect(stream.push(' = 5\n')).toMatchObject([{ code: 'numero_2 = 5' }])
  })

  it('una compuesta sale entera cuando llega la siguiente, con cada línea a su nivel', () => {
    const chunks = chunksOf(
      lines(
        'total = 0',
        'for nota in notas:',
        '    if nota >= 5:',
        '        total = total + nota',
        '    else:',
        '        print("suspenso")',
        'print(total)',
      ),
    )
    expect(chunks.map((chunk) => chunk.code.split('\n')[0])).toEqual([
      'total = 0',
      'for nota in notas:',
      'print(total)',
    ])
    expect(shape(chunks[1] as Chunk)).toEqual([
      '0 for nota in notas:',
      '1 if nota >= 5:',
      '2 total = total + nota',
      '1 else:',
      '2 print("suspenso")',
    ])
  })

  it('las vallas de código, los blancos y los comentarios no son sentencias; el comentario va con la siguiente', () => {
    const chunks = chunksOf(
      lines(
        '```python',
        '# Las notas de la clase',
        'notas = [7, 4, 9]',
        '',
        'def media(valores):',
        '    # Sumar y dividir',
        '    return sum(valores) / len(valores)',
        '```',
      ),
    )
    expect(chunks.map(shape)).toEqual([
      ['0 # Las notas de la clase\nnotas = [7, 4, 9]'],
      ['0 def media(valores):', '1 # Sumar y dividir\nreturn sum(valores) / len(valores)'],
    ])
  })

  it('una sentencia que ocupa varias líneas (un paréntesis abierto) es una sola pieza', () => {
    const chunks = chunksOf(
      lines('datos = {', '    "nombre": "Ana",', '    "nota": 7,', '}', 'print(datos)'),
    )
    expect(chunks.map((chunk) => chunk.code)).toEqual([
      'datos = {\n    "nombre": "Ana",\n    "nota": 7,\n}',
      'print(datos)',
    ])
    expect(chunks[0]?.steps).toHaveLength(1)
  })

  it('lo que no se arma por partes (try, elif, class, un decorador) se escribe entero', () => {
    const chunks = chunksOf(
      lines(
        'if nota >= 9:',
        '    print("sobresaliente")',
        'elif nota >= 5:',
        '    print("aprobado")',
        'else:',
        '    print("suspenso")',
        'try:',
        '    valor = int(texto)',
        'except ValueError:',
        '    valor = 0',
        '@cache',
        'def lenta(n):',
        '    return n',
      ),
    )
    expect(chunks.map((chunk) => chunk.steps.length)).toEqual([1, 1, 1])
    expect(chunks.every((chunk) => chunk.steps[0]?.whole === true)).toBe(true)
    expect(chunks[1]?.code).toBe('try:\n    valor = int(texto)\nexcept ValueError:\n    valor = 0')
    expect(chunks[2]?.code).toBe('@cache\ndef lenta(n):\n    return n')
  })

  it('código que llega sangrado de más se lee igual', () => {
    const chunks = chunksOf('    a = 1\n    for x in y:\n        print(x)\n    b = 2')
    expect(chunks.map(shape)).toEqual([['0 a = 1'], ['0 for x in y:', '1 print(x)'], ['0 b = 2']])
  })
})

describe('una frase, una fórmula', () => {
  it('se limpian de lo que un modelo les pone alrededor', () => {
    expect(sentenceOf('"Guardamos el **primer** número."\n')).toBe('Guardamos el primer número.')
    expect(sentenceOf('«Recorremos\ncada nota»')).toBe('Recorremos cada nota')
    expect(formulaOf('```\ny = 1 / (1 + exp(-x))\n```')).toBe('1 / (1 + exp(-x))')
    expect(formulaOf('f(x) = `x**2`')).toBe('x**2')
  })
})

describe('subrayar la parte exacta de la que habla una frase', () => {
  it('los trozos de una pieza entre los que elige el JEV, cada uno con lo que es', () => {
    expect(fragmentsOf('elif abs(sum(pesos) - 1.0) > 0.001:')).toEqual([
      'abs(sum(pesos) - 1.0) > 0.001',
      'abs',
      'sum',
      'abs(sum(pesos) - 1.0)',
      'sum(pesos)',
      'sum(pesos) - 1.0',
      'pesos',
      '1.0',
      '0.001',
    ])
    expect(fragmentsOf('# comentario\ntotal = total + nota')).toEqual([
      'total + nota',
      'total',
      'nota',
    ])
    expect(fragmentsOf('print("Hola")')).toEqual(['print', '"Hola"'])
    // La operación va con su nombre: es de lo que suele hablar la frase.
    expect(partsOf('pregunta = pregunta.lower()')).toEqual([
      { text: 'pregunta.lower()', what: 'el valor que se calcula' },
      { text: 'pregunta', what: 'la variable donde se guarda' },
      { text: 'lower', what: 'la operación que se aplica' },
    ])
    expect(fragmentsOf('for nota in notas[1:]:')).toEqual(['nota', 'notas[1:]', 'notas', '1'])
    expect(fragmentsOf('return round(total / len(notas), 2)')).toEqual([
      'round(total / len(notas), 2)',
      'round',
      'len',
      'len(notas)',
      'total / len(notas)',
      '2',
      'notas',
      'total',
    ])
  })

  it('lo que una frase delata sola: la operación dicha con otras palabras, o un nombre tal cual', () => {
    const lower = ['pregunta.lower()', 'pregunta', 'lower']
    expect(hinted('Convertimos el texto a minúsculas.', lower)).toBe(2)
    expect(hinted('Guardamos la pregunta.', lower)).toBe(1)
    expect(hinted('Y seguimos.', lower)).toBe(-1)
    expect(hinted('Calculamos la longitud de la lista.', ['len(notas)', 'len', 'notas'])).toBe(1)
    expect(hinted('Se suman los pesos.', ['sum', 'sum(pesos)', 'pesos'])).toBe(0)
  })

  it('el JEV elige uno por frase (o ninguno), todos en una petición', async () => {
    const { marks } = await judgeMarks(localDecider(), [
      { code: 'total = total + nota', say: 'Sumamos cada nota al total.' },
      { code: 'ok = True', say: 'Y seguimos adelante.' },
      { code: 'x = 1', say: '' },
      { code: 'pregunta = pregunta.lower()', say: 'Convertimos el texto a minúsculas.' },
    ])
    expect(marks).toEqual([['total'], [], [], ['lower']])
  })

  it('si el JEV no se decide o no contesta, vale lo que la frase delata; y manda suplentes', async () => {
    const piece = [
      { code: 'pregunta = pregunta.lower()', say: 'Convertimos el texto a minúsculas.' },
    ]
    const answering = (answer: JevAnswer): Decider => ({
      id: 'fijo',
      decide: () => Promise.resolve({ answers: { m1: answer }, ms: 1 }),
    })
    const choice = (pick: string, confidence: number, probabilities = {}): JevAnswer => ({
      type: 'choice',
      choice: pick,
      confidence,
      probabilities,
    })
    // Dudoso de que no haya nada: se subraya lo que la frase delata.
    expect((await judgeMarks(answering(choice('ninguno', 0.4)), piece)).marks).toEqual([['lower']])
    // Seguro de que no hay nada: nada.
    expect((await judgeMarks(answering(choice('ninguno', 0.9)), piece)).marks).toEqual([[]])
    // Elige uno: va primero, y detrás los suplentes (lo que delata la frase, y lo siguiente más probable).
    expect(
      (await judgeMarks(answering(choice('f1', 0.5, { f1: 0.5, f2: 0.3, f3: 0.05 })), piece)).marks,
    ).toEqual([['pregunta.lower()', 'lower', 'pregunta']])
    const down: Decider = { id: 'caído', decide: () => Promise.reject(new Error('sin red')) }
    expect((await judgeMarks(down, piece)).marks).toEqual([['lower']])
  })

  it('en el nodo, se subraya el campo que lleva ese trozo', () => {
    const fields = ['¿', 'abs(sum(pesos) − 1.0)', '>', '0.001', '?']
    expect(bestMatch(fields, 'abs(sum(pesos) - 1.0)')).toBe(1)
    expect(bestMatch(fields, '0.001')).toBe(3)
    // Si ningún campo lo lleva entero, el trozo más largo de él que haya escrito.
    expect(bestMatch(['total', '=', 'total + nota'], 'sum(total + nota)')).toBe(2)
    expect(bestMatch(fields, 'media')).toBe(-1)
    expect(bestMatch(fields, '')).toBe(-1)
    // El más ajustado: el nombre en su casilla antes que dentro de la expresión.
    expect(bestMatch(['pregunta', '=', 'pregunta.lower()'], 'pregunta')).toBe(0)
    expect(bestMatch(['pregunta', '=', 'pregunta.lower()'], 'lower')).toBe(2)
  })

  it('y dentro del campo, solo el tramo del que se habla', () => {
    const cut = (text: string, fragment: string) => {
      const span = locate(text, fragment)
      return span ? text.slice(span.start, span.end) : null
    }
    expect(cut('pregunta.lower()', 'lower')).toBe('lower')
    expect(cut('pregunta.lower()', 'pregunta')).toBe('pregunta')
    expect(cut('abs(sum(pesos) − 1.0)', 'sum(pesos) - 1.0')).toBe('sum(pesos) − 1.0')
    expect(cut('total  +  nota', 'total + nota')).toBe('total  +  nota')
    // Un nombre no casa a medias, ni un número dentro de otro.
    expect(cut('len(notas)', 'n')).toBeNull()
    expect(cut('1.0 + x', '1')).toBeNull()
    expect(cut('nota_final + nota', 'nota')).toBe('nota')
  })
})

describe('mientras se le oye: qué está pidiendo, palabra a palabra', () => {
  it('con cada palabra, el JEV adelanta qué clase de cosa es', async () => {
    const heard = async (text: string) => (await judgeHeard(localDecider(), text)).kind
    expect(await heard('una')).toBe('nada')
    expect(await heard('una función')).toBe('funcion')
    expect(await heard('una función que sume dos números')).toBe('funcion')
    expect(await heard('ahora una clase calculadora')).toBe('clase')
    expect(await heard('un programa que juegue')).toBe('programa')
  })
})

describe('si el usuario interrumpe: ¿vale lo que ya estaba preparado?', () => {
  const ask = async (said: string) =>
    (
      await judgeInterruption(localDecider(), {
        building: 'un programa que calcule la media',
        said,
        pending: 'print(media)',
      })
    ).what

  it('el JEV decide: seguir, ajustar lo que falta, u otra cosa', async () => {
    expect(await ask('vale, sigue')).toBe('seguir')
    expect(await ask('mejor usa un bucle while')).toBe('ajustar')
    expect(await ask('explícame cómo funciona el amor')).toBe('otra')
  })

  it('con dudas, manda lo que el usuario acaba de decir', async () => {
    const unsure = {
      id: 'duda',
      decide: () =>
        Promise.resolve({
          answers: {
            interrupcion: {
              type: 'choice' as const,
              choice: 'seguir',
              confidence: 0.3,
              probabilities: {},
            },
          },
          ms: 1,
        }),
    }
    expect((await judgeInterruption(unsure, { building: 'x', said: 'y', pending: '' })).what).toBe(
      'otra',
    )
  })
})

describe('lo que decide el JEV de cada trozo', () => {
  const stages = [
    { title: 'Preparar las notas', goal: 'Las notas de la clase.' },
    { title: 'Calcular la media', goal: 'Suma y divide.' },
    { title: 'Mostrar el resultado', goal: 'Imprime lo calculado.' },
  ]

  it('a qué etapa va, y si es seguro', async () => {
    const data = await judgeChunk(
      localDecider(),
      'la media de unas notas',
      'notas = [7, 4, 9]',
      stages,
      '',
    )
    expect(data).toMatchObject({ stage: 0, aid: null })
    expect(data.safe).toBeGreaterThan(0.7)
    const mean = await judgeChunk(localDecider(), 'x', 'media = total / len(notas)', stages, '')
    expect(mean.stage).toBe(1)
    // Si no está claro, no se decide: se queda donde se estaba.
    expect((await judgeChunk(localDecider(), 'x', 'x = 1', stages, '')).stage).toBeNull()
    expect((await judgeChunk(localDecider(), 'x', 'os.remove("a")', stages, '')).safe).toBeLessThan(
      0.7,
    )
  })

  it('si una función merece su curva, y entre qué valores', async () => {
    const fn = await judgeChunk(
      localDecider(),
      'una red neuronal',
      'def sigmoide(x):\n    return 1 / (1 + math.exp(-x))',
      [],
      '',
    )
    expect(fn.aid).toEqual([-6, 6])
    const plain = await judgeChunk(
      localDecider(),
      'x',
      'def saludar(nombre):\n    print(nombre)',
      [],
      '',
    )
    expect(plain.aid).toBeNull()
  })
})

describe('un paso de una orden larga que ya está hecho', () => {
  it('lo dice el JEV mirando el programa; el motor local, que no lo lee, no da nada por hecho', async () => {
    const asked: unknown[] = []
    const jev = {
      id: 'grabado',
      decide: (request: { state: unknown }) => {
        asked.push(request.state)
        return Promise.resolve({ ms: 1, answers: { hecho: { type: 'noul' as const, noul: 0.93 } } })
      },
    }
    const done = await judgeDone(jev, 'Pon el tablero en el programa principal', 'tablero = []\n', [
      'Saca el tablero de la función',
    ])
    expect(done).toBe(0.93)
    expect(asked[0]).toMatchObject({
      paso: 'Pon el tablero en el programa principal',
      antes: ['Saca el tablero de la función'],
    })
    expect(
      await judgeDone(localDecider(), 'Pon el tablero en el programa', 'x = 1\n', []),
    ).toBeLessThan(0.6)
  })
})

describe('lo pedido y lo construido: qué pieza cubre cada parte', () => {
  const parts = ['ver el total', 'exportar a un archivo', 'añadir un gasto']
  const pieces = ['añadir_gasto', 'calcular_suma']

  it('una pregunta cerrada por parte, con las piezas como opciones; la duda no decide', async () => {
    const offered: unknown[] = []
    const jev = {
      id: 'grabado',
      decide: (request: { questions: Record<string, unknown> }) => {
        offered.push(request.questions)
        return Promise.resolve({
          ms: 1,
          answers: {
            parte0: { type: 'choice' as const, choice: 'p1', confidence: 0.9 },
            parte1: { type: 'choice' as const, choice: 'ninguna', confidence: 0.8 },
            parte2: { type: 'choice' as const, choice: 'p0', confidence: 0.3 },
          },
        })
      },
    }
    // Segura de la pieza, segura de que ninguna, y sin saberlo.
    expect(await judgeCover(jev, 'llevar la cuenta de mis gastos', parts, pieces)).toEqual([
      'calcular_suma',
      '',
      null,
    ])
    expect(offered[0]).toMatchObject({
      parte0: { type: 'choice', criteria: { p0: 'añadir_gasto', p1: 'calcular_suma' } },
    })
  })

  it('del plan se pregunta qué etapa se ocupará, no cuál lo hace ya', async () => {
    const asked: string[] = []
    const jev = {
      id: 'grabado',
      decide: (request: { questions: Record<string, { instructions: string }> }) => {
        asked.push(request.questions.parte0?.instructions ?? '')
        return Promise.resolve({
          ms: 1,
          answers: { parte0: { type: 'choice' as const, choice: 'p0', confidence: 0.8 } },
        })
      },
    }
    expect(
      await judgeCover(jev, 'gastos', ['saber cuánto llevo'], ['Mostrar total'], true),
    ).toEqual(['Mostrar total'])
    expect(asked[0]).toContain('etapas del plan')
  })

  it('el motor local no lo sabe, y sin piezas no se pregunta', async () => {
    expect(await judgeCover(localDecider(), 'gastos', parts, pieces)).toEqual([null, null, null])
    expect(await judgeCover(localDecider(), 'gastos', parts, [])).toEqual([null, null, null])
  })
})
