import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * Guardián del design system: todo color sale de un token (`var(--…)` o una utilidad de Tailwind
 * generada desde los tokens). Un color literal es un color que el sistema no controla.
 */
const root = fileURLToPath(new URL('../../../', import.meta.url))
const scanned = ['packages/ui/src', 'packages/morphology/src', 'apps/gallery/src']

const LITERAL_COLOR = /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(/

function sources(dir: string): string[] {
  return readdirSync(join(root, dir), { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && /\.(css|tsx?)$/.test(e.name))
    .map((e) => join(e.parentPath, e.name))
}

describe('sin colores literales fuera de los tokens', () => {
  it.each(scanned)('%s', (dir) => {
    const files = sources(dir)
    expect(files.length).toBeGreaterThan(0)
    for (const file of files) {
      const lines = readFileSync(file, 'utf8').split('\n')
      lines.forEach((line, i) => {
        expect(LITERAL_COLOR.test(line), `${file}:${i + 1} → ${line.trim()}`).toBe(false)
      })
    }
  })
})
