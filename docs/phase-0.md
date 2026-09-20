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
| **M0.4b** Lienzo con React Flow             | Llevar el motor espacial a React Flow: arrastre, zoom, selección, virtualización                                                                               | Galería → lienzo navegable                         |                                       |
| **M0.5** Extensión de VS Code (cascarón)    | El mismo webview dentro de VS Code: CSP estricta, tema sincronizado, protocolo de mensajes validado en ambos extremos                                          | F5 en VS Code → comando «Prysel: Abrir lienzo»     |                                       |
| **M0.6** Componentes restantes del DS       | `Space` real (for/if/try/def con contenido), `Port` con estados, `MagicLens`, puntos de actividad en conexiones `live`                                         | Galería + tests de estados                         |                                       |
| **M0.7** Riesgos y puertas de calidad       | Spike del parser de Python, presupuesto de rendimiento (500 nodos con efectos vs. nivel de detalle), regresión visual con capturas                             | Informe corto + `pnpm verify` incluye las capturas |                                       |

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
packages/spatial         gramática espacial: clasificación topológica y layout (sin React)
packages/ui              componentes React: MorphNode, ExecutionGlyph, estilos
apps/gallery             la galería (Vite + Tailwind)
docs/                    esto, el delta del DS y la gramática espacial
```
