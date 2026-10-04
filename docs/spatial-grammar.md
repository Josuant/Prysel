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

- Es un ámbito todo nodo de rol `abstraction` —y todo bucle con cuerpo (`GraphNode.territory`)— que tiene nodos dentro **en el plano**. Una función colapsada no lo es: sus miembros ya no están, y se dibuja como un nodo más.
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
- **Qué se rechaza.** `checkConnection` (pura, en `connect.ts`) mira antes de escribir: el nombre tiene que estar **al alcance del destino** (`ProgramNode.scope`: lo definido antes, en su ámbito; así un parámetro no sale de su función ni se usa algo que se define después) y la clase tiene que encajar (`slotAccepts`: a una resta no se le conecta una lista). **Un texto donde se pide un número no se rechaza, se convierte**: el nodo escribe `float(nombre)` (`Verdict.convert`, `connectNodes`), el destino se ilumina en **ámbar** en vez de verde mientras se arrastra, y un aviso cuenta lo que se escribió. Es deliberadamente conservador: solo se rechaza lo que Python no admitiría nunca; `+`, `*` y `%` valen con textos, y lo que no se sabe (`any`) se acepta. El rechazo se explica en un aviso, no es un fallo mudo.
- **Mientras se arrastra**, solo se encienden los puertos donde valdría soltar, con la etiqueta de su campo; el resto se apaga. Soltar sobre un nodo, y no sobre un puerto, conecta si solo hay un campo posible.
- **Soltar en el vacío** abre un menú de crear un nodo **ya conectado** (`QuickAdd`), con lo que más sentido tiene para esa clase de valor (a un número: operación, `print`, decisión; a una colección: un bucle que la recorra). Sale detrás del nodo de origen, o **dentro** de la función o el bucle si sale de un parámetro o de la variable del bucle.
- **Soltar un cable**: clic en él (su zona de clic es más ancha que el trazo) y × o Supr; el campo vuelve a un valor neutro (`0`, `None`, `[]`). Supr sobre un nodo seleccionado lo elimina (no sobre un territorio: eso pide el botón). Mayús+F devuelve a la gramática la colocación de todo.
- **Añadir** desde el menú con una función o un bucle seleccionados lo pone **dentro**; si el cuerpo era solo `pass`, lo sustituye. Una función nueva nace con dos parámetros y `return a + b`, para que se vean sus puertos y sus cables.

Todo son `NodeAction` (`connect`, `disconnect`, `add` con `connect`), que pasan por la misma cola y las mismas garantías que el resto.

### Chips y cables: los valores son chips, los cables son el orden

La regla es una sola: **un valor es un chip; un cable dice qué va antes que qué**. Nada de dibujar «de dónde viene x» con una línea por cada uso: el nombre de la casilla ya lo dice, y el diagrama se queda limpio. Un cable solo se dibuja donde es estrictamente necesario:

| Es…                                                                                    | Se dibuja como                                            | Se conecta                                                      |
| -------------------------------------------------------------------------------------- | --------------------------------------------------------- | --------------------------------------------------------------- |
| Una **constante** que el contexto prepara (`limite = 20`, `xs = [1, 2]`)               | **Chip** en la cajita de su contexto                      | **Soltándolo** en la casilla: el chip aparece dentro, sin cable |
| La **variable de un bucle** o el **parámetro de una función**                          | **Chip** en la cajita del bucle / de la función           | Igual, sin cable                                                |
| El **resultado** de una operación, llamada, comprensión, importación… (`A = f()`)      | Su **nombre**, en su tarjeta, es una pastilla             | La arrastras a una casilla; sin cable                           |
| Lo que **devuelve** una función, si es una variable                                    | Una pastilla «devuelve» en el borde derecho de la función | Sueltas un chip en ella (o la quitas con ×)                     |
| El **control**: ramas de un `if`, salida de un bucle (`break`), su vuelta (`continue`) | **Cable** (grueso, de control) y el carril «repite»       | Cable                                                           |
| Un valor **sin nombre** que se devuelve (`return a + b`)                               | **Cable** al puerto «devuelve» (no hay nombre que poner)  | Cable                                                           |
| Un dato **dentro** de un nodo                                                          | Su casilla                                                | Se escribe                                                      |

Cuándo un cable de datos **no se dibuja** (`planChips`, pura y probada): cuando el nodo de destino **ya nombra** el valor —en su casilla (`x`, o `x + 1`), o en su texto si no tiene casillas (`[x * 2 for x in xs]`)—. Los cables de control, el retorno sin nombre y los de la densidad **compacta** (donde no hay casillas que enseñen nada) se conservan. El layout **sí** sigue usando esas dependencias para colocar a cada nodo tras aquel del que depende: ocultar el cable no desordena el diagrama (`flowEdges` frente a `hidden`).

**Un chip soltado en el vacío crea algo con él.** Si se lleva un chip lejos de su sitio y se suelta sobre nada (ni una casilla ni una tarjeta), aparece el menú de crear un nodo **que ya lo usa** (`QuickAdd`: a un número una operación o un `print`, a una colección un bucle que la recorra…), justo detrás de donde nace ese valor, o dentro de la función o el bucle si es un parámetro o una variable de bucle (`dropTarget`). Es lo que antes daba soltar un cable en el vacío.

