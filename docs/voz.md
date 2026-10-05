# Voz y JEV: dictar el programa

El requerimiento (RGS-01): el usuario **dicta** lo que quiere y el sistema lo convierte, de forma continua, en código Python, en nodos y cajas del diagrama, en movimientos de cámara y en una explicación hablada. Cada decisión de estructura la toma el **motor JEV**.

Este documento recoge lo que se comprobó antes de empezar, las decisiones tomadas, la arquitectura y las fases. Sigue el mismo método que `lecciones.md`: hitos pequeños que se pueden probar, y medir en vez de opinar.

## 1. Lo que se comprobó antes de diseñar

- **JEV es Jev, de TypeSafe AI.** Es un modelo de decisión, no de texto. Recibe un **estado** y unas **preguntas tipadas** y devuelve respuestas con probabilidades:
  - `noul`: una pregunta de sí o no; devuelve una probabilidad de 0 a 1.
  - `choice`: elegir una opción de una lista (hasta 255); devuelve la elegida, la probabilidad de cada una y una confianza.
  - `score`: puntuar en una escala ordenada de 2 a 10 niveles.
- **Es determinista y rápido.** El mismo estado y la misma pregunta dan la misma respuesta, y contesta en 70–500 ms. Todas las preguntas de una petición se evalúan a la vez.
- **No genera texto.** No puede escribir el cuerpo de una función ni una explicación. Sus propias guías lo usan para elegir entre conjuntos cerrados y dejan el texto libre a otro modelo.
- **Su API**: `POST https://api.typesafe.ai/v1/systemone`, con `Authorization: Bearer <clave>` y un cuerpo `{ state, model, questions }`. Errores: 401 (clave), 422 (petición mal formada), 429 (límite), 529 (saturado).
- **Un webview de VS Code no puede usar el micrófono** (VS Code lo bloquea), y el dictado integrado de VS Code no ofrece API a las extensiones. El audio lo tiene que capturar un proceso auxiliar de la extensión.
- **La voz sintetizada sí funciona en el webview** (`speechSynthesis`); ya la usa la narración de las lecciones.

## 2. Decisiones tomadas (con el usuario)

| Decisión                    | Elegido                                                                                                                                                                                 |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Qué es JEV y cómo se accede | El Jev de TypeSafe, con clave propia de `api.typesafe.ai`. La clave la guarda el usuario en el llavero de VS Code.                                                                      |
| Transcripción de la voz     | Un servicio en la nube en streaming (fase V2).                                                                                                                                          |
| De dónde sale el contenido  | **Estructura ya, contenido después**: el JEV coloca la caja al instante, marcada como «generándose»; el código y la explicación los escribe después la IA generativa que ya usa Prysel. |
| Por dónde empezar           | **Texto → JEV → diagrama**: primero el núcleo con órdenes escritas; después, el micrófono.                                                                                              |
| Cámara (RF-07)              | Zoom, traslación y foco. El lienzo no gira: no lo admite y un diagrama girado se lee peor.                                                                                              |

## 3. Arquitectura

Dos velocidades, porque el límite de 800 ms (RNF-01) solo se puede cumplir si en el camino crítico no hay un modelo generativo:

```
orden (texto; después, voz)
   │
   ▼
motor JEV ── una sola petición a Jev con todas las preguntas ──▶ decisión
   │                                                             (acción, pieza, lugar, objetivo, confianza)
   ▼
camino rápido (≤ 800 ms)                    camino lento (segundos, en segundo plano)
  · edición del Python (acción del lienzo)    · la IA generativa escribe el código de la pieza
  · el diagrama se rehace desde el código     · se valida que es la pieza que decidió el JEV
  · la cámara va a lo nuevo y lo resalta      · sustituye a la plantilla en una sola edición
  · la voz dice qué se ha hecho               · la voz explica lo que quedó
```

**El motor JEV** (`packages/extension/src/jev/`):

