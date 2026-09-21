/**
 * El modelo de datos de cada editor gráfico.
 *
 * Vive en morfología, no en la interfaz, porque lo produce el análisis del código y lo consume
 * la interfaz: el analizador dice «este `print` es un mensaje de texto» y el editor sabe
 * dibujarlo. Es solo datos — cómo se pinta cada uno es asunto de `@prysel/ui`.
 *
 * Regla: un modelo solo se produce cuando dice **toda** la sentencia. Si el analizador no
 * puede representar lo que hay debajo sin perder algo, no inventa un editor: el nodo enseña
 * el código tal cual.
 */
export type ControlModel =
  | {
      kind: 'text'
      value: string
      placeholder?: string
      /** Un mensaje largo: se edita en un área de texto, no en una línea. */
      multiline?: boolean
    }
  | {
      kind: 'number'
      value: number
      /** Con rango es un deslizador; sin él (un literal cualquiera), un campo numérico. */
      min?: number
      max?: number
      step?: number
      unit?: string
    }
  | { kind: 'boolean'; value: boolean; labels?: [string, string] }
  | { kind: 'constant'; value: string; options: string[] }
  | { kind: 'list'; items: string[]; itemType?: string }
  | { kind: 'dict'; entries: [string, string][] }
  | { kind: 'table'; columns: string[]; rows: string[][]; sortBy?: string }
  | { kind: 'args'; target: string; args: { name: string; value: string }[] }
  | { kind: 'expression'; left: string; operator: string; right: string; operators: string[] }
  | {
      kind: 'condition'
      field: string
      operator: string
      value: string
      operators: string[]
      hits?: [number, number]
    }
  | {
      kind: 'loop'
      /** La secuencia que recorre (`for`) o la condición que se evalúa en cada vuelta (`while`). */
      iterable: string
      variable: string
      /** Es un `while`: no hay variable de iteración y `iterable` es una condición. */
      while?: boolean
      current?: number
      total?: number
    }
  /** `with abre() as f:`: el recurso que se abre y el nombre con el que se usa dentro (vacío si no lo lleva). */
  | { kind: 'with'; context: string; name: string }
  /** `except ValueError as e:`: qué error se atrapa (vacío: cualquiera) y el nombre con el que se usa dentro. */
  | { kind: 'handler'; type: string; name: string }
  /**
   * `class Perro(Animal):`: de quién hereda (el texto entre paréntesis, vacío si de nadie) y lo que
   * recibe al crearse (los parámetros de su `__init__`, sin `self`).
   */
  | { kind: 'class'; bases: string; params: string[] }
  | { kind: 'signal'; errorType: string; types: string[]; message: string }
  | { kind: 'io'; target: string; mode: string; modes: string[] }
  | {
      kind: 'stats'
      metric: string
      value: string
      deltaPct?: number
      range: string
      ranges: string[]
      series: number[]
      rows?: { label: string; value: string }[]
    }
  | { kind: 'module'; module: string; alias: string }
  | { kind: 'signature'; params: { name: string; value: string }[] }
  | {
      kind: 'query'
      field: string
      operator: string
      value: string
      operators: string[]
      hash: string
    }
  | { kind: 'code'; source: string }
