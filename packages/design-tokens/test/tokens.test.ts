import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parse, rgb, wcagContrast } from 'culori'
import { describe, expect, it } from 'vitest'
import {
  cssValue,
  generateCss,
  generateNames,
  generateTailwindTheme,
  mergeTokenFiles,
  valueFor,
  type Token,
  type TokenFile,
} from '../src/build.ts'

const path = (file: string) => fileURLToPath(new URL(`../src/${file}`, import.meta.url))
const text = (file: string) => readFileSync(path(file), 'utf8')
const json = (file: string) => JSON.parse(text(file)) as TokenFile

const DS_TOKENS_SHA256 = 'f4e7417d05fd7d8323bfa820085bcee96d373472c78621103662a7c70d765422'
const set = mergeTokenFiles(json('tokens.base.json'), json('tokens.theme.json'))

describe('fuente de verdad', () => {
  it('tokens.base.json es la copia literal del design system publicado', () => {
    const sha = createHash('sha256')
      .update(readFileSync(path('tokens.base.json')))
      .digest('hex')
    // Si esto falla: el DS cambió (o alguien editó la copia). Re-sincroniza y actualiza el hash.
    expect(sha).toBe(DS_TOKENS_SHA256)
  })

  it('los archivos generados están al día', () => {
    expect(text('generated/tokens.css')).toBe(generateCss(set))
    expect(text('generated/tailwind-theme.css')).toBe(generateTailwindTheme(set))
    expect(text('generated/names.ts')).toBe(generateNames(set))
  })

  it('cada valor que el tema cambia respecto al DS explica su razón', () => {
    expect(set.overrides.length).toBeGreaterThan(0)
    for (const o of set.overrides) {
      expect(o.reason.length, o.name).toBeGreaterThan(30)
    }
  })
})

describe('mergeTokenFiles', () => {
  const themes = [
    { id: 'light', name: 'L' },
    { id: 'dark', name: 'D' },
  ]
  const base = (tokens: Token[]): TokenFile => ({ color: { themes, tokens } })

  it('rechaza nombres duplicados entre familias', () => {
    const ext: TokenFile = { radius: { tokens: [{ name: 'ink', value: '4px' }] } }
    expect(() => mergeTokenFiles(base([{ name: 'ink', value: '#000' }]), ext)).toThrow(/duplicado/)
  })

  it('rechaza alias a tokens que no existen', () => {
    expect(() => mergeTokenFiles(base([{ name: 'a', value: '{nope}' }]), {})).toThrow(/no existe/)
  })

  it('rechaza ciclos de alias', () => {
    const tokens = [
      { name: 'a', value: '{b}' },
      { name: 'b', value: '{a}' },
    ]
    expect(() => mergeTokenFiles(base(tokens), {})).toThrow(/Ciclo/)
  })

  it('impide que el tema redefina los temas de color', () => {
    const b = base([{ name: 'a', value: '#000' }])
    expect(() => mergeTokenFiles(b, { color: { themes, tokens: [] } })).toThrow(/themes/)
  })

  describe('overrides', () => {
    const b = base([{ name: 'a', value: '#000000' }])

    it('cambian el valor del token del DS', () => {
      const ext: TokenFile = { overrides: [{ name: 'a', value: '#ffffff', reason: 'porque sí' }] }
      expect(mergeTokenFiles(b, ext).color[0]?.value).toBe('#ffffff')
    })

    it('exigen una razón', () => {
      const ext = { overrides: [{ name: 'a', value: '#fff', reason: '  ' }] } as TokenFile
      expect(() => mergeTokenFiles(b, ext)).toThrow(/razón/)
    })

    it('fallan si el token no existe en el DS (protege contra erratas)', () => {
      const ext: TokenFile = { overrides: [{ name: 'inexistente', value: '#fff', reason: 'x' }] }
      expect(() => mergeTokenFiles(b, ext)).toThrow(/no existen/)
    })
  })

  describe('tipografía', () => {
    const withType: TokenFile = {
      ...base([{ name: 'a', value: '#000' }]),
      type: { families: { mono: 'monospace' }, groups: [] },
    }

    it('el tema añade familias y grupos', () => {
      const merged = mergeTokenFiles(withType, {
        type: {
          families: { sans: 'system-ui' },
          groups: [{ name: 'UI', family: 'sans', styles: [] }],
        },
      })
      expect(Object.keys(merged.type.families ?? {})).toEqual(['mono', 'sans'])
      expect(merged.type.groups).toHaveLength(1)
    })

    it('el tema no puede redefinir una familia del DS', () => {
      const ext: TokenFile = { type: { families: { mono: 'otra' } } }
      expect(() => mergeTokenFiles(withType, ext)).toThrow(/familia/)
    })

    it('un grupo no puede usar una familia inexistente', () => {
      const ext: TokenFile = { type: { groups: [{ name: 'X', family: 'nope', styles: [] }] } }
      expect(() => mergeTokenFiles(withType, ext)).toThrow(/inexistente/)
    })
  })

  it('un token sin valor en un tema hereda el del primer tema', () => {
    const token: Token = { name: 'a', value: { light: '#111' } }
    expect(valueFor(token, 'dark', themes)).toBe('#111')
  })
})