**Los valores sueltos a mitad de flujo también se llevan** a una casilla, como cualquier chip: `x = 5` tras una llamada es una píldora colocada en el plano por el orden, pero se arrastra a una casilla y vuelve a su sitio.

**La procedencia, a demanda.** Al seleccionar un nodo se dibujan sus cables ocultos (de dónde le llegan los valores y a quién los da: `revealed`), y al seleccionar un chip de una cajita se marcan las casillas donde se usa. Así el diagrama en reposo es limpio y la relación exacta está a un clic.

Lo que hace a algo un chip (`dockChips`, pura y probada):

- Es un **valor literal** asignado a un nombre: un escalar (número, texto, verdadero/falso, `None`) o una **lista / diccionario literal** (`numeros = [5, 3, 1]`), que se resume (`[5, 3, 1]`, `{a: 1, …}`, 20 caracteres como máximo) y se edita en un panel bajo el chip (los mismos editores que en un nodo: añadir y quitar elementos o claves). Una colección **calculada** (`sorted(x)`, una comprensión) no es un literal: sigue siendo un nodo.
- **Una operación entre literales también es un valor**: `TAU = 2 * 3.14159`, `limite = 10 - 2`, `saludo = "hola " + "mundo"`. No depende de nadie: es una constante con nombre (`isConstantExpression`, `isLiteralText`), y se dibuja como chip (`limite = 10 - 2`), con su fórmula editable en un panel. Con una variable en un operando (`a + 2`) deja de serlo y vuelve a ser una tarjeta. Cuenta como inicialización: no corta la preparación del contexto ni desplaza el principio de lo que actúa.
- Es una sentencia **del propio bloque** del contexto (su función, su bucle, el programa), no de una rama de un `if`: un valor que solo existe en una rama es flujo condicional, y se queda en su sitio (con forma de píldora, pero con cable).
- Viene **antes de la primera sentencia que actúa**. Los `import` y las funciones definidas no cortan la preparación; una llamada, una operación o un bucle, sí. Un valor asignado a mitad de camino es parte del flujo, y el menú del nodo lo puede **subir a las variables del contexto** («Subir a las variables del contexto», `promoteTarget`): lo mueve antes de la primera sentencia de su bloque, salvo que el nombre ya exista antes (cambiaría lo que ven los usos de en medio) o esté en la rama de un `if` (dejaría de ser condicional).
- Su contexto se dibuja como territorio (si dentro solo hubiera chips no habría cuerpo, y se quedan como nodos).

**La variable de un bucle y el parámetro de una función** vienen de la cabecera de su contexto y podrían ser cables, pero su procedencia es obvia (lo que las envuelve) y son lo que más se usa dentro: un cable por uso llenaba el cuerpo de líneas sin contar nada. Son chips de la cajita del bucle o de la función, diferenciados de las constantes (`IterVar`, `iterChipId`): color y icono propios (el del bucle, el de las funciones) y sin valor, porque no se inicializan, se reciben.

**El nombre que asigna una operación o una llamada** (`A = funcion()`, `suma = a + b`). El nodo sigue ahí (es lo que ejecuta, y tiene su sitio en el flujo), pero su **resultado es un chip**: el nombre de la línea es una pastilla que se arrastra a una casilla como cualquier otra (`resultName`, `grabResult`). Donde cae, la casilla enseña la pastilla y el cable no se dibuja. Vale para todo nodo cuyo título es el nombre que asigna (`resultName`: cálculos, llamadas, comprensiones, importaciones, datos), en su cabecera o en su línea.

Los chips del programa y sus parámetros no tienen cable alguno: si un valor se **reasigna** después (`total = 0` y más tarde `total = total + n`), el primero es el chip de la cajita y lo posterior, una tarjeta con su propio chip: cada uso se resuelve al último que lo define.

**Cómo funciona un chip**

- **Cajita por contexto**: cada función, cada bucle y el programa tienen una cajita en su cabecera (`TRAY`) donde se agrupan sus chips, con un botón **＋ variable** que añade una **al principio** del contexto (`add` con `at: 'start'`: antes de su primera sentencia; en el archivo, tras los `import`; sustituye un `pass`). Una cajita vacía dice «variable» para que se entienda qué es. Crece con sus chips (salta de fila a 460 px) y el territorio se ensancha y se alarga lo que pida (`GraphNode.headerWidth`, `headroom`).
- **Siempre compacto**: `nombre = valor`, con el valor editable en su sitio (un número, un texto, un interruptor). Renombrar (doble clic o su menú) cambia todos sus usos.
- **Se arrastra, no se mueve**: se lleva hasta una casilla y, al soltarlo, vuelve a su cajita. Mientras se arrastra, la casilla bajo el puntero se marca en verde si lo admite (misma validación que un cable: `checkConnection`) o en rojo con su motivo. Al soltarlo se escribe el nombre en el código.
- **Se ve dónde está**: la casilla que lo recibe lo muestra **dentro**, coloreado por su clase de valor y con una × para quitarlo. Al seleccionar un chip se marcan todas las casillas donde se usa: su conexión no se dibuja, así que se señala.
- **Todas las casillas que reciben un valor lo aceptan**: operandos, argumentos, el mensaje de un `print`, los lados de una condición, la secuencia de un bucle, la casilla de una función a la que llamar.

