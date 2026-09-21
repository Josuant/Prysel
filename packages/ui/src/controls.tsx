import { INLINE_ARGS, type ControlId, type ControlModel } from '@prysel/morphology'
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
  RowButton,
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
  /**
   * Qué campos se pueden reescribir en el código, por su camino (`left`, `args.a`…). Un campo
   * fuera de la lista se ve pero no se toca: no tiene un sitio en el texto al que escribir.
   * Sin lista, todos son editables (un editor de ejemplo, sin código detrás).
   */
  editable?: readonly string[]
  /** Nombres que se pueden usar en los campos que son expresiones: se ofrecen al escribir. */
  suggestions?: readonly string[]
}

/** Los editores que saben escribirse de vuelta en el código. El resto se enseña tal cual, sin tocar. */
const WRITABLE: ReadonlySet<string> = new Set([
  'text',
  'number',
  'boolean',
  'expression',
  'condition',
  'args',
  'loop',
  'signature',
  'list',
  'dict',
  'module',
  'signal',
])

/** El id declarado en el catálogo de morfología y el modelo tienen que hablar de lo mismo. */
export function matchesKind(control: ControlId, model: ControlModel): boolean {
  return control === model.kind
}

export function Control(props: ControlProps) {
  const frozen = props.editable !== undefined && !WRITABLE.has(props.model.kind)
  // Lo que el analizador no sabe reescribir se enseña, pero un campo que acepta texto y no cambia
  // el programa engaña: se deshabilita entero.
  return frozen ? (
    <fieldset className="control-frozen" disabled>
      <Editor {...props} />
    </fieldset>
  ) : (
    <Editor {...props} />
  )
}

