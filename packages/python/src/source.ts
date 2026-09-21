/**
 * De dónde sale cada cosa en el texto del archivo.
 *
 * Es lo que permite escribir de vuelta: cambiar algo en el lienzo es reescribir exactamente
 * ese trozo de Python y nada más. Los desplazamientos son de cadena (UTF-16), los mismos que usa
 * el editor, así que un `ñ` o un `é` antes del campo no los descuadran.
 */

export interface Span {
  start: number
  end: number
}

export interface Source extends Span {
  /** Cómo se vuelve a escribir un valor nuevo en ese sitio. */
  as: 'expression' | 'operator' | 'number' | 'boolean' | 'string' | 'list'
  /** El delimitador de una cadena (`"`, `'`, `"""`), para escapar bien lo que se escriba dentro. */
  quote?: string
  /** El texto original: un número conserva su forma (`5.0` sigue siendo un flotante). */
  original?: string
}

export interface TextEdit {
  start: number
  end: number
  text: string
}

/**
 * Dónde está una sentencia entera. Con esto se puede reescribir, eliminar, duplicar o poner
 * algo detrás sin entender el Python que hay dentro.
 */
export interface NodeRange extends Span {
  /** Columna en la que empieza: la sangría con la que se coloca lo que se ponga al lado. */
  indent: number
  /** Dónde acaba la cabecera de una sentencia compuesta (`if x:`): el `end` incluye su cuerpo. */
  head?: number
  /** Dónde acaba su cuerpo, y con qué sangría empieza. */
  bodyEnd?: number
  bodyIndent?: number
  /** Solo en una decisión: dónde acaba su primer camino, y dónde está su `else` (si lo tiene). */
  yesEnd?: number
  elseAt?: number
  elseHead?: number
  elseEnd?: number
  /** Dónde empieza el primer comentario pegado encima (va con la sentencia al eliminarla). */
  lead?: number
  /** Cuántas sentencias tiene su bloque, y qué sentencia lo posee (`undefined` = el archivo). */
  block: number
  owner?: string
}
