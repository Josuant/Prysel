# Lecciones: aprender con un diagrama que se explica solo

La idea: pedirle a una IA que explique un tema («recursión», «cómo funciona un `for`», «ordenar con burbuja») y que **construya el diagrama paso a paso, comentándolo**, de modo que se aprenda mirando cómo se arma y cómo se ejecuta. Primero de programación; después, de cualquier tema.

Este documento parte de lo que Prysel ya sabe hacer, propone el modelo que falta y ordena el trabajo. Es un diseño, no algo construido.

## 1. Lo que ya existe y sirve

| Ya tenemos                                                                | Papel en una lección                                                                                          |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Python → grafo semántico → lienzo, con escritura de vuelta                | El programa de la lección **es código real** y sigue siendo la fuente de verdad: lo que se ve es lo que corre |
| Motor de ejecución con espacio de nombres vivo, valores con tipo y forma  | La lección se puede **ejecutar y observar**, no solo dibujar                                                  |
| Valores por vuelta de un bucle, deslizador y reproducción                 | Ya es un «tiempo» sobre el que se mueven los chips: hay que generalizarlo a todo el programa                  |
| Cadena de pasos con vista previa por paso                                 | Explicar una transformación paso a paso                                                                       |
| Visores, estados «al día/desactualizado», orden de ejecución en el diseño | Mostrar resultados, y saber qué se rehace al cambiar algo                                                     |
| Sesión con dependencias entre sentencias (`plan.ts`)                      | Ejecutar «hasta aquí» un paso de la lección                                                                   |
| Chips arrastrables, territorios (función, bucle, `if`)                    | El vocabulario visual de cada concepto                                                                        |
| Extensión empaquetada y probada en un VS Code real                        | Dónde vive: comandos, paneles, ajustes                                                                        |

Lo que **falta** son cuatro cosas: un _guion_ (qué se dice y cuándo), una _traza_ (qué pasó línea a línea), un _reproductor_ (moverse por el guion y la traza) y la _generación_ (que la IA lo produzca y lo verifique).

## 2. El modelo: programa + traza + guion

Una lección son tres capas sobre el mismo archivo Python:

1. **Programa** (`factorial.py`): código normal. No cambia el formato ni se ensucia con metadatos.
2. **Traza**: lo que pasó al ejecutarlo, línea a línea (`sys.settrace`, con topes): qué línea, en qué llamada y a qué profundidad, qué variables cambiaron (solo las diferencias) y qué se imprimió. Con la traza, el estado en cualquier paso se reconstruye sin volver a ejecutar: **una lección grabada se puede reproducir sin Python** (alumnos, web, revisión).
3. **Guion** (`factorial.lesson.json`, junto al `.py`): una lista de _momentos_ (`beats`). Cada uno dice a qué se refiere (una sentencia por su texto, como los visores: sigue a su sentencia si cambia de línea), qué se cuenta (una nota), a dónde mira la cámara, qué se resalta, qué tramo de la traza se reproduce y, si toca, qué se pregunta.

```jsonc
{
  "version": 1,
  "title": "Recursión: el factorial",
  "level": "principiante", "lang": "es",
  "source": "factorial.py",
  "beats": [
    { "id": "b1", "at": { "hash": "…", "name": "factorial" },
      "note": { "text": "Una función que **se llama a sí misma**…", "style": "sticky" },
      "camera": { "focus": "node" },
      "play": { "from": 0, "to": 3 },
      "ask": null }
  ],
  "trace": { "events": [ … ], "truncated": false }   // se graba al verificar
}
```

Todo lo que no es código vive en el guion, no en el `.py`. El guion se puede escribir a mano: **el formato y el reproductor no dependen de la IA**, y eso es lo que permite probarlos antes de generar nada.

## 3. Lo que se pide

### 3.1 Generar diagramas con IA

La clave para que no invente: **la IA narra sobre la traza real, no sobre lo que cree que pasa.**

```
tema + nivel  →  plan (conceptos, errores típicos, pasos)
              →  código pequeño y determinista (≤ 40 líneas, sin entrada)
              →  se ejecuta y se graba la traza              ← la verdad
              →  narración: notas ancladas a pasos reales de la traza
              →  validación: el esquema, que cada ancla exista, que lo que dice el texto («aquí n vale 3») coincida con la traza
              →  reparación (máx. 2 intentos)  →  se dibuja
```

- **En directo:** el resultado se dibuja según llega, un momento tras otro; la IA «va armando» el diagrama.
- **Dos entradas:** «Explicar un tema» (genera código y guion) y, más barata y con menos riesgo, **«Explicar este archivo»** (el código ya existe: solo se traza y se anota).
- **Proveedor de modelo intercambiable:** la API de modelos de VS Code (`vscode.lm`, usa lo que el usuario ya tenga, sin claves) y/o la API de Anthropic (clave en `SecretStorage`). El resto no sabe de cuál se trata.
- **Caché** por (tema, nivel, idioma, modelo): repetir una lección no vuelve a costar.
- **Nivel e idioma** son parámetros del guion («explícamelo como a alguien que empieza», «en inglés»).

### 3.2 Notas con letra a mano

Un nodo nuevo sin código: **nota** (`NoteNode`, como el visor: una ventana en el lienzo que no escribe en el programa). Se ancla a un nodo, a un chip, a un nombre o queda libre, y con la flecha dibujada a mano hacia lo que explica.

- **Tipografía manuscrita** empaquetada con la extensión (la política de contenido ya admite fuentes locales) —una con licencia libre, como Caveat—, con una pila de reserva del sistema.
- **Trazo a mano** sin dependencias: un filtro SVG (`feTurbulence` + desplazamiento) da a flechas, subrayados y círculos el temblor de un rotulador; un subrayado «marcador» sobre un campo o un chip.
- **Estilos:** nota adhesiva, llamada con flecha, margen, definición, «ojo con esto» (error típico), analogía. Cada uno con su color y forma (que también se distingan en escala de grises, como el resto del sistema).
- Contenido: Markdown corto y **código en línea que enlaza con su nodo** (al pasar el puntero se ilumina), fórmulas sencillas.
- Anclaje por texto de la sentencia (igual que los visores), así sobrevive a editar y mover.