### El orden de ejecución coloca el plano

Con los datos convertidos en chips, lo que ordena el diagrama es **el orden en que se ejecuta**, no quién usa a quién. El analizador emite una relación propia, `sequence` (canal de control): cada sentencia **detrás de la anterior**, dentro de su bloque (`visitBlock`). Reglas:

- **Una definición no se ejecuta donde se escribe** (`def` solo dice qué es la función): el orden pasa de largo.
- **Tras una decisión** el orden sale del **final de cada camino** —y de la propia decisión si no hay `else`, que es el camino en que no se cumple—. Un camino que acaba en `return`, `raise`, `break` o `continue` no sigue con lo siguiente, y tras uno de ellos no hay nada.
- **Un bucle** lleva su cuerpo en cadena, entra a él por su cabecera y sigue tras él con lo que viene después.

El plano se coloca **solo** con ese orden, con el control (ramas, `break`, la vuelta del bucle) y con los datos que aún se dibujan (los de la densidad compacta, o un valor sin nombre): un dato que ya es un chip no coloca nada (`plan.flowEdges`). Lo que no está en el plano —un chip en su cajita, un `return` que se dibuja como salida de la función— no rompe la cadena: se salta y su anterior queda unido a su siguiente (`contractOrder`). El resultado se lee como el archivo: de izquierda a derecha, saltando de fila al llegar al borde, con cada función y cada bucle como un bloque.

**Sin cables de orden a la vista.** En un bloque lineal el orden lo dice la posición, y dibujar una flecha entre cada par de sentencias solo ensuciaría. Los únicos cables que se ven son los de control que sí dicen algo que la posición no dice (las ramas de un `if`, `break`, el carril «repite»). Al seleccionar un nodo se dibuja su orden (lo de antes y lo de después) junto con sus cables de datos ocultos, sin repetir el camino cuando ya lo une un dato.

### Reordenar arrastrando un cable de orden

El orden no se ve en reposo, pero se **edita**: cada nodo tiene **puertos de orden** que aparecen al pasar el ratón, al seleccionarlo o al arrastrar un cable de orden (`.order-port`). Arrastrar un cable de orden hasta un nodo **mueve esa sentencia en el código** (`move`): el nodo sobre el que se suelta pasa a ejecutarse donde dice el puerto del que sale el cable (`checkOrder`, pura y probada). Se puede soltar en cualquier parte del nodo, no solo sobre su puerto de entrada.

| Puerto (de salida)                                                | Dónde queda el nodo soltado                                                                                                                           |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `order-out` (abajo)                                               | **Justo detrás** del nodo, en su bloque (`after`). Sirve para reordenar y para pasar una sentencia a otro bloque, con su sangría.                     |
| `order-yes` / `order-no` (abajo de una decisión, en verde y rojo) | Al **principio del camino verdadero** / **del `else`** (`into` + `branch`). Un camino que era un `pass` lo sustituye, y si no hay `else` se **crea**. |
| `order-body` (borde izquierdo de una función o un bucle)          | Al **principio de lo que actúa** en su cuerpo (`into` + `start`): tras las inicializaciones, para no deshacer sus chips.                              |

**Crear en vez de mover.** Si el cable de orden se suelta **en el vacío**, se ofrece crear ahí una sentencia nueva (`Crear aquí…`: imprimir, llamar, operar, variable, pedir dato, decisiones, bucles, **`break`**, **`continue`**, `return`, `raise`), en el sitio que dice el puerto (`orderPlace`): detrás del nodo, al principio de un camino de la decisión (con su `else` creado si falta) o al principio de lo que actúa en un cuerpo. Así se escribe un `if x: break` o un `else: continue` sin salir del diagrama; los mismos `break` y `continue` están en el menú «Añadir».

Lo que se rechaza, con su motivo en el aviso: detrás de un `return`, `raise`, `break` o `continue` (no se ejecutaría), un nodo respecto a sí mismo, y meter un nodo dentro de lo que él mismo contiene, a cualquier profundidad.

### Llamar a una función: elegirla, y sus casillas aparecen

El nodo de una llamada tiene una casilla para **a quién llama**, con un desplegable con las funciones del programa y las de uso común (`print`, `len`, `range`…), y acepta el **chip de una función** (las funciones del programa se ofrecen como chips `ƒ nombre(a, b)` en la cajita del programa). Al elegir otra, la acción `callee` (`changeCallee`) escribe:

- el nuevo nombre, y la **lista de argumentos ajustada a sus parámetros** (los valores que había se conservan por posición; los que faltan quedan en `None`): cada parámetro tiene su casilla, que acepta chips o cables;
- si la función **devuelve algo** y la llamada estaba suelta (`f(x)`), su resultado se guarda en una variable (`resultado`, `resultado_2`…), que es la salida del nodo.

