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
- La arista de la función a su propio cuerpo (una llamada recursiva) no se dibuja: el espacio ya dice que pertenece. Las que salen de un **parámetro** sí: cada parámetro es un puerto en el borde del territorio, y de él parte el cable hasta el campo de dentro que lo usa (ver «Conectar»). Una función con parámetros reserva a su izquierda una zona para ellos (`GraphNode.gutter`).
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

## Comentarios: lo que el código dice de sí mismo

Ningún comentario se pierde en silencio. Cada uno va donde explica:

- **En una función**, su explicación va **en el nodo de la función**: el docstring, un comentario justo encima del `def`, en la línea de la firma o entre la firma y la primera sentencia. Si hay más de uno, se unen (primero los comentarios, luego el docstring). El docstring no es una sentencia del cuerpo: no genera un nodo propio. Se lee bajo la cabecera del territorio, en la lista del menú «Funciones» y bajo la ruta cuando se está dentro de la función (donde la definición ya no se dibuja).
- **En cualquier otra sentencia**: un comentario en su misma línea es suyo; uno solo en su línea explica la sentencia que viene detrás (también el primero de una rama, dentro del `if`); y uno al final de un bloque cierra la última sentencia. El docstring del archivo explica lo que viene detrás.
- **No son prosa** y se omiten: el shebang y la declaración de codificación.

En el nodo, la nota va bajo el título, en cursiva y tenue, recortada a dos líneas en normal y cuatro en expandido (el texto entero está en el tooltip y en el archivo). Ocupa sitio propio: el alto del nodo la incluye (`noteHeight`), calculado con el ajuste de línea real por palabras, no contando caracteres. En un territorio, la cabecera crece lo que pida la documentación (`headroom`). En compacto no cabe (es una píldora): va en el tooltip.

Un detalle del árbol de tree-sitter que condiciona el análisis: los comentarios entre la firma y el cuerpo de un `def` (o de un `if`, `for`, `while`) **cuelgan de la propia sentencia**, no del bloque. Por eso se recogen de los dos sitios, y por fila se distingue el de la cabecera (de la sentencia) del que precede a lo primero de dentro.

## Escribir de vuelta: el lienzo edita el Python

Cambiar un campo en el lienzo reescribe ese trozo del archivo y nada más.

1. **El analizador anota de dónde sale cada campo** (`ProgramNode.sources`: rango en el texto y cómo se vuelve a escribir). Son desplazamientos de cadena (UTF-16), los mismos que usa el editor: un `ñ` antes del campo no los descuadra (probado). Solo lleva rango lo que se puede reescribir sin descolocar nada.
2. **`editsFor(nodo, editor)`** (pura, sin tree-sitter) compara el editor tal como se analizó con el que dejó el usuario y devuelve las ediciones mínimas. Un flotante sigue siendo flotante (`5.0` → `7.0`); una comilla dentro de una cadena se escapa; un salto de línea en una cadena de una línea se escribe `\n`; una cadena cruda o de bytes no se ofrece (cambiaría lo que significa); una expresión vacía o de varias líneas no se escribe.
3. **Los editores confirman al salir del campo o con Intro** (Esc descarta), no por tecla: a medio escribir casi ningún trozo de Python es válido, y reescribir a cada pulsación haría cambiar de forma al nodo bajo los dedos. Un desplegable o un interruptor confirman al instante.
4. **La extensión valida y aplica** un `WorkspaceEdit`. El mensaje `edit` se valida en cada extremo y lleva la **versión del documento** sobre la que se calculó: si el texto cambió desde entonces (se tecleó en el editor mientras tanto), los desplazamientos ya no valen y se descarta, reenviando el estado para que el lienzo vuelva a mostrar lo que hay.
5. **Una sola edición en vuelo.** Si se confirman dos campos seguidos antes de que llegue el texto reanalizado, la segunda espera y se recalcula contra el programa nuevo (sus desplazamientos se han movido). Mientras tanto el campo enseña lo que se escribió; si el anfitrión no contesta en 3 s, se da por perdida.

**Qué se puede editar en un campo**: número, cadena, booleano, mensaje de un `print`, los dos operandos y el operador de una operación (y el operador y el lado derecho de `+=`), campo·operador·valor de una condición, el valor de cada argumento de una llamada, la secuencia de un bucle, la firma de una función (añadir, quitar y renombrar parámetros, dar o quitar un valor por defecto), los elementos de una lista, las entradas de un diccionario, el módulo de un `import` y el mensaje de un `raise`. Un campo que no se sabe reescribir se congela entero (`<fieldset disabled>`): un campo que acepta texto y no cambia el programa engaña. Un campo que recibe una conexión también es de solo lectura: su valor viene de otro nodo. Los campos de expresión ofrecen como sugerencias las variables que hay en el ámbito del nodo.

