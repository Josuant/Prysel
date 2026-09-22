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
