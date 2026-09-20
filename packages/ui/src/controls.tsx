import type { ControlId, ControlModel } from '@prysel/morphology'
import {
  Chips,
  CodeBlock,
  Field,
  MiniTable,
  Progress,
  Row,
  Segmented,
  Select,
  NumberInput,
  Slider,
  Sparkline,
  Switch,
  TextArea,
  TextInput,
} from './fields.tsx'
import { Icon } from './Icon.tsx'

/**
 * El modelo de cada editor gráfico. Es lo que convierte a un nodo en algo manipulable:
 * cambiar aquí equivale a reescribir el Python que hay debajo.
 */
export type { ControlModel }

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
          {model.multiline ? (
            <TextArea
              value={model.value}
              placeholder={model.placeholder}
              rows={full ? 4 : 2}
              // Un mensaje con {huecos} recibe valores de otros nodos, pero sigue siendo editable.
              slot={{ id: 'value', label: 'Mensaje' }}
              onChange={(value) => patch({ value })}
            />
          ) : (
            <TextInput
              value={model.value}
              placeholder={model.placeholder}
              onChange={(value) => patch({ value })}
            />
          )}
        </Field>
      )

    case 'number':
      // Un literal cualquiera no tiene rango con sentido: se escribe. El deslizador es para lo que sí lo tiene.
      if (model.min === undefined || model.max === undefined) {
        return (
          <NumberInput
            value={model.value}
            step={model.step ?? 'any'}
            onChange={(value) => patch({ value })}
          />
        )
      }
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
      // Un argumento que recibe una conexión nunca se esconde: si dos cables llegan a este nodo,
      // hay que ver a qué argumento entra cada uno. Y con su nombre, o no se sabría cuál es cuál.
      const shown = model.args
        .map((arg, index) => ({ arg, index, linked: isLinked(`arg:${arg.name}`) }))
        .filter(({ index, linked }) => full || index === 0 || linked)
      const hidden = model.args.length - shown.length
      return (
        <div className="control-stack">
          {model.target && <span className="control-target type-value">{model.target}( )</span>}
          {shown.map(({ arg, index, linked }) => (
            <Field
              key={arg.name}
              label={full || linked || model.args.length > 1 ? arg.name : undefined}
            >
              <TextInput
                value={arg.value}
                slot={{ id: `arg:${arg.name}`, label: arg.name }}
                linked={linked}
                onChange={(value) =>
                  patch({
                    args: model.args.map((a, j) => (j === index ? { ...a, value } : a)),
                  })
                }
              />
            </Field>
          ))}
          {hidden > 0 && (
            <span className="type-field-label muted">
              +{hidden} {hidden === 1 ? 'argumento' : 'argumentos'}
            </span>
          )}
        </div>
      )
    }

    case 'expression':
      return (
        <Row>
          <TextInput
            value={model.left}
            slot={{ id: 'left', label: 'Izquierda' }}
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
            slot={{ id: 'right', label: 'Derecha' }}
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
              slot={{ id: 'value', label: 'Valor' }}
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
            <Field key={p.name} label={p.name}>
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