### 3.3 Nodos para entender

Todos de solo lectura, alimentados por la traza (y por eso también funcionan sin Python en una lección grabada):

| Nodo                                 | Qué enseña                                                                                               |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| **Variables** (tabla de seguimiento) | Variables × pasos, como en Python Tutor; la fila actual resaltada                                        |
| **Memoria**                          | Cajas con su valor y **flechas de referencia**: dos nombres que apuntan a la misma lista, copia vs alias |
| **Pila de llamadas**                 | Un marco por llamada, apilándose y deshaciéndose (recursión)                                             |
| **Árbol de recursión**               | Las llamadas como árbol, construido de la traza, con el valor que devuelve cada una                      |
| **Colección viva**                   | Una lista como barras/celdas; **comparaciones e intercambios** resaltados (ordenación, búsqueda)         |
| **Estructura**                       | Lista enlazada, árbol, grafo (dict/objetos) dibujados como tales                                         |
| **Coste**                            | Contador de operaciones frente a `n`: la complejidad vista, no dicha                                     |
| **Predicción**                       | «¿Qué imprimirá?»: el alumno responde y luego se revela con la traza                                     |
| **Concepto**                         | Tarjeta sin código: definición, analogía, error típico. Permite empezar por la idea                      |
| **Ejercicio**                        | Un hueco para editar y una comprobación (`assert`) que dice si vale                                      |

### 3.4 Animación paso a paso

Un **reproductor** con una máquina de estados sobre el guion y la traza: reproducir, pausar, paso adelante/atrás, velocidad, línea de tiempo y teclado. El estado en el paso _i_ se reconstruye de la traza, así que **ir hacia atrás y saltar es gratis**.

- **Cámara:** en cada momento el lienzo se mueve y se acerca a lo que toca, y atenúa lo demás (foco).
- **Cursor de ejecución:** un aro sobre el nodo activo y una **ficha que viaja por el cable de orden** hasta el siguiente.
- **Valores que viajan:** al asignar, el chip vuela de origen a destino; al llamar a una función, sus argumentos entran por sus puertos; al volver, el resultado regresa al sitio de la llamada.
- **Llamadas:** un marco nuevo nace junto a la función y se pliega al volver (recursión visible).
- **Bucles:** la vuelta actual resalta y las anteriores se apilan como sombras; el deslizador que ya existe se integra en la línea de tiempo.
- **Construcción progresiva:** los nodos aparecen a medida que se explican («armar el diagrama»), no todos de golpe.
- **Subtítulos** con la nota del momento, y respeto de «reducir movimiento» (del sistema): sin animación, salto directo.
- Más adelante: narración con voz sincronizada (síntesis de voz del navegador; hay que comprobar que funciona dentro de un webview de VS Code) y **exportar** la lección a un HTML autónomo, un vídeo o un cuaderno.

## 4. Ideas proactivas

1. **«Explicar este archivo»** como puerta de entrada: sin generar código, funciona con cualquier programa del usuario.
2. **Modo predicción:** antes de cada paso clave se pregunta qué pasará; la fricción es donde se aprende.
3. **«¿Y si…?»:** el alumno cambia un valor en un paso y se re-ejecuta desde ahí (ya tenemos dependencias y estados desactualizados).
4. **Caza del error:** la IA introduce un fallo y el alumno lo encuentra con la traza; o un error real del alumno se explica sobre su propia traza.
5. **Errores típicos por tema** (biblioteca de malentendidos): la lección los nombra y los provoca a propósito.
6. **Varias representaciones a la vez:** código ↔ diagrama ↔ tabla de seguimiento ↔ analogía, con un interruptor.
7. **Niveles:** el mismo tema para quien empieza y para quien ya programa (más o menos notas, más o menos pasos).
8. **Cursos:** una secuencia de lecciones con prerrequisitos («antes de recursión, funciones y pila») y progreso.
9. **Lección → ejercicios autocorregidos:** los `assert` de los nodos «Ejercicio» dan retroalimentación inmediata y pistas graduales.
10. **Accesibilidad:** texto alternativo de cada paso (lectores de pantalla), subtítulos, teclado completo, sin depender del color.
11. **Más allá de la programación:** el mismo motor con nodos de _concepto_ y relaciones (un mapa de ideas) y con bibliotecas de cálculo (fórmulas, gráficas) para matemáticas, física o estadística; el «programa» pasa a ser un modelo ejecutable y no siempre Python.
12. **Calidad medible:** cada lección lleva una puntuación automática (¿corre?, ¿toda sentencia tiene explicación?, ¿el texto coincide con la traza?, longitud de notas) y no se muestra si no pasa.

## 5. Seguridad: el código generado se ejecuta

Es la parte delicada. Una IA puede escribir código que borre archivos o abra conexiones, y una lección se ejecuta en la máquina del usuario.

- **Revisar antes de ejecutar:** una lección generada se dibuja primero **sin correr**; ejecutar exige un gesto explícito (y la confianza en el espacio de trabajo, que ya se respeta).
- **Modo seguro para lecciones:** una lista de módulos permitidos (`math`, `random` con semilla, `collections`, `itertools`, `dataclasses`, `typing`…), sin `open`, `exec`, `eval`, `__import__`, `subprocess`, `socket`, con topes de tiempo, de pasos de traza y de salida. Se aplica sobre el árbol del programa **antes** de ejecutar, y el motor en un proceso aparte que se mata si se pasa.
- **Nada del modelo se ejecuta sin verlo:** el código y el guion pasan por validación estructural; el texto de las notas se muestra como texto (nunca HTML).
- **Datos:** la clave de un proveedor vive en `SecretStorage`; el contenido enviado al modelo es el tema (y, en «explicar este archivo», el código que el usuario elija) y se dice antes.

## 6. Hoja de ruta

Cada fase termina en algo que se puede usar y probar solo.