- **Estado**: la orden, lo que se está viendo (el programa o una función), el paso seleccionado y la lista de pasos, funciones y etapas que se ven, cada uno con un identificador corto.
- **Preguntas**, todas en una petición:
  - `es_orden` (`noul`): ¿es una orden, o charla y ruido?
  - `accion` (`choice`): añadir, etapa, eliminar, renombrar, enfocar, explicar, plegar, ejecutar, paso a paso, deshacer, rehacer u otra.
  - `pieza` (`choice`): qué se añade (variable, bucle, decisión, función…): las plantillas del lienzo.
  - `donde` (`choice`): al final, tras el seleccionado, tras un paso, dentro de un bucle o de una función, o en un camino de una decisión.
  - `objetivo` (`choice`): a qué paso, función o etapa se refiere.
- **Resolución determinista**, con umbrales fijos sobre la confianza:
  - por debajo de 0,5 en `es_orden`, no se hace nada;
  - con la acción poco clara, **se pregunta** enseñando las dos más probables (no se adivina);
  - lo destructivo (eliminar) exige más confianza que lo demás.
- **Salida**: una directiva con la acción del lienzo (`NodeAction`, el vocabulario que ya existe), qué enfocar, qué decir y, si hace falta, qué contenido queda por generar.

**El código es la única fuente de verdad** (RNF-03). El JEV no toca el lienzo: emite una acción que se escribe en el Python, y el lienzo se rehace desde ahí, como siempre. Cada edición lleva la versión del documento contra la que se decidió; si el texto cambió entre medias, se descarta y no se aplica a medias.

**Lo que está generándose vive en el código**, como un comentario estructurado: `# prysel:gen:<id>` en la primera línea de la plantilla. El analizador lo reconoce (no es una nota) y el nodo se dibuja rayado. Si la conexión se cae o se cierra VS Code a mitad, el estado no se pierde ni queda incoherente: al volver, una marca sin generación en curso se retira y queda la plantilla.

## 4. Fases

| Fase   | Qué                                                                                                                   | Hecho cuando                                                                |
| ------ | --------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| **V1** | Órdenes por texto → JEV → diagrama, cámara y voz. Contenido generado en segundo plano. Medida de latencia a la vista. | Una orden escrita añade su pieza en el sitio decidido y se ve cuánto tardó. |
| **V2** | Micrófono (proceso auxiliar) y transcripción en streaming.                                                            | Lo dictado llega como texto parcial y final a la misma tubería de V1.       |
| **V3** | Detección de voz e interrupción: la explicación hablada se corta si el usuario vuelve a hablar.                       | Hablar encima de la explicación la calla en menos de 200 ms.                |
| **V4** | Contenido en streaming y sincronía fina entre voz y foco (RF-09).                                                     | El texto generado se ve llegar y cada frase hablada enfoca lo que nombra.   |
| **V5** | Endurecer: caídas de red, reintentos, paridad de estado bajo fallos, 60 FPS medidos.                                  | Las pruebas de caos pasan y hay medidas de FPS.                             |

## 5. V1: órdenes por texto (hecho)

Lo que hay:

- **Cliente de Jev** (`src/jev/client.ts`): la petición HTTP con `fetch` inyectable (las pruebas nunca llaman a la red), cada fallo con su motivo (clave, petición, saturado, red, plazo) y un solo reintento si está saturado.
- **Motor** (`src/jev/engine.ts`): el catálogo de lo que se puede nombrar, las preguntas y la resolución con umbrales. Puro: con un decisor de mentira se prueba entero.
- **Decisor local** (`src/jev/local.ts`): la misma interfaz, por palabras clave, determinista. Sirve para las pruebas y para ver la tubería sin clave (ajuste `prysel.jevEngine: "local"`). No entiende, reconoce; en la caja se dice siempre quién decidió.
- **Contenido** (`src/jev/fill.ts`): pide a la IA generativa el código de la pieza y no lo acepta sin comprobar: Python válido, una sola sentencia y la pieza que decidió el JEV (un `for` sigue siendo un `for`). Un intento y una reparación; si no vale, se queda la plantilla.
- **La marca en el código**: `# prysel:gen:<id>` en la primera línea de la plantilla (`ProgramNode.generating`, y las ediciones `fillGenerated` y `clearGenerating`). Si alguien toca la plantilla antes de que llegue el contenido, lo escrito a mano manda: solo se quita la marca.
- **Consentimiento**: antes de la primera orden en un espacio de trabajo se dice qué sale del equipo (a TypeSafe, la orden y la primera línea de cada paso; a la IA generativa, el código del archivo).
- **Lienzo**: la caja de órdenes (`webview/src/CommandBar.tsx`), el foco de cámara con su anillo (`spotlight` en `Canvas`), la voz que dice lo que se hizo (se calla al escribir) y la latencia de cada orden.

