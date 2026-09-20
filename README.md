# Prysel

Prysel no representa código: representa su **comportamiento**. Un lienzo 2D que vive junto al código Python dentro de VS Code y hace visible qué hace cada bloque, con nodos cuya forma, color, relleno, tamaño y sombra significan algo.

Estado: **Fase 0** (fundaciones y lenguaje visual). Ver [docs/phase-0.md](docs/phase-0.md).

## Ver la galería de morfología

Requisitos: Node 24 y pnpm 12.

```bash
npm install -g pnpm@12.5.1
pnpm install
pnpm dev:gallery
```

Abre http://localhost:5173. La sección **«De Python al lienzo, en vivo»** convierte lo que escribas en el diagrama mientras tecleas.

Para la extensión de VS Code: `pnpm --filter prysel-extension build` y luego F5 sobre `packages/extension`.

Abre http://localhost:5173. Al final están **«Gramática espacial»** (cómo la forma del programa decide su layout) y **«Un caso real»** (un programa entero de pandas en el lienzo, con nodos editables).

Parámetros útiles en la URL: `?theme=dark&density=compact&state=running&gray=1&only=valores&case=compact`.

> En algunas instalaciones de Windows `corepack` falla con `EXDEV: cross-device link`; instalar pnpm con npm evita el problema.

## Probar la extensión (F5)

La extensión convierte el archivo Python activo en el diagrama, en tiempo real.

```bash
pnpm install
pnpm build:extension
```

En VS Code, pulsa **F5** (configuración `Prysel — extensión (F5)` en `.vscode/launch.json`). Se abre una ventana de Extension Development Host; abre cualquier `.py` y ejecuta el comando **«Prysel: Abrir lienzo»**. Cada cambio en el editor reanaliza el código y redibuja el lienzo.

- El parser corre en el host (`@prysel/python` + tree-sitter) y manda el grafo semántico al webview.
- El webview es el mismo lienzo que la galería (`@prysel/ui`), con CSP estricta, nonce, tema sincronizado y mensajes validados en ambos extremos.
- Para iterar sin parar: `pnpm watch:extension` (recompila el host al guardar).

## Comandos

| Comando                             | Qué hace                                                         |
| ----------------------------------- | ---------------------------------------------------------------- |
| `pnpm verify`                       | Todo lo siguiente, en orden                                      |
| `pnpm tokens` / `pnpm tokens:check` | Regenera / comprueba CSS, tema Tailwind y tipos desde los tokens |
| `pnpm lint`                         | ESLint                                                           |
| `pnpm typecheck`                    | TypeScript en todos los paquetes                                 |
| `pnpm test`                         | Vitest                                                           |
| `pnpm format`                       | Prettier                                                         |

## Documentación

- [Fase 0 y sus hitos](docs/phase-0.md)
- [ADR 0001 — Stack y seguridad](docs/adr/0001-stack.md)
- [Gramática espacial](docs/spatial-grammar.md) — cómo la topología del programa decide su forma
- [Diferencias respecto al design system publicado](docs/design-system-delta.md)
