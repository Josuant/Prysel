import type { Metrics, NodeKindId } from '@prysel/morphology'
import type { ControlModel } from '@prysel/ui'

export interface Sample {
  label: string
  code?: string
  meta?: string
  metrics?: Metrics
  control?: ControlModel
}

/**
 * Un ejemplo realista por tipo, con el editor gráfico que le corresponde.
 * `Record<NodeKindId, …>` obliga a cubrir cualquier tipo nuevo del catálogo.
 */
export const SAMPLES: Record<NodeKindId, Sample> = {
  'value.str': {
    label: 'customer',
    code: 'customer = "Ana Pérez"',
    meta: 'str · sales.py:4',
    control: { kind: 'text', value: 'Ana Pérez', placeholder: 'texto' },
  },
  'value.number': {
    label: 'THRESHOLD',
    code: 'THRESHOLD = 1000',
    meta: 'int · sales.py:6',
    control: { kind: 'number', value: 1000, min: 0, max: 5000, step: 50, unit: '€' },
  },
  'value.bool': {
    label: 'include_taxes',
    code: 'include_taxes = True',
    meta: 'bool',
    control: { kind: 'boolean', value: true },
  },
  'value.none': {
    label: 'discount',
    code: 'discount = None',
    meta: 'NoneType · sin asignar',
    control: { kind: 'constant', value: 'None', options: ['None', '0', '""', '[]', '{}'] },
  },

  'data.list': {
    label: 'prices',
    code: 'prices = [12.5, 8.0, 31.2, …]',
    meta: '24 elementos',
    metrics: { cardinality: 24 },
    control: { kind: 'list', items: ['12.5', '8.0', '31.2', '4.9', '17.0'], itemType: 'float' },
  },
  'data.dict': {
    label: 'config',
    code: 'config = {"mode": "fast", …}',
    meta: '6 claves',
    metrics: { cardinality: 6 },
    control: {
      kind: 'dict',
      entries: [
        ['mode', '"fast"'],
        ['retries', '3'],
        ['verbose', 'False'],
      ],
    },
  },
  'data.dataframe': {
    label: 'sales',
    code: 'sales = pd.read_csv("sales.csv")',
    meta: '428 filas · 6 columnas',
    metrics: { cardinality: 428 },
    control: {
      kind: 'table',
      columns: ['region', 'amount', 'date'],
      rows: [
        ['Norte', '1 240', '03-05'],
        ['Sur', '890', '03-05'],
        ['Este', '2 310', '03-06'],
        ['Oeste', '1 105', '03-07'],
      ],
      sortBy: 'amount',
    },
  },

  'transform.call': {
    label: 'Agrupar por región',
    code: 'big.groupby("region").amount.sum()',
    meta: '91 → 4 filas · sales.py:42',
    metrics: { ops: 3 },
    control: {
      kind: 'args',
      target: 'groupby',
      args: [
        { name: 'by', value: '"region"' },
        { name: 'columna', value: 'amount' },
        { name: 'agregación', value: 'sum' },
      ],
    },
  },
  'transform.operation': {
    label: 'Añadir IVA',
    code: 'total * 1.16',
    meta: 'float',
    control: {
      kind: 'expression',
      left: 'total',
      operator: '*',
      right: '1.16',
      operators: ['+', '-', '*', '/', '//', '%', '**'],
    },
  },
  'transform.comprehension': {
    label: 'Duplicar precios',
    code: '[p * 2 for p in prices]',
    meta: '24 elementos',
    metrics: { ops: 4 },
    control: {
      kind: 'expression',
      left: 'p',
      operator: '*',
      right: '2',
      operators: ['+', '-', '*', '/'],
    },
  },
  'transform.lambda': {
    label: 'is_big',
    code: 'lambda r: r > 1000',
    meta: 'sin ejecutar',
    control: {
      kind: 'expression',
      left: 'r',
      operator: '>',
      right: '1000',
      operators: ['>', '>=', '<', '<=', '==', '!='],
    },
  },

  'control.condition': {
    label: '¿Venta grande?',
    code: 'sales[sales.amount > THRESHOLD]',
    meta: 'sales.py:31',
    control: {
      kind: 'condition',
      field: 'amount',
      operator: '>',
      value: 'THRESHOLD',
      operators: ['>', '>=', '<', '<=', '==', '!=', 'in'],
      hits: [91, 337],
    },
  },
  'control.loop': {
    label: 'Cada fila grande',
    code: 'for row in big.itertuples():',
    meta: 'sales.py:48',
    control: {
      kind: 'loop',
      iterable: 'big.itertuples()',
      variable: 'row',
      current: 34,
      total: 91,
    },
  },
  'control.with': {
    label: 'con archivo',
    code: 'with open("ventas.csv") as archivo:',
    meta: 'sales.py:12',
    control: { kind: 'with', context: 'open("ventas.csv")', name: 'archivo' },
  },
  'control.try': {
    label: 'intentar',
    code: 'try:',
    meta: 'sales.py:20',
  },
  'control.entrypoint': {
    label: 'programa principal',
    code: 'if __name__ == "__main__":',
    meta: 'sales.py:30',
  },
  'control.except': {
    label: 'si falla: ValueError',
    code: 'except ValueError as error:',
    meta: 'sales.py:24',
    control: { kind: 'handler', type: 'ValueError', name: 'error' },
  },
  'control.clause': {
    label: 'al final',
    code: 'finally:',
    meta: 'sales.py:28',
  },
  'control.match': {
    label: 'según orden',
    code: 'match orden:',
    meta: 'sales.py:40',
    control: { kind: 'match', subject: 'orden' },
  },
  'control.case': {
    label: 'caso "sí" | "s"',
    code: 'case "sí" | "s" if listo:',
    meta: 'sales.py:41',
    control: { kind: 'case', pattern: '"sí" | "s"', guard: 'listo' },
  },
  'control.raise': {
    label: 'Importe inválido',
    code: 'raise ValueError("importe negativo")',
    meta: 'sales.py:58',
    control: {
      kind: 'signal',
      errorType: 'ValueError',
      types: ['ValueError', 'TypeError', 'KeyError', 'RuntimeError'],
      message: 'importe negativo',
    },
  },
  'control.break': {
    label: 'salir',
    code: 'break',
    meta: 'sort.py:31',
  },
  'control.continue': {
    label: 'siguiente',
    code: 'continue',
    meta: 'sort.py:24',
  },
  'control.return': {
    label: 'Devolver total',
    code: 'return total',
    meta: 'float · sales.py:62',
    control: {
      kind: 'expression',
      left: 'total',
      operator: '+',
      right: 'tax',
      operators: ['+', '-', '*', '/'],
    },
  },

  'effect.io': {
    label: 'Leer sales.csv',
    code: 'open("data/sales.csv")',
    meta: 'disco · 2,1 MB',
    control: {
      kind: 'io',
      target: 'data/sales.csv',
      mode: 'lectura',
      modes: ['lectura', 'escritura', 'añadir'],
    },
  },
  'output.display': {
    label: 'Ventas por región',
    code: 'display(summary)',
    meta: 'actualizado hace 2 s',
    control: {
      kind: 'stats',
      metric: 'Importe total',
      value: '128 400 €',
      deltaPct: 12.5,
      range: '12d',
      ranges: ['7d', '12d', '30d'],
      series: [12, 18, 14, 22, 19, 27, 24, 31, 28, 35, 33, 41],
      rows: [
        { label: 'Ventas grandes', value: '91' },
        { label: 'Ticket medio', value: '1 411 €' },
      ],
    },
  },

  'external.import': {
    label: 'pandas',
    code: 'import pandas as pd',
    meta: 'externo · 2.2.3',
    control: { kind: 'module', module: 'pandas', alias: 'pd' },
  },
  'abstraction.class': {
    label: 'Perro',
    code: 'class Perro(Animal):',
    meta: 'animales.py:8',
    control: { kind: 'class', bases: 'Animal', params: ['nombre', 'edad'] },
  },
  'abstraction.collapsed': {
    label: 'load_sales',
    code: 'def load_sales(path, sep=","): …',
    meta: '12 operaciones dentro',
    metrics: { ops: 12 },
    control: {
      kind: 'signature',
      params: [
        { name: 'path', value: '"data/sales.csv"' },
        { name: 'sep', value: '","' },
      ],
    },
  },
  'smart.ui': {
    label: 'Constructor de consulta',
    code: 'df.query("amount > 1000 and region == \'Norte\'")',
    meta: 'UI en caché · a3f9c1',
    control: {
      kind: 'query',
      field: 'amount',
      operator: '>',
      value: '1000',
      operators: ['>', '>=', '<', '<=', '=='],
      hash: 'a3f9c1',
    },
  },
  'opaque.code': {
    label: 'assert',
    code: 'assert total > 0, "…"',
    meta: 'no soportado · sales.py:71',
    control: {
      kind: 'code',
      source: 'assert total > 0, "el total no puede ser negativo"',
    },
  },

  'space.for': { label: 'PARA cada fila de big' },
  'space.if': { label: 'SI importe > 1000' },
  'space.try': { label: 'INTENTAR load_sales' },
  'space.section': { label: 'Probar: cada pájaro vuela' },
}