Lo que una orden puede pedir: añadir una pieza (cualquier plantilla, al final, al principio, después o dentro de algo, o en un camino de una decisión), empezar una etapa, eliminar, renombrar, ir a ver algo, que se explique, plegar o abrir, ejecutar, paso a paso, deshacer y rehacer.

**Cómo probarlo**: «Prysel: Configurar la clave de TypeSafe», abrir el lienzo de un `.py` y escribir en la caja de abajo (o dictar con Win+H). Sin clave, la caja ofrece configurarla.

Decisiones que conviene recordar:

- **El nombre nuevo no lo saca Jev.** Jev elige entre opciones; no copia texto. El nombre de «renombra total a suma» y el título de una etapa se sacan de la orden con reglas (`nameIn`, `titleIn`).
- **Deshacer y las marcas.** El contenido generado entra en la historia del lienzo como un cambio más: deshacer una vez vuelve a la plantilla (con su marca), y otra la quita. Una marca huérfana solo se limpia sola la primera vez que se mira un archivo (se cerró VS Code a medias); después no, para no pelearse con deshacer.

## 6. Órdenes complejas: la IA generativa redacta, el JEV decide y juzga (hecho)

Una plantilla por orden se queda corta: «escribe un algoritmo que calcule la media de las notas y avise si pasa del límite» no es una pieza. Para eso las dos herramientas se reparten el trabajo, cada una en lo que sabe hacer:

|                     | JEV (Jev de TypeSafe)                                                                         | IA generativa (DeepSeek, Anthropic o la de VS Code)                                                  |
| ------------------- | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Qué es              | Un juez: elige entre opciones y da probabilidades. Determinista, décimas de segundo.          | Un redactor: escribe texto y código. Segundos, y puede equivocarse.                                  |
| Antes de escribir   | Decide qué clase de orden es (una pieza, un algoritmo, varias órdenes), dónde va y sobre qué. | Parte una orden larga en órdenes sencillas.                                                          |
| Al escribir         | —                                                                                             | Redacta el código, ya partido en **etapas** (comentarios de sección) para que el diagrama lo cuente. |
| Después de escribir | Juzga lo escrito: **¿cumple la orden?**, **¿es seguro?**                                      | Corrige, si el juez dice que no cumple (una vez).                                                    |

El recorrido de una orden:

```
orden ──▶ JEV: ¿es una orden? ¿varias? ¿qué pide? ¿qué pieza? ¿dónde? ¿sobre qué?   (una petición)
            │
            ├─ una pieza ───────▶ plantilla al instante (≤ 800 ms) ──▶ la IA escribe su contenido
            │
            ├─ un algoritmo ────▶ la IA lo redacta ──▶ ¿es Python? ──▶ JEV: ¿cumple? ¿seguro?
            │                                                           ├─ sí ──▶ se escribe, de una vez
            │                                                           ├─ no cumple ──▶ se corrige (una vez)
            │                                                           └─ no es seguro ──▶ no se escribe
            │
            └─ varias órdenes ──▶ la IA las separa ──▶ cada una vuelve al JEV, por orden
```

Reglas:

- **La IA generativa nunca escribe en el archivo por su cuenta.** Todo pasa por el analizador (Python válido) y por el juicio del JEV, con umbrales fijos (`COMPOSE_THRESHOLDS`: cumple ≥ 0,6; seguro ≥ 0,7).
- **Lo que no es seguro no se corrige ni se escribe**: código que borra archivos, usa la red o lanza programas sin que la orden lo pida.
- **Cada trozo de una orden partida es una orden más**: vuelve a pasar por el motor, con sus mismos umbrales. Si un trozo no se entiende, se para ahí (seguir sería hacer otra cosa que la pedida).
- **El algoritmo llega al diagrama con sus etapas**: al redactor se le pide un comentario corto antes de cada fase; el analizador las reconoce y el lienzo las enseña como tarjetas.
- **Añadir algo que no es una pieza de las de siempre** («añade lo necesario para saludar») ya no pregunta «¿qué añado?»: se manda escribir. Sin IA generativa, sigue preguntando.
- **La lección narrada** («hazme una lección de este programa») lanza «Explicar este archivo con IA» y su reproducción paso a paso: es la animación, anclada a la traza real.

