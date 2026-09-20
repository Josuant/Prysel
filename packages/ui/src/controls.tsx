import type { ControlId } from '@prysel/morphology'
import {
  Chips,
  CodeBlock,
  Field,
  MiniTable,
  Progress,
  Row,
  Segmented,
  Select,
  Slider,
  Sparkline,
  Switch,
  TextInput,
} from './fields.tsx'
import { Icon } from './Icon.tsx'

/**
 * El modelo de cada editor gráfico. Es lo que convierte a un nodo en algo manipulable:
 * cambiar aquí equivale a reescribir el Python que hay debajo.
 */
export type ControlModel =
  | { kind: 'text'; value: string; placeholder?: string }
  | { kind: 'number'; value: number; min: number; max: number; step?: number; unit?: string }
  | { kind: 'boolean'; value: boolean; labels?: [string, string] }
  | { kind: 'constant'; value: string; options: string[] }
  | { kind: 'list'; items: string[]; itemType?: string }
  | { kind: 'dict'; entries: [string, string][] }
  | { kind: 'table'; columns: string[]; rows: string[][]; sortBy?: string }
  | { kind: 'args'; target: string; args: { name: string; value: string }[] }
  | { kind: 'expression'; left: string; operator: string; right: string; operators: string[] }
  | {
      kind: 'condition'
      field: string
      operator: string
      value: string
      operators: string[]
      hits?: [number, number]
    }
  | { kind: 'loop'; iterable: string; variable: string; current?: number; total?: number }
  | { kind: 'signal'; errorType: string; types: string[]; message: string }
  | { kind: 'io'; target: string; mode: string; modes: string[] }
  | {
      kind: 'stats'
      metric: string
      value: string
      deltaPct?: number
      range: string
      ranges: string[]
      series: number[]
      rows?: { label: string; value: string }[]
    }
  | { kind: 'module'; module: string; alias: string }
  | { kind: 'signature'; params: { name: string; value: string }[] }
  | {
      kind: 'query'
      field: string
      operator: string
      value: string
      operators: string[]
      hash: string
    }
  | { kind: 'code'; source: string }

export type ControlKind = ControlModel['kind']

/** `summary` = una fila, cabe en densidad normal · `full` = el editor completo, en expandido. */
export type ControlLevel = 'summary' | 'full'

export interface ControlProps {
  model: ControlModel
  level: ControlLevel
  onChange?: (next: ControlModel) => void
  /** Campos que ya reciben un valor de otro nodo: se marcan y dejan de ser editables a mano. */
  linked?: string[]
}

/** El id declarado en el catálogo de morfología y el modelo tienen que hablar de lo mismo. */
export function matchesKind(control: ControlId, model: ControlModel): boolean {
  return control === model.kind
}