| Fase                               | Entrega                                                                                                                                                           | «Hecho» cuando…                                                                                    |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| **A. Traza y reproductor**         | Grabar la traza de un programa; reproducirla en el lienzo con cursor, ficha por el cable, chips que cambian, cámara y foco; paso adelante/atrás y línea de tiempo | Un programa de 30 líneas se recorre hacia delante y atrás y cada chip enseña su valor en cada paso |
| **B. Guion y notas**               | Formato `.lesson.json`, nodo nota manuscrita con flecha, ancla por texto, subtítulos; lección escrita a mano que se reproduce                                     | Se abre una lección de ejemplo, se reproduce y las notas siguen a su sentencia al editar           |
| **C. Nodos para entender**         | Variables, Memoria, Pila de llamadas, Árbol de recursión, Colección viva, Predicción                                                                              | Factorial recursivo y burbuja se explican solo con estos nodos                                     |
| **D. Generación con IA**           | Proveedor de modelo, «Explicar este archivo», después «Explicar un tema» con verificación y reparación, streaming, modo seguro, caché                             | Una lección generada pasa la validación y se reproduce; una inventada no                           |
| **E. Animación avanzada y salida** | Construcción progresiva, valores que viajan, voz, reducir movimiento, exportar a HTML autónomo                                                                    | Una lección se comparte como un solo archivo y se ve sin Python                                    |
| **F. Más allá del código**         | Nodos de concepto y mapas de ideas, otros modelos ejecutables                                                                                                     | Una lección de un tema sin programa (por ejemplo, un proceso biológico) se genera y se recorre     |

Orden: A y B antes que D a propósito. Con la traza y el guion en la mano, generar es «producir un `.lesson.json` válido», que se puede comprobar automáticamente; al revés, se construiría sobre algo que aún no se sabe validar.

## 7. Decisiones abiertas

1. **Proveedor de la IA:** la API de modelos de VS Code (sin claves; depende de tener un proveedor instalado, como Copilot), la API de Anthropic con clave propia, o ambos detrás de una interfaz.
2. **Dónde vive el guion:** un `.lesson.json` junto al `.py` (propuesto), comentarios estructurados en el propio código, o un documento propio con el código dentro.
3. **Por dónde empezar:** los cimientos manuales (fases A y B) o directamente «Explicar este archivo».
4. **Tipografía manuscrita:** empaquetar una fuente libre (hay que descargar el archivo de la fuente) o usar solo las del sistema.

## 8. Decisiones tomadas y estado

Decisiones (las cuatro de arriba): **ambos proveedores tras una interfaz** (`vscode.lm` y la API de Anthropic con la clave en `SecretStorage`); **guion en `.lesson.json` junto al `.py`**; **empezar por A y B**; **empaquetar una fuente libre** (se anunciará su nombre, origen y tamaño antes de descargarla).

### Fase A: traza y reproductor

Hecho (probado, y comprobado dentro de un VS Code de verdad con captura del lienzo):

- **El motor graba la traza** (`runtime/prysel_runner.py`, petición `trace`): `sys.settrace` sobre el archivo entero, en un espacio de nombres aparte (no toca lo ya ejecutado), con tope de pasos, salida impresa atribuida a cada paso, identidad de objetos (dos nombres con el mismo `id` son el mismo objeto) y sin ruido de comprensiones ni de la biblioteca estándar.
- **`src/trace.ts`** reconstruye el estado de cualquier paso (pila, variables, salida, error) y salta a cualquiera sin volver a ejecutar; ir hacia atrás cuesta lo mismo que hacia delante.
- **Protocolo**: `trace` de ida (con la versión del texto) y de vuelta (`running` / `done` / `failed`); una traza de un texto que ya cambió se descarta. Comando `Prysel: Reproducir el programa paso a paso`.
- **Lienzo**: prop `cursor` (anillo en el nodo por el que va el paso y cámara que lo sigue solo si se sale de la vista); si el nodo está dentro de una función que no se ve, el cursor sube a la función o, si tampoco se ve, a la llamada que la abrió.
- **Webview**: botón «▶ Paso a paso», barra con inicio/atrás/reproducir/adelante/final, línea de tiempo, velocidad (0,5×–4×), frase de lo que pasa en el paso, pila, variables (la que cambió, resaltada) y lo impreso; teclado (←, →, Espacio). Mientras se reproduce, los chips enseñan lo que valían en ese paso, no lo de la última ejecución.
- `ProgramNode.lineEnd` (última línea de la sentencia) para asociar una línea de la traza con su nodo.

Pendiente de la fase: la **ficha que viaja por el cable** de orden, el valor de la variable de iteración en su chip (hoy solo en la barra), y una lección de ejemplo con más de 30 líneas para medir el «hecho cuando…».

### Fase B: guion y notas a mano

Hecho (probado, y comprobado en un VS Code real con capturas de la lección de ejemplo `examples/lecciones/factorial`):

- **`.lesson.json` junto al `.py`** (`factorial.py` → `factorial.lesson.json`): el host lo lee (del editor si está abierto, sin guardar; si no, del disco), lo vigila (crear, guardar, borrar) y lo manda al lienzo. Se valida al leerlo y otra vez al llegar al webview (`src/lesson.ts`): tope de momentos y de texto, ids únicos, clases de nota que existen; lo que no reconoce lo ignora, y un guion roto no rompe nada: llega el motivo y se enseña en una franja. Comando `Prysel: Crear o abrir la lección de este archivo` (y el botón «＋ Lección»): crea un guion de partida con las primeras sentencias.
- **Ancla por el texto de la sentencia** (`at: { text, nth }`), como los visores: sigue a su sentencia si se mueve de línea o cambian los espacios; la cabecera se reconoce sin los dos puntos. Una nota sobre una línea de dentro de una función que no se ve cuelga de la llamada que la abre; la de la definición, del chip de la función.
- **Momento** (`when: { text, visit }`): la vez `visit` que la ejecución llega a esa sentencia. Así el guion no depende de números de paso y sobrevive a editar el código.
- **Nota a mano** (`NoteNode`): letra Caveat (SIL OFL, empaquetada con su licencia en `dist/webview/OFL-Caveat.txt`) con pila de reserva del sistema; seis clases que se distinguen por la forma, no solo por el color (`sticky`, `callout`, `warning`, `definition`, `analogy`, `margin`); `**negrita**` y `` `código` `` (texto, nunca HTML). Flecha con temblor de rotulador (filtro SVG `feTurbulence` con la región a medida de cada cable).
- **Margen de notas**: las notas no entran en el reparto del diagrama; van en una columna a su derecha, a la altura de lo que explican, repartidas alrededor de su ancla sin solaparse (regresión isotónica, `placeNotes`). Aparecer una nota nunca mueve nada, porque las que aún no llegaron guardan su sitio.
- **Lección reproducida**: la reproducción se detiene en cada momento (hay algo que leer), con botones «‹ Momento» / «Momento ›» y la nota actual como subtítulo a mano; la nota del momento se levanta, las anteriores se retiran, las futuras no se ven. La cámara sigue al cursor y a la nota que se lee; si no caben las dos, manda lo que se ejecuta.

