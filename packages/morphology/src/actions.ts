/**
 * Lo que se le puede hacer a un nodo del diagrama, y lo que se puede añadir.
 *
 * Son datos puros, compartidos entre la interfaz (que los emite) y el analizador (que los
 * convierte en ediciones de texto). Viven en morfología porque las dos partes dependen de ella.
 */

/** Qué se puede añadir al programa: cada plantilla es una sentencia (o un bloque) de Python. */
export const TEMPLATES = {
  variable: { label: 'Variable', group: 'Valores' },
  text: { label: 'Texto', group: 'Valores' },
  boolean: { label: 'Verdadero / falso', group: 'Valores' },
  list: { label: 'Lista', group: 'Valores' },
  dict: { label: 'Diccionario', group: 'Valores' },
  operation: { label: 'Operación', group: 'Cálculo' },
  call: { label: 'Llamada a función', group: 'Cálculo' },
  input: { label: 'Pedir dato', group: 'Entrada y salida' },
  print: { label: 'Imprimir', group: 'Entrada y salida' },
  if: { label: 'Decisión', group: 'Control' },
  ifelse: { label: 'Decisión con alternativa', group: 'Control' },
  for: { label: 'Bucle para cada', group: 'Control' },
  while: { label: 'Bucle mientras', group: 'Control' },
  return: { label: 'Devolver', group: 'Control' },
  raise: { label: 'Lanzar un error', group: 'Control' },
  import: { label: 'Importar un módulo', group: 'Estructura' },
  function: { label: 'Función', group: 'Estructura' },
} as const

export type TemplateId = keyof typeof TEMPLATES

export const TEMPLATE_IDS = Object.keys(TEMPLATES) as TemplateId[]

/** Lo que el usuario le hace a un nodo, o lo que añade: la interfaz lo emite, el analizador lo escribe. */
export type NodeAction =
  /** Reescribir la sentencia (o su cabecera) como texto: la red de seguridad que permite escribir cualquier cosa. */
  | { type: 'code'; id: string; text: string }
  | { type: 'delete'; id: string }
  | { type: 'duplicate'; id: string }
  /** Cambiar el nombre de lo que el nodo define, en todos los sitios donde se usa. */
  | { type: 'rename'; id: string; to: string }
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
      connect?: { from: string; port?: string }
    }
  /**
   * Conectar la salida de un nodo (`port`: el parámetro de una función, si sale de uno) a un campo de
   * otro: el campo pasa a leer el nombre que el origen define, sin escribirlo a mano.
   */
  | { type: 'connect'; from: string; to: string; slot: string; port?: string }
  /** Soltar un cable: el campo vuelve a un valor neutro. */
  | { type: 'disconnect'; id: string; slot: string }
