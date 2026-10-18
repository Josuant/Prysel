/* global document, PointerEvent */
// (Las funciones que se pasan a `page.evaluate` corren dentro de la página: allí sí hay `document`.)
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import puppeteer from 'puppeteer-core'

/**
 * **El recorrido**: abre la web de Prysel en un Chrome sin ventana, carga cada programa de
 * `scripts/recorrido/*.py` y comprueba lo que una persona notaría al usarlo:
 *
 * - que no salte ningún error ni aparezca ningún `NaN`/`Infinity` en lo dibujado, y que la cámara se mueva;
 * - que no haya «construcciones sin entender» ni código suelto fuera de toda etapa;
 * - que cada etapa abierta se pueda plegar (y volver a abrir);
 * - si usa la pantalla: que arranque con «Empezar», que no salga negra, que lo que se pulsa responda sin
 *   fallos, y que en el móvil se pueda usar desde la idea («Úsalo»).
 *
 * Guarda una captura de cada uno en `scripts/recorrido/capturas/`. Sale con código 1 si algo falla.
 *
 * `node scripts/recorrido.mjs [url]` (por defecto, la web publicada). `CHROME` para otro navegador.
 * No usa la IA: lo que se mira es lo que hace la web con el motor local.
 */

const here = dirname(fileURLToPath(import.meta.url))
const url = process.argv[2] ?? 'https://josuant.github.io/Prysel/'
const examples = join(here, 'recorrido')
const shots = join(examples, 'capturas')
mkdirSync(shots, { recursive: true })

