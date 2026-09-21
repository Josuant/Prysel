import type { IconId } from './types.ts'

/**
 * Iconos de identidad: trazos sobre una rejilla de 24×24, sin relleno, para dibujarse con
 * `stroke-width: 1.5` y `currentColor`. Reemplazan a los glifos tipográficos del DS porque
 * dentro de una insignia el icono tiene que leerse a 14 px y en cualquier fuente del sistema.
 */

/** Un círculo como trazado, para poder componerlo con el resto del icono en un solo `d`. */
function circle(cx: number, cy: number, r: number): string {
  return `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${r * 2} 0a${r} ${r} 0 1 0 ${-r * 2} 0`
}

export const ICONS: Record<IconId, string> = {
  quote: 'M6 8h4v4c0 2.2-1.5 3.6-3.2 4M14 8h4v4c0 2.2-1.5 3.6-3.2 4',
  hash: 'M5 9.5h14M5 14.5h14M10.5 4.5 8.5 19.5M17 4.5 15 19.5',
  toggle: `M8.5 6.5h7a5.5 5.5 0 0 1 0 11h-7a5.5 5.5 0 0 1 0-11Z${circle(9.8, 12, 2.4)}`,
  'circle-slash': `${circle(12, 12, 8)}M6.4 6.4 17.6 17.6`,
  list: 'M9 6.5h11M9 12h11M9 17.5h11M4.5 6.5h.01M4.5 12h.01M4.5 17.5h.01',
  braces:
    'M9 4.5c-2 0-2.2 2.6-2.2 3.8S6.4 11 4.6 11c1.8 0 2.2 1.5 2.2 2.7S6.6 19.5 9 19.5M15 4.5c2 0 2.2 2.6 2.2 3.8s.4 2.7 2.2 2.7c-1.8 0-2.2 1.5-2.2 2.7s.2 5.8-2.2 5.8',
  table: 'M4.5 5.5h15v13h-15zM4.5 10h15M9.5 10v8.5M14.5 10v8.5',
  function: 'M8.5 19.5c2 0 3-1.2 3-3.6V8c0-2.4 1-3.6 3-3.6M7 12h9',
  sigma: 'M17 5.5H7.5l5 6.5-5 6.5H17',
  repeat:
    'M17 3.5 20.5 7 17 10.5M3.5 11.5V10a3 3 0 0 1 3-3h14M7 20.5 3.5 17 7 13.5M20.5 12.5V14a3 3 0 0 1-3 3h-14',
  lambda: 'M5.5 19.5 12.5 4.5M11 12.2l4 7.3M11.4 4.5h2.2',
  branch: `M7 5.5v13${circle(7, 18, 2.2)}${circle(17, 7, 2.2)}M16.6 9.2A8 8 0 0 1 9 15.8`,
  loop: 'M4 12a8 8 0 1 0 2.6-5.9L4 8.5M4 4v4.5h4.5',
  alert:
    'M10.6 4.6 3 17.4a1.7 1.7 0 0 0 1.4 2.6h15.2a1.7 1.7 0 0 0 1.4-2.6L13.4 4.6a1.6 1.6 0 0 0-2.8 0ZM12 9.5v4M12 16.8h.01',
  return: 'M9.5 10 5 14.5l4.5 4.5M19.5 4.5v6a4 4 0 0 1-4 4H5',
  // Una puerta con una flecha que sale: `break`.
  exit: 'M14 4.5h4A1.5 1.5 0 0 1 19.5 6v12a1.5 1.5 0 0 1-1.5 1.5h-4M10.5 8 6.5 12l4 4M6.5 12H16',
  // Dos puntas y una barra: `continue`, saltar a la siguiente vuelta.
  skip: 'M5 6.5 11.5 12 5 17.5zM12.5 6.5 19 12l-6.5 5.5zM20 5v14',
  globe: `${circle(12, 12, 8)}M4 12h16M12 4a13 13 0 0 1 0 16a13 13 0 0 1 0-16`,
  chart: 'M4 4v14.5a1.5 1.5 0 0 0 1.5 1.5H20M7.5 15.5l3.5-4 2.8 2.6L19 7.5',
  package: 'M12 3.2 4 7.6v8.8l8 4.4 8-4.4V7.6zM4 7.6l8 4.4 8-4.4M12 12v8.8',
  folder: 'M4 7.5a2 2 0 0 1 2-2h3.6l2 2.2H18a2 2 0 0 1 2 2v7.8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z',
  sparkles:
    'M10 3.5 11.5 8l4.5 1.5L11.5 11 10 15.5 8.5 11 4 9.5 8.5 8zM17.5 14.5l.9 2.6 2.6.9-2.6.9-.9 2.6-.9-2.6-2.6-.9 2.6-.9z',
  help: `${circle(12, 12, 8)}M9.6 9.6a2.5 2.5 0 1 1 3.3 2.4c-.6.2-.9.7-.9 1.3v.4M12 16.8h.01`,
  shield: 'M12 3.5 19 6.3v4.9c0 4.7-2.9 7.7-7 9-4.1-1.3-7-4.3-7-9V6.3z',
  check: 'M4.5 12.5 9.5 17.5 19.5 6.5',
  clock: `${circle(12, 12, 8)}M12 7.5V12l3 1.8`,
  x: 'M6 6l12 12M18 6 6 18',
  dot: circle(12, 12, 4),
  diamond: 'M12 3.8 20.2 12 12 20.2 3.8 12z',
  trash: 'M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12M10.5 11v5M13.5 11v5',
  copy: 'M9 9.5a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-7a2 2 0 0 1-2-2zM5 15.5a2 2 0 0 1-1-1.7V6a2 2 0 0 1 2-2h7.8a2 2 0 0 1 1.7 1',
  pencil: 'M4.5 19.5h4L19.3 8.7a2 2 0 0 0 0-2.8l-1.2-1.2a2 2 0 0 0-2.8 0L4.5 15.5zM14.5 6.5l3 3',
  chevron: 'M6 9.5 12 15.5 18 9.5',
  plus: 'M12 5.5v13M5.5 12h13',
  calendar:
    'M4.5 7.5a2 2 0 0 1 2-2h11a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-11a2 2 0 0 1-2-2zM8.5 3.5v4M15.5 3.5v4M4.5 11h15',
}

export const ICON_IDS = Object.keys(ICONS) as IconId[]
