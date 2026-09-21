import { spawnSync } from 'node:child_process'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Kernel } from '../src/kernel.ts'

/**
 * El motor de ejecución de verdad: un Python real detrás de un espacio de nombres vivo. Necesita un
 * intérprete (`PRYSEL_PYTHON`, o `python` del PATH); sin él, las pruebas se saltan. Lo que depende de
 * una librería (numpy, matplotlib…) se salta si esa librería no está.
 */

const python = process.env['PRYSEL_PYTHON'] ?? 'python'
const works = (code: string) => spawnSync(python, ['-c', code], { stdio: 'ignore' }).status === 0
const available = works('import sys')
const withNumpy = available && works('import numpy')
const withPil = available && works('import PIL.Image')
const withMatplotlib = available && works('import matplotlib')
const withPandas = available && works('import pandas')

describe.skipIf(!available)('el motor de ejecución', () => {
  let kernel: Kernel
  const started = performance.now()
  let startup = 0

  beforeAll(async () => {
    kernel = await Kernel.start({ python })
    startup = performance.now() - started
  }, 30_000)

  afterAll(() => {
    kernel.dispose()
    console.log(`arranque: ${startup.toFixed(0)} ms · ${kernel.info?.python ?? ''}`)
  })

  it('el espacio de nombres persiste de una ejecución a la siguiente', async () => {
    await kernel.reset()
    const first = await kernel.run('x = 20\ny = 22')
    expect(first.ok).toBe(true)
    const second = await kernel.run('x + y')
    expect(second.ok).toBe(true)
    expect(second.result).toMatchObject({ type: 'int', repr: '42' })
  })

  it('devuelve la salida escrita, sin mezclarla con el protocolo', async () => {
    const result = await kernel.run(
      'print("hola ñandú")\nimport sys\nprint("mal", file=sys.stderr)',
    )
    expect(result.stdout).toBe('hola ñandú\n')
    expect(result.stderr).toBe('mal\n')
    expect(result.result).toBeUndefined()
  })

  it('cada nombre pedido vuelve resumido, con su tipo y su tamaño', async () => {
    const result = await kernel.run(
      'nombres = ["a", "b", "c"]\nconfig = {"lr": 0.1, "epochs": 3}\ntexto = "hola"\nnada = None',
      { watch: ['nombres', 'config', 'texto', 'nada', 'noexiste'] },
    )
    expect(result.values['nombres']).toMatchObject({ type: 'list', length: 3 })
    expect(result.values['config']).toMatchObject({ type: 'dict', length: 2 })
    expect(result.values['texto']).toMatchObject({ type: 'str', length: 4, repr: "'hola'" })
    expect(result.values['nada']).toMatchObject({ type: 'NoneType' })
    // Lo que no está definido no se inventa.
    expect(result.values['noexiste']).toBeUndefined()
  })

  it('un error dice qué línea del fragmento falló, y el motor sigue vivo', async () => {
    const result = await kernel.run('a = 1\nb = 2\nc = a / 0\nd = 4')
    expect(result.ok).toBe(false)
    expect(result.error).toMatchObject({ name: 'ZeroDivisionError', line: 3 })
    expect(result.error?.traceback).toContain('ZeroDivisionError')
    // Lo anterior al fallo queda definido; lo posterior, no.
    const after = await kernel.run('(a, b)', { watch: ['d'] })
    expect(after.result?.type).toBe('tuple')
    expect(after.values['d']).toBeUndefined()
  })

  it('un error de sintaxis también señala su línea', async () => {
    const result = await kernel.run('x = 1\ny = (2 +\n')
    expect(result.ok).toBe(false)
    expect(result.error?.name).toBe('SyntaxError')
    expect(result.error?.line).toBeGreaterThan(0)
  })

  it('una interrupción corta un bucle infinito y el motor responde después', async () => {
    const running = kernel.run('import time\nwhile True:\n    time.sleep(0.01)', { id: 'largo' })
    await new Promise((resolve) => setTimeout(resolve, 300))
    kernel.interrupt()
    const result = await running
    expect(result.ok).toBe(false)
    expect(result.error?.name).toBe('KeyboardInterrupt')
    expect((await kernel.run('1 + 1')).result?.repr).toBe('2')
  }, 15_000)

  it('la salida llega según se produce, no solo al final', async () => {
    const seen: number[] = []
    const started = performance.now()
    await kernel.run('import time\nfor i in range(3):\n    print(i)\n    time.sleep(0.15)', {
      onStream: () => seen.push(performance.now() - started),
    })
    expect(seen).toHaveLength(6) // cada `print` escribe el número y el salto de línea
    expect((seen.at(-1) ?? 0) - (seen[0] ?? 0)).toBeGreaterThan(200)
  })

  it('un valor con NaN o infinito no rompe el protocolo', async () => {
    const result = await kernel.run('vals = [1.5, float("nan"), float("inf")]', { watch: ['vals'] })
    expect(result.ok).toBe(true)
    expect(result.values['vals']?.items).toHaveLength(3)
    const value = await kernel.run('float("nan")')
    expect(value.result?.type).toBe('float')
  })

  it('ejecutar el mismo programa sentencia a sentencia enseña el valor de cada chip', async () => {
    await kernel.reset()
    const steps: [string, string[]][] = [
      ['datos = [3, 1, 2]', ['datos']],
      ['ordenados = sorted(datos)', ['ordenados']],
      ['lo, hi = min(datos), max(datos)', ['lo', 'hi']],
      ['total = sum(ordenados)', ['total']],
    ]
    const seen: Record<string, string | undefined> = {}
    for (const [code, watch] of steps) {
      const result = await kernel.run(code, { watch })
      expect(result.ok).toBe(true)
      for (const name of watch)
        seen[name] = result.values[name]?.repr ?? result.values[name]?.items?.join(',')
    }
    expect(seen).toEqual({
      datos: '3,1,2',
      ordenados: '1,2,3',
      lo: '1',
      hi: '3',
      total: '6',
    })
  })

  it('cuenta lo que hay definido', async () => {
    await kernel.reset()
    await kernel.run('import os\nvalor = 7\n_privada = 1')
    const names = Object.keys(await kernel.vars())
    expect(names).toEqual(['valor'])
  })

  it('reconoce un array por su forma sin importarlo', async ({ skip }) => {
    if (!withNumpy) return skip()
    const result = await kernel.run(
      'import numpy as np\nX = np.arange(12, dtype="float32").reshape(3, 4)',
      { watch: ['X'] },
    )
    expect(result.values['X']).toMatchObject({
      type: 'ndarray',
      module: 'numpy',
      shape: [3, 4],
      dtype: 'float32',
      bytes: 48,
      range: [0, 11],
    })
    expect(result.values['X']?.sample).toHaveLength(12)
  })

  it('reconoce algo con forma de DataFrame por sus columnas, sin importar pandas', async () => {
    const result = await kernel.run(
      [
        'class Tabla:',
        '    columns = ["a", "b"]',
        '    dtypes = {"a": "int64", "b": "object"}',
        '    shape = (3, 2)',
        '    def head(self, n): return self',
        '    def __getitem__(self, columns): return self',
        '    values = property(lambda self: self)',
        '    def tolist(self): return [[1, "x"], [2, "y"], [3, float("nan")]]',
        '    def isna(self): return self',
        '    def sum(self): return {"a": 0, "b": 1}',
        'tabla = Tabla()',
      ].join('\n'),
      { watch: ['tabla'] },
    )
    expect(result.ok).toBe(true)
    const summary = result.values['tabla']
    expect(summary?.shape).toEqual([3, 2])
    expect(summary?.table?.columns).toEqual([
      { name: 'a', dtype: 'int64', nulls: 0 },
      { name: 'b', dtype: 'object', nulls: 1 },
    ])
    // El NaN de una celda llega como `null`: el protocolo sigue siendo JSON válido.
    expect(summary?.table?.rows[2]).toEqual([3, null])
  })

  it('resume un DataFrame: columnas con tipo y nulos, y las primeras filas', async ({ skip }) => {
    if (!withPandas) return skip()
    const result = await kernel.run(
      'import pandas as pd\ndf = pd.DataFrame({"a": [1, 2, None], "b": ["x", "y", "z"]})',
      { watch: ['df'] },
    )
    const table = result.values['df']?.table
    expect(result.values['df']?.shape).toEqual([3, 2])
    expect(table?.columns).toEqual([
      { name: 'a', dtype: 'float64', nulls: 1 },
      { name: 'b', dtype: 'object', nulls: 0 },
    ])
    expect(table?.rows).toHaveLength(3)
  })

  it('resume una imagen de PIL con una miniatura', async ({ skip }) => {
    if (!withPil) return skip()
    const result = await kernel.run(
      'from PIL import Image\nimg = Image.new("RGB", (64, 32), "red")',
      {
        watch: ['img'],
      },
    )
    expect(result.values['img']?.size).toEqual([64, 32])
    expect(result.values['img']?.image?.length).toBeGreaterThan(50)
  })

  it('recoge las figuras de matplotlib como imágenes', async ({ skip }) => {
    if (!withMatplotlib) return skip()
    const result = await kernel.run(
      'import matplotlib.pyplot as plt\nplt.plot([1, 2, 3], [1, 4, 9])\nplt.title("t")',
    )
    expect(result.ok).toBe(true)
    expect(result.figures).toHaveLength(1)
    expect(result.figures[0]?.mime).toBe('image/png')
    // Es un PNG de verdad: su cabecera en Base64.
    expect(result.figures[0]?.data.startsWith('iVBORw0KGgo')).toBe(true)
    // La figura se cierra tras recogerla: la siguiente ejecución no arrastra la anterior.
    expect((await kernel.run('1')).figures).toHaveLength(0)
  })

  it('si el proceso muere, lo dice y no deja nada colgado', async () => {
    const dying = await Kernel.start({ python })
    const result = await dying.run('import os\nos._exit(3)')
    expect(result.ok).toBe(false)
    expect(result.error?.name).toBe('KernelDied')
    expect(dying.alive).toBe(false)
    expect((await dying.run('1')).error?.name).toBe('KernelDied')
  })

  it('un intérprete que no existe falla al arrancar con un motivo', async () => {
    await expect(Kernel.start({ python: 'python-que-no-existe-prysel' })).rejects.toThrow()
  })
})
