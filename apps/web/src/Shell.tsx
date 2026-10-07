import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { recorder } from './recorder.ts'
import { App, type HostFeatures } from '../../../packages/extension/webview/src/App.tsx'
import { ErrorBoundary } from '../../../packages/extension/webview/src/ErrorBoundary.tsx'
import { CodeEditor } from './CodeEditor.tsx'
import { BLANK, EMPTY, EXAMPLES, type Example } from './examples.ts'
import type { WebDocument, WebHost } from './host.ts'
import {
  ANTHROPIC_MODELS,
  DEEPSEEK_MODELS,
  hasAiKey,
  loadFlow,
  saveFlow,
  type AiSettings,
} from './settings.ts'
import { loadDocument, saveDocument } from './store.ts'

/**
 * La página: el diagrama ocupa todo, con el chat de la IA abajo (eso lo pone el lienzo). Arriba, una barra
 * mínima: el menú (lecciones, empezar de cero, ajustes), qué se está viendo y el código, que se abre
 * encima cuando hace falta. En una pantalla ancha, el código puede quedarse al lado.
 */

const WEB_FEATURES: HostFeatures = {
  orders: true,
  calls: false,
  editLesson: false,
  chat: true,
  foldInsights: true,
  suggestions: ['Enséñame la recursión', 'Explícame este programa', 'Paso a paso'],
}

/** Descarga unos datos como un archivo `.json`, con la fecha en el nombre. */
function save(data: unknown, name: string) {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }),
  )
  const link = document.createElement('a')
  link.href = url
  link.download = `${name}-${stamp}.json`
  document.body.append(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

/** Dónde se recuerda, en este navegador, si se quieren ver las consultas a los modelos. */
const CALLS = 'prysel.web.calls'

function readFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === '1'
  } catch {
    return false
  }
}

function writeFlag(key: string, on: boolean) {
  try {
    localStorage.setItem(key, on ? '1' : '0')
  } catch {
    // Sin almacenamiento (modo privado): vale para esta visita.
  }
}

const WIDE = '(min-width: 960px)'

function useWide(): boolean {
  const [wide, setWide] = useState(() => window.matchMedia(WIDE).matches)
  useEffect(() => {
    const query = window.matchMedia(WIDE)
    const change = () => setWide(query.matches)
    query.addEventListener('change', change)
    return () => query.removeEventListener('change', change)
  }, [])
  return wide
}

function useSystemTheme(host: WebHost) {
  useEffect(() => {
    const query = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = () => host.setTheme(query.matches ? 'dark' : 'light')
    apply()
    query.addEventListener('change', apply)
    return () => query.removeEventListener('change', apply)
  }, [host])
}

type Sheet = 'menu' | 'settings' | null