Una llamada sin argumentos a una función también tiene editor (es donde se elige a quién llamar). `print` e `input` no repiten su nombre en un campo: lo dice el título.

### Tarjetas esbeltas: solo lo relevante

En densidad normal un nodo enseña lo justo, y su alto sale de lo que lleva dentro (`slimHeight`), no de un tamaño de serie:

- **Cabecera**: el icono del tipo (el nombre va en su tooltip), el nombre del nodo y el chevron. Sin pie: la línea del archivo va en el tooltip y el estado solo aparece si pasa algo (`running`, `error`…). En expandido se conserva todo.
- **Una fórmula en una fila**: una operación es `A · operador · B`; una decisión, `campo · operador · valor` (titulada «Si»). Sus puertos, que caerían uno sobre otro, se reparten a lo alto del borde.
- **Los argumentos** llevan su nombre a la izquierda del campo, no encima; `print("Hola")` es una sola fila con el mensaje (crece solo si es largo o de varias líneas).
- **Operaciones y llamadas en una sola línea** (`isLineCard`, `lineWidth`, `lineHeight`): icono · nombre que asigna (el chip) · `=` · lo que hace. `Σ suma = a + b`; `ƒ x = suma(a, b)` (con la función elegible en un desplegable y cada parámetro con su nombre, que van entre paréntesis y aceptan chips); `⊕ Imprimir(x, y)`; `⊕ n = Pedir dato()`. Los argumentos solo se rotulan si tienen nombre propio (no `arg1` ni `valor`). El ancho sale del contenido; el alto es una fila. En expandido y compacto se conserva la tarjeta apilada.
- **Lo que no tiene editor propio se enseña entero como destino y valor** (`assign`): `y = x`, `z = a and b`, `self.nombre = nombre`, `xs[i] = v`, `t = (a, b)`, `r = f(*args)`, `d = df.groupby("k").sum()`. En una línea es `(y) = [x]`: si el destino es un **nombre**, la pastilla que abre la línea ya lo dice (y se renombra en todos sus usos); si no (`self.nombre`, `xs[i]`), lleva su propio campo y se reescribe. El **valor** es un campo con puerto: acepta chips (`self.nombre = ⟨nombre⟩`) y, cuando nombra justo lo que llega, su cable no se dibuja. Solo cuando cada lado cabe en una línea; lo de varias líneas se queda como código.
- **Varios resultados, un chip por nombre** (`ProgramNode.results`): `X_train, X_test, y_train, y_test = train_test_split(…)`, `fig, ax = plt.subplots()`, `lo, hi = min(y), max(y)`. Cada nombre es una pastilla que abre la línea y se lleva por separado a una casilla; sale por su propio puerto (`result:X_test`, como `param:` en una función), así que el cable a una casilla que ya lo nombra tampoco se dibuja. Se renombra cada uno por separado (la acción `rename` lleva `from`) y en todos sus usos. Solo con un destino que sea una lista de nombres limpia (`a, b`): con `*resto`, paréntesis o atributos (`self.a, self.b = …`) no hay pastillas, el destino se edita como texto (y ningún atributo redefine el objeto). Con varias pastillas la línea se ensancha hasta 800 px antes de apretar sus campos.
- **Sin iconos de copiar, editar y borrar**: están en el **menú del nodo** (clic derecho, o la tecla de menú con el nodo enfocado): renombrar, plegar/abrir, duplicar, editar como código y eliminar (Supr).

### Bucles: un territorio que envuelve lo que repite

Un `for` o un `while` con cuerpo se dibuja como un **territorio**, igual que una función: envuelve físicamente lo que repite, y los bucles anidados son territorios dentro de territorios, como la indentación. Un bucle vacío, o plegado, es la tarjeta de siempre (con su editor).

- **Todo lo que nace dentro es suyo, a cualquier profundidad**: el analizador declara como contenido del bucle también las ramas de un `if` y los bucles anidados (antes solo los hijos directos, y el intercambio de una burbuja quedaba fuera del marco).
- **La cabecera lleva el editor**: `para [n] en [range(10)]` (o `mientras [condición]`), con el puerto de su secuencia o condición. Pide sitio propio a la cabecera (`LOOP_HEADROOM`).
- **La variable de iteración es un chip** de la cajita del bucle (`IterVar`, `iterChipId`): con el color y el icono del bucle y sin valor (no se inicializa, se recibe en cada vuelta), para que no se confunda con una constante. Va la primera de la cajita. Se **suelta** en las casillas de dentro como cualquier chip y la casilla la enseña; su cable (`param:n`) no se dibuja, así que el cuerpo del bucle no se llena de líneas desde la cabecera hasta cada uso (`iterName`). Seleccionarla marca dónde se usa.
- **Desempaquetar** (`for clave, valor in datos.items()`): cada nombre del patrón es su propio chip (`param:clave`, `param:valor`). Con varios nombres el bucle no ofrece un puerto «normal» (`provides` no está definido): no habría cuál elegir.
- **El carril de repetición**: una línea discontinua en movimiento suave sale del final del cuerpo, recorre el borde de abajo y sube hasta la cabecera, con la etiqueta «repite». Sustituye a la arista de retorno (`feedback`), que dibujada como cable cruzaba el diagrama. Con `prefers-reduced-motion` no se anima.
- **`break` y `continue` son nodos propios** (`control.break`, `control.continue`), no código opaco. Se conectan, con un cable de control, al bucle **más cercano** que afectan: `break` al puerto **termina** del borde derecho (por donde sigue el flujo al acabar el bucle) y `continue` al puerto **siguiente**, junto a la cabecera (la vuelta que se salta no termina al final, sino al principio). Un `break` dentro de una función no cruza a un bucle que la rodea. Esos puertos solo se dibujan cuando hay alguien que llega a ellos.
- **Plegar**: el chevron de la cabecera (o el modo compacto) pliega el bucle a una tarjeta con su editor; las conexiones internas se van con él.
- **Meter y sacar** funciona igual que con las funciones (se decide por el territorio más interno bajo el nodo), y lo que entra va antes de un `break`, `continue` o `return` final.

