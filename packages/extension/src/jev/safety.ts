/**
 * ¿Se puede escribir este código sin riesgo? Lo juzga el JEV, pero **cuánta certeza se le pide depende de lo
 * que el propio código puede hacer**. Un trozo que solo calcula —sin importar nada de fuera, sin abrir
 * archivos, sin ejecutar texto— no tiene con qué tocar el equipo: ahí una respuesta tibia del JEV (un «sí»
 * al 50 %) no es motivo para pararlo todo, y solo lo detiene un «no» claro. En cuanto el código tiene con qué
 * salir de sí mismo, se exige el «sí» firme de siempre.
 *
 * Es puro: mira el texto del código, no lo ejecuta.
 */

/** Lo que hace falta del JEV cuando el código tiene con qué tocar archivos, la red o el sistema. */
export const SAFE_WHEN_IT_REACHES = 0.7
/** Y cuando no lo tiene: basta con que el JEV no diga claramente que no. */
export const SAFE_WHEN_IT_ONLY_COMPUTES = 0.3

/** Módulos que solo calculan: importarlos no da con qué tocar el equipo. */
const HARMLESS = new Set(
  'random math cmath statistics itertools functools collections dataclasses typing string re json datetime time copy enum decimal fractions heapq bisect operator abc numbers textwrap pprint unicodedata array numpy'.split(
    ' ',
  ),
)

/** Lo que, aun sin importar nada, sale del programa: abrir archivos, ejecutar texto, hurgar en el intérprete. */
const REACHING =
  /\b(open|eval|exec|compile|__import__|globals|locals|getattr|setattr|delattr|breakpoint|exit|quit)\s*\(|__\w+__|\b(os|sys|subprocess|shutil|socket|pathlib|ctypes|importlib|pickle|requests|urllib|http)\b/

/** Los módulos que importa un trozo de código (su raíz: `os` en `import os.path`). */
function imported(code: string): string[] {
  const modules: string[] = []
  for (const line of code.split('\n')) {
    const from = /^\s*from\s+([\w.]+)\s+import\b/.exec(line)
    if (from) modules.push(from[1] ?? '')
    const plain = /^\s*import\s+(.+)$/.exec(line)
    if (plain)
      for (const part of (plain[1] ?? '').split(','))
        modules.push(part.trim().split(/\s+/)[0] ?? '')
  }
  return modules.map((name) => name.split('.')[0] ?? '').filter((name) => name !== '')
}

/** Si el código tiene con qué tocar archivos, la red o el sistema (no si lo hace: si podría). */
export function reachesOutside(code: string): boolean {
  // Lo que va entre comillas o en un comentario no hace nada.
  const bare = code.replace(/"[^"\n]*"|'[^'\n]*'/g, '""').replace(/#.*$/gm, '')
  return REACHING.test(bare) || imported(bare).some((name) => !HARMLESS.has(name))
}

/** Si, con lo que dice el JEV (`safe`, de 0 a 1), ese código se puede escribir. */
export function safeEnough(code: string, safe: number): boolean {
  return safe >= (reachesOutside(code) ? SAFE_WHEN_IT_REACHES : SAFE_WHEN_IT_ONLY_COMPUTES)
}