export function Shell({ host }: { host: WebHost }) {
  const [doc, setDoc] = useState(() => host.current)
  const [sheet, setSheet] = useState<Sheet>(null)
  // El código, a la vista de entrada donde cabe al lado del diagrama (en un móvil lo taparía).
  const [code, setCode] = useState(() => window.matchMedia(WIDE).matches)
  // Ver lo que se le pregunta a cada modelo y lo que contesta: una opción, apagada de entrada.
  const [calls, setCalls] = useState(() => readFlag(CALLS))
  const features = useMemo(() => ({ ...WEB_FEATURES, calls }), [calls])
  const [flow, setFlow] = useState(loadFlow)
  // Grabar cada explicación (vídeo de la pestaña y línea de tiempo) para revisarla después.
  const recording = useSyncExternalStore(
    (listener) => recorder.subscribe(listener),
    () => `${recorder.state.on}|${recorder.state.video}|${recorder.state.recording}`,
  )
  const [recOn, recVideo, recNow] = recording.split('|').map((flag) => flag === 'true')
  const wide = useWide()
  useSystemTheme(host)

  useEffect(
    () =>
      host.subscribe((next) => {
        setDoc(next)
        saveDocument(next)
      }),
    [host],
  )
  useEffect(() => host.onRequest(() => setSheet('settings')), [host])

  // Al arrancar: lo que se dejó abierto, o la primera lección (después de suscribirse, para enterarse).
  const opened = useRef(false)
  useEffect(() => {
    if (opened.current) return
    opened.current = true
    host.open(loadDocument() ?? EXAMPLES[0] ?? BLANK)
  }, [host])

  const open = (next: WebDocument) => {
    host.open(next)
    setSheet(null)
  }

  const example = EXAMPLES.find((candidate) => candidate.name === doc.name)
  const title = example?.title ?? (doc.text.trim() === '' ? 'Nuevo tema' : doc.name)

  return (
    <div className="web-shell">
      <header className="web-bar">
        <IconButton label="Menú" onClick={() => setSheet('menu')}>
          <path d="M4.5 7h15M4.5 12h15M4.5 17h10" />
        </IconButton>
        <div className="web-bar__title">
          <span className="web-bar__brand">Prysel</span>
          <span className="web-bar__doc">{title}</span>
        </div>
        {recNow && (
          <button
            type="button"
            className="web-rec"
            title="Grabando esta explicación. Pulsa para terminar y guardarla ya."
            onClick={() => recorder.finish()}
          >
            <span className="web-rec__dot" aria-hidden />
            Grabando
          </button>
        )}
        <IconButton
          label={code ? 'Ocultar el código' : 'Ver el código'}
          pressed={code}
          onClick={() => setCode((v) => !v)}
        >
          <path d="M8.5 7.5 4 12l4.5 4.5M15.5 7.5 20 12l-4.5 4.5M13.5 5.5l-3 13" />
        </IconButton>
      </header>

      <main className={wide && code ? 'web-main web-main--split' : 'web-main'}>
        <section className="web-canvas" aria-label="Diagrama">
          <ErrorBoundary label="el diagrama">
            <App features={features} />
          </ErrorBoundary>
        </section>
        {code && (
          <section
            className="web-code"
            data-overlay={!wide || undefined}
            aria-label="Código Python"
          >
            <div className="web-code__bar">
              <span>Código · {doc.name}</span>
              <button type="button" className="web-text-button" onClick={() => setCode(false)}>
                {wide ? 'Ocultar' : 'Volver al diagrama'}
              </button>
            </div>
            <CodeEditor value={doc.text} onChange={(text) => host.setText(text)} />
          </section>
        )}
      </main>

      {sheet === 'menu' && (
        <Drawer label="Menú" onClose={() => setSheet(null)}>
          <h2>Empezar</h2>
          <ul>
            <li>
              <button type="button" onClick={() => open(EMPTY)}>
                <strong>Nuevo tema</strong>
                <span>Pídele a la IA que te enseñe algo desde cero</span>
              </button>
            </li>
            <li>
              <button type="button" onClick={() => open(BLANK)}>
                <strong>Mi propio código</strong>
                <span>Escribe o pega Python y míralo como diagrama</span>
              </button>
            </li>
          </ul>
          <h2>Lecciones</h2>
          <ul>
            {EXAMPLES.map((item: Example) => (
              <li key={item.id}>
                <button
                  type="button"
                  aria-current={item.name === doc.name}
                  onClick={() => open(item)}
                >
                  <strong>{item.title}</strong>
                  <span>
                    {item.name}
                    {item.level ? ` · ${item.level}` : ''}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          <h2>Ajustes</h2>
          <ul>
            <li>
              <button type="button" onClick={() => setSheet('settings')}>
                <strong>Inteligencia artificial</strong>
                <span>
                  {host.aiSettings.anthropicKey
                    ? 'Clave guardada en este dispositivo'
                    : 'Falta tu clave de Anthropic'}
                </span>
              </button>
            </li>
            <li>
              <button
                type="button"
                aria-pressed={calls}
                onClick={() => {
                  writeFlag(CALLS, !calls)
                  setCalls(!calls)
                  setSheet(null)
                }}
              >
                <strong>Consultas a los modelos: {calls ? 'a la vista' : 'ocultas'}</strong>
                <span>
                  {calls
                    ? 'Quitar el botón «Consultas» del diagrama'
                    : 'Un botón en el diagrama para ver qué se le pregunta a cada IA y qué contesta'}
                </span>
              </button>
            </li>
            <li>
              <button
                type="button"
                onClick={() => {
                  save(host.callsLog(), 'prysel-consultas')
                  setSheet(null)
                }}
              >
                <strong>Descargar las consultas a los modelos</strong>
                <span>
                  Todo lo que se le preguntó a la IA y al JEV, y lo que contestaron (sin claves)
                </span>
              </button>
            </li>
            <li>
              <button
                type="button"
                onClick={() => {
                  save(host.changesLog(), 'prysel-cambios')
                  setSheet(null)
                }}
              >
                <strong>Descargar los cambios al código</strong>
                <span>Cada cambio, quién lo hizo y cómo quedó el código después</span>
              </button>
            </li>
            <li>
              <button
                type="button"
                onClick={() => {
                  const next = flow === 'stream' ? 'voice' : 'stream'
                  saveFlow(next)
                  setFlow(next)
                  setSheet(null)
                }}
              >
                <strong>Ritmo: {flow === 'stream' ? 'al de la IA' : 'al de la voz'}</strong>
                <span>
                  {flow === 'stream'
                    ? 'Cada pieza aparece en cuanto llega. Pulsa para que espere a que se explique cada una'
                    : 'Cada pieza espera a que se diga su frase. Pulsa para que vaya al ritmo de la IA'}
                </span>
              </button>
            </li>
            <li>
              <button
                type="button"
                aria-pressed={recOn}
                onClick={() => {
                  // Desde el propio clic: el navegador solo deja pedir la captura tras un gesto.
                  if (recOn) recorder.disarm()
                  else void recorder.arm()
                  setSheet(null)
                }}
              >
                <strong>
                  Grabar las explicaciones:{' '}
                  {recOn ? (recVideo ? 'vídeo y línea de tiempo' : 'solo línea de tiempo') : 'no'}
                </strong>
                <span>
                  {recOn
                    ? 'Dejar de grabar y soltar la captura de la pestaña'
                    : 'Al pedir algo a la IA se graba la pestaña hasta que termina, y se descarga con su línea de tiempo'}
                </span>
              </button>
            </li>
          </ul>
        </Drawer>
      )}

      {sheet === 'settings' && (
        <SettingsSheet
          initial={host.aiSettings}
          onSave={(next) => {
            host.setAiSettings(next)
            setSheet(null)
          }}
          onClose={() => setSheet(null)}
        />
      )}
    </div>
  )
}

function IconButton({
  label,
  pressed,
  onClick,
  children,
}: {
  label: string
  pressed?: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      className="web-icon"
      aria-label={label}
      aria-pressed={pressed}
      onClick={onClick}
    >
      <svg viewBox="0 0 24 24" aria-hidden="true">
        {children}
      </svg>
    </button>
  )
}

function useEscape(onClose: () => void) {
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [onClose])
}

function Drawer({
  label,
  onClose,
  children,
}: {
  label: string
  onClose: () => void
  children: ReactNode
}) {
  useEscape(onClose)
  return (
    <div className="web-sheet" role="dialog" aria-modal="true" aria-label={label}>
      <button type="button" className="web-sheet__scrim" aria-label="Cerrar" onClick={onClose} />
      <div className="web-sheet__panel">{children}</div>
    </div>
  )
}

function SettingsSheet({
  initial,
  onSave,
  onClose,
}: {
  initial: AiSettings
  onSave: (settings: AiSettings) => void
  onClose: () => void
}) {
  const [draft, setDraft] = useState(initial)
  useEscape(onClose)
  return (
    <div
      className="web-sheet"
      data-side="bottom"
      role="dialog"
      aria-modal="true"
      aria-label="Ajustes de la IA"
    >
      <button type="button" className="web-sheet__scrim" aria-label="Cerrar" onClick={onClose} />
      <form
        className="web-sheet__panel web-settings"
        onSubmit={(event) => {
          event.preventDefault()
          onSave({
            ...draft,
            anthropicKey: draft.anthropicKey.trim(),
            deepseekKey: draft.deepseekKey.trim(),
            typesafeKey: draft.typesafeKey.trim(),
            jevProxy: draft.jevProxy.trim(),
          })
        }}
      >
        <h2>Inteligencia artificial</h2>
        <p className="web-settings__hint">
          La IA escribe el código y las explicaciones. Las claves se guardan solo en este navegador
          y la página llama directamente a la IA elegida: lo que escribes en el chat y tu código van
          a su API.
        </p>
        <div className="web-segmented" role="radiogroup" aria-label="Qué IA usar">
          {(
            [
              ['anthropic', 'Anthropic (Claude)'],
              ['deepseek', 'DeepSeek'],
            ] as const
          ).map(([vendor, label]) => (
            <button
              key={vendor}
              type="button"
              role="radio"
              aria-checked={draft.vendor === vendor}
              onClick={() => setDraft({ ...draft, vendor })}
            >
              {label}
            </button>
          ))}
        </div>
        {draft.vendor === 'anthropic' ? (
          <>
            <label>
              <span>Clave de la API de Anthropic</span>
              <input
                type="password"
                autoComplete="off"
                placeholder="sk-ant-…"
                value={draft.anthropicKey}
                onChange={(event) => setDraft({ ...draft, anthropicKey: event.target.value })}
              />
              <small>
                Consíguela en{' '}
                <a
                  href="https://console.anthropic.com/settings/keys"
                  target="_blank"
                  rel="noreferrer"
                >
                  console.anthropic.com
                </a>
                .
              </small>
            </label>
            <label>
              <span>Modelo</span>
              <select
                value={draft.anthropicModel}
                onChange={(event) => setDraft({ ...draft, anthropicModel: event.target.value })}
              >
                {ANTHROPIC_MODELS.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.label}
                  </option>
                ))}
              </select>
            </label>
          </>
        ) : (
          <>
            <label>
              <span>Clave de la API de DeepSeek</span>
              <input
                type="password"
                autoComplete="off"
                placeholder="sk-…"
                value={draft.deepseekKey}
                onChange={(event) => setDraft({ ...draft, deepseekKey: event.target.value })}
              />
              <small>
                Consíguela en{' '}
                <a href="https://platform.deepseek.com/api_keys" target="_blank" rel="noreferrer">
                  platform.deepseek.com
                </a>
                .
              </small>
            </label>
            <label>
              <span>Modelo</span>
              <select
                value={draft.deepseekModel}
                onChange={(event) => setDraft({ ...draft, deepseekModel: event.target.value })}
              >
                {DEEPSEEK_MODELS.map((model) => (
                  <option key={model} value={model}>
                    {model}
                  </option>
                ))}
              </select>
            </label>
          </>
        )}
        <label>
          <span>Clave de TypeSafe (opcional)</span>
          <input
            type="password"
            autoComplete="off"
            placeholder="Sin ella decide el motor local"
            value={draft.typesafeKey}
            onChange={(event) => setDraft({ ...draft, typesafeKey: event.target.value })}
          />
          <small>
            El motor JEV decide qué hacer con cada mensaje. Sin clave, decide uno local, sin red.
          </small>
        </label>
        {draft.typesafeKey.trim() !== '' && (
          <label>
            <span>Intermediario para TypeSafe</span>
            <input
              type="url"
              inputMode="url"
              autoComplete="off"
              placeholder="https://prysel-jev.tu-cuenta.workers.dev"
              value={draft.jevProxy}
              onChange={(event) => setDraft({ ...draft, jevProxy: event.target.value })}
            />
            <small>
              TypeSafe no admite llamadas desde páginas web: hace falta un intermediario que reenvíe
              las peticiones (un Worker de Cloudflare, gratis; instrucciones en apps/web/proxy del
              repositorio). Sin él, decide el motor local.
            </small>
          </label>
        )}
        <div className="web-settings__actions">
          {(hasAiKey(initial) || initial.typesafeKey) && (
            <button
              type="button"
              className="web-text-button"
              onClick={() =>
                onSave({ ...draft, anthropicKey: '', deepseekKey: '', typesafeKey: '' })
              }
            >
              Borrar claves
            </button>
          )}
          <button type="button" className="web-text-button" onClick={onClose}>
            Cancelar
          </button>
          <button type="submit" className="web-primary">
            Guardar
          </button>
        </div>
      </form>
    </div>
  )
}
