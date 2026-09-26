import { useContext } from 'react'
import {
  ACTION_CALLS,
  INLINE_ARGS,
  isNameList,
  labelsArgs,
  moveStep,
  parseChainStep,
  lineArgs,
  type ControlId,
  type ControlModel,
} from '@prysel/morphology'
import {
  Chips,
  CodeBlock,
  Field,
  MiniTable,
  Progress,
  Row,
  Segmented,
  Select,
  SlotStateContext,
  NumberInput,
  RowButton,
  Slider,
  Sparkline,
  Switch,
  TextArea,
  TextInput,
} from './fields.tsx'
import { Icon } from './Icon.tsx'
import type { StepInfo } from './steps.ts'

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
  /** Lo que se observó de cada paso de una cadena (índice 0: el receptor), para enseñarlo junto a él. */
  steps?: readonly StepInfo[]
  /** La llamada se escribe en una sola línea, `funcion(a, b)`, en vez de un campo por fila. */
  line?: boolean
}

/** Los editores que saben escribirse de vuelta en el código. El resto se enseña tal cual, sin tocar. */
const WRITABLE: ReadonlySet<string> = new Set([
  'text',
  'number',
  'boolean',
  'expression',
  'condition',
  'args',
  'chain',
  'loop',
  'assign',
  'with',
  'handler',
  'class',
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

function Editor({
  model,
  level,
  onChange,
  linked = [],
  editable,
  suggestions,
  steps: observed,
  line = false,
}: ControlProps) {
  const state = useContext(SlotStateContext)
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
              linked={isLinked('value')}
              onChange={on('value', (value: string) => patch({ value }))}
            />
          ) : (
            <TextInput
              value={model.value}
              placeholder={model.placeholder}
              // La misma casilla que la de arriba: un mensaje corto también recibe un cable.
              slot={{ id: 'value', label: 'Mensaje' }}
              linked={isLinked('value')}
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

    case 'list': {
      // Cambiar un elemento en su sitio: la lista se reescribe entera, en el mismo orden.
      const editItem = on('items', ([i, item]: [number, string]) =>
        patch({ items: model.items.map((current, j) => (j === i ? item : current)) }),
      )
      return (
        <div className="control-stack">
          <Chips
            items={model.items}
            max={full ? 10 : 4}
            onRemove={on('items', (i: number) =>
              patch({ items: model.items.filter((_, j) => j !== i) }),
            )}
            onAdd={on('items', (item: string) => patch({ items: [...model.items, item] }))}
            {...(editItem ? { onChange: (i: number, item: string) => editItem([i, item]) } : {})}
          />
          {full && model.itemType && (
            <span className="type-field-label muted">
              {model.items.length} elementos · {model.itemType}
            </span>
          )}
        </div>
      )
    }

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
      // Una llamada de una línea: `funcion(a, b)`, con cada casilla al lado de la anterior.
      if (line) {
        const { shown, hidden } = lineArgs(model.args, linked)
        const labeled = labelsArgs(model.args)
        return (
          <div className="control-line">
            {model.target && !ACTION_CALLS.has(model.target) && (
              <TextInput
                value={model.target}
                slot={{ id: 'callee', label: 'Función' }}
                placeholder="función"
                {...(state.callees && state.callees.length > 0
                  ? { suggestions: state.callees }
                  : {})}
                onChange={on('target', (target: string) => patch({ target }))}
              />
            )}
            <span className="control-line__paren">(</span>
            {shown.map((arg) => {
              const index = model.args.indexOf(arg)
              return (
                <span key={arg.name} className="control-line__arg">
                  {labeled && <span className="control-line__name">{arg.name}</span>}
                  <TextInput
                    value={arg.value}
                    slot={{ id: `arg:${arg.name}`, label: arg.name }}
                    linked={isLinked(`arg:${arg.name}`)}
                    {...(suggestions ? { suggestions } : {})}
                    onChange={on(`args.${arg.name}`, (value: string) =>
                      patch({
                        args: model.args.map((a, j) => (j === index ? { ...a, value } : a)),
                      }),
                    )}
                  />
                </span>
              )
            })}
            {hidden > 0 && <span className="type-field-label muted">+{hidden}</span>}
            <span className="control-line__paren">)</span>
          </div>
        )
      }
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
          {/* A quién se llama: un desplegable con las funciones del programa (o un nombre cualquiera) y una casilla donde soltar un chip de función. */}
          {model.target && !ACTION_CALLS.has(model.target) && (
            <TextInput
              value={model.target}
              slot={{ id: 'callee', label: 'Función' }}
              placeholder="función"
              {...(state.callees && state.callees.length > 0 ? { suggestions: state.callees } : {})}
              onChange={on('target', (target: string) => patch({ target }))}
            />
          )}
          {shown.map(({ arg, index, linked }) => (
            <Field key={arg.name} label={full || model.args.length > 1 ? arg.name : undefined}>
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

    case 'chain': {
      const rewrite = on('chain', (steps: typeof model.steps) => patch({ steps }))
      const changeStep = (index: number, change: Partial<(typeof model.steps)[number]>) =>
        patch({
          steps: model.steps.map((step, j) => (j === index ? { ...step, ...change } : step)),
        })
      const preview = (at: number) => {
        const info = observed?.[at]
        return info?.short ? (
          <button
            type="button"
            className="chain__preview"
            title={info.long ?? info.short}
            disabled={!info.onView}
            onClick={info.onView}
          >
            {info.short}
          </button>
        ) : null
      }
      return (
        <div className="chain">
          <div className="chain__row">
            <TextInput
              value={model.receiver}
              slot={{ id: 'receiver', label: 'Receptor' }}
              linked={isLinked('receiver')}
              {...(suggestions ? { suggestions } : {})}
              onChange={on('receiver', (receiver: string) => patch({ receiver }))}
            />
            {preview(0)}
          </div>
          {model.steps.map((step, i) => (
            <div className="chain__row" key={i}>
              {step.kind === 'index' ? (
                <span className="chain__glue">[</span>
              ) : (
                <>
                  <span className="chain__glue">.</span>
                  <TextInput
                    value={step.name}
                    onChange={on(`steps[${i}].name`, (name: string) => changeStep(i, { name }))}
                  />
                </>
              )}
              {step.kind === 'call' && <span className="chain__glue">(</span>}
              {step.kind !== 'attr' && (
                <TextInput
                  value={step.args}
                  placeholder={step.kind === 'call' ? 'argumentos' : 'índice'}
                  {...(suggestions ? { suggestions } : {})}
                  onChange={on(`steps[${i}].args`, (args: string) => changeStep(i, { args }))}
                />
              )}
              {step.kind !== 'attr' && (
                <span className="chain__glue">{step.kind === 'call' ? ')' : ']'}</span>
              )}
              {preview(i + 1)}
              {rewrite && (
                <span className="chain__tools">
                  <button
                    type="button"
                    aria-label={`Subir el paso ${i + 1}`}
                    title="Subir"
                    disabled={i === 0}
                    onClick={() => {
                      rewrite(moveStep(model.steps, i, i - 1))
                    }}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    aria-label={`Bajar el paso ${i + 1}`}
                    title="Bajar"
                    disabled={i === model.steps.length - 1}
                    onClick={() => {
                      rewrite(moveStep(model.steps, i, i + 1))
                    }}
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    aria-label={`Quitar el paso ${i + 1}`}
                    title="Quitar el paso"
                    disabled={model.steps.length <= 1}
                    onClick={() => {
                      rewrite(model.steps.filter((_, j) => j !== i))
                    }}
                  >
                    ×
                  </button>
                </span>
              )}
            </div>
          ))}
          {rewrite && (
            <div className="chain__row chain__add">
              <TextInput
                value=""
                placeholder='＋ paso: head(3), ["col"], .T'
                onChange={(text: string) => {
                  const step = parseChainStep(text)
                  if (step) rewrite([...model.steps, step])
                }}
              />
            </div>
          )}
        </div>
      )
    }

    case 'expression':
      return (
        // Se lee como la fórmula: un operando, la operación en medio y el otro operando. Cada
        // operando tiene su puerto a su altura; la salida, a la derecha, es el resultado.
        <div className="control-stack control-formula" data-inline={full ? undefined : ''}>
          <TextInput
            value={model.left}
            slot={{ id: 'left', label: 'A' }}
            linked={isLinked('left')}
            {...(suggestions ? { suggestions } : {})}
            onChange={on('left', (left: string) => patch({ left }))}
          />
          <div className="control-formula__op">
            <Select
              value={model.operator}
              options={model.operators}
              compact
              onChange={on('operator', (operator: string) => patch({ operator }))}
            />
          </div>
          <TextInput
            value={model.right}
            slot={{ id: 'right', label: 'B' }}
            linked={isLinked('right')}
            {...(suggestions ? { suggestions } : {})}
            onChange={on('right', (right: string) => patch({ right }))}
          />
        </div>
      )

    case 'condition':
      // Esbelta: campo, operador y valor en una fila (sus puertos se reparten a lo alto del borde).
      if (!full) {
        return (
          <div className="control-stack control-formula" data-inline="">
            <TextInput
              value={model.field}
              slot={{ id: 'field', label: 'Campo' }}
              linked={isLinked('field')}
              {...(suggestions ? { suggestions } : {})}
              onChange={on('field', (field: string) => patch({ field }))}
            />
            <div className="control-formula__op">
              <Select
                value={model.operator}
                options={model.operators}
                compact
                onChange={on('operator', (operator: string) => patch({ operator }))}
              />
            </div>
            <TextInput
              value={model.value}
              slot={{ id: 'value', label: 'Valor' }}
              linked={isLinked('value')}
              {...(suggestions ? { suggestions } : {})}
              onChange={on('value', (value: string) => patch({ value }))}
            />
          </div>
        )
      }
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
      // `while`: no hay variable ni secuencia, sino una condición que se evalúa en cada vuelta.
      if (model.while) {
        return (
          <Row>
            <span className="type-field-label muted">mientras</span>
            <TextInput
              value={model.iterable}
              slot={{ id: 'iterable', label: 'Condición' }}
              linked={isLinked('iterable')}
              {...(suggestions ? { suggestions } : {})}
              onChange={on('iterable', (iterable: string) => patch({ iterable }))}
            />
          </Row>
        )
      }
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

    case 'assign': {
      // En una línea, un destino que es un nombre ya lo dice el chip que la abre: solo el valor.
      const named = isNameList(model.destination)
      const showTarget = !line || !named
      const valueField = (
        <TextInput
          value={model.value}
          slot={{ id: 'value', label: 'Valor' }}
          linked={isLinked('value')}
          {...(suggestions ? { suggestions } : {})}
          onChange={on('value', (value: string) => patch({ value }))}
        />
      )
      const targetField = (
        <TextInput
          value={model.destination}
          {...(!named
            ? { slot: { id: 'destination', label: 'Destino' }, linked: isLinked('destination') }
            : {})}
          {...(!named && suggestions ? { suggestions } : {})}
          onChange={on('destination', (destination: string) => patch({ destination }))}
        />
      )
      if (line) {
        return (
          <div className="control-line">
            {showTarget && (
              <>
                {targetField}
                <span className="control-line__paren">=</span>
              </>
            )}
            {valueField}
          </div>
        )
      }
      return (
        <div className="control-stack">
          <Field label={full ? 'Destino' : undefined}>{targetField}</Field>
          <Field label={full ? 'Valor' : undefined}>{valueField}</Field>
        </div>
      )
    }

    case 'with':
      return (
        <Row>
          <span className="type-field-label muted">con</span>
          <TextInput
            value={model.context}
            slot={{ id: 'context', label: 'Recurso' }}
            linked={isLinked('context')}
            {...(suggestions ? { suggestions } : {})}
            onChange={on('context', (context: string) => patch({ context }))}
          />
          {model.name !== '' && (
            <>
              <span className="type-field-label muted">como</span>
              <TextInput
                value={model.name}
                onChange={on('name', (name: string) => patch({ name }))}
              />
            </>
          )}
        </Row>
      )

    case 'class':
      return (
        <Row>
          <span className="type-field-label muted">hereda de</span>
          <TextInput
            value={model.bases}
            placeholder="nadie"
            slot={{ id: 'bases', label: 'Base' }}
            linked={isLinked('bases')}
            {...(suggestions ? { suggestions } : {})}
            onChange={on('bases', (bases: string) => patch({ bases }))}
          />
        </Row>
      )

    case 'match':
      return (
        <Row>
          <span className="type-field-label muted">según</span>
          <TextInput
            value={model.subject}
            slot={{ id: 'subject', label: 'Qué se compara' }}
            linked={isLinked('subject')}
            {...(suggestions ? { suggestions } : {})}
            onChange={on('subject', (subject: string) => patch({ subject }))}
          />
        </Row>
      )

    case 'case':
      return (
        <Row>
          {/* `case _:` no compara nada: es lo que queda. */}
          {model.pattern.trim() === '_' && model.guard === '' ? (
            <span className="type-field-label muted">en otro caso</span>
          ) : (
            <>
              <span className="type-field-label muted">caso</span>
              <TextInput
                value={model.pattern}
                onChange={on('pattern', (pattern: string) => patch({ pattern }))}
              />
            </>
          )}
          {model.guard !== '' && (
            <>
              <span className="type-field-label muted">y si</span>
              <TextInput
                value={model.guard}
                slot={{ id: 'guard', label: 'Condición' }}
                linked={isLinked('guard')}
                {...(suggestions ? { suggestions } : {})}
                onChange={on('guard', (guard: string) => patch({ guard }))}
              />
            </>
          )}
        </Row>
      )

    case 'handler':
      return (
        <Row>
          {/* `except*`: los de ese tipo que vengan dentro de un grupo de errores. */}
          <span className="type-field-label muted">
            {model.group ? 'si falla alguno de' : 'si falla'}
          </span>
          <TextInput
            value={model.type}
            placeholder="cualquier error"
            slot={{ id: 'type', label: 'Error' }}
            linked={isLinked('type')}
            {...(suggestions ? { suggestions } : {})}
            onChange={on('type', (type: string) => patch({ type }))}
          />
          {model.name !== '' && (
            <>
              <span className="type-field-label muted">como</span>
              <TextInput
                value={model.name}
                onChange={on('name', (name: string) => patch({ name }))}
              />
            </>
          )}
        </Row>
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