export interface Group {
  title: string
  blurb: string
  kinds: NodeKindId[]
}

export const GROUPS: Group[] = [
  {
    title: 'Valores',
    blurb:
      'Datos puros: hojas del grafo. No tienen puerto de entrada porque no dependen de nada, y se editan directamente — un deslizador, un interruptor, un campo.',
    kinds: ['value.str', 'value.number', 'value.bool', 'value.none'],
  },
  {
    title: 'Colecciones',
    blurb:
      'Datos con estructura. Su tamaño crece con la cantidad de elementos, y el cuerpo de la tarjeta muestra el dato de verdad, no una descripción del dato.',
    kinds: ['data.list', 'data.dict', 'data.dataframe'],
  },
  {
    title: 'Transformaciones',
    blurb:
      'El dato entra y sale distinto. Todas llevan punta de flecha: la silueta apunta hacia donde fluye el dato.',
    kinds: ['transform.call', 'transform.operation', 'transform.comprehension', 'transform.lambda'],
  },
  {
    title: 'Control de flujo',
    blurb:
      'El camino se decide, se repite o se corta. Las salidas están donde dice la lógica: la condición tiene dos, el retorno y la excepción no tienen ninguna.',
    kinds: [
      'control.condition',
      'control.loop',
      'control.with',
      'control.try',
      'control.entrypoint',
      'control.except',
      'control.clause',
      'control.match',
      'control.case',
      'control.break',
      'control.continue',
      'control.raise',
      'control.return',
    ],
  },
  {
    title: 'Efectos y salida',
    blurb: 'Lo que toca el mundo exterior, y lo que está hecho para mirarse.',
    kinds: ['effect.io', 'output.display'],
  },
  {
    title: 'Fronteras',
    blurb:
      'Lo ajeno, lo encapsulado y lo que aún no se entiende. Aquí viven la transparencia y el desenfoque.',
    kinds: [
      'external.import',
      'abstraction.collapsed',
      'abstraction.class',
      'smart.ui',
      'opaque.code',
    ],
  },
  {
    title: 'Espacios',
    blurb:
      'Territorios que contienen nodos: trazo discontinuo y sin relleno, para que se vea el lienzo a través. La geometría es la lógica.',
    kinds: ['space.for', 'space.if', 'space.try', 'space.section'],
  },
]