El progreso de una ejecución (`i / N`) ya lo lleva el modelo del editor (`current` / `total`) y se dibuja en la cabecera cuando hay ejecución que mostrar.

### `with` y `try`: territorios con nombre

`with` y `try` ya no son código opaco. Son **territorios** (`TERRITORY_KINDS`: bucle, `with`, `try`, `except` y las cláusulas `else` / `finally`): envuelven lo que abarcan, cada uno con su cajita de variables, y comparten con el bucle el margen, el plegado y los puertos de orden. Su silueta es siempre la pestaña (`territoryShape`), sea cual sea la de su tipo.

| Construcción              | Nodo                            | Qué enseña                                                                                                                                                                                                                                                                          |
| ------------------------- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `with open(ruta) as f:`   | **Con** (`control.with`)        | Un editor `con [recurso] como [nombre]` en su cabecera. Lo que abre es un **chip** de su cajita (`param:f`), como la variable de un bucle, y su nombre se renombra en todos sus usos. Con varios recursos (`with a as x, b as y`) enseña su código y cada nombre es su propio chip. |
| `try:`                    | **Intentar** (`control.try`)    | Un territorio con lo que se intenta. Sus cláusulas van **dentro**, cada una en su propio marco.                                                                                                                                                                                     |
| `except ValueError as e:` | **Si falla** (`control.except`) | `si falla [error] como [nombre]` (vacío = cualquier error). El nombre es un chip de su cajita.                                                                                                                                                                                      |
| `else:` · `finally:`      | **Cláusula** (`control.clause`) | «si no falla» / «al final», con su cuerpo dentro.                                                                                                                                                                                                                                   |

Lo que se define dentro se ve después, como en Python, y las cláusulas se **leen en el orden del archivo** (intento, cada `except`, `else`, `finally`): el orden que las coloca es de lectura, no de ejecución. Una **cláusula no se mueve por sí sola** ni se pone nada «detrás» de ella (`checkOrder`, `CLAUSE_KINDS`): vive dentro de su `try`. Sí reciben nodos por el puerto de inicio de su cuerpo, y «Añadir» sobre un `try` seleccionado escribe al final del intento (antes de sus cláusulas). Plantillas nuevas: «Intentar / si falla» y «Con un recurso (with)». Eliminar el `try` se lleva todas sus cláusulas.

### `class` y decoradores

Una clase es un **territorio como una función** (`abstraction.class`, de rol abstracción y también en `TERRITORY_KINDS`): un marco con su cajita de variables y, dentro, lo que define.

- **Cabecera**: `hereda de [Animal, Otro]` (las bases, editables y sin cable: la casilla ya nombra lo que hereda). El nombre es el título y se renombra en todos sus usos; su docstring es su nota.
- **Atributos de clase** (`patas = 4`): chips de su cajita, como las constantes de una función.
- **Métodos**: funciones dentro de la clase, cada una con su cajita (`self` y sus parámetros son chips) y su «devuelve». **No se ofrecen como funciones sueltas** en el menú «Funciones» ni como chips del programa (`functionsOf`): viven en su clase.
- **Crearla es llamarla**: `Perro("Rex", 3)` es una llamada que lleva a la clase (chevron), con un argumento por cada parámetro de su `__init__` (sin `self`) y el chip `ƒ Perro(nombre, edad)` para soltar en «a quién llamar». Como una función usada, la clase no se dibuja en el flujo del programa: se ve en la llamada y se abre desde ella.
- **Ámbito**: lo que se define en el cuerpo de la clase es de la clase, no se ve desde fuera. Los `__init__` de clases distintas no se mezclan.

Los **decoradores** (`@property`, `@staticmethod`, `@dataclass`) ya no vuelven opaca la definición: la sentencia empieza en ellos, así que eliminar, duplicar o mover la definición se los lleva, y se puede meter algo en su cuerpo (`place` distingue la sentencia de la definición que decora).

### El retorno es la salida de la función

Un `return` no es un nodo más: es lo que la función **da**. `foldReturns` (en `program.ts`, tras plegar) lo trata así:

- Un `return suma` que solo devuelve una variable **no se dibuja**: el cable va de donde se calcula `suma` directamente a un puerto `devuelve` en el borde derecho de la función, y eso ya dice que ese valor es lo que sale. La arista lleva `via` (el `return` real), que es donde se escribe al cambiarla.
- Un `return a + b` es una operación: se dibuja como tal (título «devuelve»), con su salida a ese puerto.
- Se quedan a la vista los retornos a los que llega un cable de control (una decisión o un bucle: perderían su camino) y una función cuyo cuerpo sería solo su retorno (sin nada dentro no habría territorio).
- Conectar algo a `devuelve` escribe el `return` (cambia el valor si ya había uno, lo añade al final si no); solo vale lo que se calcula dentro de la función o uno de sus parámetros. Soltar ese cable quita el `return`.

### Una operación se lee como una fórmula

Operando **A**, el operador en medio y operando **B**, cada uno en su fila con su puerto a su altura; el resultado sale a la derecha. Los puertos de un campo se miden en píxeles **del nodo** (no de pantalla): con el lienzo acercado, medirlos en pantalla los descolocaba respecto de su campo.

### Meter y sacar nodos de una función

Una función es un territorio, y pertenecer a ella es una decisión espacial **y** de código, así que las dos cosas van juntas:

- **Arrastrar un nodo sobre una función** lo mete: la función se marca con un borde discontinuo y «Suelta para meterlo en «f»». **Arrastrarlo fuera de la suya** lo saca: «Suelta fuera para sacarlo de «f»», en ámbar. Se decide por el centro del nodo y el territorio más interno que lo contiene (`territoryAt`); al soltar, la acción `move` mueve su sentencia en el archivo.
- `moveNode` se lleva la sentencia entera —cuerpo y comentarios pegados— cambiándole la sangría; deja un `pass` donde no queda nada y no mueve algo dentro de sí mismo. Lo que entra en una función va **antes de su `return` final** (detrás no se ejecutaría), y un cuerpo que era solo `pass` se sustituye. Vale también para añadir desde el menú.
- Solo cambian de función los nodos; una función arrastrada se lleva lo suyo.
- **Dónde va lo que se añade** está siempre a la vista junto al botón («Dentro de «sumar»», «Después de «x»», «Al final del programa»), y la función destino se marca en el lienzo.
- **El tamaño de una función se cambia** desde el agarre de su esquina inferior derecha (con la función seleccionada). La gramática lo respeta como **mínimo**: nunca queda por debajo de su contenido, y lo de dentro no se mueve (el espacio de más queda a la derecha y abajo). No se guarda en el archivo.

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

## El diagrama de flujo (leído hacia abajo)

Leído hacia abajo —como lo lee la extensión— el lienzo es un **diagrama de flujo tradicional**. Tres reglas, pedidas así:

1. **Los nodos y las conexiones solo cuentan la secuencia.** No hay cables de datos (ni se dibujan, ni al seleccionar un nodo, ni tienen puertos): las variables viajan únicamente como **chips** (en su cajita y en las casillas donde se usan). Tampoco se esconde ningún paso: un `return` es el último paso de su camino (no se pliega en la pastilla «devuelve») y un valor asignado a mitad de camino es una píldora con su entrada y su salida.
2. **Las decisiones se parten en un rombo.** La pregunta va en una píldora como cualquier paso (`¿ campo operador valor ?`, editable como siempre) y, justo debajo, un **rombo pequeño** marca dónde se parte el camino: el **«sí»** sale por su vértice de abajo y sigue la espina; el **«no»**, por el de la derecha (`questionSize`, `GATEWAY`). Así el rombo es el símbolo de siempre, limpio, y la pregunta se lee sin estrecharse.
3. **La secuencia se ve, sin saturar.** Un trazo fino y continuo con punta, en ángulos rectos (`routeFlow`), del color de la tinta tenue: no compite con las tarjetas y solo se enciende (violeta) con la selección. «sí» / «no» van junto al vértice del que salen, no en medio del camino, y **donde se juntan varios caminos hay un punto** justo encima del paso al que llegan.

La colocación no reparte capas: **reconstruye la estructura** (`layoutFlowchart`):

- Un bloque es una columna; sus pasos bajan centrados en una misma **espina**.
- Una decisión pone su camino «sí» debajo (en la espina) y abre el «no» a la derecha, pasado el vértice del rombo y sin tocar el camino «sí». Sin `else`, el «no» es un **carril** que rodea el camino «sí» por la derecha. Los caminos se juntan justo encima del paso que sigue, que vuelve a la espina.
- Un `elif` es la decisión del camino «no» de la anterior: la cadena escalona hacia la derecha, y todos sus caminos se juntan en el mismo punto.
- Qué pasos son de cada camino lo dice su **dueño** (`owner`, la sentencia que lo envuelve), no una heurística: así un camino que acaba en `return` no arrastra lo de después.
- Un territorio (bucle, `with`, `try`, función) lleva su espina **donde la tenga su contenido** (`LayoutResult.spines`), y la espina de fuera pasa por ella: una cadena de `elif` dentro de un bucle no deja medio territorio vacío.
- Solo mandan `sequence` y `branch`: los datos no colocan nada. Un grafo sin orden (las ilustraciones de la galería) se lee siguiendo su flujo de datos.

