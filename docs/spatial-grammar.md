# Gramática espacial

La quinta gramática de Prysel, junto a las de nodo, flujo, ejecución e interacción.

> **Prysel usa el espacio como un lenguaje semántico.**
> La posición, la topología, la orientación, la profundidad y el movimiento no son decoración
> ni el resultado de un `autoLayout()` genérico: son la forma visual de la topología computacional.

Vive en `packages/spatial`, no sabe nada de React y está cubierta por 27 tests propios.

## El recorrido

```
AST de Python
   ↓
Grafo semántico        nodos con rol y tamaño · relaciones tipadas
   ↓
Clasificación espacial ¿qué forma tiene este trozo de programa?
   ↓
Estrategia de layout   cada forma se dibuja con la suya
   ↓
Grafo visual           posiciones, trazados, puertos
```

El paso que suele faltar en los editores de nodos es el segundo y el tercero: casi todos van del grafo directamente a un algoritmo de colocación genérico. Aquí, **la clasificación es explícita, deducida del grafo y auditable**: cada región dice qué vio para clasificarse así (`evidence`).

## La tabla

| Topología     | Estrategia   | Por qué                                                                                           |
| ------------- | ------------ | ------------------------------------------------------------------------------------------------- |
| `pipeline`    | `linear`     | Una cadena se lee como una frase: en una línea, sin desvíos que inventen jerarquía.               |
| `branch`      | `tree`       | El programa se parte en dos caminos, así que las ramas se separan de verdad: arriba, abajo.       |
| `loop`        | `orbital`    | El cuerpo describe un arco sobre la cabecera y el retorno lo cierra: el espacio vuelve al inicio. |
| `aggregation` | `convergent` | Las líneas se juntan porque los datos se juntan.                                                  |
| `fan-out`     | `radial`     | Un valor que alimenta a muchos queda en el centro de un abanico: ningún consumidor es especial.   |
| `comparison`  | `parallel`   | Dos caminos equivalentes, alineados, para que solo destaque su diferencia.                        |
| `nesting`     | `nested`     | Lo contenido va dentro, no al lado: la pertenencia es espacial antes que una línea.               |

Los umbrales de detección son explícitos (`THRESHOLDS`): a partir de 3 consumidores una cadena pasa a ser un abanico; a partir de 3 fuentes un paso pasa a ser una convergencia.

## Gramática de conexiones

Una conexión no es una línea que une dos cajas: es una relación computacional, y de ella se derivan grosor, punta y curvatura. El color queda libre para el estado.

| Relación     | Significado                                         | Cómo se ve                                    |
| ------------ | --------------------------------------------------- | --------------------------------------------- |
| `dependency` | B usa el valor que produce A                        | Trazo fino con punta                          |
| `transform`  | El dato entra y sale distinto (el flujo principal)  | Trazo grueso: pesa más en el programa         |
| `branch`     | Una salida de una decisión                          | Trazo fino con su etiqueta encima             |
| `merge`      | Varias fuentes en un mismo destino                  | Convergen antes de entrar                     |
| `feedback`   | El control vuelve atrás                             | Discontinuo y por debajo: va contra el tiempo |
| `reference`  | Se alude a algo sin que fluya un dato (un `import`) | Punteado y tenue                              |

`branch` y `merge` comparten el trazo de una dependencia **a propósito**: lo que las distingue es la topología, no el estilo.

## Puertos con nombre

Éste era el problema concreto: cuando dos conexiones llegan al mismo nodo, no se sabe cuál alimenta qué.

La solución es que **los puertos no se declaran, se miden**. Cada editor marca sus campos conectables (`data-slot`), el nodo los mide tras el layout y dibuja un puerto a la altura exacta de cada uno. Una arista con `toPort` aterriza ahí.

Consecuencias:

- En una condición, la entrada de datos y la del valor comparado caen a alturas distintas — por eso el editor de condición apila sus dos campos en lugar de ponerlos en una fila.
- Un campo alimentado por una conexión se marca (borde grueso, cursiva) y deja de ser editable a mano: su valor viene de otro sitio.
- Los puertos con nombre solo aparecen donde llega algo; el resto de nodos conserva su puerto único.

## Profundidad

La tercera dimensión **no es decoración 3D**: representa el nivel de abstracción.

Entrar en un nodo no abre un panel: baja un nivel, y el nivel anterior se queda detrás desenfocado — exactamente lo que ya significaba el relleno de vidrio en la gramática de nodos. La ruta se lleva en migas de pan.

```
nivel 0   Customer pipeline      cargar → normalizar → guardar
nivel 1   normalize()            limpiar → validar → enriquecer
nivel 2   validate()             ¿nulos? → tipos | error
```

Quedan por explorar las otras dos lecturas de la profundidad que se plantearon: **tiempo** (entrar en el historial de una ejecución iterativa) y **contexto** (el anidamiento léxico de una función). La primera necesita el kernel (Fase 4); la segunda ya está medio cubierta por `nesting`.

## Plegado: el programa se lee como un texto

Una región lineal larga no crece sin fin a lo ancho: cuando la fila llega a su presupuesto de ancho, **salta a la siguiente**, igual que un párrafo. Cada fila se lee de izquierda a derecha, y el salto de fila se cuenta como lo que es —un retorno de carro— y no como un retroceso.

El ancho de fila por defecto cabe en una pantalla. Eso cambia la pregunta de legibilidad: ya no es «¿cabe el programa entero de un vistazo?» sino «¿puedo leerlo al 100 % recorriéndolo?», que es como se lee un documento.

## La prueba de densidad

