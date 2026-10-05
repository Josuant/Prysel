import { useEffect, useRef, useState } from 'react'
import { App, type HostFeatures } from '../../../packages/extension/webview/src/App.tsx'
import { ErrorBoundary } from '../../../packages/extension/webview/src/ErrorBoundary.tsx'
import { CodeEditor } from './CodeEditor.tsx'
import { BLANK, EXAMPLES, type Example } from './examples.ts'
import type { WebDocument, WebHost } from './host.ts'
import { loadDocument, saveDocument } from './store.ts'

/**
 * La página: una barra arriba (qué se está viendo y las lecciones), y debajo el diagrama o el código. En
 * un móvil se ve una cosa cada vez, con pestañas; en una pantalla ancha, las dos lado a lado.
 */

type Tab = 'diagram' | 'code'

/** Lo que la web aún no tiene: las órdenes con IA y su pestaña de consultas, y un guion que editar aparte. */
const WEB_FEATURES: HostFeatures = { orders: false, calls: false, editLesson: false }

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

export function Shell({ host }: { host: WebHost }) {
  const [doc, setDoc] = useState(() => host.current)
  const [tab, setTab] = useState<Tab>('diagram')
  const [menu, setMenu] = useState(false)
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

  // Al arrancar: lo que se dejó abierto, o la primera lección (después de suscribirse, para enterarse).
  const opened = useRef(false)
  useEffect(() => {
    if (opened.current) return
    opened.current = true
    host.open(loadDocument() ?? EXAMPLES[0] ?? BLANK)
  }, [host])

  const open = (next: WebDocument) => {
    host.open(next)
    setMenu(false)
    setTab('diagram')
  }

  const example = EXAMPLES.find((candidate) => candidate.name === doc.name)
  const title = example?.title ?? doc.name

  return (
    <div className="web-shell">
      <header className="web-bar">
        <button
          type="button"
          className="web-bar__menu"
          aria-label="Lecciones y programas"
          aria-expanded={menu}
          onClick={() => setMenu((value) => !value)}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M4 7h16M4 12h16M4 17h10" />
          </svg>
        </button>
        <div className="web-bar__title">
          <span className="web-bar__brand">Prysel</span>
          <span className="web-bar__doc">{title}</span>
        </div>
        {!wide && (
          <div className="web-tabs" role="tablist" aria-label="Vista">
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'diagram'}
              onClick={() => setTab('diagram')}
            >
              Diagrama
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'code'}
              onClick={() => setTab('code')}
            >
              Código
            </button>
          </div>
        )}
      </header>

      <main className={wide ? 'web-main web-main--wide' : 'web-main'}>
        <section className="web-code" hidden={!wide && tab !== 'code'} aria-label="Código Python">
          <CodeEditor value={doc.text} onChange={(text) => host.setText(text)} />
        </section>
        <section
          className="web-canvas"
          data-hidden={!wide && tab !== 'diagram' ? 'true' : undefined}
          aria-label="Diagrama"
        >
          <ErrorBoundary label="el diagrama">
            <App features={WEB_FEATURES} />
          </ErrorBoundary>
        </section>
      </main>

      {menu && (
        <LessonMenu
          current={doc.name}
          onPick={open}
          onClose={() => setMenu(false)}
          onBlank={() => open(BLANK)}
        />
      )}
    </div>
  )
}

function LessonMenu({
  current,
  onPick,
  onClose,
  onBlank,
}: {
  current: string
  onPick: (example: Example) => void
  onClose: () => void
  onBlank: () => void
}) {
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [onClose])
  return (
    <div className="web-sheet" role="dialog" aria-modal="true" aria-label="Lecciones">
      <button type="button" className="web-sheet__scrim" aria-label="Cerrar" onClick={onClose} />
      <div className="web-sheet__panel">
        <h2>Lecciones</h2>
        <p className="web-sheet__hint">
          Ábrelas y pulsa «Paso a paso» en el diagrama: se ejecutan y se explican solas.
        </p>
        <ul>
          {EXAMPLES.map((example) => (
            <li key={example.id}>
              <button
                type="button"
                aria-current={example.name === current}
                onClick={() => onPick(example)}
              >
                <strong>{example.title}</strong>
                <span>
                  {example.name}
                  {example.level ? ` · ${example.level}` : ''}
                </span>
              </button>
            </li>
          ))}
        </ul>
        <h2>Tu código</h2>
        <ul>
          <li>
            <button type="button" onClick={onBlank}>
              <strong>Programa nuevo</strong>
              <span>Escribe Python y míralo como diagrama</span>
            </button>
          </li>
        </ul>
      </div>
    </div>
  )
}