Los bucles cierran el círculo con su **carril de vuelta**: sale del pie del cuerpo, en la espina, recorre el fondo y el lateral izquierdo y vuelve a entrar arriba del cuerpo. A él llegan el final de cada camino (el analizador cierra el bucle desde **cada final** del cuerpo, no desde el último `if` entero), el «no» de una decisión sin `else` y los `continue`, que rodean por la derecha lo que queda debajo. Un `break` sale del territorio por su derecha y llega a lo que sigue al bucle, **saltándose su `else`** (que solo se hace al acabar sin salir).

Medido con los programas sintéticos (`generateProgram({ order: true })`, 12–200 pasos): ningún nodo se pisa, ninguna conexión sube (`against = 0`), una sola columna, y no cruza más conexiones que la lectura a lo ancho. Tests en `packages/spatial/test/flowchart.test.ts`.

## Etapas: el algoritmo a la vista

Un diagrama de flujo sentencia a sentencia no cuenta un algoritmo largo. Con el algoritmo genético de `examples/lecciones/flappy_ga.py`, el programa enseñaba 14 constantes en una columna y una llamada, `entrenar()`; y `entrenar`, 25 sentencias sin ninguna fase a la vista. Un algoritmo se entiende por sus **fases** («probar», «juzgar», «criar», «relevo»). Por eso el diagrama tiene un nivel entre la función y la sentencia: la **etapa**.

**De dónde salen.** Salen del propio código: de los comentarios de sección (`packages/python/src/sections.ts`), igual que los títulos de un párrafo.

- **Explícito**: una celda (`# %% Título`, como las de VS Code y Jupytext) o un rótulo con adornos (`# ── Título ──`). Basta uno.
- **Implícito**: un comentario al principio del bloque o tras una línea en blanco, siempre que el bloque tenga **al menos dos**. Un comentario suelto sigue siendo la nota de su sentencia.
- **Qué abarca**: una etapa va desde su rótulo hasta el siguiente o hasta el final del bloque. Lo que hay antes del primer rótulo no es de ninguna.
- **Título**: el rótulo se lee sin almohadilla, adornos ni numeración. `Probar: cada pájaro vuela` da el título «Probar» y el subtítulo «cada pájaro vuela».
- **El rótulo ya no es nota**: no se repite como nota de la primera sentencia, ni forma parte de su `lead` (borrar esa sentencia no borra la etapa).

El analizador las devuelve aparte (`Program.sections`) y no toca `Program.nodes`: las ediciones, la ejecución y las anclas de las lecciones siguen igual. Si el código no tiene etapas, **la IA las propone** (`prysel.proposeSections`, botón «Etapas» del lienzo, `src/ai/sections.ts`):

- valida cada ancla, con al menos dos por bloque, y repara lo que falle;
- entrega lo propuesto como una edición que el usuario revisa en la vista previa de refactorización de VS Code, antes de que se escriba;
- lo que queda escrito son comentarios de sección normales.

**Cómo se ven** (`withSections` en `packages/ui/src/program.ts`). Cada etapa es un territorio `space.section`:

- **Plegada**, una tarjeta con:
  - su número en el esquema (`2.3`), su título y su subtítulo;
  - lo que **usa** de antes → lo que **deja** para después, como chips (con su valor si ya se ejecutó);
  - las pastillas de los subprocesos a los que llama;
  - unos glifos de lo que esconde (↻ bucle, ◇ decisión, algo que se imprime).
- **Abierta**, un marco discontinuo y sin relleno con esa cabecera. Dentro va el diagrama de flujo de siempre, y la secuencia entra por su marco (`enterSections`), como en un `with`.
- **Fusionada**: una etapa cuyo único miembro es un territorio (un bucle) no dibuja un marco dentro de otro. Su título y su número encabezan el bucle («↻ 2 Evolución» sobre `para generacion en …`).
- **El `owner` no cambia**: cada sentencia conserva el de siempre (del que dependen las cajitas de chips y las ramas). El marco sale de `contains`, que recoge también lo que cuelga por `owner` (los caminos de una decisión no declaran `contains`).
- **Renombrar** una etapa reescribe su rótulo (`NodeAction.retitle`). «Empezar una etapa aquí» escribe los rótulos que hagan falta (`section`), y «Quitar la etapa» borra solo el comentario (`unsection`).
- **Lo pedido sobre una etapa** («detrás de», «dentro de», «antes de») se traduce a su bloque real (`resolveSectionAction`). A una etapa no se le borra ni se le mueve nada con una tecla.

**Cuánto se ve.** Cada densidad es una decisión de «cuánto quiero ver»:

- **compacto** pliega todo;
- **normal** pliega las **etapas hoja** (las que no tienen otra dentro), así que se ve el esquema entero y cada fase se abre donde está;
- **expandido** lo abre todo.