export function Control({ model, level, onChange, linked = [] }: ControlProps) {
  const isLinked = (slot: string) => linked.includes(slot)
  const patch = <M extends ControlModel>(next: Partial<M>) =>
    onChange?.({ ...model, ...next } as ControlModel)
  const full = level === 'full'

  switch (model.kind) {
    case 'text':
      return (
        <Field label={full ? 'Valor' : undefined}>
          <TextInput
            value={model.value}
            placeholder={model.placeholder}
            onChange={(value) => patch({ value })}
          />
        </Field>
      )

    case 'number':
      return (
        <div className="control-stack">
          <Row>
            <Slider
              value={model.value}
              min={model.min}
              max={model.max}
              step={model.step}
              onChange={(value) => patch({ value })}
            />
            <span className="control-stack__readout type-value">
              {model.value.toLocaleString('es')}
              {model.unit && <span className="unit type-field-label">{model.unit}</span>}
            </span>
          </Row>
          {full && (
            <Row>
              <span className="type-field-label muted">
                {model.min.toLocaleString('es')} – {model.max.toLocaleString('es')}
              </span>
            </Row>
          )}
        </div>
      )

    case 'boolean':
      return (
        <Switch
          checked={model.value}
          labels={model.labels}
          onChange={(value) => patch({ value })}
        />
      )

    case 'constant':
      return (
        <Field label={full ? 'Sustituir por' : undefined}>
          <Select
            value={model.value}
            options={model.options}
            onChange={(value) => patch({ value })}
          />
        </Field>
      )

    case 'list':
      return (
        <div className="control-stack">
          <Chips
            items={model.items}
            max={full ? 8 : 3}
            onRemove={(i) => patch({ items: model.items.filter((_, j) => j !== i) })}
            onAdd={full ? () => patch({ items: [...model.items, '0'] }) : undefined}
          />
          {full && model.itemType && (
            <span className="type-field-label muted">
              {model.items.length} elementos · {model.itemType}
            </span>
          )}
        </div>
      )

    case 'dict': {
      const entries = full ? model.entries : model.entries.slice(0, 1)
      return (
        <div className="control-stack">
          {entries.map(([key, value], i) => (
            <Row key={key}>
              <TextInput
                value={key}
                grow={false}
                onChange={(k) =>
                  patch({
                    entries: model.entries.map((e, j): [string, string] =>
                      j === i ? [k, e[1]] : e,
                    ),
                  })
                }
              />
              <Icon name="chevron" size={12} className="row__arrow" />
              <TextInput
                value={value}
                onChange={(v) =>
                  patch({
                    entries: model.entries.map((e, j): [string, string] =>
                      j === i ? [e[0], v] : e,
                    ),
                  })
                }
              />
            </Row>
          ))}
          {!full && model.entries.length > 1 && (
            <span className="type-field-label muted">+{model.entries.length - 1} claves</span>
          )}
        </div>
      )
    }

    case 'table':
      return (
        <MiniTable
          columns={model.columns}
          rows={model.rows}
          sortBy={model.sortBy}
          maxRows={full ? 4 : 1}
          slot={{ id: 'data', label: 'Datos' }}
          linked={isLinked('data')}
          onSort={(sortBy) => patch({ sortBy })}
        />
      )

    case 'args': {
      const args = full ? model.args : model.args.slice(0, 1)
      return (
        <div className="control-stack">
          {args.map((arg, i) => (
            <Field key={arg.name} label={full ? arg.name : undefined}>
              <TextInput
                value={arg.value}
                slot={{ id: `arg:${arg.name}`, label: arg.name }}
                linked={isLinked(`arg:${arg.name}`)}
                onChange={(value) =>
                  patch({
                    args: model.args.map((a, j) => (j === i ? { ...a, value } : a)),
                  })
                }
              />
            </Field>
          ))}
          {!full && model.args.length > 1 && (
            <span className="type-field-label muted">+{model.args.length - 1} argumentos</span>
          )}
        </div>
      )
    }

    case 'expression':
      return (
        <Row>
          <TextInput
            value={model.left}
            slot={{ id: 'left', label: 'Operando izquierdo' }}
            linked={isLinked('left')}
            onChange={(left) => patch({ left })}
          />
          <Select
            value={model.operator}
            options={model.operators}
            compact
            onChange={(operator) => patch({ operator })}
          />
          <TextInput
            value={model.right}
            slot={{ id: 'right', label: 'Operando derecho' }}
            linked={isLinked('right')}
            onChange={(right) => patch({ right })}
          />
        </Row>
      )

    case 'condition':
      return (
        <div className="control-stack">
          {/* Apiladas a propósito: cada entrada necesita su propia altura para su puerto. */}
          <TextInput
            value={model.field}
            slot={{ id: 'field', label: 'Campo' }}
            linked={isLinked('field')}
            onChange={(field) => patch({ field })}
          />
          <Row>
            <Select
              value={model.operator}
              options={model.operators}
              compact
              onChange={(operator) => patch({ operator })}
            />
            <TextInput
              value={model.value}
              slot={{ id: 'value', label: 'Valor comparado' }}
              linked={isLinked('value')}
              onChange={(value) => patch({ value })}
            />
          </Row>
          {full && model.hits && (
            <div className="branches">
              <span className="branches__item type-field-label" data-branch="true">
                verdadero · {model.hits[0].toLocaleString('es')}
              </span>
              <span className="branches__item type-field-label" data-branch="false">
                falso · {model.hits[1].toLocaleString('es')}
              </span>
            </div>
          )}
        </div>
      )

    case 'loop':
      return (
        <div className="control-stack">
          <Row>
            <span className="type-field-label muted">para</span>
            <TextInput value={model.variable} onChange={(variable) => patch({ variable })} />
            <span className="type-field-label muted">en</span>
            <TextInput
              value={model.iterable}
              slot={{ id: 'iterable', label: 'Secuencia' }}
              linked={isLinked('iterable')}
              onChange={(iterable) => patch({ iterable })}
            />
          </Row>
          {model.total !== undefined && (
            <div className="control-stack__progress">
              <Progress current={model.current ?? 0} total={model.total} />
              <span className="type-field-label muted">
                {(model.current ?? 0).toLocaleString('es')} / {model.total.toLocaleString('es')}
              </span>
            </div>
          )}
        </div>
      )

    case 'signal':
      return (
        <div className="control-stack">
          <Select
            value={model.errorType}
            options={model.types}
            onChange={(errorType) => patch({ errorType })}
          />
          {full && (
            <Field label="Mensaje">
              <TextInput value={model.message} onChange={(message) => patch({ message })} />
            </Field>
          )}
        </div>
      )

    case 'io':
      return (
        <div className="control-stack">
          <Field label={full ? 'Destino' : undefined}>
            <TextInput
              value={model.target}
              slot={{ id: 'target', label: 'Destino' }}
              linked={isLinked('target')}
              onChange={(target) => patch({ target })}
            />
          </Field>
          {full && (
            <Field label="Modo">
              <Select
                value={model.mode}
                options={model.modes}
                onChange={(mode) => patch({ mode })}
              />
            </Field>
          )}
        </div>
      )

    case 'stats':
      return (
        <div className="stats">
          {full && (
            <Segmented
              value={model.range}
              options={model.ranges}
              onChange={(range) => patch({ range })}
            />
          )}
          <div className="stats__headline">
            <span className="stats__value type-stat">{model.value}</span>
            {model.deltaPct !== undefined && (
              <span
                className="stats__delta type-field-label"
                data-up={model.deltaPct >= 0 ? '' : undefined}
              >
                {model.deltaPct >= 0 ? '↑' : '↓'} {Math.abs(model.deltaPct)}%
              </span>
            )}
          </div>
          <Sparkline series={model.series} height={full ? 40 : 24} />
          {full &&
            model.rows?.slice(0, 2).map((row) => (
              <div className="stats__row" key={row.label}>
                <span className="type-field-label muted">{row.label}</span>
                <span className="type-value">{row.value}</span>
              </div>
            ))}
        </div>
      )

    case 'module':
      return (
        <Row>
          <span className="type-value muted">{model.module}</span>
          <span className="type-field-label muted">como</span>
          <TextInput value={model.alias} onChange={(alias) => patch({ alias })} />
        </Row>
      )

    case 'signature': {
      const params = full ? model.params : model.params.slice(0, 1)
      return (
        <div className="control-stack">
          {params.map((p, i) => (
            <Field key={p.name} label={full ? p.name : undefined}>
              <TextInput
                value={p.value}
                slot={{ id: `param:${p.name}`, label: p.name }}
                linked={isLinked(`param:${p.name}`)}
                onChange={(value) =>
                  patch({ params: model.params.map((q, j) => (j === i ? { ...q, value } : q)) })
                }
              />
            </Field>
          ))}
          {!full && model.params.length > 1 && (
            <span className="type-field-label muted">+{model.params.length - 1} parámetros</span>
          )}
        </div>
      )
    }

    case 'query':
      return (
        <div className="control-stack">
          <TextInput
            value={model.field}
            slot={{ id: 'field', label: 'Campo' }}
            linked={isLinked('field')}
            onChange={(field) => patch({ field })}
          />
          <Row>
            <Select
              value={model.operator}
              options={model.operators}
              compact
              onChange={(operator) => patch({ operator })}
            />
            <TextInput
              value={model.value}
              slot={{ id: 'value', label: 'Valor' }}
              linked={isLinked('value')}
              onChange={(value) => patch({ value })}
            />
          </Row>
          {full && (
            <span className="type-field-label muted">
              Interfaz generada una vez y guardada en caché · {model.hash}
            </span>
          )}
        </div>
      )

    case 'code':
      // Prysel no entiende esta construcción: no inventa una interfaz, deja el texto editable.
      return full ? (
        <CodeBlock source={model.source} rows={3} onChange={(source) => patch({ source })} />
      ) : (
        <CodeBlock source={model.source.split('\n')[0] ?? ''} />
      )
  }
}
