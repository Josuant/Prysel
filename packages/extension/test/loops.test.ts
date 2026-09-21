import { spawnSync } from 'node:child_process'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Kernel, type LoopSeries } from '../src/kernel.ts'

/**
 * Los valores por vuelta: lo que valen, en cada vuelta de un bucle, los nombres que ese bucle cambia.
 * Es lo que permite ver una curva de pérdida o recorrer un bucle vuelta a vuelta.
 */

const python = process.env['PRYSEL_PYTHON'] ?? 'python'
const available = spawnSync(python, ['-c', 'import sys'], { stdio: 'ignore' }).status === 0
const withNumpy =
  available && spawnSync(python, ['-c', 'import numpy'], { stdio: 'ignore' }).status === 0

describe.skipIf(!available)('los valores por vuelta de un bucle', () => {
  let kernel: Kernel
  beforeAll(async () => {
    kernel = await Kernel.start({ python })
  }, 30_000)
  afterAll(() => {
    kernel.dispose()
  })

  /** Ejecuta y devuelve la última serie que avisó cada bucle. */
  const series = async (code: string, id = 'f1') => {
    const seen = new Map<string, LoopSeries>()
    const result = await kernel.run(code, {
      id,
      onIteration: (s) => seen.set(`${s.frag}|${s.loop}`, s),
    })
    return { result, seen, get: (loop: string) => seen.get(`${id}|${loop}`) }
  }

  it('cada vuelta anota lo que valen los nombres que el bucle cambia', async () => {
    const { get } = await series(
      'total = 0\nfor i in range(5):\n    total += i\n    cuadrado = i * i\n',
    )
    const loop = get('2:0')
    expect(loop?.n).toBe(5)
    expect(loop?.done).toBe(true)
    expect(loop?.idx).toEqual([0, 1, 2, 3, 4])
    expect(loop?.names).toEqual({
      i: [0, 1, 2, 3, 4],
      total: [0, 1, 3, 6, 10],
      cuadrado: [0, 1, 4, 9, 16],
    })
  })

  it('un bucle while también, y la clave dice dónde está (línea:columna)', async () => {
    const { get } = await series('n = 3\nwhile n > 0:\n    n -= 1\n')
    expect(get('2:0')?.names).toEqual({ n: [2, 1, 0] })
  })

  it('un break y un continue no pierden la vuelta en la que ocurren', async () => {
    const { get } = await series(
      'suma = 0\nfor i in range(10):\n    if i == 1:\n        continue\n    suma += i\n    if i == 4:\n        break\n',
    )
    const loop = get('2:0')
    expect(loop?.n).toBe(5)
    expect(loop?.names['suma']).toEqual([0, 0, 2, 5, 9])
  })

  it('un error en mitad del bucle deja anotada hasta donde llegó', async () => {
    const { result, get } = await series('x = 0\nfor i in range(5):\n    x = 10 / (2 - i)\n')
    expect(result.ok).toBe(false)
    expect(result.error).toMatchObject({ name: 'ZeroDivisionError', line: 3 })
    const loop = get('2:0')
    expect(loop?.done).toBe(true)
    expect(loop?.names['i']).toEqual([0, 1, 2])
  })

  it('lo que no es un número se guarda como una descripción corta', async () => {
    const { get } = await series(
      'for i in range(2):\n    fila = [i, i]\n    nombre = "ab" * (i + 1)\n    ok = i == 1\n    nada = None\n',
    )
    const names = get('1:0')?.names
    expect(names?.['fila']).toEqual(['list #2', 'list #2'])
    expect(names?.['nombre']).toEqual(["'ab'", "'abab'"])
    expect(names?.['ok']).toEqual(['False', 'True'])
    expect(names?.['nada']).toEqual(['None', 'None'])
  })

  it('un array pequeño con un solo elemento cuenta como número; uno grande, como su forma', async ({
    skip,
  }) => {
    if (!withNumpy) return skip()
    const { get } = await series(
      'import numpy as np\nfor i in range(2):\n    perdida = np.float64(i) + np.zeros(())\n    w = np.zeros((3, 4))\n',
    )
    const names = get('2:0')?.names
    expect(names?.['perdida']).toEqual([0, 1])
    expect(names?.['w']).toEqual(['ndarray 3×4', 'ndarray 3×4'])
  })

  it('bucles anidados: cada uno tiene su serie, y el de dentro empieza de nuevo en cada vuelta de fuera', async () => {
    const { get } = await series(
      'total = 0\nfor i in range(3):\n    for j in range(2):\n        total += 1\n',
    )
    expect(get('2:0')?.names['total']).toEqual([2, 4, 6])
    // La serie del interior es la de la última vuelta de fuera.
    expect(get('3:4')?.n).toBe(2)
    expect(get('3:4')?.names['j']).toEqual([0, 1])
  })

  it('un bucle dentro de una función anota cuando se la llama, aunque se llame en otra ejecución', async () => {
    await series(
      'def entrenar(n):\n    acumulado = 0\n    for e in range(n):\n        acumulado += e\n    return acumulado\n',
      'def1',
    )
    const seen: LoopSeries[] = []
    const run = await kernel.run('entrenar(4)', { id: 'call1', onIteration: (s) => seen.push(s) })
    expect(run.result?.repr).toBe('6')
    const last = seen.at(-1)
    // La serie es del fragmento que definió la función, no del que la llama.
    expect(last?.frag).toBe('def1')
    expect(last?.loop).toBe('3:4')
    expect(last?.names['acumulado']).toEqual([0, 1, 3, 6])
  })

  it('un bucle largo guarda una muestra, no una fila por vuelta, y la última es exacta', async () => {
    const started = performance.now()
    const { get } = await series('t = 0\nfor i in range(300000):\n    t += i\n')
    const elapsed = performance.now() - started
    const loop = get('2:0')
    expect(loop?.n).toBe(300000)
    expect(loop?.idx.length).toBeLessThanOrEqual(600)
    expect(loop?.idx.at(-1)).toBe(299999)
    expect(loop?.names['t']?.at(-1)).toBe((299999 * 300000) / 2)
    // Anotar no puede volver el bucle inservible.
    expect(elapsed).toBeLessThan(4000)
  }, 20_000)

  it('un bucle lento anota cada vuelta aunque sean muchas', async () => {
    const { get } = await series(
      'import time\nfor i in range(300):\n    x = i\n    if i % 100 == 0:\n        time.sleep(0.3)\n',
    )
    const loop = get('2:0')
    // Las primeras 256 vueltas se guardan todas, y las lentas también.
    expect(loop?.idx.slice(0, 5)).toEqual([0, 1, 2, 3, 4])
    expect(loop?.idx).toContain(200)
  }, 20_000)

  it('el código sin bucles no se toca, y los números de línea de los errores siguen siendo los mismos', async () => {
    const { result, seen } = await series('a = 1\nb = a / 0\n')
    expect(seen.size).toBe(0)
    expect(result.error?.line).toBe(2)
  })

  it('reiniciar olvida las series', async () => {
    await series('for i in range(3):\n    pass\n', 'antes')
    await kernel.reset()
    const { get } = await series('for i in range(2):\n    pass\n', 'despues')
    expect(get('1:0')?.n).toBe(2)
  })
})
