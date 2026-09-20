/**
 * Generador de tokens: `tokens.base.json` (copia literal del design system) +
 * `tokens.theme.json` (el tema v2: overrides razonados y tokens nuevos) → CSS, tema de Tailwind y tipos.
 * Todas las funciones son puras; `scripts/build.ts` se encarga del disco.
 */

export interface Theme {
  id: string
  name: string
}

export type TokenValue = string | Record<string, string>

export interface Token {
  name: string
  value: TokenValue
  usage?: string
}

export interface TypeStyle {
  name: string
  fontSize: string
  lineHeight: string
  fontWeight: number
  letterSpacing?: string
  usage?: string
}

export interface TypeSection {
  families?: Record<string, string>
  groups?: { name: string; family: string; styles: TypeStyle[] }[]
}

/** Un token del design system al que el tema le cambia el valor. `reason` es obligatorio. */
export interface Override extends Token {
  reason: string
}

export interface TokenFile {
  name?: string
  version?: number
  color?: { themes?: Theme[]; tokens: Token[] }
  type?: TypeSection
  overrides?: Override[]
  [family: string]: unknown
}

export interface TokenSet {
  themes: Theme[]
  color: Token[]
  /** Todas las familias con lista de tokens que no son color (spacing, radius, shadow, blur…). */
  families: Record<string, Token[]>
  type: TypeSection
  /** Los tokens del DS cuyo valor cambia este tema, para poder documentarlos. */
  overrides: Override[]
}

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/
const ALIAS_RE = /^\{([A-Za-z0-9][A-Za-z0-9_.-]*)\}$/
const RESERVED_KEYS = new Set(['name', 'version', 'color', 'type', 'overrides'])

function isTokenList(value: unknown): value is { tokens: Token[] } {
  return (
    typeof value === 'object' &&
    value !== null &&
    Array.isArray((value as { tokens?: unknown }).tokens)
  )
}

/**
 * Une el archivo base (copia literal del design system) con el tema.
 * El tema puede AÑADIR tokens, AÑADIR familias y estilos tipográficos, y cambiar el valor
 * de un token existente solo a través de `overrides`, siempre con una razón escrita.
 */
export function mergeTokenFiles(base: TokenFile, ext: TokenFile): TokenSet {
  const themes = base.color?.themes
  if (!themes || themes.length === 0) throw new Error('El archivo base debe declarar color.themes')
  if (ext.color?.themes) throw new Error('El tema no puede redefinir color.themes')

  const overrides = ext.overrides ?? []
  for (const o of overrides) {
    if (!o.reason?.trim()) throw new Error(`El override de "${o.name}" no explica su razón`)
  }
  const patches = new Map(overrides.map((o) => [o.name, o]))

  const apply = (tokens: Token[]): Token[] =>
    tokens.map((t) => {
      const patch = patches.get(t.name)
      if (!patch) return t
      patches.delete(t.name)
      return { name: t.name, value: patch.value, usage: patch.usage ?? t.usage }
    })

  const color = [...apply(base.color?.tokens ?? []), ...(ext.color?.tokens ?? [])]
  const families: Record<string, Token[]> = {}
  for (const file of [base, ext]) {
    for (const [key, value] of Object.entries(file)) {
      if (RESERVED_KEYS.has(key) || !isTokenList(value)) continue
      families[key] = [...(families[key] ?? []), ...apply(value.tokens)]
    }
  }
  if (patches.size > 0) {
    throw new Error(
      `Overrides de tokens que no existen en el design system: ${[...patches.keys()].join(', ')}`,
    )
  }

  const set: TokenSet = { themes, color, families, type: mergeType(base.type, ext.type), overrides }
  validateTokenSet(set)
  return set
}

/** La tipografía del tema se suma a la del DS: familias nuevas y grupos nuevos, nunca redefinir un estilo. */
function mergeType(base: TypeSection = {}, ext: TypeSection = {}): TypeSection {
  const families = { ...base.families, ...ext.families }
  for (const key of Object.keys(ext.families ?? {})) {
    if (base.families?.[key]) throw new Error(`El tema no puede redefinir la familia "${key}"`)
  }
  const groups = [...(base.groups ?? []), ...(ext.groups ?? [])]
  const names = groups.flatMap((g) => g.styles.map((s) => s.name))
  const duplicate = names.find((n, i) => names.indexOf(n) !== i)
  if (duplicate) throw new Error(`Estilo tipográfico duplicado: "${duplicate}"`)
  for (const group of groups) {
    if (!families[group.family])
      throw new Error(`El grupo "${group.name}" usa una familia inexistente`)
  }
  return { families, groups }
}

export function validateTokenSet(set: TokenSet): void {
  const seen = new Set<string>()
  const all = [...set.color, ...Object.values(set.families).flat()]
  for (const token of all) {
    if (!NAME_RE.test(token.name)) throw new Error(`Nombre de token inválido: "${token.name}"`)
    if (seen.has(token.name)) throw new Error(`Nombre de token duplicado: "${token.name}"`)
    seen.add(token.name)
  }

  const colorNames = new Set(set.color.map((t) => t.name))
  const themeIds = set.themes.map((t) => t.id)
  for (const token of set.color) {
    for (const themeId of themeIds) {
      const raw = valueFor(token, themeId, set.themes)
      const alias = ALIAS_RE.exec(raw)?.[1]
      if (alias !== undefined && !colorNames.has(alias)) {
        throw new Error(`El alias {${alias}} de "${token.name}" no existe`)
      }
    }
  }
  assertNoAliasCycles(set)
}