Formato mínimo:

```json
{
  "version": 1,
  "title": "Recursión: el factorial",
  "beats": [
    {
      "at": { "text": "total = 0" },
      "when": { "text": "total = 0", "visit": 1 },
      "note": { "title": "Ojo", "text": "Empezamos en `0`.", "style": "warning" }
    }
  ]
}
```

Pendiente: código en línea que enlaza con su nodo (al pasar el puntero se ilumina), fórmulas, preguntas (`ask`), y arrastrar una nota para dejarla donde se quiera (hoy el margen la coloca).

### Fase C: nodos para entender

Hecho (probado con la traza real de factorial, Fibonacci, burbuja y alias, y comprobado en VS Code real con las tres lecciones de `examples/lecciones`):

- **Cinco tarjetas de solo lectura**, todas calculadas de la traza (`webview/src/insights.ts`, puro) y por eso también valen hacia atrás y sin Python: **Variables** (tabla de seguimiento: una columna por cada momento en que algo cambió en la llamada actual, lo cambiado resaltado), **Pila de llamadas** (un marco por llamada, la de arriba es la que se ejecuta, muestra lo que devuelve; una recursión profunda se resume), **Árbol de llamadas** (se construye de la traza entera y se ilumina con el paso: las futuras no se ven, las abiertas van a trazos, la actual manda; un bosque si el programa llama varias veces; tope de 120 llamadas), **Memoria** (cada variable de cada llamada abierta y los objetos a los que apuntan, con la identidad que graba el motor: dos flechas al mismo objeto son un alias, con su `×2`) y **Colección viva** (una lista como celdas o barras; se resaltan las celdas que cambiaron desde el paso anterior y las variables que el programa usa como índice —`xs[j]`— marcan su celda con `▲j`).
- **Predicción** (`ask` en un momento del guion): «¿qué valdrá `total` tras esta línea?» (`expect: "value"`, con `name`) o «¿qué imprimirá?» (`expect: "output"`). Se responde al llegar al momento y se compara con lo que dice la traza (tolerante a espacios, comillas y `2` frente a `2.0`); el alumno ve si acertó y qué pasó. No bloquea: se puede seguir sin responder.
- **Dónde viven**: en un panel junto al lienzo (a un lado si es ancho, debajo si es estrecho), no dentro del plano con zoom: así se leen siempre a su tamaño y no se pierden de vista mientras la cámara se mueve. Los botones «Entender: …» de la barra de reproducción los encienden y apagan (se recuerda por archivo); el guion puede pedir los que necesita con `"show": ["stack", "tree"]`.
- **La traza graba las listas cortas enteras** (hasta 40 escalares: `{l: [...], n, t}`): antes se recortaban a ocho elementos, y un intercambio en la cola de una lista no contaba como cambio.
- La cámara ahora se aleja lo justo (hasta un 0,45) para que quepan el nodo que se ejecuta y la nota que se lee.

Ejemplos: `factorial` (pila y árbol), `burbuja` (colección y variables, con una predicción) y `alias` (memoria y variables, con dos predicciones).

Pendiente: Estructura (lista enlazada, árbol, grafo), Coste, Concepto y Ejercicio; la ficha que viaja por el cable; los valores que vuelan de origen a destino.

### Revisión: leer la secuencia de pasos hacia abajo

El usuario pidió, antes de la Fase D, que el orden de ejecución se lea de arriba abajo, con las notas a la
derecha y lo auxiliar (variables, visores) a la izquierda; con el plegado a lo ancho de antes, la secuencia
de un programa no se seguía de un vistazo.

- **`Canvas` con `axis="vertical"`** (activado en el lienzo de la extensión): el plegado en filas se
  desactiva (`maxRun: 0`, una sola columna) y la propia gramática de conexiones ya sabe leer en ese eje.
- **La espina se ve**: leído hacia abajo, el cable de orden entre dos pasos consecutivos sí se dibuja (antes
  solo aparecía al seleccionar un nodo, porque en horizontal ya lo decía la posición). Entra y sale por el
  centro de cada tarjeta (asas `step-in`/`step-out`, invisibles) para que quede recto; una punta de flecha
  más grande (`prysel-arrow-spine`) marca el sentido. Medido con `packages/spatial/scripts/density.ts
vertical` y fijado en `packages/spatial/test/density.test.ts`: 0 solapes, 0 conexiones «contra la
  lectura» y una sola columna hasta 200 pasos.
- **Números de línea** fuera de cada tarjeta y de cada chip de la cajita del programa (`.flow-step`): se
  lee el orden sin seguir ningún cable. La cajita de variables pasa a una columna (`trayLayout(..., column:
true)`, un chip por fila) y mezcla variables y funciones por su línea.
- **Las notas** siguen a la derecha (ya lo estaban desde la Fase B); ahora, además, su flecha usa el eje
  horizontal aunque el diagrama sea vertical (nace de un asa `note-out`/`aux-out` a la derecha o la
  izquierda del nodo, no de la espina).
- **Los visores fijados** (antes mezclados con los pasos) se sacan a un margen a la izquierda, bajo la
  cajita de variables, con su propio cable (`viewerNode` reutilizado, asa `in` a la derecha). `placeNotes`
  (renombrada de hecho a «reparto en un margen») ahora acepta un `top`: nada sube por encima de lo que ya
  ocupa ese sitio (la cajita), y la pila nunca baja respecto a la fila anterior.
- **Métricas nuevas** en `analyze()`: `against` (conexiones que van contra el sentido de lectura; debe ser 0) y `drift`/`spineDrift` (cuánto se desvía cada paso del anterior en el eje transversal; 0 en una
  secuencia lineal).