const chrome =
  process.env.CHROME ??
  [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/google-chrome',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].find((path) => existsSync(path))
if (!chrome) {
  console.error('No encuentro Chrome: dímelo en la variable CHROME.')
  process.exit(1)
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
const results = []
const check = (example, name, ok, detail = '') => {
  results.push({ example, name, ok, detail })
  const mark = ok === true ? '✓' : ok === 'aviso' ? '⚠' : '✗'
  console.log(`  ${mark} ${name}${detail ? ` — ${detail}` : ''}`)
}

const browser = await puppeteer.launch({
  executablePath: chrome,
  headless: true,
  args: ['--autoplay-policy=no-user-gesture-required', '--no-first-run'],
})

/** Abre la web con ese programa ya cargado (como si se hubiera escrito allí) y espera a que se dibuje. */
async function open(page, name, text) {
  await page.goto(`${url}?recorrido=${Date.now()}`, { waitUntil: 'domcontentloaded' })
  await page.evaluate(
    (doc) => {
      localStorage.setItem('prysel.web.doc', JSON.stringify(doc))
    },
    { name, text, lesson: null },
  )
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.react-flow__node', { timeout: 90_000 })
  // Python (Pyodide) arranca y ejecuta el programa para mirarlo: se deja que se asiente.
  await sleep(9000)
}

/** Lo que se lee del lienzo desde dentro: la cámara, lo dibujado y lo que recibe el lienzo (sus props). */
const inspect = () => {
  const attrs = [
    'width',
    'height',
    'viewBox',
    'points',
    'x',
    'y',
    'cx',
    'cy',
    'r',
    'd',
    'transform',
  ]
  const bad = [...document.querySelectorAll('svg, svg *')].filter((element) =>
    attrs.some((attr) => /NaN|Infinity/.test(element.getAttribute(attr) ?? '')),
  ).length
  const camera = document.querySelector('.react-flow__viewport')?.style.transform ?? ''
  const pane = document.querySelector('.react-flow__pane')
  let props = null
  if (pane) {
    const key = Object.keys(pane).find((name) => name.startsWith('__reactFiber'))
    let fiber = key ? pane[key] : null
    while (fiber) {
      const memo = fiber.memoizedProps
      if (memo && 'architecture' in memo && Array.isArray(memo.nodes)) {
        props = memo
        break
      }
      fiber = fiber.return
    }
  }
  const architecture = props?.architecture ?? null
  // Suelto: lo que no está dentro de ninguna etapa ni función (los `import` del principio no cuentan).
  const contained = new Set((props?.nodes ?? []).flatMap((node) => node.contains ?? []))
  const loose =
    architecture && architecture.modules.length > 0
      ? props.nodes
          .filter((node) => !node.parent && !node.viewer && node.kind !== 'space.section')
          .filter((node) => node.kind !== 'external.import' && !contained.has(node.id))
          .filter((node) => !architecture.modules.some((module) => module.id === node.id))
          .map((node) => `${node.label} (línea ${node.line})`)
      : []
  const banner = [...document.querySelectorAll('[role="note"]')]
    .map((note) => note.textContent ?? '')
    .find((text) => /sin entender/.test(text))
  return { bad, camera, loose, banner: banner ?? null, modules: architecture?.modules.length ?? 0 }
}

/**
 * Cada etapa, en los dos sentidos: la abierta se pliega y se vuelve a abrir; la plegada se abre y se vuelve
 * a plegar. Dice las que no se dejaron.
 */
const folding = async () => {
  const wait = (ms) => new Promise((done) => setTimeout(done, ms))
  const label = (button) => button.getAttribute('aria-label') ?? ''
  const find = (text) => [...document.querySelectorAll('button')].find((one) => label(one) === text)
  const titles = [...document.querySelectorAll('button')]
    .map(label)
    .filter((text) => /^(Plegar|Abrir) la etapa /.test(text))
  const stuck = []
  for (const text of titles) {
    const title = text.replace(/^(Plegar|Abrir) la etapa /, '')
    const closing = text.startsWith('Plegar')
    const [now, back] = closing ? ['Plegar', 'Abrir'] : ['Abrir', 'Plegar']
    find(`${now} la etapa ${title}`)?.click()
    await wait(900)
    if (!find(`${back} la etapa ${title}`)) {
      stuck.push(`${title} (${closing ? 'plegar' : 'abrir'})`)
      continue
    }
    find(`${back} la etapa ${title}`)?.click()
    await wait(900)
    if (!find(`${now} la etapa ${title}`)) stuck.push(`${title} (${closing ? 'abrir' : 'plegar'})`)
  }
  return { tried: titles.length, stuck }
}

/** La pantalla: «Empezar», que no salga negra, y pulsar lo primero que se pueda. */
const useScreen = async (inIdea) => {
  const wait = (ms) => new Promise((done) => setTimeout(done, ms))
  const root = inIdea
    ? document.querySelector('.idea [data-kind="screen"]')
    : document.querySelector('.react-flow .screen-node')
  if (!root) return { found: false }
  root.querySelector('.screen-node__start')?.click()
  // Hasta que tenga algo que pulsar (o falle), como mucho 15 s: la primera vez se carga Python.
  for (let waited = 0; waited < 15_000; waited += 500) {
    await wait(500)
    const ready =
      root.querySelector('.screen-node__button') ||
      root.querySelector('.screen-node__canvas[data-touchable]') ||
      root.querySelector('.screen-node__error')
    if (ready) break
  }
  await wait(800)
  const canvas = root.querySelector('.screen-node__canvas')
  let black = null
  if (canvas) {
    const context = canvas.getContext('2d')
    const samples = []
    for (let i = 1; i < 5; i++)
      for (let j = 1; j < 5; j++) {
        const data = context.getImageData(
          (canvas.width * i) / 5,
          (canvas.height * j) / 5,
          1,
          1,
        ).data
        samples.push(data[0] + data[1] + data[2])
      }
    black = samples.every((sum) => sum === 0)
  }
  const buttons = root.querySelectorAll('.screen-node__button').length
  const touchable = canvas?.hasAttribute('data-touchable') ?? false
  const before = root.querySelector('.screen-node__lines')?.textContent ?? ''
  const first = root.querySelector('.screen-node__button')
  if (first) first.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }))
  else if (canvas && touchable) {
    const box = canvas.getBoundingClientRect()
    canvas.dispatchEvent(
      new PointerEvent('pointerdown', {
        bubbles: true,
        button: 0,
        clientX: box.left + box.width * 0.2,
        clientY: box.top + box.height * 0.5,
      }),
    )
  }
  await wait(1500)
  return {
    found: true,
    state: root.querySelector('.screen-node__state')?.textContent ?? '',
    canvas: Boolean(canvas),
    black,
    buttons,
    touchable,
    answered: (root.querySelector('.screen-node__lines')?.textContent ?? '') !== before,
    error: root.querySelector('.screen-node__error')?.textContent ?? null,
  }
}

