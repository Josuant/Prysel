import {
  EXPERT_IDS,
  EXPERTS,
  PRESENCE_NAMES,
  type ExpertLevels,
  type Presence,
} from '../../src/jev/experts.ts'
import type { AuditMessage } from '../../src/protocol.ts'
import './experts.css'

/**
 * **El panel de los expertos**: cuánto está cada uno (apagado, observa, propone, corrige) y lo que dijeron en
 * la última orden, cada hallazgo con lo que decidió el JEV. Lo propuesto se aplica con un botón: es una
 * orden más, que se ve hacerse y se puede deshacer.
 */

const PRESENCES: Presence[] = [0, 1, 2, 3]

const PRESENCE_HINTS: Record<Presence, string> = {
  0: 'No mira nada',
  1: 'Mira y dice lo que ve, sin tocar nada',
  2: 'Mira y propone, con un botón para aplicarlo',
  3: 'Mira y arregla solo lo que el JEV confirma que es un problema real',
}

export function ExpertsPanel({
  levels,
  audit,
  onLevels,
  onApply,
  onClose,
}: {
  levels: ExpertLevels
  audit: AuditMessage | null
  onLevels: (levels: ExpertLevels) => void
  /** Aplicar un hallazgo: se pide como una orden (`fix`). */
  onApply: (fix: string) => void
  onClose: () => void
}) {
  const findings = audit?.experts.flatMap((report) => report.findings) ?? []
  const applied = findings.filter((finding) => finding.applied).length
  return (
    <section className="experts" aria-label="Expertos">
      <header className="experts__head">
        <div>
          <h2 className="experts__title">Expertos</h2>
          <p className="experts__sub">Revisan lo que se construye al acabar cada orden.</p>
        </div>
        <button type="button" className="experts__close" aria-label="Cerrar" onClick={onClose}>
          ×
        </button>
      </header>
      <ul className="experts__list">
        {EXPERT_IDS.map((id) => (
          <li key={id} className="experts__row">
            <div className="experts__who">
              <span className="experts__name">{EXPERTS[id].name}</span>
              <span className="experts__looks">{EXPERTS[id].looks}</span>
            </div>
            <div className="experts__levels" role="radiogroup" aria-label={EXPERTS[id].name}>
              {PRESENCES.map((level) => (
                <button
                  key={level}
                  type="button"
                  role="radio"
                  aria-checked={levels[id] === level}
                  title={PRESENCE_HINTS[level]}
                  className="experts__level"
                  onClick={() => {
                    onLevels({ ...levels, [id]: level })
                  }}
                >
                  {PRESENCE_NAMES[level]}
                </button>
              ))}
            </div>
          </li>
        ))}
      </ul>
      {audit && (
        <div className="experts__audit">
          <h3 className="experts__subtitle">Última revisión</h3>
          <p className="experts__asked">
            Lo pedido: «{audit.asked}»
            {findings.length === 0
              ? ' — nadie ve nada que mejorar.'
              : applied > 0
                ? ` — arreglaron ${applied} ${applied === 1 ? 'cosa' : 'cosas'}.`
                : ''}
          </p>
          {audit.broken !== undefined && (
            <p className="experts__warn">Lo que aplicaron dejó un fallo: {audit.broken}</p>
          )}
          {audit.experts
            .filter((report) => report.findings.length > 0 || report.silent)
            .map((report) => (
              <div key={report.id} className="experts__report">
                <h4 className="experts__expert">
                  {EXPERTS[report.id].name}
                  <span className="experts__mode">{PRESENCE_NAMES[report.level]}</span>
                </h4>
                {report.silent && <p className="experts__quiet">No pudo mirarlo esta vez.</p>}
                <ul className="experts__findings">
                  {report.findings.map((finding, at) => (
                    <li key={at} className="experts__finding" data-severity={finding.severity}>
                      <span className="experts__tag">
                        {finding.severity === 'grave' ? 'Grave' : 'Mejora'}
                      </span>
                      <div className="experts__body">
                        <p className="experts__what">{finding.what}</p>
                        <p className="experts__fix">{finding.fix}</p>
                      </div>
                      {finding.applied ? (
                        <span className="experts__done">Hecho</span>
                      ) : (
                        report.level >= 1 && (
                          <button
                            type="button"
                            className="experts__apply"
                            title={
                              finding.verdict === 'aplicar'
                                ? 'El JEV cree que conviene arreglarlo'
                                : 'Opcional: lo mejoraría'
                            }
                            onClick={() => {
                              onApply(finding.fix)
                            }}
                          >
                            Aplicar
                          </button>
                        )
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
        </div>
      )}
    </section>
  )
}

/** Cuántas recomendaciones de la última revisión siguen sin aplicar (lo que dice el botón del panel). */
export const openFindings = (audit: AuditMessage | null): number =>
  audit?.experts.reduce(
    (sum, report) => sum + report.findings.filter((finding) => !finding.applied).length,
    0,
  ) ?? 0
