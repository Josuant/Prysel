import { createHash } from 'node:crypto'

/**
 * Caché de «Explicar un tema» por (tema, nivel, idioma, modelo): repetir la misma lección no vuelve a
 * costarle nada al modelo. Puro: solo calcula la clave; dónde se guarda (el almacén global de la
 * extensión) lo decide `extension.ts`, que es quien sabe hablar con el disco.
 */

export interface CacheKey {
  topic: string
  level?: string
  lang?: string
  /** `AiProvider.id`: ya lleva el proveedor Y el modelo (`vscode:gpt-4o-mini`, `anthropic:claude-…`). */
  providerId: string
}

/** Lo que se guarda de una generación que valió, para poder repetirla sin llamar al modelo. */
export interface CachedTopic {
  title: string
  code: string
  lesson: unknown
  cachedAt: string
}

/** Espacios y mayúsculas de más no deberían fallar la caché: «Recursión» y «recursión » son lo mismo. */
const norm = (text: string): string => text.trim().toLowerCase().replace(/\s+/g, ' ')

/** Un nombre de archivo estable (hexadecimal, sin caracteres raros) para la clave dada. */
export function cacheKeyOf(key: CacheKey): string {
  const material = JSON.stringify([
    norm(key.topic),
    norm(key.level ?? ''),
    norm(key.lang ?? ''),
    key.providerId,
  ])
  return createHash('sha256').update(material).digest('hex')
}