El plazo de 800 ms vale para la decisión y para lo que se ve al instante (la plantilla, o el aviso de que se está pensando el primer paso). Un algoritmo no llega de golpe: **se construye paso a paso** (siguiente sección).

Dónde está: `src/jev/compose.ts` (`splitOrder`, `composeCode`, `judgeCode`), `addCode` en `@prysel/python/edits`, y `src/ai/deepseek.ts`.

**DeepSeek**: «Prysel: Configurar la clave de DeepSeek» guarda la clave en el llavero y pone `prysel.aiProvider` en `deepseek` (con `auto` ganaría el modelo de VS Code, si hay uno). El modelo se cambia con `prysel.deepseekModel` (por defecto, `deepseek-chat`). Vale para todo lo que usa IA generativa en Prysel: lecciones, etapas y órdenes.

## 7. Construir paso a paso, mientras se explica (hecho)

Un algoritmo que aparece entero no enseña nada. Una orden compleja se arma a la vista, en el orden en que alguien lo explicaría: «una función que sume dos números» es el primer número, el segundo, la función, lo que devuelve, el resultado.

```
IA generativa (streaming) ──▶ un paso por línea: { nivel, code, say }
        │  en cuanto una línea se cierra, sin esperar al resto
        ▼
JEV, por cada paso ──▶ ¿es seguro? · ¿se enseña de cerca o en su conjunto? · ¿merece una pausa?
        ▼
se escribe en el archivo (Python válido tras cada paso) ──▶ el diagrama se rehace
        ▼
el nodo aparece (él, y lo de dentro, uno tras otro) · la cámara va a él · la voz dice su frase
        ▼
se espera lo que tarda en decirse ──▶ siguiente paso
```

- **Un paso es una sentencia y su frase.** De una sentencia compuesta (`def`, `for`, `if`…) se dicta solo la cabecera; nace con un `pass` que su primer paso de dentro sustituye. Así el archivo es un programa válido en todo momento.
- **Los pasos llegan en el orden del archivo**, y cada uno se escribe al final de lo que ya hay (`BuildPlan`): lo anterior no se mueve, y no hay que recolocar nada.
- **El JEV va entre paso y paso** (`judgeStep`): es rápido y determinista, cabe ahí. Decide si el paso es seguro (si no, la construcción se detiene), si la cámara se acerca a la pieza o enseña el conjunto, y si es una idea clave que merece una pausa. Al final juzga el conjunto: ¿cumple la orden?
- **Se puede interrumpir**: el botón «Detener», la tecla Esc o dar otra orden cortan el streaming y la construcción. Lo escrito hasta ahí se queda (es un programa que funciona) y se deshace paso a paso.
- **La entrada de cada nodo** (`data-born`): la pieza sube y toma cuerpo, y su nombre, sus campos y sus valores entran detrás, uno tras otro. Con «reducir movimiento», solo aparecen.
- **Lo que no se arma así** (`elif`, `try`, `match`, `class`) se le pide al redactor que lo evite; si aun así lo dicta, la construcción se detiene y lo dice.

Dónde está: `src/jev/build.ts` (`StepStream`, `BuildPlan`, `judgeStep`, `paceOf`), `src/ai/stream.ts` (streaming de DeepSeek, Anthropic y los modelos de VS Code) y `runCompose` en `src/extension.ts`.

**Elegir los modelos**: el botón con el nombre del modelo, en la caja de órdenes (o «Prysel: Elegir los modelos»), abre una lista con la IA que redacta (DeepSeek, Anthropic, cada modelo instalado en VS Code, o automático) y el motor que decide (Jev o el local). Lo que no tiene clave lo dice, y la pide al elegirlo.

## 8. Pensar por partes: el director (hecho)