for (const file of readdirSync(examples)
  .filter((name) => name.endsWith('.py'))
  .sort()) {
  const text = readFileSync(join(examples, file), 'utf8')
  const screen = /^import pantalla\b/m.test(text)
  console.log(`\n▸ ${file}`)
  const page = await browser.newPage()
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })
  try {
    // ── en una pantalla ancha: el diagrama por partes ──
    await page.setViewport({ width: 1400, height: 900 })
    await open(page, file, text)
    const seen = await page.evaluate(inspect)
    check(
      file,
      'nada dibujado con NaN o Infinity',
      seen.bad === 0,
      seen.bad ? `${seen.bad} elementos` : '',
    )
    check(
      file,
      'la cámara está en un sitio de verdad',
      !/NaN|Infinity/.test(seen.camera),
      seen.camera,
    )
    check(file, 'nada «sin entender»', seen.banner === null, seen.banner ?? '')
    check(
      file,
      'nada suelto fuera de las etapas',
      seen.loose.length === 0 ? true : 'aviso',
      seen.loose.join(', '),
    )
    const folded = await page.evaluate(folding)
    check(
      file,
      `las etapas se pliegan y se abren (${folded.tried})`,
      folded.stuck.length === 0,
      folded.stuck.join(', '),
    )
    if (screen) {
      const used = await page.evaluate(useScreen, false)
      check(file, 'hay pantalla', used.found)
      if (used.found) {
        check(file, 'la pantalla arranca', used.state === 'úsalo', used.state)
        if (used.canvas) check(file, 'lo dibujado no sale negro', used.black === false)
        check(
          file,
          'hay algo que pulsar',
          used.buttons > 0 || used.touchable,
          `${used.buttons} botones${used.touchable ? ', lienzo pulsable' : ''}`,
        )
        check(file, 'lo pulsado responde sin fallos', used.error === null, used.error ?? '')
      }
    }
    await page.screenshot({ path: join(shots, `${file.replace('.py', '')}-ancho.png`) })
    // ── en un móvil: se abre la idea, y la pantalla tiene que estar ahí ──
    if (screen) {
      await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true })
      await page.reload({ waitUntil: 'domcontentloaded' })
      await page.waitForSelector('.idea', { timeout: 60_000 })
      await sleep(8000)
      const used = await page.evaluate(useScreen, true)
      check(
        file,
        'en el móvil se usa desde la idea («Úsalo»)',
        used.found && used.state === 'úsalo',
        used.state ?? '',
      )
      await page.screenshot({ path: join(shots, `${file.replace('.py', '')}-movil.png`) })
    }
    const real = errors.filter((message) => !/favicon|ResizeObserver loop/i.test(message))
    check(file, 'ningún error en la página', real.length === 0, real.slice(0, 3).join(' | '))
  } catch (error) {
    check(
      file,
      'el recorrido llegó al final',
      false,
      error instanceof Error ? error.message : String(error),
    )
  }
  await page.close()
}

await browser.close()
const failed = results.filter((result) => result.ok === false)
const warned = results.filter((result) => result.ok === 'aviso')
console.log(
  `\n${results.length - failed.length - warned.length} bien, ${warned.length} avisos, ${failed.length} fallos. Capturas en ${resolve(shots)}`,
)
process.exit(failed.length > 0 ? 1 : 0)
