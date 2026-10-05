import { useEffect, useRef, useState, type ReactNode } from 'react'
import { App, type HostFeatures } from '../../../packages/extension/webview/src/App.tsx'
import { ErrorBoundary } from '../../../packages/extension/webview/src/ErrorBoundary.tsx'
import { CodeEditor } from './CodeEditor.tsx'
import { BLANK, EMPTY, EXAMPLES, type Example } from './examples.ts'
import type { WebDocument, WebHost } from './host.ts'
import { ANTHROPIC_MODELS, type AiSettings } from './settings.ts'
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
  suggestions: ['Enséñame la recursión', 'Explícame este programa', 'Paso a paso'],
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
  const [code, setCode] = useState(false)
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
            <App features={WEB_FEATURES} />
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
            typesafeKey: draft.typesafeKey.trim(),
          })
        }}
      >
        <h2>Inteligencia artificial</h2>
        <p className="web-settings__hint">
          La IA escribe el código y las explicaciones. Tu clave se guarda solo en este navegador y
          la página llama directamente a Anthropic: lo que escribes en el chat y tu código van a su
          API.
        </p>
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
            <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noreferrer">
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
        <div className="web-settings__actions">
          {initial.anthropicKey && (
            <button
              type="button"
              className="web-text-button"
              onClick={() => onSave({ ...draft, anthropicKey: '', typesafeKey: '' })}
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