/** Los canales visuales: cada uno dice una sola cosa. */
export const CHANNELS: { name: string; says: string; rule: string }[] = [
  {
    name: 'Insignia',
    says: 'Qué es el nodo',
    rule: 'icono + color de familia. Es lo primero que se lee, y el icono funciona sin color',
  },
  {
    name: 'Silueta',
    says: 'Su papel en el flujo',
    rule: 'punta de flecha = transforma · borde plano = extremo sin puerto · esquina cortada = el flujo se detiene · pestaña = hay algo encapsulado · muescas = pares clave-valor · capas = muchos elementos',
  },
  {
    name: 'Trazo',
    says: 'Qué clase de objeto es',
    rule: 'sólido = entidad · discontinuo = contenedor · punteado = externo o aún sin ejecutar · doble = toca el mundo exterior',
  },
  {
    name: 'Relleno',
    says: 'Cuánto se sabe de él',
    rule: 'opaco = conocido · vidrio = complejidad encapsulada · translúcido = diferido o ajeno · rayado = su interfaz se está generando · vacío = territorio',
  },
  {
    name: 'Cuerpo',
    says: 'Cómo se manipula',
    rule: 'el editor gráfico propio del tipo; al cambiarlo se reescribe el Python que hay debajo',
  },
  {
    name: 'Chip',
    says: 'En qué punto de su vida está',
    rule: 'cada estado tiene icono además de color, para funcionar en escala de grises',
  },
  {
    name: 'Tamaño',
    says: 'Cuánta complejidad esconde',
    rule: 'crece de forma logarítmica con las operaciones o los elementos, y se satura',
  },
  {
    name: 'Elevación',
    says: 'Atención',
    rule: 'solo las ventanas de resultado y el nodo que el usuario está mirando',
  },
]