Los ids de los nodos pasan a ser por **línea y columna** (`def:9:0`), no por desplazamiento: editar dentro de una línea no mueve ninguna sentencia de sitio, así que el diagrama no se re-anima entero con cada cambio.

### Escribir todo el Python desde el diagrama

Los campos no bastan: para _escribir_ un programa hay que poder crear, quitar y renombrar cosas. Esas operaciones son `NodeAction` (`code`, `delete`, `duplicate`, `rename`, `add`) y se traducen a ediciones en `@prysel/python/edits` (`actionEdits`), con las mismas garantías que los campos.

- **Añadir** (menú «Añadir»): una plantilla (`TEMPLATES`: variable, texto, lista, diccionario, operación, llamada, `input`, `print`, `if`, `if/else`, `for`, `while`, `return`, `raise`, `import`, `def`). Va tras el nodo seleccionado, al final de la función que se está viendo o al final del archivo, con la sangría y el salto de línea del archivo (CRLF incluido). Lo creado queda seleccionado: la cola espera a que el programa reanalizado lo contenga y lo localiza por su línea (`onCreated`).
- **Eliminar** quita la sentencia entera con sus comentarios contiguos. Si era lo único de un bloque, deja un `pass`: un bloque vacío no es Python válido.
- **Duplicar** copia la sentencia justo debajo, con su sangría.
- **Renombrar** (doble clic en el título) cambia la definición y **todos sus usos** en el ámbito: no toca atributos (`x.nombre`), claves de argumentos con nombre (`f(nombre=…)`) ni variables de comprensión que ocultan a la de fuera. Un nombre que no es un identificador válido (o que es una palabra reservada) se rechaza.
- **Ver / escribir el código** (panel «Código»): cualquier nodo se puede reescribir como texto Python. Es la red de seguridad de la edición 100 % desde el diagrama: lo que aún no tenga un editor propio (un `with`, un `try`, una clase) se puede escribir aquí. Lo que no analiza como Python se rechaza antes de tocar el archivo (`replaceCode`).

Todas las operaciones de estructura pasan por la misma cola que los campos: **una sola en vuelo**, y las que esperan se calculan _cuando les toca_ (guardadas como función del programa, no como ediciones ya calculadas), porque sus desplazamientos habrían caducado. Deshacer es el del editor: cada operación es un único `WorkspaceEdit`.

### Conectar: los cables se escriben arrastrando

Un cable **es** una variable: arrastrar de una salida a un campo escribe en ese campo el nombre que la salida define. No hay que teclear el nombre a mano.

- **Qué sale.** Cada nodo que deja algo definido (`total = 0`, una función, la variable de un bucle, un `import`) ofrece un puerto de salida (`ProgramNode.provides`). Una función ofrece además **un puerto por parámetro**, en el borde de su territorio (`params`), con los cables ya trazados hacia lo que hay dentro: la función se cablea como un grupo con entradas.
- **Qué entra.** Cada campo que acepta un valor (un operando, un argumento, la secuencia de un bucle, el mensaje de un `print`) tiene su puerto, a su altura (`ProgramNode.inputs`: el puerto y qué trozo del texto se sustituye). Un puerto libre es un **aro**; con cable, está relleno; el de un parámetro es **cuadrado**. Los dos operandos de una operación van en filas distintas: dos puertos a la misma altura se taparían y no se podría elegir.
- **Clases de valor.** El color del puerto dice qué transporta: número (cian), texto (esmeralda), verdadero/falso (ámbar), colección (púrpura), cualquiera (gris). Son tokens del design system (`socket-*`), y el color no es la única señal (aro / relleno / cuadrado).
- **Qué se rechaza.** `checkConnection` (pura, en `connect.ts`) mira antes de escribir: el nombre tiene que estar **al alcance del destino** (`ProgramNode.scope`: lo definido antes, en su ámbito; así un parámetro no sale de su función ni se usa algo que se define después) y la clase tiene que encajar (`slotAccepts`: a una resta no se le conecta un texto). Es deliberadamente conservador: solo se rechaza lo que Python no admitiría nunca; `+`, `*` y `%` valen con textos, y lo que no se sabe (`any`) se acepta. El rechazo se explica en un aviso, no es un fallo mudo.
- **Mientras se arrastra**, solo se encienden los puertos donde valdría soltar, con la etiqueta de su campo; el resto se apaga. Soltar sobre un nodo, y no sobre un puerto, conecta si solo hay un campo posible.
- **Soltar en el vacío** abre un menú de crear un nodo **ya conectado** (`QuickAdd`), con lo que más sentido tiene para esa clase de valor (a un número: operación, `print`, decisión; a una colección: un bucle que la recorra). Sale detrás del nodo de origen, o **dentro** de la función o el bucle si sale de un parámetro o de la variable del bucle.
- **Soltar un cable**: clic en él (su zona de clic es más ancha que el trazo) y × o Supr; el campo vuelve a un valor neutro (`0`, `None`, `[]`). Supr sobre un nodo seleccionado lo elimina (no sobre un territorio: eso pide el botón). Mayús+F devuelve a la gramática la colocación de todo.
- **Añadir** desde el menú con una función o un bucle seleccionados lo pone **dentro**; si el cuerpo era solo `pass`, lo sustituye. Una función nueva nace con dos parámetros y `return a + b`, para que se vean sus puertos y sus cables.

