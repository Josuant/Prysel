import { describe, expect, it } from 'vitest'
import { reachesOutside, safeEnough } from '../src/jev/safety.ts'

/**
 * Cuánta certeza se le pide al JEV para dar un trozo por seguro depende de lo que el código puede hacer: lo
 * que solo calcula no se para por una respuesta tibia.
 */

const lines = (...rows: string[]) => rows.join('\n')

describe('si un trozo tiene con qué tocar archivos, la red o el sistema', () => {
  it('lo que solo calcula, no', () => {
    expect(
      reachesOutside(
        lines(
          'def seleccionar(poblacion):',
          '    ordenados = sorted(poblacion, key=evaluar, reverse=True)',
          '    return ordenados[:2]',
        ),
      ),
    ).toBe(false)
    expect(reachesOutside('import random\nfrom math import exp\nx = random.randint(0, 10)')).toBe(
      false,
    )
    expect(reachesOutside('print("abre os.system y open(archivo)")  # eval(x)')).toBe(false)
  })

  it('abrir archivos, ejecutar texto o importar algo de fuera, sí', () => {
    expect(reachesOutside('datos = open("notas.txt").read()')).toBe(true)
    expect(reachesOutside('import os')).toBe(true)
    expect(reachesOutside('from subprocess import run')).toBe(true)
    expect(reachesOutside('import random, requests')).toBe(true)
    expect(reachesOutside('eval(texto)')).toBe(true)
    expect(reachesOutside('x.__class__.__bases__')).toBe(true)
    expect(reachesOutside('import pygame')).toBe(true)
  })
})

describe('cuánto hace falta del JEV', () => {
  const harmless = 'ordenados = sorted(poblacion, key=evaluar, reverse=True)'
  const reaching = 'import os\nos.remove("datos.csv")'

  it('lo que solo calcula sigue con un «sí» tibio: solo lo para un «no» claro', () => {
    expect(safeEnough(harmless, 0.5)).toBe(true)
    expect(safeEnough(harmless, 0.3)).toBe(true)
    expect(safeEnough(harmless, 0.1)).toBe(false)
  })

  it('lo que puede salir del programa necesita el «sí» firme de siempre', () => {
    expect(safeEnough(reaching, 0.5)).toBe(false)
    expect(safeEnough(reaching, 0.69)).toBe(false)
    expect(safeEnough(reaching, 0.9)).toBe(true)
  })
})