function Editor({ model, level, onChange, linked = [], editable, suggestions }: ControlProps) {
  const isLinked = (slot: string) => linked.includes(slot)
  const patch = <M extends ControlModel>(next: Partial<M>) =>
    onChange?.({ ...model, ...next } as ControlModel)
  const full = level === 'full'
  /** El manejador de un campo, o nada si ese campo no se puede escribir (y entonces solo se lee). */
  const on = <T,>(path: string, apply: (value: T) => void): ((value: T) => void) | undefined =>
    onChange && (editable === undefined || editable.includes(path)) ? apply : undefined

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
              onChange={on('value', (value: string) => patch({ value }))}
            />
          ) : (
            <TextInput
              value={model.value}
              placeholder={model.placeholder}
              onChange={on('value', (value: string) => patch({ value }))}
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
            onChange={on('value', (value: number) => patch({ value }))}
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
              onChange={on('value', (value: number) => patch({ value }))}
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
          onChange={on('value', (value: boolean) => patch({ value }))}
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
            max={full ? 10 : 4}
            onRemove={on('items', (i: number) =>
              patch({ items: model.items.filter((_, j) => j !== i) }),
            )}
            onAdd={on('items', (item: string) => patch({ items: [...model.items, item] }))}
          />
          {full && model.itemType && (
            <span className="type-field-label muted">
              {model.items.length} elementos · {model.itemType}
            </span>
          )}
        </div>
      )

    case 'dict': {
      const change = (index: number, at: 0 | 1) =>
        on('entries', (value: string) =>
          patch({
            entries: model.entries.map((entry, j): [string, string] =>
              j === index ? (at === 0 ? [value, entry[1]] : [entry[0], value]) : entry,
            ),
          }),
        )
      const shown = model.entries
        .map((entry, index) => ({ entry, index }))
        .filter(({ index }) => full || index < 1)
      const editing = on('entries', () => undefined) !== undefined
      return (
        <div className="control-stack">
          {shown.map(({ entry, index }) => (
            <Row key={index}>
              <TextInput
                value={entry[0]}
                grow={false}
                placeholder="clave"
                onChange={change(index, 0)}
              />
              <Icon name="chevron" size={12} className="row__arrow" />
              <TextInput value={entry[1]} placeholder="valor" onChange={change(index, 1)} />
              {editing && (
                <RowButton
                  label={`Quitar ${entry[0]}`}
                  icon="x"
                  onClick={() => {
                    patch({ entries: model.entries.filter((_, j) => j !== index) })
                  }}
                />
              )}
            </Row>
          ))}
          {!full && model.entries.length > 1 && (
            <span className="type-field-label muted">+{model.entries.length - 1} claves</span>
          )}
          {editing && (
            <RowButton
              label="Añadir una clave"
              icon="plus"
              text="clave"
              onClick={() => {
                // Una clave que no esté ya: un diccionario con dos iguales pierde una.
                let key = '"clave"'
                for (let n = 2; model.entries.some(([k]) => k === key); n++) key = `"clave_${n}"`
                patch({ entries: [...model.entries, [key, '"valor"']] })
              }}
            />
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
        .filter(
          ({ index, linked }) => full || index === 0 || linked || model.args.length <= INLINE_ARGS,
        )
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
                {...(suggestions ? { suggestions } : {})}
                onChange={on(`args.${arg.name}`, (value: string) =>
                  patch({
                    args: model.args.map((a, j) => (j === index ? { ...a, value } : a)),
                  }),
                )}
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
        <div className="control-stack">
          {/* Apiladas a propósito: dos puertos a la misma altura se taparían y no se podría elegir. */}
          <TextInput
            value={model.left}
            slot={{ id: 'left', label: 'Izquierda' }}
            linked={isLinked('left')}
            {...(suggestions ? { suggestions } : {})}
            onChange={on('left', (left: string) => patch({ left }))}
          />
          <Row>
            <Select
              value={model.operator}
              options={model.operators}
              compact
              onChange={on('operator', (operator: string) => patch({ operator }))}
            />
            <TextInput
              value={model.right}
              slot={{ id: 'right', label: 'Derecha' }}
              linked={isLinked('right')}
              {...(suggestions ? { suggestions } : {})}
              onChange={on('right', (right: string) => patch({ right }))}
            />
          </Row>
        </div>
      )

    case 'condition':
      return (
        <div className="control-stack">
          {/* Apiladas a propósito: cada entrada necesita su propia altura para su puerto. */}
          <TextInput
            value={model.field}
            slot={{ id: 'field', label: 'Campo' }}
            linked={isLinked('field')}
            {...(suggestions ? { suggestions } : {})}
            onChange={on('field', (field: string) => patch({ field }))}
          />
          <Row>
            <Select
              value={model.operator}
              options={model.operators}
              compact
              onChange={on('operator', (operator: string) => patch({ operator }))}
            />
            <TextInput
              value={model.value}
              slot={{ id: 'value', label: 'Valor' }}
              linked={isLinked('value')}
              {...(suggestions ? { suggestions } : {})}
              onChange={on('value', (value: string) => patch({ value }))}
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
            <TextInput
              value={model.variable}
              onChange={on('variable', (variable: string) => patch({ variable }))}
            />
            <span className="type-field-label muted">en</span>
            <TextInput
              value={model.iterable}
              slot={{ id: 'iterable', label: 'Secuencia' }}
              linked={isLinked('iterable')}
              {...(suggestions ? { suggestions } : {})}
              onChange={on('iterable', (iterable: string) => patch({ iterable }))}
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
          <TextInput
            value={model.errorType}
            suggestions={model.types}
            onChange={on('errorType', (errorType: string) => patch({ errorType }))}
          />
          <TextInput
            value={model.message}
            placeholder="Mensaje"
            onChange={on('message', (message: string) => patch({ message }))}
          />
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
          <TextInput
            value={model.module}
            grow={false}
            onChange={on('module', (module: string) => patch({ module }))}
          />
          <span className="type-field-label muted">como</span>
          <TextInput
            value={model.alias}
            onChange={on('alias', (alias: string) => patch({ alias }))}
          />
        </Row>
      )

    case 'signature': {
      const structural = on('paramsList', () => undefined) !== undefined
      const fresh = () => {
        let name = 'parametro'
        for (let n = 2; model.params.some((q) => q.name === name); n++) name = `parametro_${n}`
        return name
      }
      return (
        <div className="control-stack">
          {model.params.map((p, i) => (
            <Row key={i}>
              <TextInput
                value={p.name}
                grow={false}
                placeholder="nombre"
                onChange={on(`params[${i}].name`, (name: string) =>
                  patch({ params: model.params.map((q, j) => (j === i ? { ...q, name } : q)) }),
                )}
              />
              <span className="type-field-label muted">=</span>
              <TextInput
                value={p.value}
                placeholder="por defecto"
                slot={{ id: `param:${p.name}`, label: p.name }}
                linked={isLinked(`param:${p.name}`)}
                {...(suggestions ? { suggestions } : {})}
                onChange={on(`params.${p.name}`, (value: string) =>
                  patch({ params: model.params.map((q, j) => (j === i ? { ...q, value } : q)) }),
                )}
              />
              {structural && (
                <RowButton
                  label={`Quitar ${p.name}`}
                  icon="x"
                  onClick={() => {
                    patch({ params: model.params.filter((_, j) => j !== i) })
                  }}
                />
              )}
            </Row>
          ))}
          {structural && (
            <RowButton
              label="Añadir un parámetro"
              icon="plus"
              text="parámetro"
              onClick={() => {
                patch({ params: [...model.params, { name: fresh(), value: '' }] })
              }}
            />
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