Comprobado con las tres lecciones de ejemplo en un VS Code real: la burbuja, el factorial (con su función y
sus variables en columna) y sin romper ninguna densidad (compacto/normal/expandido).

### Fase D: generación con IA (primera entrada: «Explicar este archivo»)

Hecho (probado con proveedores de mentira y con la traza real del factorial; sin llamar a ningún modelo de
verdad desde las pruebas, que no llevan clave ni Copilot instalado):

- **Interfaz de proveedor** (`src/ai/provider.ts`): `AiProvider = { id, generate({system, prompt, maxTokens}) }`.
  Nada más del sistema sabe si detrás hay `vscode.lm` o Anthropic.
  - `src/ai/vscodeLm.ts`: `vscode.lm.selectChatModels({})`, usa lo que el usuario ya tenga (Copilot u otro),
    sin pedir clave; `null` si no hay ninguno.
  - `src/ai/anthropic.ts`: la API de Mensajes de Anthropic por HTTP, con `fetchImpl` inyectable (así se
    prueba sin red). La clave vive en `SecretStorage` (comandos `Prysel: Configurar la clave de Anthropic`
    y `…: Borrar la clave de Anthropic`); el modelo es configurable (`prysel.anthropicModel`) porque el
    nombre exacto cambia con el tiempo.
  - Ajuste `prysel.aiProvider` (`auto` | `vscode` | `anthropic`); `auto` prueba `vscode.lm` primero (no
    hace falta clave) y si no hay, Anthropic si hay clave guardada.
- **«Explicar este archivo»** (comando `prysel.explainFile`): traza el archivo (la Fase A ya sabe hacerlo),
  le pide al modelo un guion anclado a esa traza real y, si pasa la validación, lo escribe como
  `<archivo>.lesson.json` junto al `.py` y lo manda al lienzo. Antes de mandar nada fuera, avisa qué se
  envía (el código y la traza) y a qué proveedor, y pide confirmación explícita; si ya existe un guion,
  confirma antes de sobrescribirlo.
- **La verdad es la traza, no lo que el modelo suponga** (`src/ai/prompt.ts`): el pedido lleva la lista de
  sentencias del programa (lo único válido como `at.text`/`when.text`) y un resumen legible de la traza real
  (qué cambia en cada paso, qué se llama, qué se devuelve, qué se imprime), con tope (400 pasos) y aviso de
  corte. El mensaje de sistema exige responder solo JSON, con el formato exacto del guion, las clases de
  nota que existen y los nodos para entender disponibles.
- **No se acepta nada que no se compruebe** (`src/ai/validate.ts`, reutilizando `resolveBeats` y
  `expectedFor` de las fases B y C): el formato (`parseLesson`), que cada ancla sea de verdad una sentencia
  del programa, que se ejecute las veces que pide `visit`, y que una pregunta (`ask`) se pueda responder con
  la traza (el nombre existe justo ahí). Un guion que no cumple algo no se guarda nunca.
- **Reparación** (`src/ai/generate.ts`): si no vale, se le dice el motivo exacto (letra por letra: «el ancla
  «X» no es ninguna sentencia», «no se ejecuta 99 veces», «la pregunta pide un nombre que no existe ahí») y
  se le pide corregir solo eso, hasta dos veces (tres intentos en total). Si a la tercera sigue sin valer,
  se avisa del motivo del último intento en vez de guardar algo a medias.
- `anchorNode` se movió a `src/anchor.ts` (antes solo en el webview) para que la generación compruebe las
  anclas con la misma regla exacta con la que el lienzo las dibuja.

```
programa + traza real
  → prompt (sentencias + resumen de la traza)
  → modelo → JSON
  → validar (formato, anclas, visitas, preguntas)  → si falla, reparar (máx. 2 veces)
  → .lesson.json
```

Pendiente de la fase: «Explicar un tema» (generar el código además del guion, con el modo seguro de la
sección 5: allowlist de módulos, sin ejecutar nada que no se haya visto), streaming (hoy se espera la
respuesta entera antes de validar, no se dibuja «en directo»), y caché por (tema, nivel, idioma, modelo) —
hoy la única «caché» es que no se regenera un guion existente sin confirmar.

### Revisión: «Explicar un tema», con modo seguro y caché

Cierra la Fase D con la segunda entrada de la sección 3.1: no parte de un archivo que ya existe, así que el
código lo escribe la IA — y ese código nadie del usuario lo revisó antes de que se ejecute.

- **Modo seguro** (`packages/extension/runtime/prysel_runner.py`, `SAFE_MODULES`/`_check_safe`): antes de
  compilar una sola línea, se recorre el árbol (`ast`) del programa. Un `import` de un módulo fuera de una
  lista corta (`math`, `random`, `itertools`, `functools`, `collections`, `dataclasses`, `typing`, `string`,
  `statistics`, `fractions`, `decimal`, `enum`, `re`, `heapq`, `bisect`, `copy`, `operator`, `textwrap`), un
  nombre como `open`/`exec`/`eval`/`compile`/`__import__`/`input`/`globals`/`locals`/`vars`, o un atributo
  del escape clásico de un sandbox de Python (`__subclasses__`, `__globals__`, `__bases__`, `__mro__`,
  `__code__`…) cortan el paso: ni se compila, y el motivo llega como el mismo `error` de una traza normal
  (`error.name === 'UnsafeCode'`), con su línea. El tope de pasos que ya existía (`limit`) sigue cortando un
  bucle sin fin igual que siempre: no hizo falta ningún tope de tiempo aparte. `Kernel.trace`/`Session.trace`
  ganan un tercer parámetro, `safe` (`false` por defecto: el código del propio usuario, en «Explicar este
  archivo» o al pulsar «▶ Paso a paso», sigue sin esta restricción — ya lo cubre la confianza del espacio de
  trabajo).