function assertNoAliasCycles(set: TokenSet): void {
  const byName = new Map(set.color.map((t) => [t.name, t]))
  for (const theme of set.themes) {
    for (const token of set.color) {
      const trail = new Set<string>()
      let current: Token | undefined = token
      while (current) {
        if (trail.has(current.name)) throw new Error(`Ciclo de alias en "${current.name}"`)
        trail.add(current.name)
        const alias: string | undefined = ALIAS_RE.exec(
          valueFor(current, theme.id, set.themes),
        )?.[1]
        current = alias === undefined ? undefined : byName.get(alias)
      }
    }
  }
}

/** Valor de un token en un tema; si falta, hereda el del primer tema (regla del DS). */
export function valueFor(token: Token, themeId: string, themes: Theme[]): string {
  if (typeof token.value === 'string') return token.value
  const fallback = themes[0] ? token.value[themes[0].id] : undefined
  const value = token.value[themeId] ?? fallback
  if (value === undefined) throw new Error(`El token "${token.name}" no tiene valor en ningún tema`)
  return value
}

export function isThemed(token: Token): boolean {
  return typeof token.value !== 'string'
}

/** Convierte `{line}` en `var(--line)`; cualquier otro valor pasa intacto. */
export function cssValue(raw: string): string {
  const alias = ALIAS_RE.exec(raw)?.[1]
  return alias === undefined ? raw : `var(--${alias})`
}

const HEADER = '/* GENERADO por packages/design-tokens (pnpm tokens). No editar a mano. */\n'

function declarations(tokens: Token[], themeId: string, themes: Theme[]): string[] {
  return tokens.map((t) => `  --${t.name}: ${cssValue(valueFor(t, themeId, themes))};`)
}

function typeClasses(type: TypeSection): string {
  const out: string[] = []
  for (const group of type.groups ?? []) {
    for (const s of group.styles) {
      const lines = [
        `  font-family: var(--font-${group.family});`,
        `  font-size: ${s.fontSize};`,
        `  line-height: ${s.lineHeight};`,
        `  font-weight: ${s.fontWeight};`,
      ]
      if (s.letterSpacing) lines.push(`  letter-spacing: ${s.letterSpacing};`)
      out.push(`.type-${s.name} {\n${lines.join('\n')}\n}`)
    }
  }
  return out.join('\n\n')
}

export function generateCss(set: TokenSet): string {
  const [first, ...rest] = set.themes
  if (!first) throw new Error('Sin temas')
  const all = [...set.color, ...Object.values(set.families).flat()]
  const themed = all.filter(isThemed)
  const fixed = all.filter((t) => !isThemed(t))
  const fonts = Object.entries(set.type.families ?? {}).map(([k, v]) => `  --font-${k}: ${v};`)

  const blocks: string[] = []
  blocks.push(
    `:root,\n:root[data-theme='${first.id}'] {\n  color-scheme: ${first.id};\n${[
      ...fonts,
      ...declarations(fixed, first.id, set.themes),
      ...declarations(themed, first.id, set.themes),
    ].join('\n')}\n}`,
  )
  for (const theme of rest) {
    const body = declarations(themed, theme.id, set.themes).join('\n')
    blocks.push(`:root[data-theme='${theme.id}'] {\n  color-scheme: ${theme.id};\n${body}\n}`)
    if (theme.id === 'dark') {
      blocks.push(
        `@media (prefers-color-scheme: dark) {\n  :root:not([data-theme]) {\n    color-scheme: dark;\n${body
          .split('\n')
          .map((l) => `  ${l}`)
          .join('\n')}\n  }\n}`,
      )
    }
  }
  blocks.push(typeClasses(set.type))
  return `${HEADER}\n${blocks.join('\n\n')}\n`
}

/**
 * Tema de Tailwind v4. Vacía la paleta por defecto: solo existen los colores del sistema,
 * así `bg-red-500` o `text-blue-600` no compilan y nadie puede colar un color propio.
 */
export function generateTailwindTheme(set: TokenSet): string {
  const lines: string[] = ['  --color-*: initial;']
  for (const t of set.color) lines.push(`  --color-${t.name}: var(--${t.name});`)
  const map: Record<string, string> = {
    spacing: 'spacing',
    radius: 'radius',
    shadow: 'shadow',
    blur: 'blur',
  }
  for (const [family, prefix] of Object.entries(map)) {
    for (const t of set.families[family] ?? [])
      lines.push(`  --${prefix}-${t.name}: var(--${t.name});`)
  }
  for (const key of Object.keys(set.type.families ?? {})) {
    lines.push(`  --font-${key}: var(--font-${key});`)
  }
  return `${HEADER}\n@theme inline {\n${lines.join('\n')}\n}\n`
}

export function generateNames(set: TokenSet): string {
  const list = (names: string[]) => `[${names.map((n) => `'${n}'`).join(', ')}] as const`
  const groups: Record<string, string[]> = { color: set.color.map((t) => t.name) }
  for (const [family, tokens] of Object.entries(set.families))
    groups[family] = tokens.map((t) => t.name)
  groups['typeStyle'] = (set.type.groups ?? []).flatMap((g) => g.styles.map((s) => s.name))

  const body = Object.entries(groups)
    .map(([k, names]) => `  ${k}: ${list(names)},`)
    .join('\n')
  return `${HEADER.replace('/*', '//').replace(' */', '')}
export const tokenNames = {
${body}
} as const

export type TokenFamily = keyof typeof tokenNames
export type TokenName<F extends TokenFamily> = (typeof tokenNames)[F][number]
export type ColorToken = TokenName<'color'>
`
}