describe('salida CSS', () => {
  const css = text('generated/tokens.css')

  it('convierte alias en var()', () => {
    expect(cssValue('{line}')).toBe('var(--line)')
    expect(css).toContain('--state-dormant: var(--line);')
  })

  it('declara ambos temas y el respaldo por prefers-color-scheme', () => {
    expect(css).toContain(":root[data-theme='dark']")
    expect(css).toContain('@media (prefers-color-scheme: dark)')
  })

  it('declara las dos familias tipográficas: interfaz y código', () => {
    expect(css).toContain('--font-sans:')
    expect(css).toContain('--font-mono:')
    expect(css).toContain('.type-node-title')
    expect(css).toContain('.type-code')
  })

  it('el tema de Tailwind vacía la paleta por defecto', () => {
    expect(text('generated/tailwind-theme.css')).toContain('--color-*: initial;')
  })
})

// ──────────────────────────────────────────────────────────────────────────
// Contraste WCAG. Criterios del checklist del DS: texto 4.5:1, bordes de control y glifos 3:1.
// ──────────────────────────────────────────────────────────────────────────

function resolveColor(name: string, theme: string, depth = 0): string {
  if (depth > 8) throw new Error(`alias demasiado profundo: ${name}`)
  const token = set.color.find((t) => t.name === name)
  if (!token) throw new Error(`token desconocido: ${name}`)
  const raw = valueFor(token, theme, set.themes)
  const alias = /^\{(.+)\}$/.exec(raw)?.[1]
  return alias ? resolveColor(alias, theme, depth + 1) : raw
}

interface Rgb {
  mode: 'rgb'
  r: number
  g: number
  b: number
  alpha?: number
}

function toRgb(color: string | Rgb): Rgb {
  const parsed = typeof color === 'string' ? rgb(parse(color)) : color
  if (!parsed) throw new Error(`color inválido: ${String(color)}`)
  return parsed as Rgb
}

/** Compone `fg` (con alfa) sobre `bg` opaco, como hace el navegador en sRGB. */
function over(fg: string | Rgb, bg: string | Rgb): Rgb {
  const f = toRgb(fg)
  const b = toRgb(bg)
  const a = f.alpha ?? 1
  return {
    mode: 'rgb',
    r: f.r * a + b.r * (1 - a),
    g: f.g * a + b.g * (1 - a),
    b: f.b * a + b.b * (1 - a),
  }
}

const themes = ['light', 'dark']
const grounds = ['void', 'surface', 'surface-raised', 'field']
const badges = ['value', 'data', 'transform', 'control', 'effect', 'output', 'neutral']
const chips = ['dormant', 'running', 'success', 'stale', 'warning', 'error', 'selected']
const states = [
  'state-running',
  'state-success',
  'state-stale',
  'state-warning',
  'state-error',
  'state-selected',
]

describe.each(themes)('contraste — tema %s', (theme) => {
  const c = (name: string) => resolveColor(name, theme)

  it.each(['ink', 'ink-muted', 'ink-faint'])('%s ≥ 4.5:1 sobre cada fondo', (ink) => {
    for (const ground of grounds) {
      expect(wcagContrast(c(ink), c(ground)), `${ink} sobre ${ground}`).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('accent ≥ 4.5:1 sobre surface: también se usa como texto', () => {
    expect(wcagContrast(c('accent'), c('surface'))).toBeGreaterThanOrEqual(4.5)
  })

  it('line ≥ 3:1 sobre void y surface (bordes de controles editables)', () => {
    for (const ground of ['void', 'surface']) {
      expect(wcagContrast(c('line'), c(ground)), ground).toBeGreaterThanOrEqual(3)
    }
  })

  it.each(states)('%s ≥ 3:1 sobre void y surface (glifos y aros)', (state) => {
    for (const ground of ['void', 'surface']) {
      expect(wcagContrast(c(state), c(ground)), `${state} sobre ${ground}`).toBeGreaterThanOrEqual(
        3,
      )
    }
  })

  it.each(badges)('insignia %s: su texto ≥ 4.5:1 sobre su propio fondo', (badge) => {
    const bg = c(`badge-${badge}-bg`)
    expect(wcagContrast(c(`badge-${badge}-fg`), bg), `badge-${badge}`).toBeGreaterThanOrEqual(4.5)
  })

  it.each(badges)(
    'insignia %s: sirve de píldora compacta, con ink e ink-muted legibles',
    (badge) => {
      const bg = c(`badge-${badge}-bg`)
      for (const ink of ['ink', 'ink-muted']) {
        expect(wcagContrast(c(ink), bg), `${ink} sobre badge-${badge}-bg`).toBeGreaterThanOrEqual(
          4.5,
        )
      }
    },
  )

  it.each(chips)('chip %s: su texto ≥ 4.5:1 sobre su propio fondo', (chip) => {
    const bg = c(`chip-${chip}-bg`)
    expect(wcagContrast(c(`chip-${chip}-fg`), bg), `chip-${chip}`).toBeGreaterThanOrEqual(4.5)
  })

  it('el texto sigue siendo legible sobre una tarjeta de vidrio', () => {
    // El vidrio lleva una lámina de surface (opacity-veil) bajo el desenfoque.
    const veil = Number(set.families['opacity']?.find((t) => t.name === 'opacity-veil')?.value)
    const glass = over({ ...toRgb(c('surface')), alpha: veil }, c('void'))
    for (const ink of ['ink', 'ink-muted', 'ink-faint']) {
      expect(wcagContrast(c(ink), glass), `${ink} sobre vidrio`).toBeGreaterThanOrEqual(4.5)
    }
  })
})
