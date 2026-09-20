# Fase 0 — Fundaciones y lenguaje visual

Objetivo: que, antes de tocar Python o VS Code, el lienzo ya **se vea y se entienda bien**, y que la base técnica aguante crecer.
Cada hito es pequeño, se puede comprobar en minutos y termina con algo que se ve o se ejecuta.

| Hito                                        | Entrega                                                                                                                                                        | Cómo se comprueba                                  | Estado                                |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- | ------------------------------------- |
| **M0.1** Monorepo y herramientas            | pnpm workspaces, TypeScript estricto, ESLint, Prettier, Vitest, `pnpm verify`                                                                                  | `pnpm verify` en verde                             | ✅                                    |
| **M0.2** Tokens del design system en código | `tokens.json` del DS (copia con hash) + extensión de morfología → CSS claro/oscuro, tema Tailwind, tipos; contraste WCAG automatizado                          | `pnpm tokens:check` y los tests de contraste       | ✅                                    |
| **M0.3** Gramática de morfología + galería  | 23 tipos de nodo (insignia, silueta, trazo, relleno, tamaño, elevación, puertos) y una galería para verlos                                                     | `pnpm dev:gallery` → http://localhost:5173         | ✅                                    |
| **M0.3b** Dirección artística v2 + editores | Tarjetas claras con insignia e iconos, chips de estado, 18 editores gráficos por tipo y un caso real completo con el programa entero                           | Galería → secciones «Densidad» y «Un caso real»    | ✅ **punto de decisión de dirección** |
| **M0.4a** Gramática espacial                | `@prysel/spatial`: grafo semántico → clasificación topológica → estrategia de layout. Puertos con nombre, gramática de conexiones, profundidad por abstracción | Galería → «Gramática espacial» y «Un caso real»    | ✅                                    |
| **M0.4b** Legibilidad a densidad            | Plegado en filas, eje de lectura configurable y colapso por abstracción: un programa largo se lee al 100 % recorriéndolo                                       | `node packages/spatial/scripts/density.ts`         | ✅                                    |
| **M0.4c** Lienzo y movimiento               | React Flow sobre el motor espacial (recorrer, acercar, seleccionar, arrastrar) y transiciones interpoladas entre layouts                                       | Galería → «Un caso real» y «En vivo»               | ✅                                    |
| **M0.5** Parser y extensión de VS Code      | tree-sitter → grafo semántico en tiempo real, y la extensión con su webview, CSP estricta y protocolo validado en ambos extremos                               | `pnpm --filter prysel-extension build`, luego F5   | ✅                                    |
| **M0.6** Componentes restantes del DS       | `Space` real (for/if/try/def con contenido), `Port` con estados, `MagicLens`, puntos de actividad en conexiones `live`                                         | Galería + tests de estados                         |                                       |
| **M0.7** Riesgos y puertas de calidad       | Presupuesto de rendimiento con efectos activos, regresión visual con capturas, y análisis incremental del parser                                               | Informe corto + `pnpm verify` incluye las capturas |                                       |

**Fuera de alcance por ahora:** Jupyter Notebook (se retoma tras validar la extensión de VS Code).

## Qué revisar en M0.3b

La galería es donde el lenguaje visual se juzga con los ojos. Conviene mirarla en este orden:

1. **Un caso real** (al final de la página). Es la prueba de fuego: seis líneas de pandas en el lienzo. Mueve el deslizador de `THRESHOLD` y comprueba que el código, las ramas y el resultado se recalculan; cambia la densidad entre compacto, normal y expandido; pulsa «Ejecutar».
2. **Compacto como referencia rápida.** En esa densidad el programa entero se lee como una frase de píldoras de colores. ¿Se entiende la lógica de un vistazo?
3. **Los editores.** ¿El editor de cada tipo es el que esperarías (deslizador para un número, tabla para un DataFrame, campo + operador + valor para una condición)?
4. **Insignias e iconos.** ¿El icono de cada tipo se reconoce sin leer la etiqueta?
5. **Escala de grises.** Activa la casilla: la silueta y los iconos deben bastar.

Lo que cambie aquí es barato de cambiar: vive en `packages/morphology/src/kinds.ts` (qué forma tiene cada cosa) y `packages/morphology/src/geometry.ts` (cómo se dibuja).

## Dónde vive cada cosa

```
packages/design-tokens   fuente de tokens → CSS / Tailwind / tipos (+ tests de contraste)
packages/morphology      gramática de nodos: tipos, siluetas, tamaño, iconos (sin React)
packages/spatial         gramática espacial: clasificación topológica, layout y colapso (sin React)
packages/python          Python → grafo semántico, con tree-sitter
packages/extension       la extensión de VS Code y su webview
packages/ui              componentes React: MorphNode, ExecutionGlyph, estilos
packages/extension       extensión de VS Code: comando «Prysel: Abrir lienzo», parser en el host y webview con el lienzo
apps/gallery             la galería (Vite + Tailwind)
docs/                    esto, el delta del DS y la gramática espacial
```