- **El código, antes que el guion** (`src/ai/topic.ts`, `generateTopic`): un prompt aparte
  (`buildCodeSystemPrompt`/`buildCodeUserPrompt`) le pide al modelo un JSON `{ title, code }`: un programa de
  como mucho 40 líneas, determinista (semilla fija si usa `random`), sin `input()`, que termine solo. Antes
  de gastar una ejecución se comprueban esas mismas cosas del lado de la extensión (líneas, `input()`); el
  resto —el módulo prohibido, el `NameError`, el `ZeroDivisionError`— solo se sabe al trazarlo EN MODO
  SEGURO, y ese es el motivo exacto que se le devuelve al modelo para reparar (máximo 3 intentos, igual que
  la narración). Con una traza real y sin error, se reutiliza `generateLesson` tal cual (con su propia
  reparación, aparte): el código no se vuelve a tocar si lo que falla es solo el guion.
- **Comando `prysel.explainTopic`**: pide el tema, opcionalmente el nivel, y el nombre del archivo a crear
  (en la raíz del proyecto abierto); avisa antes de mandar el tema al proveedor (nunca código del usuario,
  porque aquí no lo hay todavía) y antes de sobrescribir un archivo existente. Al terminar dejan un `.py` y
  su `.lesson.json` nuevos, como si el usuario los hubiera escrito él mismo, y abre el primero.
- **Caché por (tema, nivel, idioma, proveedor)** (`src/ai/cache.ts`, `cacheKeyOf`): una clave estable
  (espacios y mayúsculas de más no cuentan) sobre un `sha256`, guardada en el almacén global de la extensión
  (`context.globalStorageUri/ai-cache/<clave>.json`). Repetir el mismo tema pregunta si se reutiliza lo
  guardado o se genera de nuevo, sin volver a llamar al modelo si se elige lo primero. Una caché de un
  esquema de lección más viejo que ya no valida (`parseLesson`) se descarta sola, como si no existiera.

```
tema + nivel
  → prompt de código (≤ 40 líneas, determinista, módulos permitidos)
  → modelo → JSON { title, code }
  → se analiza y se traza EN MODO SEGURO   ← si falla (código roto o prohibido), reparar (máx. 3)
  → con la traza real, generateLesson narra el guion (su propia reparación, aparte)
  → .py + .lesson.json, y a la caché
```

Pendiente de la fase: streaming («en directo», construir el diagrama momento a momento según llega, en vez
de esperar toda la respuesta antes de dibujar nada). No es necesario para que una lección generada valga o
no (el criterio de la hoja de ruta), así que se deja para cuando toque la Fase E (animación avanzada).

### Revisión: correcciones y el ejemplo que pone todo a prueba

Tres arreglos y un ejemplo final para comprobar que las cuatro fases encajan entre sí.

- **Un modelo pequeño traduce lo que no debe** (`src/ai/normalize.ts`): `gpt-4o-mini` (vía Copilot) a veces
  traduce los códigos fijos del guion (`"value"` → `"valor"`, `"sticky"` → `"pegajosa"`, `"stack"` →
  `"pila"`) aunque el prompt pida no tocarlos. `normalizeAiJson()` corrige estos sinónimos (con y sin
  acentos, mayúsculas) antes de validar, así una traducción de más no gasta un intento de reparación;
  `src/ai/prompt.ts` además lo pide explícito con un ejemplo de JSON.
- **Un chip no se podía arrastrar a Imprimir**: la casilla de `TextInput` (mensaje de una sola línea, a
  diferencia del `TextArea` multilínea de al lado) no llevaba `slot`, así que no había ningún
  `data-slot="value"` en el DOM donde soltar el cable. El modelo de datos (`inputsOf`, `checkConnection`) ya
  lo permitía; faltaba la marca en `packages/ui/src/controls.tsx`. Corregido con el mismo `slot`/`linked`
  que ya tenía el `TextArea`.
- **Las tarjetas «Entender» pedidas por el guion (`show`) no se veían sin darle antes a «▶ Paso a paso»**:
  ahora, si el guion trae `show`, la extensión pide la traza sola al abrir el archivo (`App.tsx`), así las
  tarjetas aparecen desde el primer vistazo.
- **`if __name__ == "__main__":`** es ahora un tipo de nodo propio (`control.entrypoint`,
  `packages/morphology/src/kinds.ts`; reconocido en `packages/python/src/program.ts` por
  `isMainGuard()`/`entryPoint()`, sin importar el orden de los operandos ni si compara con `!=`). Se dibuja
  como una pestaña de un solo camino (igual que `with`), no como una decisión de dos salidas: en la
  práctica esa condición siempre es cierta cuando Prysel traza el archivo, así que un rombo con «verdadero»
  y «falso» sería confuso. Un `if __name__` con otro nombre o comparación (o con `elif`/`else`) sigue
  cayendo en `control.condition`, sin cambios.
- **Seguir automáticamente a lo que ocurre en una función o clase oculta**: durante la reproducción paso a
  paso, si el paso actual ocurre dentro de una función o método que no está a la vista, el lienzo la abre
  solo (`enclosingFunctionNode()` en `webview/src/player.ts`, un efecto en `App.tsx`); al salir de la
  reproducción, vuelve a lo que se veía antes de empezar. Antes había que abrir cada función a mano para
  seguir la ejecución si se metía en ellas.

**El ejemplo final**: `examples/lecciones/flappy_ga` — un algoritmo genético que aprende a jugar. Se pidió
explícitamente como prueba de fondo: que el diagrama por sí solo explique cómo funciona el algoritmo, y que
si hacía falta un nodo nuevo para lograrlo, se creara. De ahí salieron dos tarjetas «Entender» nuevas, además
de las cinco de la Fase C:

- **Evolución** (`show: "evolution"`, campo de guion `track: [{label, name}]`, hasta seis series): una
  línea por variable seguida, un punto por cada vez que el bucle de generaciones vuelve a su cabecera; se
  revela punto a punto según el paso actual, nunca de golpe. Sirve para cualquier programa con un bucle de
  optimización o entrenamiento, no solo para este ejemplo.
- **Trayectoria** (`show: "trail"`, campo de guion `trail: {value, min, max, obstacle?: {name, gap,
width}}`): una escena SVG con un punto (la variable seguida, escalada entre `min` y `max`) y, si el guion
  declara un `obstacle`, dos barras que marcan un hueco a esquivar más una chispa (sparkline) de los últimos
  valores. Sigue el fotograma más reciente que tenga la variable seguida, así que funciona aunque esa
  variable solo exista dentro de una función que no es la que se ejecuta en este preciso paso.
