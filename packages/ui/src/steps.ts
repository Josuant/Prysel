/**
 * Lo que se observó al ejecutar de cada paso de una cadena, para enseñarlo junto a él. El índice 0 es
 * el receptor y el `i + 1`, lo que queda tras el paso `i`. Solo lee: no cambia el programa.
 */
export interface StepInfo {
  /** Lo corto que cabe en la fila (`DataFrame 12×2`). */
  short?: string
  /** Lo que dice al pasar el puntero (columnas, primeras filas…). */
  long?: string
  /** Ver este paso en un visor del lienzo, si hay algo que enseñar. */
  onView?: () => void
}