Todo son `NodeAction` (`connect`, `disconnect`, `add` con `connect`), que pasan por la misma cola y las mismas garantías que el resto.

### Por qué a veces desaparecían las conexiones

Un fallo de esta fase que merece quedar escrito: al mover o expandir un nodo, sus cables se borraban. React Flow, al recibir un nodo nuevo sin `measured` (lo que pasa cuando el estado es controlado y se reconstruye el objeto), **descarta las medidas de sus puertos** (`handleBounds`), y sin ellas no hay dónde anclar el cable. La solución son dos cosas: pasar siempre el tamaño conocido como `measured` (`nodeFrame`), y avisar a React Flow (`updateNodeInternals`) cuando cambia la disposición de los puertos (tamaño, densidad, eje, contenedor, qué puertos están conectados y a qué altura).

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
- **Una función**: un lienzo limpio con su contenido, envuelto por el territorio de la propia función (es donde están sus parámetros: ver «Conectar»). Se llega desde el menú **Funciones** (lista con firma, número de llamadas y tamaño) o desde el chevron de una llamada; una ruta «Programa › suma(a, b)» lleva de vuelta.

Cada vista es «otro diagrama»: al cambiar, el lienzo olvida lo movido, lo seleccionado y lo recorrido (`fitKey`) y se reencuadra. Compacto sigue plegando las funciones sin usar que se dibujan. La lógica es común a la extensión y la galería (`useProgramView`).

## Compacto: la vista de pájaro

**Compacto pliega todas las funciones**: cada `def` pasa a ser un nodo con lo que recibe y lo que devuelve, sin su lógica interna, para que la arquitectura quepa en una mirada. Normal y expandido las abren como territorios. Se puede dar la vuelta a cualquier función con su chevron; cambiar de densidad vuelve a lo de serie. Al replegar, las conexiones que apuntaban a un campo interno entran por el borde de la función (un puerto pertenece al nodo plegado, no al grupo).

## Lo que falta

- Micro-interfaces semánticas: sustituir la línea de código literal de cada nodo (`print`, `input`…) por controles reales — un desplegable para un operador lógico, un campo de formulario para un literal.
- Orden secuencial entre sentencias como conexiones de control (ver arriba).
- **Puertos de ejecución** (la flecha ▸ de entrada y salida que ordena las sentencias): hoy el orden es el del archivo y no se dibuja ni se cablea; conectarlos reordenaría el código y es la decisión abierta del orden secuencial.
- **Conectar un cable existente a otro campo** (arrastrar el extremo de un cable ya tendido) y **cables desde un puerto de entrada** hacia una salida nueva: hoy se conecta desde salidas.
- **Un nodo sin nombre como origen** (`print(x)` no define nada; `float(input())` sin asignar): para usarlos habría que introducir una variable.
- **Insertar un conversor** (`float()`) al rechazar una clase: hoy solo se rechaza y se explica.
- **Bucles como territorio**: un `for` con cuerpo se pinta como nodo con su retorno, no como marco que expone su variable de iteración como puerto (la variable sí sale por su puerto normal).
- **Auto-layout jerárquico** (Dagre/ELK): el reparto lo hace la gramática espacial; Mayús+F solo le devuelve lo que el usuario movió.
- **Reordenar y mover sentencias** (arrastrar un nodo a otro sitio del flujo de control, o a otro bloque): hoy se duplica y se elimina, pero no se mueve.
- **Editar un elemento de una lista en su sitio**: se añade, se quita y se reescribe como cadena de chips; un elemento suelto no se edita.
- **`with`, `try`, `class` y decoradores como nodos con estructura**: hoy son nodos opacos (se editan como texto en el panel «Código»).
- **Deshacer propio**: se apoya en el del editor (una operación = un deshacer); el lienzo no tiene historial propio.
- **Comentarios**: los que cuelgan entre las ramas de un `if`/`elif`/`else` se recogen solo si tree-sitter los cuelga de la sentencia; los de otras construcciones (`with`, `try`) no se tratan porque esas construcciones aún son nodos opacos.
- Enrutado: separar en carriles las conexiones que comparten pasillo, y esquivar también a los retornos de bucle.
- `timeline` y `hub-and-spoke` como topologías propias (hoy caen en `pipeline` y `fan-out`).
- Orientación vertical a fondo: el eje ya es un parámetro, pero las estrategias están afinadas para horizontal.
- Análisis incremental: hoy se reanaliza el archivo entero en cada cambio (bastan décimas de milisegundo, pero tree-sitter puede hacerlo incremental).