- **Una limitación real del motor de traza, resuelta sin tocarlo**: la traza solo graba variables locales que
  cambian; una mutación de atributo (`self.altura = ...`) es invisible para ella, porque el `repr` de un
  objeto no cambia. Se resolvió añadiendo una variable local (`altura = pajaro.altura`) justo después de
  mutar el objeto — también hace el código más legible (evita repetir el acceso al atributo) y de paso deja
  el valor disponible para la tarjeta «Trayectoria». Cualquier otra lección con estado en atributos de
  instancia necesitará el mismo truco si quiere que ese estado se siga con una tarjeta.
- **Tope de pasos de la traza subido de 5000 a 20 000** (`Kernel.trace`/`Session.trace`): la simulación
  entera (cinco generaciones, población de cuatro) genera del orden de 7000 pasos; reducir el ejemplo para
  caber en 5000 le habría quitado margen para mostrar una curva de aprendizaje que de verdad mejora.
- El guion tiene 13 momentos (idea → cerebro → física → vuelo → colisión → aleatorio → cruce → mutación →
  `if __name__` → primera generación → una predicción de valor → una predicción de salida en la tercera
  generación → reemplazo de la población → resultado final), pensados para leerse en ese orden sin saltos.

Comprobado: las 1385 pruebas (`pnpm verify`) y la prueba real dentro de un VS Code de verdad (`pnpm e2e`)
pasan; capturas del lienzo confirmaron a mano que la ruta de reproducción sigue sola de `entrenar` a `volar`
a `decidir`, y que la tarjeta «Trayectoria» dibuja las dos barras del hueco y el punto del pájaro con la
geometría esperada.

### Fase E: animación avanzada (primera entrada: movimiento y accesibilidad)

De la sección 3.4, lo que se podía dejar cerrado sin depender de «exportar a HTML autónomo» (un proyecto en
sí mismo, aparte). Streaming de la Fase D, voz sincronizada, construcción progresiva y exportar siguen
pendientes.

- **Reducir movimiento, en la cámara del reproductor** (el hueco real: `useMotion` ya apagaba el
  desplazamiento de los NODOS con la preferencia del sistema, pero la cámara —`setCenter` al seguir el
  cursor y la nota, el encuadre al abrir una función— tenía su propio interruptor `animate`, que nadie
  conectaba a nada). `packages/ui/src/motion.ts` gana `usePrefersReducedMotion()` (reactivo: si la
  preferencia cambia mientras la extensión está abierta, se entera sin recargar); el webview
  (`App.tsx`) lo pasa como `animate={!reducedMotion}` al lienzo.
- **La «ficha que viaja por el cable de orden» y «los valores que vuelan», adaptadas a como quedó el
  diseño** (rondas 9–17, muy posteriores a como se escribió originalmente esta sección): con «cable = solo
  donde sea estrictamente necesario», casi ningún paso consecutivo tiene ya un cable de orden dibujado
  entre sí y el anterior (rondas 13–14) — viajar por un cable que no existe no tiene sentido. En su lugar:
  - El **anillo del cursor** llega con un pulso (`prysel-cursor-arrive`, 380 ms) en vez de aparecer sin
    más: se nota la llegada sin fingir un cable.
  - El **chip que acaba de recibir un valor** (una pastilla de resultado, `A = f(...)`) se anuncia con un
    pulso propio (`vchip-arrive`, 480 ms) el paso exacto en que la traza lo escribió — es «el valor vuela
    hasta su chip», pero como un chip no tiene «origen» físico desde que casi todo es chip y no cable, el
    vuelo se cuenta como llegada, no como trayecto. `observedAt()` (`webview/src/player.ts`) ahora dice
    también `changed: boolean` por nombre (comparando con `state.event.ch`, lo que la traza dice que
    cambió justo en ese paso), y ese booleano llega hasta `ResultChip` (`MorphNode.tsx`) como
    `data-changed`.
  - Ambas animaciones se apagan solas bajo `prefers-reduced-motion: reduce` (mismo patrón que ya usaba el
    resto del lienzo).

Pendiente de la fase (al terminar la entrada de arriba): construcción progresiva, voz sincronizada y
exportar a HTML autónomo.

### Fase E: construcción progresiva

De las tres piezas que quedaban, esta: «los nodos aparecen a medida que se explican, no todos de golpe».
Antes de tocar el layout se le preguntó al usuario el criterio de «todavía no» (tres opciones: atenuar sin
mover nada, quitar de verdad —como las notas— recolocando el lienzo en cada paso, o dejarlo para después);
eligió **atenuar, no ocultar**: más seguro (no toca el motor de layout, que ya está muy probado) y el
diagrama entero sigue sirviendo de mapa.

- **`reachedNodes(program, trace, step)`** (`webview/src/player.ts`, pura): qué nodos ha tocado la
  ejecución hasta este paso (incluido). Un nodo cuenta como tocado si alguna línea ejecutada cae dentro de
  su rango `[line, lineEnd]` — así un contenedor (bucle, decisión, `with`/`try`) se enciende en cuanto se
  ejecuta cualquier línea de su interior, sin recorrer hijos uno a uno.
- **Caso especial: una función o una clase «se define» mucho antes de llamarla.** La línea `def f():` se
  ejecuta (crea el objeto función) nada más cargar el módulo, muy antes de que `f()` se llame de verdad; si
  contara como «tocada» igual que cualquier otra línea, casi todas las funciones se encenderían de golpe al
  principio y la construcción progresiva no diría nada. Por eso, para `abstraction.collapsed`
  (función/método) y `abstraction.class`, el rango que cuenta empieza en `line + 1` (el cuerpo), nunca en
  la cabecera: una función se enciende cuando se ejecuta lo que hace, no cuando se define.
- **Token nuevo del sistema de diseño: `opacity-pending` (0.18)**, más tenue que `opacity-dead` (0.45, el
  código inalcanzable): no es un juicio sobre el código, es solo que todavía no le toca. Modificador nuevo
  en `MorphNode` (`modifier: 'pending'`, junto a los ya existentes `dead`/`generating`), con transición de
  220 ms al aclararse (apagada bajo «reducir movimiento»).
