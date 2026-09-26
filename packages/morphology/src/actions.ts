import type { IconId } from './types.ts'

/**
 * Lo que se le puede hacer a un nodo del diagrama, y lo que se puede añadir.
 *
 * Son datos puros, compartidos entre la interfaz (que los emite) y el analizador (que los
 * convierte en ediciones de texto). Viven en morfología porque las dos partes dependen de ella.
 */

/** Qué se puede añadir al programa: cada plantilla es una sentencia (o un bloque) de Python. */
export const TEMPLATES = {
  variable: {
    label: 'Variable',
    group: 'Valores',
    icon: 'hash',
    hint: 'Guarda un número con un nombre',
  },
  text: {
    label: 'Texto',
    group: 'Valores',
    icon: 'quote',
    hint: 'Guarda unas palabras entre comillas',
  },
  boolean: {
    label: 'Verdadero / falso',
    group: 'Valores',
    icon: 'toggle',
    hint: 'Guarda sí o no (True / False)',
  },
  list: { label: 'Lista', group: 'Valores', icon: 'list', hint: 'Varios valores, en orden' },
  dict: { label: 'Diccionario', group: 'Valores', icon: 'braces', hint: 'Pares de nombre y valor' },
  operation: {
    label: 'Operación',
    group: 'Cálculo',
    icon: 'sigma',
    hint: 'Suma, resta, multiplica, compara…',
  },
  call: {
    label: 'Llamada a función',
    group: 'Cálculo',
    icon: 'function',
    hint: 'Usa una función que ya existe',
  },
  input: {
    label: 'Pedir dato',
    group: 'Entrada y salida',
    icon: 'pencil',
    hint: 'Pregunta un valor a quien ejecuta',
  },
  print: {
    label: 'Imprimir',
    group: 'Entrada y salida',
    icon: 'globe',
    hint: 'Muestra un valor en la salida',
  },
  if: {
    label: 'Decisión',
    group: 'Control',
    icon: 'branch',
    hint: 'Hace algo solo si se cumple una condición',
  },
  ifelse: {
    label: 'Decisión con alternativa',
    group: 'Control',
    icon: 'branch',
    hint: 'Elige entre dos caminos',
  },
  for: {
    label: 'Bucle para cada',
    group: 'Control',
    icon: 'loop',
    hint: 'Repite para cada elemento de algo',
  },
  while: {
    label: 'Bucle mientras',
    group: 'Control',
    icon: 'repeat',
    hint: 'Repite mientras se cumpla una condición',
  },
  try: {
    label: 'Intentar / si falla',
    group: 'Control',
    icon: 'shield',
    hint: 'Prueba algo y reacciona si falla',
  },
  with: {
    label: 'Con un recurso (with)',
    group: 'Control',
    icon: 'lock',
    hint: 'Usa un recurso y lo cierra solo',
  },
  break: {
    label: 'Salir del bucle',
    group: 'Control',
    icon: 'exit',
    hint: 'Deja de repetir y sigue después',
  },
  continue: {
    label: 'Siguiente vuelta',
    group: 'Control',
    icon: 'skip',
    hint: 'Salta a la siguiente vuelta del bucle',
  },
  return: {
    label: 'Devolver',
    group: 'Control',
    icon: 'return',
    hint: 'Termina la función con un resultado',
  },
  raise: {
    label: 'Lanzar un error',
    group: 'Control',
    icon: 'alert',
    hint: 'Avisa de que algo va mal',
  },
  import: {
    label: 'Importar un módulo',
    group: 'Estructura',
    icon: 'package',
    hint: 'Trae math, random, numpy…',
  },
  function: {
    label: 'Función',
    group: 'Estructura',
    icon: 'function',
    hint: 'Agrupa pasos bajo un nombre',
  },
} as const satisfies Record<string, { label: string; group: string; icon: IconId; hint: string }>

export type TemplateId = keyof typeof TEMPLATES

export const TEMPLATE_IDS = Object.keys(TEMPLATES) as TemplateId[]

/** Lo que el usuario le hace a un nodo, o lo que añade: la interfaz lo emite, el analizador lo escribe. */
export type NodeAction =
  /** Reescribir la sentencia (o su cabecera) como texto: la red de seguridad que permite escribir cualquier cosa. */
  | { type: 'code'; id: string; text: string }
  | { type: 'delete'; id: string }
  | { type: 'duplicate'; id: string }
  /** Cambiar el nombre de lo que el nodo define, en todos los sitios donde se usa. */
  | { type: 'rename'; id: string; to: string; from?: string }
  /**
   * Añadir una plantilla: detrás de un nodo, o dentro de una función o un bucle (`into`), o al final
   * del archivo. Con `connect`, la plantilla nace ya alimentada por el valor de otro nodo: es lo que
   * pasa al soltar un cable en el vacío.
   */
  | {
      type: 'add'
      template: TemplateId
      after?: string
      into?: string
      /** Al principio del contexto (del cuerpo de `into`, o del archivo) en vez de al final: donde se inicializa. */
      at?: 'start'
      /** Con `into`: al principio de lo que actúa en su cuerpo (tras sus inicializaciones). */
      start?: true
      /** Con `into` una decisión: al principio de uno de sus dos caminos (se crea el `else` si falta). */
      branch?: 'yes' | 'no'
      connect?: { from: string; port?: string }
    }
  /**
   * Conectar la salida de un nodo (`port`: el parámetro de una función, si sale de uno) a un campo de
   * otro: el campo pasa a leer el nombre que el origen define, sin escribirlo a mano.
   */
  | {
      type: 'connect'
      from: string
      to: string
      slot: string
      port?: string
      /** El valor es un texto y el campo pide un número: se escribe `float(nombre)` en vez del nombre. */
      convert?: 'float'
    }
  /**
   * Cambiar a quién llama una llamada: la función pasa a ser otra, su lista de argumentos se ajusta
   * a los parámetros de la nueva (cada uno con su casilla) y, si devuelve algo, el resultado se guarda.
   */
  | { type: 'callee'; id: string; callee: string }
  /** Soltar un cable: el campo vuelve a un valor neutro. */
  | { type: 'disconnect'; id: string; slot: string }
  /**
   * Mover un extremo de un cable ya tendido: el que llegaba a `was` (un campo de un nodo) pasa a salir de
   * `from` y a llegar a `to`/`slot`. Si cambia el destino, el campo de antes vuelve a un valor neutro y el
   * nuevo lee el nombre, todo de una vez (una sola edición); si solo cambia el origen, el campo pasa a
   * leer el nombre del nuevo. Si el cable nuevo no vale, no se toca nada (el de antes se queda).
   */
  | {
      type: 'reconnect'
      was: { id: string; slot: string }
      from: string
      port?: string
      to: string
      slot: string
      convert?: 'float'
    }
  /**
   * Mover una sentencia a otro sitio: al final del cuerpo de una función (`into`), detrás de otro
   * nodo (`after`) o justo antes de otro (`before`). Es lo que pasa al arrastrar un nodo dentro o fuera de una función.
   */
  | {
      type: 'move'
      id: string
      after?: string
      into?: string
      before?: string
      /**
       * Con `into`: no al final del cuerpo sino al **principio de lo que actúa** (tras las
       * inicializaciones), que es donde lleva el puerto de inicio de una función o un bucle.
       */
      start?: true
      /** Con `into` una decisión: a cuál de sus dos caminos (`yes` el verdadero, `no` el `else`), al principio. */
      branch?: 'yes' | 'no'
    }
