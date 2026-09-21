import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Prueba de extremo a extremo con un VS Code de verdad: empaqueta el `.vsix`, lo instala en un VS Code
 * aislado (carpetas de usuario y de extensiones temporales: no toca el del usuario) y lanza dentro
 * pruebas que abren el lienzo, ejecutan un archivo y comprueban el resultado.
 *
 * `node e2e/run.mjs`. Necesita VS Code instalado (`VSCODE_EXE` si no está en un sitio habitual) y un
 * Python (`PRYSEL_PYTHON`, o `python` del PATH). No forma parte de `pnpm verify`. Con `KEEP=1` conserva
 * las carpetas temporales si algo falla.
 */

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')

function findCode() {
  if (process.env.VSCODE_EXE) return process.env.VSCODE_EXE
  const candidates =
    process.platform === 'win32'
      ? [
          join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Microsoft VS Code', 'Code.exe'),
          join(process.env.ProgramFiles ?? '', 'Microsoft VS Code', 'Code.exe'),
        ]
      : process.platform === 'darwin'
        ? ['/Applications/Visual Studio Code.app/Contents/MacOS/Electron']
        : ['/usr/share/code/code', '/opt/visual-studio-code/code']
  const found = candidates.find((path) => existsSync(path))
  if (!found) throw new Error('No encuentro VS Code: indica su ejecutable en VSCODE_EXE.')
  return found
}

const work = mkdtempSync(join(tmpdir(), 'prysel-e2e-'))
const vsix = join(work, 'prysel.vsix')
const userData = join(work, 'user')
const extensions = join(work, 'extensions')
const project = join(work, 'proyecto')
const out = join(work, 'resultado.json')
// Una carpeta de trabajo con el archivo Python dentro: la extensión ejecuta en la carpeta del archivo.
mkdirSync(project)

const code = findCode()
// El proceso que nos lanza puede venir de una app de Electron: si lo heredara, VS Code arrancaría como Node.
const env = { ...process.env, PRYSEL_TEST_OUT: out, PRYSEL_TEST_DIR: project }
delete env.ELECTRON_RUN_AS_NODE
env.PRYSEL_PYTHON ??= 'python'

function step(title, command, args, options = {}) {
  console.log(`\n▸ ${title}`)
  const result = spawnSync(command, args, { stdio: 'inherit', env, ...options })
  if (result.status !== 0) {
    console.error(`✖ ${title} falló (código ${result.status})`)
    process.exitCode = 1
    return false
  }
  return true
}

let ok = step('Empaquetar el .vsix', process.execPath, [join(root, 'scripts/package.mjs'), vsix], {
  cwd: root,
})
if (ok) {
  const cli = join(dirname(code), 'bin', process.platform === 'win32' ? 'code.cmd' : 'code')
  const install = [
    JSON.stringify(cli),
    `--user-data-dir=${JSON.stringify(userData)}`,
    `--extensions-dir=${JSON.stringify(extensions)}`,
    '--install-extension',
    JSON.stringify(vsix),
    '--force',
  ].join(' ')
  ok = step('Instalar en un VS Code aislado', install, [], { shell: true })
}
if (ok) {
  ok = step(
    'Correr las pruebas dentro de VS Code',
    code,
    [
      project,
      `--user-data-dir=${userData}`,
      `--extensions-dir=${extensions}`,
      `--extensionDevelopmentPath=${join(here, 'host')}`,
      `--extensionTestsPath=${join(here, 'suite.cjs')}`,
      '--disable-gpu',
      '--disable-updates',
      '--disable-workspace-trust',
      '--skip-welcome',
      '--skip-release-notes',
      '--no-sandbox',
    ],
    { timeout: 180_000 },
  )
}

if (existsSync(out)) {
  const result = JSON.parse(readFileSync(out, 'utf8'))
  console.log('\n' + JSON.stringify(result, null, 2))
  if (result.error) process.exitCode = 1
} else {
  console.error('Las pruebas no dejaron resultado.')
  process.exitCode = 1
}
if (process.exitCode === 0 || process.env.KEEP !== '1')
  rmSync(work, { recursive: true, force: true })
else console.log(`(se conserva ${work})`)