- **Cableado**: `Canvas` gana `modifierOf?: (id) => 'dead' | 'generating' | 'pending' | undefined` — el
  mismo patrón que `stateOf` (la app decide por id, el lienzo dibuja) — y solo se aplica a los nodos de
  verdad del programa (el bloque de `'prysel'`, no a chips, notas ni visores, que tienen sus propios
  mecanismos o no aplica). `App.tsx` calcula `reached` con `reachedNodes()` solo mientras hay reproducción.

Comprobado en un VS Code real (`factorial`, capturas paso a paso): antes de que el bucle escriba
`total = total + factorial(i)`, esa línea y el `Imprimir` final se ven muy tenues; en cuanto se ejecutan, se
aclaran del todo y ya no vuelven a atenuarse (aunque el paso avance a otra parte del programa). `pnpm
verify` (1405 tests, con un test nuevo de `reachedNodes` que cubre justo el caso de la función que aún no
se llamó) y `pnpm e2e` reales, en verde.

Pendiente de la fase (al terminar la entrada de arriba): voz sincronizada y exportar a HTML autónomo.

### Fase E: voz sincronizada

La duda que dejó abierta la sección 3.4 («hay que comprobar que funciona dentro de un webview de VS Code»)
se resolvió primero, antes de escribir nada: un webview es Electron con Chromium entero detrás, así que
`window.speechSynthesis`/`SpeechSynthesisUtterance` son de verdad, no un cascarón vacío — comprobado en
vivo (`speechSynthesis.speaking` pasa a `true` al pedirle que hable, y `getVoices()` devuelve voces reales
del sistema, incluidas varias en español).

- **`useNarration()`** (`webview/src/useNarration.ts`): lee en voz alta la nota del momento actual cuando
  cambia (`key`, normalmente el id del momento — quedarse varios pasos dentro del mismo no la repite;
  volver a un momento anterior al rebobinar sí, porque el id vuelve a cambiar). Elige la voz que mejor casa
  con `lesson.lang` (exacta, o el mismo idioma sin variante regional) cuando hay una instalada.
- **`speakableNote(note)`**: el título (si tiene) y el texto sin marcas de Markdown — reutiliza `plainNote`
  (la misma función que ya limpia el subtítulo en pantalla), para que no se lean asteriscos ni comillas
  invertidas sueltas.
- **Apagada por defecto**: nadie espera que la extensión hable sin pedirlo. Un botón nuevo en la barra de
  reproducción («🔈 Voz» / «🔊 Voz», solo visible con una lección) la enciende y apaga; se recuerda entre
  archivos (`SavedState.narrate`, una preferencia de quien mira, no de la lección). El subtítulo ya tenía
  `aria-live="polite"` para lectores de pantalla: la voz es un canal aparte, para quien la quiere oír sin
  depender de uno.

Comprobado: `pnpm verify` (con un test nuevo para `speakableNote`) y `pnpm typecheck`/`lint` en verde. La
confirmación en vivo de la propia síntesis de voz (`speechSynthesis` respondiendo dentro del webview) se hizo
antes de escribir el código; una segunda vuelta para verla funcionando ya cableada, paso a paso en un
VS Code real, no se pudo completar en esta sesión porque VS Code estaba a mitad de una actualización propia
del sistema («Code is currently being updated») que bloqueó lanzar cualquier instancia nueva —no es un fallo
del código, es un bloqueo externo del entorno; queda por repetir esa vuelta cuando se pueda.

Pendiente de la fase: exportar a HTML autónomo (el criterio de «hecho» de toda la fase en la hoja de ruta:
«una lección se comparte como un solo archivo y se ve sin Python») — el proyecto grande, aparte.

### Revisión: el algoritmo a la vista (etapas)

Con el ejemplo del algoritmo genético, el diagrama enseñaba el programa como constantes y una llamada, y cada función como una columna de sentencias: el algoritmo no se veía. Ahora `flappy_ga.py` nombra sus fases con comentarios de sección (Población inicial · Evolución: Probar, Juzgar, Criar, Relevo · Resultado; y en `volar`: Preparar el vuelo · Volar: Decidir y moverse, La tubería avanza, Tubería superada, ¿Sigue vivo? · Aptitud). El lienzo las dibuja como **etapas** plegables (ver `spatial-grammar.md`).

Qué cambia para una lección:

- **Las anclas no cambian.** Los rótulos son comentarios, y las anclas se atan por el texto de las sentencias: el guion de `flappy_ga` sigue valiendo tal cual.
- **Un momento abre la etapa de su ancla** y la cierra al pasar al siguiente, para que la nota apunte a la sentencia de la que habla. Una etapa que el usuario abrió o cerró a mano no se toca.
- **El cursor del paso a paso** y las notas de lo que no se ve caen en la **etapa plegada** que lo tiene dentro, no en el bucle que la envuelve.
- **Lo que deja una etapa plegada** enseña su valor en cada paso (con el pulso de llegada al cambiar). Se ve, por ejemplo, `altura` al mover el pájaro sin abrir la fase.
- **La construcción progresiva** enciende una etapa en cuanto se ejecuta algo de lo que tiene dentro.
- **La función principal** (`entrenar`) se ve desplegada en el programa, así que el paso a paso ya no salta a una vista aparte para ella. Sí entra en `volar` o en `Pajaro.decidir`, y vuelve al programa al salir.
- **«Explicar un tema»** pide al modelo que nombre las fases del código que escribe con comentarios de sección, y **«Proponer etapas con IA»** las añade a un archivo que no las tiene, siempre revisadas por el usuario antes de escribirse.

**Mover una nota a mano ya no reescribe el guion.** Antes se guardaba su posición volviendo a escribir el `.lesson.json` entero con `JSON.stringify`. Eso deshacía el formato de quien lo escribió y dejaba un archivo que `prettier --check` (y con él `pnpm verify`) rechazaba. Ahora `moveNoteIn` (`src/lesson.ts`) localiza en el texto la nota de ese momento y cambia **solo** su `offset`:

- lo añade como una línea más con la sangría de las demás propiedades (o detrás, si la nota va en una sola línea);
- lo reescribe en su sitio si ya estaba;
- lo quita con su coma.

El resto del archivo queda igual, byte a byte (también los saltos de línea de Windows).
