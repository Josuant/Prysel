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

Una conexión no es una línea que une dos cajas: es una relación computacional. Y viaja por uno de **dos canales**, que son dos lenguajes visuales distintos — mezclarlos es lo que vuelve ilegible un algoritmo denso.

| Canal       | Qué dice                                                           | Cómo se ve                                                |
| ----------- | ------------------------------------------------------------------ | --------------------------------------------------------- |
| **control** | El orden de ejecución: qué sigue, por qué camino, cuándo se repite | **Continua y gruesa** (3 px): la columna vertebral        |
| **datos**   | El paso de un valor: qué variable alimenta qué operación           | **Fina y punteada** (2 px): una dependencia, no un camino |

La diferencia es de trazo, no de color, así que se lee igual en escala de grises y a cualquier zoom. El color queda libre para el estado. Dentro de cada canal, la relación afina el trazo y la curvatura:

| Relación     | Canal   | Significado                                                 | Cómo se ve                                         |
| ------------ | ------- | ----------------------------------------------------------- | -------------------------------------------------- |
| `dependency` | datos   | B usa el valor que produce A                                | Punteada                                           |
| `transform`  | datos   | El dato entra y sale distinto (el flujo de datos principal) | Punteada, un punto más oscura                      |
| `reference`  | datos   | Se alude a algo sin que fluya un dato (un `import`)         | Punteada más espaciada y tenue                     |
| `merge`      | datos   | Varias fuentes en un mismo destino                          | Convergen antes de entrar                          |
| `branch`     | control | Una salida de una decisión                                  | Continua y gruesa, con su etiqueta encima          |
| `feedback`   | control | El control vuelve atrás                                     | Continua y gruesa, por debajo: va contra el tiempo |

El canal se deduce de la relación (`CHANNEL_OF`) salvo que la arista lo declare: la entrada al cuerpo de un bucle se traza como una `transform` pero es **control**, y el analizador lo marca así.

Aún no se dibuja el orden secuencial entre sentencias consecutivas (el `a` que precede al `b` sin que fluya ningún valor). Hoy el canal de control cubre ramas y bucles; añadir el orden lineal cambiaría el layout de todo programa, así que es una decisión aparte.

## Ámbitos: el territorio de una función

La pertenencia es una relación espacial antes que una línea. Un `def` no es un nodo más con su `return` flotando al lado: es un **territorio** que envuelve físicamente su cuerpo, igual que la indentación agrupa el cuerpo de una función en el texto.

El layout lo resuelve **de dentro hacia fuera**. Cada ámbito coloca primero su contenido en su propio plano, y toma el tamaño que ese contenido necesita (`SCOPE_FRAME`: cabecera arriba, margen a los lados). Después el programa de fuera trata a cada ámbito como un solo bloque del tamaño justo. Por eso lo de dentro nunca se sale ni se mezcla con lo de fuera, y los ámbitos se anidan a cualquier profundidad.

- Es un ámbito todo nodo de rol `abstraction` que tiene nodos dentro **en el plano**. Una función colapsada no lo es: sus miembros ya no están, y se dibuja como un nodo más.
- Lo que un ámbito abarca incluye lo transitivo: el cuerpo de un bucle dentro de la función sigue dentro de la función.
- Las conexiones que cruzan el borde se recogen en él para ordenar el plano de fuera, pero siguen apuntando al nodo real de dentro: el dato entra en el territorio.
- La arista de la función a su propio cuerpo (los parámetros) no se dibuja: la firma `(a, b)` va en la cabecera y el espacio ya dice que pertenece.
- Todo lo que nace dentro del `def` es suyo, a cualquier profundidad: el analizador declara el cuerpo entero (no solo el primer nivel), y el layout asigna cada nodo a su **ámbito más interno**, sin depender del orden en que se declaren.
- Se dibuja translúcido, con la pestaña de carpeta del tipo función a cualquier densidad, para que lo de dentro se lea sobre él.

## Enrutado: ángulos de 90° que esquivan lo que hay en medio

Una curva directa atraviesa lo que quede entre dos nodos —otros nodos, el territorio de una función— y en un programa denso eso es el espagueti visual. Una conexión de flujo se traza ahora con `routeOrthogonal`: un A\* sobre una rejilla dispersa formada solo por los bordes de los obstáculos (más un margen), con **penalización por giro**, así que entre dos caminos gana el que menos tuerce. El coste depende de cuántos nodos hay cerca, no del tamaño del lienzo, y tiene tope: con demasiados obstáculos alrededor, o sin camino posible, se deja la curva simple en vez de inventar un rodeo.

- Son obstáculos todos los nodos y territorios, **salvo** el origen, el destino y los territorios que los envuelven: una conexión entra en la función por su borde, pero no la atraviesa de largo.
- Las conexiones que van contra el flujo (el retorno de un bucle, el salto de fila) conservan su trazado propio: ahí el recorrido ya _es_ el significado.
- La etiqueta (`verdadero`, `falso`) va en el punto medio del recorrido real, no en el de la línea recta.
- No se han creado nodos «proxy» para duplicar una variable cerca de donde se usa: es la alternativa si el enrutado no basta en programas muy densos, y queda como opción.

## Nodos que enseñan significado, no sintaxis

Un nodo no muestra Python: muestra lo que significa. El analizador (`semantics.ts`) decide qué editor le toca a cada construcción y lo entrega como un `ControlModel`:

| Python               | El nodo enseña                                                                   |
| -------------------- | -------------------------------------------------------------------------------- |
| `print("hola")`      | «Imprimir» con un área de texto: `hola`, sin la palabra `print` ni las comillas  |
| `numeroA = 5`        | un campo numérico con `5`                                                        |
| `numero2 < 0`        | campo · operador · valor                                                         |
| `return a + b`       | operando · operador · operando                                                   |
| `suma(x, y)`         | `suma( )` y un campo por argumento, con el **nombre de su parámetro** (`a`, `b`) |
| `for n in range(10)` | variable y secuencia                                                             |

La regla de honestidad manda: **solo se produce un editor cuando dice toda la sentencia**. Un `*args`, una cadena de comparaciones o una cadena de métodos se quedan como código, porque un editor que oculta información es peor que ninguno. Con editor, el código no se repite en el nodo: está en el archivo, en la línea que indica el pie.

## Puertos con nombre

Éste era el problema concreto: cuando dos conexiones llegan al mismo nodo, no se sabe cuál alimenta qué.

La solución es que **los puertos no se declaran, se miden**. Cada editor marca sus campos conectables (`data-slot`), el nodo los mide tras el layout y dibuja un puerto a la altura exacta de cada uno. Una arista con `toPort` aterriza ahí, y **cada puerto conectado lleva su etiqueta** sobre el cable (`a`, `b`, `Campo`, `Mensaje`): con dos cables a un mismo nodo se ve cuál alimenta qué. Un argumento que recibe una conexión nunca se esconde, aunque el nodo esté resumido. Las salidas no llevan etiqueta propia: llevan el nombre del nodo, y las de una decisión ya dicen `verdadero` / `falso` en su conexión.

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

## El alto lo decide el contenido

El tamaño base de cada densidad da sitio a un editor de una fila. Un editor con varios campos (una llamada con `a` y `b`, una condición, un mensaje largo) no cabe, y un nodo que no crece **recorta** el campo y deja su puerto fuera de la tarjeta: el cable llega a ninguna parte. Por eso `controlHeight` / `extraHeight` estiman el alto que necesita cada editor y el layout lo sabe _antes_ de pintar. Las medidas (campo con etiqueta 49 px, línea de destino 18 px, 6 px entre filas, lo que ya cabe en la tarjeta base) salen del DOM real, no de la intuición, y se comprobaron midiendo `scrollHeight − clientHeight` y la posición de cada puerto en normal y expandido. Un mensaje largo crece con sus líneas hasta un tope; pasado el tope, se desplaza dentro de su campo.

## Selección y movimiento

- **Seleccionar un nodo resalta sus conexiones** (violeta, opacas) y retira las demás. Si es un territorio, se iluminan también las de todo lo que envuelve. Un dato sigue siendo fino y punteado: destaca por color y opacidad, no por peso, para no confundirse con el control.
- **Arrastrar un territorio arrastra su interior**, el mismo desplazamiento a todo lo que envuelve (`dragTerritory`, pura y testeada). Arrastrar un nodo lo selecciona: React Flow mueve a la vez todo lo seleccionado, y otro nodo ya elegido se sumaba al desplazamiento. Mientras se arrastra no se interpola: el nodo sigue al puntero.
- Un territorio seleccionado **no sube por encima de sus hijos** (`elevateNodesOnSelect` desactivado): su área cubre todo el interior y se tragaría sus clics.

## El programa y sus funciones

Enseñar la definición de una función _y_ la llamada que la usa, en el mismo plano, es decir dos veces lo mismo. El programa se ve ahora de dos maneras:

- **Programa**: el flujo del archivo. Una función **usada** (algo de fuera de su cuerpo depende de ella) no se dibuja: ya está en la llamada, cuyo chevron lleva a ella. Una función **sin usar** sí se dibuja, porque si no, no se vería en ningún sitio (típicamente el punto de entrada, `_main`).
- **Una función**: un lienzo limpio con solo su contenido, sin ella misma alrededor. Se llega desde el menú **Funciones** (lista con firma, número de llamadas y tamaño) o desde el chevron de una llamada; una ruta «Programa › suma(a, b)» lleva de vuelta.

Cada vista es «otro diagrama»: al cambiar, el lienzo olvida lo movido, lo seleccionado y lo recorrido (`fitKey`) y se reencuadra. Compacto sigue plegando las funciones sin usar que se dibujan. La lógica es común a la extensión y la galería (`useProgramView`).

## Compacto: la vista de pájaro

**Compacto pliega todas las funciones**: cada `def` pasa a ser un nodo con lo que recibe y lo que devuelve, sin su lógica interna, para que la arquitectura quepa en una mirada. Normal y expandido las abren como territorios. Se puede dar la vuelta a cualquier función con su chevron; cambiar de densidad vuelve a lo de serie. Al replegar, las conexiones que apuntaban a un campo interno entran por el borde de la función (un puerto pertenece al nodo plegado, no al grupo).

## Lo que falta

- Micro-interfaces semánticas: sustituir la línea de código literal de cada nodo (`print`, `input`…) por controles reales — un desplegable para un operador lógico, un campo de formulario para un literal.
- Orden secuencial entre sentencias como conexiones de control (ver arriba).
- **Escritura de vuelta al código**: los editores se ven pero son de solo lectura; editar un campo no reescribe el Python. Necesita el rango de origen de cada sub-expresión y un `WorkspaceEdit` en la extensión.
- Enrutado: separar en carriles las conexiones que comparten pasillo, y esquivar también a los retornos de bucle.
- `timeline` y `hub-and-spoke` como topologías propias (hoy caen en `pipeline` y `fan-out`).
- Orientación vertical a fondo: el eje ya es un parámetro, pero las estrategias están afinadas para horizontal.
- Análisis incremental: hoy se reanaliza el archivo entero en cada cambio (bastan décimas de milisegundo, pero tree-sitter puede hacerlo incremental).
