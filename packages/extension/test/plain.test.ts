import { describe, expect, it } from 'vitest'
import { localDecider } from '../src/jev/local.ts'
import { bestMatch } from '../webview/src/marking.ts'
import {
  CodeStream,
  LineStream,
  formulaOf,
  fragmentsOf,
  judgeChunk,
  judgeInterruption,
  judgeMarks,
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
  it('los trozos de una pieza entre los que elige el JEV: llamadas, nombres, números y textos', () => {
    expect(fragmentsOf('elif abs(sum(pesos) - 1.0) > 0.001:')).toEqual([
      'abs(sum(pesos) - 1.0)',
      'sum(pesos)',
      'abs',
      'sum',
      'pesos',
      '1.0',
      '0.001',
    ])
    expect(fragmentsOf('# comentario\ntotal = total + nota')).toEqual(['total', 'nota'])
    expect(fragmentsOf('print("Hola")')).toEqual(['"Hola"'])
  })

  it('el JEV elige uno por frase (o ninguno), todos en una petición', async () => {
    const { marks } = await judgeMarks(localDecider(), [
      { code: 'total = total + nota', say: 'Sumamos cada nota al total.' },
      { code: 'print(total)', say: 'Y lo enseñamos.' },
      { code: 'x = 1', say: '' },
    ])
    // El decisor local subraya el nombre que la frase dice tal cual.
    expect(marks).toEqual(['total', '', ''])
  })

  it('en el nodo, se subraya el campo que lleva ese trozo', () => {
    const fields = ['¿', 'abs(sum(pesos) − 1.0)', '>', '0.001', '?']
    expect(bestMatch(fields, 'abs(sum(pesos) - 1.0)')).toBe(1)
    expect(bestMatch(fields, '0.001')).toBe(3)
    // Si ningún campo lo lleva entero, el trozo más largo de él que haya escrito.
    expect(bestMatch(['total', '=', 'total + nota'], 'sum(total + nota)')).toBe(2)
    expect(bestMatch(fields, 'media')).toBe(-1)
    expect(bestMatch(fields, '')).toBe(-1)
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