«¿Se entiende?» es una opinión hasta que se mide. `analyze()` calcula las propiedades que la literatura de dibujo de grafos asocia a la legibilidad, y `generateProgram()` fabrica programas sintéticos con forma de script real. `node packages/spatial/scripts/density.ts` imprime la tabla.

| Pasos | Nodos | Solapes | Cruces/conexión | Filas | Nodo al encajar | Nodo con scroll | ms   |
| ----- | ----- | ------- | --------------- | ----- | --------------- | --------------- | ---- |
| 6     | 15    | 0       | 0,13            | 3     | 183 px          | **258 px**      | 4,6  |
| 12    | 27    | 0       | 0,55            | 5     | 107 px          | **258 px**      | 1,8  |
| 25    | 49    | 0       | 0,67            | 9     | 63 px           | **258 px**      | 4,5  |
| 50    | 92    | 0       | 0,39            | 17    | 37 px           | **258 px**      | 5,7  |
| 100   | 178   | 0       | 0,24            | 32    | 21 px           | **258 px**      | 12,9 |
| 200   | 350   | 0       | 0,16            | 63    | 11 px           | **258 px**      | 53,4 |

«Nodo con scroll» es el ancho que le queda a un nodo encajando solo a lo ancho y recorriendo el resto hacia abajo: se mantiene a tamaño completo a cualquier longitud, porque una fila siempre cabe en una pantalla. Ningún nodo se pisa, ninguna conexión de flujo retrocede dentro de su fila, y colocar 350 nodos tarda 53 ms.

Antes del plegado, un programa de 12 pasos ya dejaba los nodos en 68 px —por debajo de los ~90 px que hacen falta para leer uno— y la proporción del lienzo llegaba a 102:1. Eso salió midiendo, no mirando: con seis nodos el diagrama parecía perfecto.

## Orientación

El eje de lectura es un parámetro, no una suposición. `layout(graph, { axis: 'vertical' })` coloca el mismo grafo como una lista de pasos hacia abajo, y las estrategias siguen funcionando porque razonan en ejes «principal» y «transversal», no en x e y. `AXIS_FOR` declara qué eje le sienta mejor a cada topología.

## Profundidad por abstracción

`collapse(graph, groups)` sustituye un grupo de nodos por uno solo que los encapsula y recablea las conexiones que cruzaban su borde. Un `def` se convierte en un nodo en el que se puede entrar.

De dónde salen los grupos:

- **Del AST** (`groupsFromContainers`): cada función es un grupo con su nombre.
- **De la IA**, más adelante: ante un script largo sin funciones, propondrá dónde está la costura natural.

Por eso una agrupación lleva `source` y `reason` obligatorios, y las rechazadas se devuelven con su motivo: una agrupación propuesta por un modelo tiene que poder auditarse igual que la clasificación espacial, y el usuario tiene que poder rechazarla. La IA nunca se hace pasar por el AST.

La transición entre niveles es un viaje real por el eje Z (`perspective`, `translateZ`): el nivel que dejas atrás retrocede y se desenfoca. No es un efecto decorativo — es el mismo significado que ya tenía el relleno de vidrio en la gramática de nodos.

## Movimiento

La quinta dimensión, y la última en llegar. Cuando el programa cambia —tecleas, colapsas una función, cambias de densidad— el diagrama **no salta**: interpola.

El movimiento es tipado, porque dice qué ha pasado:

| Fase       | Significa                                                         |
| ---------- | ----------------------------------------------------------------- |
| `moving`   | El nodo es el mismo, en otro sitio. Puedes seguirlo con la vista. |
| `entering` | Algo nuevo se escribió. Aparece con una escala mínima.            |
| `leaving`  | Algo se borró o se colapsó. Se queda un instante desvaneciéndose. |
| `settled`  | En su sitio.                                                      |

`useMotion` (en `@prysel/ui`) interpola las posiciones con una salida suave y retiene un instante a los que desaparecen. Respeta `prefers-reduced-motion`: con esa preferencia, las posiciones se fijan sin animar.

Es lo que permite seguir un nodo concreto mientras se teclea, en vez de tener que volver a buscarlo en cada pulsación.

## El lienzo

React Flow aporta lo que un lienzo infinito necesita —recorrer, acercar, seleccionar, arrastrar y virtualizar—, pero **no decide nada**: las posiciones salen de la gramática espacial, el trazado de las conexiones de `routeEdge`, y los puertos de los campos que mide cada nodo.

Dos decisiones que vale la pena registrar:

- **El encuadre lo calcula la gramática, no la vista.** `fitView` obliga a React Flow a redescubrir los límites midiendo el DOM, y eso llega tarde. Como el layout ya sabe cuánto ocupa el programa, el viewport se calcula con esos números: es determinista y no depende de cuándo mida nadie.
- **La gramática propone y el usuario dispone.** Un nodo arrastrado a mano conserva su sitio, y el lienzo deja de reencuadrarse solo en cuanto alguien lo recorre.

El modo de encaje distingue dos cosas: una **ilustración** se enseña entera (`contain`); un **lienzo de trabajo** se ajusta al ancho y se recorre hacia abajo (`width`), que es el modelo de documento que hace legible un programa largo.

## Lo que falta

- Enrutado de aristas que esquive nodos (hoy son curvas directas, salvo los saltos de fila y los retornos).
- `timeline` y `hub-and-spoke` como topologías propias (hoy caen en `pipeline` y `fan-out`).
- Orientación vertical a fondo: el eje ya es un parámetro, pero las estrategias están afinadas para horizontal.
- Análisis incremental: hoy se reanaliza el archivo entero en cada cambio (bastan décimas de milisegundo, pero tree-sitter puede hacerlo incremental).
