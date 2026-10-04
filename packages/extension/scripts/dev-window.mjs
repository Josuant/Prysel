import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Abre una ventana de VS Code con Prysel cargada desde esta carpeta (`--extensionDevelopmentPath`), **sin
 * depurador**. Es lo que hace F5 en `.vscode/launch.json` («Prysel — probar la extensión»).
 *
 * Por qué no se usa la depuración de siempre: con ella, el anfitrión de extensiones de la ventana nueva arranca
 * en pausa hasta que el depurador de VS Code se conecta a él por `localhost`. En un equipo donde `localhost`
 * resuelve primero a `::1` (una línea `::1 localhost` en el archivo `hosts`), el depurador llama a `::1`, el
 * anfitrión solo escucha en `127.0.0.1`, la conexión se rechaza y a los 60 s VS Code lo da por perdido: no carga
 * ninguna extensión. Sin depurador no hay nada que esperar.
 *
 * Con `--isolated` la ventana usa un **perfil aparte** (sus propios ajustes, extensiones y cachés, en
 * `%LOCALAPPDATA%/prysel-dev`, que se conservan entre pruebas): no depende del estado del perfil de siempre. Es la
 * salida cuando ese perfil tiene la caché de los webviews estropeada («Could not register service worker:
 * InvalidStateError»), algo que puede pasar tras una actualización de VS Code.
 *
 * `node scripts/dev-window.mjs <ejecutable de VS Code> [carpeta] [--isolated]`. Con `--dry-run`, solo dice qué haría.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const flags = new Set(process.argv.slice(2).filter((arg) => arg.startsWith('--')))
const [code, folder] = process.argv.slice(2).filter((arg) => !arg.startsWith('--'))
const dryRun = flags.has('--dry-run')
const isolated = flags.has('--isolated')

if (!code || !existsSync(code)) {
  console.error(
    'Prysel: no encuentro el ejecutable de VS Code. Pásalo como primer argumento (en launch.json, `${execPath}`).',
  )
  process.exit(1)
}

/** Dónde vive el perfil aparte: fuera del repositorio, y el mismo en cada prueba (para no repetir el arranque). */
const devHome = join(process.env.LOCALAPPDATA ?? tmpdir(), 'prysel-dev')

const launch = [
  `--extensionDevelopmentPath=${root}`,
  // Una ventana propia: nunca se reutiliza la que ya está abierta.
  '--new-window',
  ...(isolated
    ? [
        `--user-data-dir=${join(devHome, 'user')}`,
        `--extensions-dir=${join(devHome, 'extensions')}`,
        // Un perfil nuevo pregunta si se confía en la carpeta y enseña la bienvenida: para probar, sobra.
        '--disable-workspace-trust',
        '--skip-welcome',
        '--skip-release-notes',
      ]
    : []),
  ...(folder && existsSync(folder) ? [folder] : []),
]

// Si nos lanza un proceso de Electron (el propio VS Code), no hay que heredar su modo «solo Node».
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

if (dryRun) {
  console.log(JSON.stringify({ code, args: launch }, null, 2))
  process.exit(0)
}

const child = spawn(code, launch, { env, detached: true, stdio: 'ignore' })
child.on('error', (error) => {
  console.error(`Prysel: no se pudo abrir VS Code (${error.message}).`)
  process.exit(1)
})
child.unref()
console.log(
  `Prysel: ventana de desarrollo abierta${isolated ? ' con un perfil aparte' : ''}${folder ? ` en ${folder}` : ''}.`,
)