Una sola llamada grande al principio hace esperar sin ver nada, y si su respuesta no sirve no queda nada. El trabajo se reparte en llamadas pequeñas, cada una con lo que hace falta saber en ese momento, y entre ellas el diagrama ya va cambiando (`src/jev/director.ts`):

| Paso           | Quién                                 | Qué hace                                                                           | Qué se ve mientras                                            |
| -------------- | ------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| 1. Repartir    | JEV                                   | Qué clase de orden es, dónde va, y si es pequeña (directa) o grande (con esquema). | «Decidiendo…»                                                 |
| 2. Contexto    | JEV                                   | Qué trozos del programa hay que leer para esta orden.                              | «Leyendo lo que ya hay…»                                      |
| 3. Plan        | IA (streaming)                        | Las etapas, a grandes rasgos. Sin código.                                          | Cada etapa aparece como una tarjeta con su título y un hueco. |
| 4. Cada etapa  | IA (streaming), una llamada por etapa | Sus pasos, con el plan y lo ya escrito delante.                                    | «Etapa 2 de 3 · Calcular la media…»                           |
| 5. Cada paso   | JEV                                   | ¿Es seguro? ¿De cerca o en su conjunto? ¿Merece una pausa?                         | El nodo aparece, la cámara va a él, la voz lo cuenta.         |
| 6. El conjunto | JEV                                   | ¿Cumple lo que se pidió?                                                           | «Hecho, en 6 pasos.»                                          |

- **Lo pequeño se salta el plan** (una función sencilla, unas pocas sentencias) y va directo a los pasos.
- **El hueco de una etapa** es una pieza marcada (`...  # prysel:gen:<id>`) bajo su rótulo: el primer paso de la etapa la sustituye. Si se detiene antes, las marcas que queden se retiran.
- **Nunca «hecho, en 0 pasos».** Los pasos se sacan de la respuesta vengan como vengan (`ObjectStream`: uno por línea, en una lista con sangría, entre vallas, envueltos en otro objeto). Si aun así no hay ninguno, se le pide otra vez diciéndole qué se espera; y si insiste, se dice qué contestó.

### El contexto (`src/jev/context.ts`)

- Un programa corto (hasta 6000 caracteres) se manda entero, **con sus números de línea**.
- Uno largo se parte en trozos con sentido (cada función o clase; cada tramo de sentencias sueltas) y se manda: el **índice** de todo el archivo, los trozos **obligados** (donde se escribe, lo seleccionado, lo último que se hizo) y los que el **JEV** dice que hacen falta para esa orden. Se le pregunta por todos a la vez, en una petición.

### Cambiar lo que ya está escrito (`src/jev/modify.ts`)

«Ahora que reste en lugar de sumar», «refactoriza esto». El JEV decide que es un cambio y sobre qué: lo que se nombra, lo seleccionado o **lo último que se hizo** («eso», «lo de antes»). La IA no reescribe el programa: dicta cambios pequeños que nombran las sentencias por su número de línea.

- `cambiar` (una sentencia pasa a ser otra; de una compuesta, solo su cabecera), `quitar` y `añadir` (detrás de una sentencia, o dentro de ella).
- Los números de línea son los del programa de antes de empezar; `LineMap` los traduce a donde está cada cosa tras los cambios ya hechos.
- Cada cambio se juzga, se escribe y **se ve**: lo que cambia recibe un barrido de luz y late una vez; lo que se quita se despide antes de irse (se apaga y encoge); lo que se añade entra como cualquier pieza nueva.

### Preguntar bien (`src/jev/ask.ts`)

Cuando el motor duda, la pregunta de plantilla aparece al instante y, en cuanto está lista, la sustituye una concreta: la IA generativa lee la orden, el programa y las dudas del JEV y propone de dos a cuatro salidas, cada una escrita como una orden completa. El JEV comprueba cada salida (la decide como si se hubiera dicho) y solo se ofrecen las que el motor sabe cumplir.

## 9. Proactivo y visual (hecho)

