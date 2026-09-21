import type { ControlModel } from './controls.ts'
import type { NodeKindId } from './kinds.ts'

/**
 * Qué clase de valor sale de un nodo y qué acepta cada campo.
 *
 * Un cable lleva un valor, y no todos los valores valen en todos los sitios: a una resta no se le
 * conecta un texto. La clase es lo que colorea cada puerto (número, texto, booleano, colección) y
 * lo que permite rechazar una conexión antes de escribir código que fallaría al ejecutarse.
 *
 * Es deliberadamente **conservadora**: solo se rechaza lo que Python no admitiría nunca. Lo que no
 * se sabe (`any`) se acepta en todas partes: Python es dinámico y un falso rechazo estorba más
 * que un cable que falla al ejecutarse.
 */

export type ValueType = 'number' | 'text' | 'boolean' | 'collection' | 'any'

export const VALUE_TYPES: readonly ValueType[] = ['number', 'text', 'boolean', 'collection', 'any']

/** Cómo se llama cada clase al hablar con el usuario. */
export const VALUE_NAMES: Record<ValueType, string> = {
  number: 'un número',
  text: 'un texto',
  boolean: 'un verdadero / falso',
  collection: 'una colección',
  any: 'un valor',
}

const NUMERIC_RESULT = new Set(['int', 'float', 'len', 'round', 'abs', 'sum', 'ord'])
const TEXT_RESULT = new Set(['str', 'input', 'repr', 'chr', 'format'])
const COLLECTION_RESULT = new Set(['list', 'dict', 'set', 'tuple', 'sorted', 'range', 'zip'])
const COMPARISONS = new Set(['<', '<=', '>', '>=', '==', '!=', 'in', 'not in', 'is', 'is not'])
/** Operadores que Python solo admite entre números (`+`, `*` y `%` también valen con textos). */
const NUMERIC_ONLY = new Set(['-', '/', '//', '**', '-=', '/=', '//=', '**='])

/** La clase del valor que sale de un nodo, según lo que enseña su editor y, si no, su tipo. */
export function valueTypeOf(kind: NodeKindId, control?: ControlModel): ValueType {
  switch (control?.kind) {
    case 'number':
      return 'number'
    case 'text':
      return 'text'
    case 'boolean':
      return 'boolean'
    case 'list':
    case 'dict':
      return 'collection'
    case 'args': {
      const target = control.target
      if (NUMERIC_RESULT.has(target)) return 'number'
      if (TEXT_RESULT.has(target)) return 'text'
      if (COLLECTION_RESULT.has(target)) return 'collection'
      if (target === 'bool') return 'boolean'
      return 'any'
    }
    case 'expression':
      if (COMPARISONS.has(control.operator)) return 'boolean'
      return NUMERIC_ONLY.has(control.operator) ? 'number' : 'any'
    default:
      break
  }
  switch (kind) {
    case 'value.number':
      return 'number'
    case 'value.str':
      return 'text'
    case 'value.bool':
      return 'boolean'
    case 'data.list':
    case 'data.dict':
      return 'collection'
    default:
      return 'any'
  }
}

/**
 * Qué clases acepta un campo, o `undefined` si acepta cualquiera. Un operando de una resta pide un
 * número; la secuencia de un bucle, algo que se pueda recorrer.
 */
export function slotAccepts(
  control: ControlModel | undefined,
  slot: string,
): readonly ValueType[] | undefined {
  if (control?.kind === 'expression' && (slot === 'left' || slot === 'right')) {
    return NUMERIC_ONLY.has(control.operator) ? ['number', 'boolean', 'any'] : undefined
  }
  if (control?.kind === 'loop' && slot === 'iterable') return ['collection', 'text', 'any']
  return undefined
}

/** La clase con la que se pinta el puerto de entrada de un campo (`any` si acepta cualquiera). */
export function slotTypeOf(control: ControlModel | undefined, slot: string): ValueType {
  const accepts = slotAccepts(control, slot)
  return accepts?.[0] ?? 'any'
}

/** ¿Vale un valor de esta clase en ese campo? */
export function accepts(
  control: ControlModel | undefined,
  slot: string,
  given: ValueType,
): boolean {
  const allowed = slotAccepts(control, slot)
  return allowed === undefined || given === 'any' || allowed.includes(given)
}
