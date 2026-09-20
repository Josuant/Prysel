# ADR 0001 — Stack y principios de construcción

Estado: aceptada · Fecha: 2026-09-20

## Contexto

Prysel será una extensión de VS Code con un lienzo (webview) que visualiza código Python. Se prioriza: (1) que la visualización sea nítida y fluida, (2) que crezca sin reescrituras, (3) que sea segura, porque ejecutará código generado por un LLM. Primero se valida como extensión de VS Code; Jupyter queda para después.

## Decisiones

| Área            | Decisión                                                                                                 | Por qué                                                                                                                                                                                    |
| --------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Monorepo        | pnpm workspaces con catálogo de versiones                                                                | Dependencias estrictas (sin «fantasmas»), una sola versión de cada librería compartida.                                                                                                    |
| Lenguaje        | TypeScript 6.0 en modo estricto (`noUncheckedIndexedAccess`, `verbatimModuleSyntax`)                     | 6.0 y no 7: `typescript-eslint` aún no lo soporta. Revisar cuando lo haga.                                                                                                                 |
| Frontend        | React 19 + Vite 8                                                                                        | Estándar, y el mismo webview servirá en la galería y en VS Code.                                                                                                                           |
| Estilos         | Tailwind 4 con la paleta por defecto **vaciada** + CSS propio basado en tokens                           | Solo existen los colores del design system: `bg-red-500` no compila.                                                                                                                       |
| Tokens          | El `tokens.json` del DS se copia literal (hash verificado en test) y se extiende en un archivo aparte    | El DS puede seguir evolucionando; las diferencias quedan explícitas.                                                                                                                       |
| Render de nodos | SVG (silueta y trazo) + CSS (`clip-path`, `backdrop-filter`) + HTML (texto)                              | Permite formas arbitrarias, desenfoque y accesibilidad de texto real. Nivel de detalle `flat` apaga efectos costosos. Se reevalúa (canvas/WebGL) solo si las mediciones de M0.7 lo exigen. |
| Lienzo          | `@xyflow/react` (React Flow), en M0.4                                                                    | Ya previsto en el documento maestro; soporta nodos y aristas propios.                                                                                                                      |
| Pruebas         | Vitest; pruebas de propiedades sobre la gramática (p. ej. cada tipo es distinguible en escala de grises) | Las reglas de diseño se vuelven ejecutables y no se degradan en silencio.                                                                                                                  |
| Calidad         | `pnpm verify` = tokens al día + ESLint + tipos + tests + Prettier                                        | Un solo comando, el mismo en CI.                                                                                                                                                           |

## Seguridad y cadena de suministro

- `minimumReleaseAge: 1440`: no se instalan versiones publicadas hace menos de 24 h.
- `pnpm-lock.yaml` versionado; CI usará `--frozen-lockfile`.
- pnpm no ejecuta scripts de instalación de dependencias salvo los aprobados explícitamente.
- ESLint prohíbe `eval`, `new Function` e `implied eval`: el webview correrá con una CSP que los bloquea.
- Un test impide colores literales fuera de los tokens (`packages/ui/test/no-rogue-colors.test.ts`).
- Pendiente (M0.5): CSP con nonce, validación de mensajes con esquemas en ambos lados del `postMessage`.
- Pendiente (Fase 3): los componentes generados por el LLM correrán en un iframe aislado y con lista blanca de imports.

## Pendiente de decidir (spike en M0.7)

Cómo obtener el árbol de sintaxis de Python. **Pylance no expone el AST**; da tipos, símbolos y hovers. Candidatos: tree-sitter-python (WASM) o libcst en un proceso auxiliar, más Pylance solo para tipos.