- **Lo que se escribe en la caja es una orden.** No se le pregunta al JEV si lo es, y nunca se contesta «no lo tomé como una orden» (eso queda para lo que se oiga de pasada, cuando haya micrófono). Con una IA que redacte, una orden poco clara se toma por su lectura más probable —salvo que destruya algo: eso sí se pregunta— y, si no encaja en nada, como algo que construir. «Una red neuronal artificial», sin verbo, se construye.
- **Primero el plan, casi siempre.** Solo lo claramente pequeño va directo a los pasos. El rótulo de cada etapa lleva su «qué» (`# Calcular la salida: Suma ponderada de las entradas y activación`), y el lienzo lo enseña bajo el título de la tarjeta: el plan se lee en el diagrama antes de que haya código.
- **La IA pensando, en el diagrama.** Mientras decide, lee o piensa una etapa, un nodo «La IA está pensando…» cuelga de donde está trabajando (el hueco de esa etapa) y dice en qué anda; los huecos respiran. Con el archivo vacío, se dice en el centro del lienzo.
- **Ayudas visuales** (`src/jev/visual.ts`): nodos que no son parte del programa pero ayudan a entenderlo. Un paso puede traer la **curva** de la función que usa (una sigmoide) o una **tabla** de valores; el lienzo la dibuja al lado, con borde discontinuo. Se guarda como una marca al final de la línea (`# prysel:ver curva «Sigmoide» y = 1/(1+exp(-x)), x de -6 a 6`, `ProgramNode.aid`), así que no se pierde y se puede borrar a mano. La fórmula la propone un modelo, así que **no se ejecuta**: la lee un intérprete propio que solo sabe de números, `x`, las operaciones de siempre y unas pocas funciones (`exp`, `log`, `sqrt`, `sin`, `cos`, `tan`, `tanh`, `abs`, `max`, `min`). Lo que no entiende, no se dibuja.

### Entender un tema: el programa como pizarra

«Explícame cómo funciona la reproducción humana» no es una pregunta sobre el programa, y contestaba «Dime a qué te refieres: selecciónalo o nómbralo». El fallo no era de comprensión sino de repertorio: «explicar» solo sabía explicar un elemento del diagrama, y sin elemento se rendía. Lo que cambia:

- **Una intención nueva, `ensenar`**: querer entender un tema, un concepto o cómo funciona algo que no está en el programa. Y «explicar» sin nada que señalar en el programa es lo mismo: no se usa lo que casualmente esté seleccionado (para eso está decir «esto»).
- **Se responde construyendo**: un programa pequeño que modela el tema, con su plan primero (las partes de la explicación, como tarjetas) y luego cada parte, paso a paso, con voz y ayudas visuales. A la IA se le dice que el programa es su pizarra (`teachingNote`): las etapas son las de la explicación, los nombres salen del tema y cada frase cuenta qué pasa en la realidad, no la sintaxis.
- **Va al final del programa**, no dentro de lo seleccionado.
- **Si lo que se quiere entender sí está en el programa** (el JEV lo señala), se explica ese elemento, como antes.
- **Una regla general contra los callejones sin salida**: cuando el motor no puede cumplir una orden y la IA solo encuentra una lectura posible de lo que se dijo (y el JEV la da por cumplible), no se pregunta: se hace.

## 10. Medidas

RNF-01 pide ≤ 800 ms desde el final de la orden hasta la mutación visible. Cada orden enseña dos cifras: lo que tardó el motor en decidir y el total, desde que se pulsa Intro hasta que el cambio está pintado.

| Qué                                                                 | Cuánto                                                           | Cómo se midió                                                                                          |
| ------------------------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Todo lo que no es Jev, en el anfitrión (`flappy_ga.py`, 142 líneas) | ~12 ms: analizar 5,8 · decidir 0,7 · editar 0,1 · reanalizar 5,7 | En las pruebas, con el decisor local, en caliente. Hay una prueba que lo limita a 150 ms.              |
| De la decisión al cambio pintado, en el lienzo                      | 50–100 ms                                                        | En el navegador, con un anfitrión de mentira y un Jev simulado de 250 ms: totales de 296–346 ms.       |
| Con Jev de verdad                                                   | pendiente                                                        | Se anotará con la clave del usuario. Si Jev contesta en 70–500 ms, el total esperado es de 150–650 ms. |