El usuario puede darle la vuelta a cualquiera. Un momento de una lección abre la etapa donde está su ancla y la vuelve a cerrar al pasar al siguiente (`reveal`). El cursor del paso a paso y las notas caen en la etapa plegada que tiene dentro su sentencia (`representative`).

**Subprocesos.** El analizador apunta en cada sentencia todas las funciones, clases y métodos del archivo a los que llama su texto (`ProgramNode.callees`, `packages/python/src/callees.ts`):

- también dentro de una comprensión (`[volar(g) for g in poblacion]`), anidadas (`mutar(cruzar(…))`, en el orden en que se ejecutan) o por un objeto (`pajaro.decidir(…)`, con un tipado mínimo: `p = Pajaro(…)` y `self`);
- se resuelven con el archivo entero ya visto, así que valen para una función definida más abajo;
- el lienzo las dibuja como pastillas «↗ volar» que la abren (y los métodos se pueden abrir, `methodsOf`). Las migas guardan el camino recorrido: Programa › volar › Pajaro.decidir.

**El programa desplegado.** La función que el programa llama una sola vez desde su punto de entrada se dibuja **en el sitio de la llamada** (`inlineCalls`). Las constantes del módulo (`GRAVEDAD`, `TAMANO_POBLACION`) van a la cajita **«Parámetros»**, estén donde estén. Así lo primero que se ve de `flappy_ga` es el algoritmo: 1 Población inicial → 2 Evolución (2.1 Probar · 2.2 Juzgar · 2.3 Criar · 2.4 Relevo) → 3 Resultado.

**Medido** en densidad normal (`packages/extension/test/sections-view.test.ts`):

| Vista      | Antes                                  | Ahora                  |
| ---------- | -------------------------------------- | ---------------------- |
| programa   | 16 nodos (14 constantes, ninguna fase) | 11 (el esquema entero) |
| `entrenar` | 25                                     | 8                      |
| `volar`    | 20                                     | 8                      |

Compacto se queda en 4 en cada vista, y expandido lo enseña todo (33, 30 y 23).

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

Cada vista es «otro diagrama»: al cambiar, el lienzo olvida lo movido, lo seleccionado y lo recorrido (`fitKey`) y se reencuadra. Compacto sigue plegando las funciones sin usar que se dibujan. La lógica es común a la extensión y la galería (`useProgramView`, y su parte sin estado, `viewOf`).

Dos excepciones, leído como diagrama de flujo (ver «Etapas»):

- La función **principal** (la que el programa llama una sola vez desde su punto de entrada) se dibuja desplegada en el sitio de su llamada.
- Cualquier llamada, también dentro de una expresión, lleva una **pastilla** que abre su función (o su método). El paso a paso entra en una función solo si no está desplegada donde se mira (`homeOf`).

## Compacto: la vista de pájaro

**Compacto pliega todo**: cada `def`, cada bucle y cada etapa pasan a ser un nodo, sin su lógica interna, para que la arquitectura quepa en una mirada. Normal pliega solo las etapas hoja (el esquema del algoritmo), y expandido lo abre todo. Se puede dar la vuelta a cualquier ámbito con su chevron; cambiar de densidad vuelve a lo de serie. Al replegar, las conexiones que apuntaban a un campo interno entran por el borde de la función (un puerto pertenece al nodo plegado, no al grupo).

## Lo que falta

- Micro-interfaces semánticas: sustituir la línea de código literal de cada nodo (`print`, `input`…) por controles reales — un desplegable para un operador lógico, un campo de formulario para un literal.
- **Un nodo sin nombre como origen** (`print(x)` no define nada; `float(input())` sin asignar): para usarlos habría que introducir una variable.
- **Meter una función dentro de otra** arrastrándola (hoy solo se reubican nodos).
- **Auto-layout jerárquico** (Dagre/ELK): el reparto lo hace la gramática espacial; Mayús+F solo le devuelve lo que el usuario movió.
- Un `self.x = valor` cuyo valor sí tiene editor (`self.edad = edad + 1`, un literal) enseña su destino solo como título, sin campo propio; y no hay herencia entre clases dibujada más allá de su casilla de bases.
- **Comentarios**: los que cuelgan entre las ramas de un `if`/`elif`/`else` se recogen solo si tree-sitter los cuelga de la sentencia; los de otras construcciones (`with`, `try`) no se tratan porque esas construcciones aún son nodos opacos.
- Enrutado: separar en carriles las conexiones que comparten pasillo, y esquivar también a los retornos de bucle.
- `timeline` y `hub-and-spoke` como topologías propias (hoy caen en `pipeline` y `fan-out`).
- El diagrama de flujo en horizontal: la lectura a lo ancho sigue siendo la del grafo de datos (con sus cables), la de las ilustraciones de la galería.
- En el diagrama de flujo, el carril de vuelta de un bucle entra arriba del cuerpo, no en su cabecera (la condición de un `while`): se lee bien, pero un diagrama de flujo de libro volvería a la pregunta.
- Análisis incremental: hoy se reanaliza el archivo entero en cada cambio (bastan décimas de milisegundo, pero tree-sitter puede hacerlo incremental).
