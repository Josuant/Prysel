# La experiencia de notebook en el lienzo

Análisis (2026-09-21) de qué hace falta para que Prysel sirva para ciencia de datos y algoritmos de IA como lo hace un Jupyter Notebook, pero en el lienzo 2D. Parte de una medición con cinco programas típicos: EDA con pandas y matplotlib, un pipeline de scikit-learn, un bucle de PyTorch, k-means y descenso de gradiente con NumPy, e inferencia con transformers y PIL (93 nodos).

## Lo que mostró la medición

- Todo se analiza (0 construcciones no soportadas), pero el 53 % de los nodos son un `transform.call` genérico y solo 3 son `output.display`. De cinco llamadas de dibujo, solo `plt.show()` cuenta como salida.
- `data.dataframe` está en el catálogo pero el analizador nunca lo emite: que `df.groupby(…).sum()` sea un DataFrame no se sabe sin ejecutar.
- **No hay ejecución.** La extensión analiza y edita; el nodo `output.display` enseña un `stats` de ejemplo, no datos. Sin motor de ejecución, un visor sería decoración.
- Cinco asignaciones con varios resultados (`train_test_split`, `plt.subplots`, `kmeans`…) no daban chips — **resuelto**, ver la gramática espacial («Varios resultados, un chip por nombre»).
- Un ternario y una cadena de métodos ya se ven y se editan como destino y valor (`assign`), con chips soltables en el valor. Una versión con estructura (`valor si condición si no otro`; una cadena en pasos) espera al motor de ejecución: su valor real es la vista previa de cada paso.

## La tesis

En Jupyter la unidad es la celda con su salida debajo. Aquí es **el nodo con su valor pegado**: cada chip lleva el tipo y la forma observados en el kernel (`df · DataFrame 1200×8`, `X_train · (120, 4)`), y los visores son ventanas que se abren desde los chips. El orden de lectura se conserva porque el diseño ya sigue el orden de ejecución. Como hay grafo de dependencias, se puede marcar qué está **desactualizado** tras una edición y re-ejecutar solo lo afectado: resuelve el estado oculto de los notebooks.

## Nodos propuestos

| Nodo                         | Qué muestra                                                                          | Qué escribe                                                                     |
| ---------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| **Visor**                    | Según el tipo: tabla, figura, imagen, tensor (mapa de calor), JSON, texto            | La llamada `display`/`plt.show` si existe; si no, un «pin» que no toca el `.py` |
| **DataFrame**                | Cabecera paginada, tipos, nulos, mini-histograma por columna                         | Selección de columnas, filtro, orden                                            |
| **Cadena de pasos**          | Cada método como un paso reordenable, con vista previa intermedia                    | La cadena completa                                                              |
| **Figura**                   | Un territorio con `plt.subplots` y las llamadas sobre `ax`; la imagen real al final  | Tipo de gráfico, ejes, títulos                                                  |
| **Modelo**                   | Hiperparámetros como campos o deslizadores, y estado (sin entrenar, entrenado)       | Los argumentos del constructor                                                  |
| **Métricas**                 | Accuracy, matriz de confusión, ROC                                                   | La llamada de la métrica                                                        |
| **Bucle de entrenamiento**   | Época i/N, curva de pérdida en vivo, deslizador para ver los chips en cada iteración | Nada (solo lectura)                                                             |
| **Imagen / tensor**          | Miniatura, canales, forma y dispositivo                                              | Nada                                                                            |
| **Nota** (`# %% [markdown]`) | Texto y LaTeX                                                                        | El comentario                                                                   |
| **Celda** (`# %%`)           | Un territorio con «ejecutar celda»                                                   | El marcador                                                                     |

## Funciones más allá de los nodos

Estados por nodo (al día, desactualizado, ejecutando, error, con el traceback anclado); modo reactivo opcional; caché persistente de nodos costosos; sugerencias con datos reales (columnas de `df`, archivos del proyecto); editor de argumentos generado desde `inspect.signature` (sustituye las listas fijas `IO_CALLS`/`DISPLAY_CALLS`); comparar antes/después o dos ejecuciones; barridos de hiperparámetros; coste por nodo; salida en un archivo aparte (`.prysel/`, ignorado por git); importar y exportar `.ipynb`.

Los tipos observados afinan el aspecto de un nodo, pero nunca cambian lo que significa el código.

## Riesgos

- **Tamaño:** imágenes y tablas chocan con el diagrama compacto. El visor es un chip con miniatura o sparkline y se expande a demanda; el kernel resume (cabecera, histogramas, PNG ya renderizado) y nunca envía arrays enteros.
- **Seguridad:** ejecutar código exige respetar Workspace Trust; el HTML de salida (`_repr_html_`) va en un iframe aislado.

## Orden y decisiones (por defecto: las recomendadas)

1. **Cimientos del análisis** (estático): chips con varios resultados ✔; ternario y cadena como nodos con estructura, junto al motor.
2. **Puente de ejecución:** kernel, ejecutar un nodo, resúmenes de tipo y forma, estados. Antes de decidir entre la API de la extensión Jupyter de VS Code y un `ipykernel` propio, una prueba corta con la API.
3. **Visor**, con render según el tipo y chips tipados. Los «pins» viven solo en el lienzo; se mapean las llamadas de salida existentes.
4. **Celdas, desactualizado y caché.** Ejecución manual con marcas; reactiva opcional por territorio.
5. **Nodos de dominio:** cadena de pandas, figura, modelo, bucle con deslizador.
6. **Barridos, comparación y coste.**

## Resultado de la prueba del motor (paso 2)

**Descartada: la API de kernels de la extensión Jupyter** (leída en `ms-toolsai.jupyter` 2025.9.1). `kernels.getKernel(uri)` solo devuelve un kernel si el usuario ya lo arrancó para un notebook o una Interactive Window (`userStartedKernel`); no arranca ninguno. Además exige confianza en el espacio de trabajo y un **diálogo modal de consentimiento** por extensión («¿conceder acceso a kernels?»), y solo entrega salidas MIME, sin tipo ni forma. Un `.py` normal no tendría kernel.

**Elegido: un motor propio y mínimo**, `packages/extension/runtime/prysel_runner.py` (solo biblioteca estándar) y su cliente `src/kernel.ts` (sin dependencia de `vscode`):

- Un proceso de Python con un espacio de nombres vivo; el protocolo son líneas de JSON por un **socket local** con clave (no por la entrada estándar: en Windows, una lectura bloqueada sobre esa tubería cuelga imports como el de numpy; se comprobó).
- Ejecuta un fragmento y devuelve la salida (en directo), el valor de la última expresión (como Jupyter), el resumen de **cada nombre que el fragmento define o muta** (asignaciones, imports, `def`, receptores de métodos: `model.fit(X)`, `xs.append(1)`) y las figuras de matplotlib como PNG. El grafo no tiene que saber qué cambia un bucle.
- Resúmenes por forma, sin importar las librerías: tipo, forma, dtype, dispositivo, bytes, muestra y rango de arrays/tensores; columnas con tipo y nulos y primeras filas de algo con `columns`/`dtypes`/`head`; miniatura de imágenes PIL. Nunca el dato entero.
- Errores con la **línea dentro del fragmento** (base 1): línea del archivo = línea donde empieza el nodo + línea − 1. Un `KeyboardInterrupt` (interrumpir) corta un bucle infinito y el motor sigue vivo; si el proceso muere, lo dice.
- Medido: arranque ≈ 130 ms; ida y vuelta ≈ 0,2 ms; importar numpy y resumir un array de 2000×2000 ≈ 140 ms, con una respuesta de ~130 bytes.
- Se ejecutó un programa real nodo a nodo (grafo → texto de cada sentencia de primer nivel → motor): cada chip trae tipo y forma (`X · (200, 2) float64`, `centers · (3, 2)`), incluidos los resultados múltiples y lo que cambia un bucle.

**Límites conocidos:** interrumpir no corta una llamada nativa larga (un `fit` de sklearn): habrá que ofrecer «reiniciar». `input()` acaba con `EOFError` (no hay entrada). El código de funciones anidadas y de compuestas se ejecuta entero: la granularidad es la sentencia de primer nivel. Falta elegir el intérprete (API de `ms-python`), empaquetar `runtime/` con la extensión, y conectar el cliente con el lienzo (estados por nodo, chips tipados).

## Paso 3: el motor conectado al lienzo

- **Qué se ejecuta** (`src/plan.ts`, puro): la unidad es la **sentencia de primer nivel** (una función, un bucle o una decisión corren enteros). El grafo da las dependencias entre ellas: lo que lee, las funciones que llama y —lo que un notebook no tiene— los **mutadores**: `pred = model.predict(X)` depende también de `model.fit(X)`, que no define ningún nombre. Pedir un nodo ejecuta lo pedido y, antes, lo que necesita y no está al día; «Todo» ejecuta todo.
- **Qué está al día:** cada sentencia guarda con qué texto corrió. Tras editar, los registros siguen a su sentencia aunque cambie de línea (se reasocian por el texto); lo editado vuelve a «sin ejecutar» y lo que lo lee, a **desactualizado**. Volver a ejecutar una dependencia deja atrás a quien corrió antes. Un error deja la sentencia en «falló» hasta que algo cambie, y detiene lo que quedaba.
- **Sesión** (`src/session.ts`): un motor por documento, peticiones encoladas, interrumpir (descarta lo que quedaba), reiniciar (todo vuelve a «sin ejecutar») y motor caído (olvida lo ejecutado y se recupera al pedir otra vez). Sin `vscode`, probada con un Python real.
- **En el lienzo:** botones «▶ Todo», «▶ Selección» (Mayús+Intro), «■ Parar», «↻ Reiniciar» y el estado del motor; «Ejecutar» en el menú de cada nodo. Cada nodo toma su estado de su sentencia (al día → completado, desactualizado → atención, ejecutándose, error) y el pie dice cuánto tardó y qué valor dejó. Los **chips llevan lo observado**: `X 200×2`, `labels (200)`, `#3` en una lista, y al pasar el puntero `ndarray 200×2 float64`. Un fallo lleva la selección a su nodo y abre el panel con la línea real del archivo.
- **Panel de salida** (`webview/src/OutputPanel.tsx`): del nodo seleccionado, el error con su traceback, lo que imprimió, el valor de cada nombre (tabla con tipos y nulos, muestra y rango de arrays, miniatura de imágenes) y las figuras. Solo texto, tabla e imagen `data:`: nunca HTML que venga del programa.
- **Protocolo:** `run {version, ids | 'all'}`, `interrupt`, `restart` (webview → extensión, validados: es ejecutar código del usuario; un `run` de una versión vieja del texto se descarta) y `runs {views, kernel, problem, version}` + `assets {seq, …}` (extensión → webview). Lo pesado (figuras, miniaturas) va aparte, una vez, por el orden de ejecución.
- **Extensión:** intérprete = `prysel.python`, si no el entorno elegido en la extensión de Python (API `environments`), si no `python`. Ejecutar exige confiar en el espacio de trabajo (`capabilities.untrustedWorkspaces: limited`).

**Comprobado:** 1020 tests (plan, sesión con Python real, protocolo) y el webview compilado corriendo contra un anfitrión simulado con una `Session` real (ejecutar todo, panel con figura, error con línea real, reiniciar). **Sin probar en un VS Code real:** el cableado de `extension.ts` (resolución del intérprete con `ms-python`, confianza del espacio de trabajo, cierre de documentos); solo está comprobado por tipos.

**Pendiente:** un estado propio «desactualizado» (hoy usa el de atención); empaquetar `runtime/` con la extensión; el nodo **Visor** en el lienzo (hoy la salida está en un panel); elegir qué ejecutar dentro de una función o un bucle (la granularidad es la sentencia de primer nivel).

## Paso 4: el Visor, el estado «desactualizado» y el resto de lo pendiente

- **Visor en el lienzo** (`ui/src/viewer.ts`, `flow/ViewerNode.tsx`, `webview/src/pins.ts`): una ventana con el valor que un nodo dejó al ejecutarse —tabla con tipos y nulos, figura, miniatura de una imagen, muestra y rango de un array, elementos de una lista—, colgada de su nodo por un cable. Se fija desde el menú del nodo («Ver «X» en un visor», «Ver la figura…») o desde el panel de salida; se quita con la ×, el menú o Supr. **No es código:** no escribe nada en el archivo; vive en el estado del webview, por archivo, y se ata a la sentencia por su texto (sigue a la sentencia aunque cambie de línea) o, si se editó en el mismo sitio, por su id. Se atenúa y se marca «Desactualizado» si el resultado quedó atrás, y dice «sin ejecutar» si se editó. Mide lo que enseña (`viewerSize`), con topes; una imagen se ajusta a su ancho sin ampliarse.
- **Estado propio «desactualizado»** (`NodeState 'stale'`): tokens nuevos (`state-stale`, `chip-stale-*`, un cian que no se confunde con el ámbar del aviso ni con el azul de la selección), icono propio y etiqueta «Desactualizado». Ya no reutiliza el de advertencia.
- **Un lienzo que se abre de nuevo** recibe las imágenes de lo ya ejecutado (`Session.allAssets`), y los visores fijados vuelven con ellas.
- **Empaquetado:** `dist/runtime/prysel_runner.py` (la compilación copia el motor junto al código), el cliente lo busca ahí y, en desarrollo, en `runtime/`; `.vscodeignore` deja fuera fuentes y pruebas. Un `.vsix` completo (con la dependencia de tree-sitter en un monorepo pnpm) sigue sin probarse.
- **El cableado de `extension.ts`, comprobado con una API de VS Code simulada** (`test/extension.test.ts`, con un Python real): abrir el lienzo, responder al «ready», ejecutar, pasar por «arrancando/ocupado/libre», descartar una petición sobre un texto que ya cambió, negarse a ejecutar sin confianza, resolver el intérprete por la API de la extensión de Python, un intérprete inexistente, reiniciar, cerrar el documento y mensajes mal formados. **Sigue sin probarse en un VS Code real:** la API de verdad (`ms-python`, Workspace Trust) solo está simulada.
- **Fallo preexistente arreglado:** las conexiones activas o fallidas se pintaban como polígonos (su regla CSS ponía relleno a la línea).

**Pendiente:** probar en un VS Code real y generar un `.vsix`; que un visor de una función o de un bucle enseñe el valor de cada vuelta (hoy solo el final); ejecutar una sola línea dentro de una función; el nodo **Cadena de pasos** (pandas) y el **Bucle de entrenamiento** con deslizador, que necesitan capturar valores por iteración.

## Paso 5: los valores por vuelta de un bucle

- **Motor** (`runtime/prysel_runner.py`): antes de ejecutar, cada bucle (`for`, `while`) del fragmento —también los de dentro de una función— se reescribe con un `try/finally` por vuelta que anota lo que valen los nombres que el bucle cambia (asignaciones, `+=`, la variable del bucle; no los receptores de llamadas). Los números de línea no se mueven, así que los errores siguen señalando lo mismo. El `finally` corre también con `break`, `continue` y una excepción: la última vuelta queda anotada aunque no acabe. Si la reescritura falla, se ejecuta el código de siempre.
- **Qué se guarda por vuelta:** un número si lo es (también un array o tensor de un solo elemento: la pérdida de un `.item()`), y si no una descripción corta (`ndarray 3×4`, `list #2`, `'ab'`, `True`). Nunca el dato entero.
- **Coste acotado:** las primeras 256 vueltas se guardan todas; después una de cada 2ⁿ (o cualquiera si pasó más de 0,25 s desde la última: un bucle lento anota todas), con un tope de 600 puntos (se descarta uno de cada dos y sube el paso). La última vuelta siempre se anota y es exacta. Los avisos van espaciados (150 ms), no uno por vuelta. Medido: un millón de vueltas de `t += i` tarda ≈ 0,37 s (frente a 0,07 s sin anotar), unos 0,3 µs por vuelta.
- **Un bucle dentro de una función anota cuando se la llama,** aunque sea en otra ejecución: la serie es del fragmento que la definió (`frag`), y la sesión la ata a esa sentencia por su texto. Se ve en la definición, no en la llamada.
- **Sesión:** `RunView.loops` (por `línea:columna` dentro de la sentencia). Sigue a su sentencia si cambia de línea, se olvida si se edita o se vuelve a ejecutar, o al reiniciar. Se ve a medias mientras el bucle corre.
- **En el lienzo:** el pie de un bucle dice cuántas vueltas dio; el panel de salida de un bucle tiene un **deslizador de vuelta** y, por cada nombre, su valor en esa vuelta y una curva pequeña con un punto en ella. Los **chips de dentro del bucle enseñan lo que valieron en la vuelta que se mira** (`loss 0.452`), y al pasar el puntero, «vuelta 5 de 40: 0.452». Cualquier curva se puede **fijar como visor** en el lienzo (`Ver la curva de «loss»`, o el botón «Curva»): una línea con su última vuelta, su mínimo y su máximo.
- **Comprobado:** 1093 tests (motor con Python real: nombres, `break`/`continue`, errores, no numéricos, anidados, función definida en otra ejecución, bucle largo, bucle lento; sesión; correspondencia nodo↔serie; curvas) y el webview contra un anfitrión simulado con un bucle de descenso de gradiente de 40 vueltas.

**Límites:** un bucle anidado solo conserva la serie de la última vuelta del de fuera; los valores son escalares o descripciones (no el tensor de cada vuelta); `async for` no se anota; los bucles de un código que se ejecuta con `exec` dentro del programa del usuario, tampoco. Solo se ve el bucle en el fragmento que lo define: un visor de curva de un bucle dentro de una función colgada de un panel plegado no se enseña.

**Pendiente:** el nodo **Cadena de pasos** (pandas) con vista previa por paso, y el **Bucle de entrenamiento** como nodo propio (época i/N y curvas en vivo dentro del propio territorio, hoy en el panel); probar en un VS Code real y generar un `.vsix`; ejecutar una sola línea dentro de una función.

## Paso 6: el bucle de entrenamiento, dentro de su territorio

Un bucle que ya dio vueltas lleva una **franja de vueltas** en la cabecera de su territorio (`ui/src/laps.ts`, `flow/LapsStrip.tsx`), entre su editor (`para epoch en range(40)`) y la cajita de variables. No hay que abrir ningún panel:

- **▶ reproducir:** recorre las vueltas de la primera a la última (una cada 110 ms) mientras los chips de dentro del bucle van cambiando de valor; se detiene con el mismo botón o al tocar el deslizador. Si se pulsa al final, empieza de nuevo.
- **Deslizador de vuelta** (`vuelta 8/40`): elige la vuelta que se mira. Es la misma que la del panel de salida: los dos se mueven a la vez.
- **Una curva por lo que vale la pena vigilar**, con un punto en la vuelta que se mira y su valor: `loss`, `precisión`, `error`, `score`, `reward`… primero, y luego el resto; como mucho tres; nunca la variable del propio bucle ni un contador (`0, 1, 2, …`).
- **En vivo:** mientras el bucle corre, la franja sigue la última vuelta (`vuelta 16/16 …`); al terminar queda en la última. Al volver a ejecutar, una elección de la ejecución anterior se descarta.
- La cabecera pide sitio para la franja solo cuando el bucle dio vueltas (`territoryHeadroom` suma `LAPS_HEADROOM`), así que el territorio crece lo justo y el resto del diagrama se recoloca con él.

Es el bucle de entrenamiento como nodo propio sin un nodo nuevo: cualquier `for`/`while` con números que cambian (descenso de gradiente, épocas de un modelo, una simulación) se recorre igual. Sigue siendo de solo lectura: no escribe nada en el archivo.

**Comprobado:** 1108 tests (curvas elegidas, geometría, formato, franja, cabecera del territorio) y el webview contra un anfitrión simulado: la franja aparece al ejecutar, reproducir avanza y para donde se le dice, los chips cambian con la vuelta, y en una segunda ejecución sigue en vivo hasta la última.

**Pendiente:** el nodo **Cadena de pasos** (pandas) con vista previa por paso; probar en un VS Code real y generar un `.vsix`; ejecutar una sola línea dentro de una función; un bucle anidado solo conserva la serie de la última vuelta del de fuera.

## Paso 7: la cadena de pasos

`df.groupby("mes")["monto"].sum().reset_index()` deja de ser un campo de texto y pasa a ser **una fila por paso**, cada una con lo que valía el resultado tras ella.

- **Qué es una cadena** (`python/src/semantics.ts`): un receptor y al menos dos pasos (una llamada `.groupby("mes")`, un índice `["monto"]` o un atributo `.dt`). Los atributos del principio (`os.path`, `self.model`) son el camino hasta el receptor, no pasos: `os.path.join(a, b)` sigue siendo una llamada. Se reconoce como valor de una asignación, de una sentencia suelta o entre paréntesis en varias líneas (cada trozo en una línea; si no, se enseña el código). Es un `ControlModel 'chain'` con `receiver` y `steps`, y el nodo sigue siendo lo que era (`transform.call`; una cadena que acaba en índice con un `<` ya no se toma por una condición). Cada trozo tiene su sitio en el texto (`receiver`, `steps[i].name`, `steps[i].args`, `chain`), y `ProgramNode.anchor` dice dónde empieza (línea y columna en bytes de UTF-8, como la cuenta Python).
- **Editar** (`python/src/edits.ts`, `morphology/src/chain.ts`): cambiar el método o los argumentos de un paso reescribe solo ese trozo (los argumentos pueden quedar vacíos: `.sum()` ↔ `.sum(axis=0)`); llevar un chip al **receptor** lo cambia; **subir, bajar, quitar y añadir** un paso reescriben la cadena (intercambiar dos pasos del mismo tipo solo intercambia sus textos, y una cadena en varias líneas conserva su formato mientras no cambie el número de pasos). Un paso nuevo se escribe como texto: `head(3)`, `.T` (atributo), `["col"]` (índice). Lo que no se puede escribir (un salto de línea, un nombre que no es un identificador) no toca nada. Los argumentos de un paso son texto con sugerencias, no una casilla donde soltar un chip: soltar uno reemplazaría todos los argumentos.
- **Vista previa por paso** (`runtime/prysel_runner.py`): antes de ejecutar, cada cadena que es el valor de una sentencia se reescribe para envolver cada paso en `__prysel_step__(…)`, que anota un resumen de lo que queda tras él y devuelve el valor tal cual. **Cada paso se evalúa una sola vez**: no se repite ninguna llamada ni su efecto (`fit`, `read_csv`, un contador). Un paso que falla deja anotados los que llegaron a evaluarse; una cadena de un bucle o de una función que se llama muchas veces se anota las primeras veces, de vez en cuando y, si es lenta, siempre. El resumen es ligero (sin contar nulos: `isna()` en cada paso de un DataFrame grande sería caro).
- **En el lienzo:** junto a cada paso, lo que quedó (`Tabla 3×2`, `Grupo`) con la ayuda (columnas, muestra); pulsarlo fija un **visor** de ese paso (la tabla con sus primeras filas), que se atenúa si el resultado quedó atrás. La cadena hereda todo lo demás: su resultado es un chip que se arrastra, su cable al receptor no se dibuja si el receptor ya lo nombra, y editarla la devuelve a «sin ejecutar».
- **Un fallo que encontré al probarlo:** los resúmenes anidados en un evento (evento → resumen → tabla → filas → fila) llegaban a 5 niveles y el motor aplanaba la última a texto; el visor de un paso se rompía y dejaba el lienzo en blanco. El motor ya admite 8 niveles, el visor tolera una fila que no es una lista, y el lienzo y el panel llevan un **límite de errores** (`ErrorBoundary`): si algo de lo que dibujan falla, dicen qué pasó y se recuperan solos con el siguiente estado, en vez de dejar la pantalla vacía.

**Comprobado:** 1183 tests (reconocimiento y descarte de cadenas, edición, geometría, la fila y sus herramientas, el motor con Python real —incluido que no repite ningún paso— y la sesión) y el webview contra un anfitrión simulado con una tabla de juguete: pasos con su vista previa, fijar un paso, subir, bajar, quitar, añadir y cambiar el método, comprobando el texto resultante. **Sin probar con pandas real** (no está instalado aquí): la cadena de un DataFrame de verdad usa el mismo camino que la tabla simulada.

**Pendiente:** probar en un VS Code real y generar un `.vsix`; ejecutar una sola línea dentro de una función; una cadena dentro de un `return` no se enseña como pasos (un `return` tiene su propio editor); soltar un chip en los argumentos de un paso; un bucle anidado solo conserva la serie de la última vuelta del de fuera.

## Paso 8: el `.vsix` y la prueba en un VS Code de verdad

- **Empaquetado autocontenido:** `pnpm package:extension` genera `packages/extension/prysel.vsix` (12 archivos, ≈ 420 KB). Sin dependencias en tiempo de ejecución: tree-sitter va **dentro** de `dist/extension.js`, sus dos wasm (`tree-sitter.wasm`, `tree-sitter-python.wasm`, ≈ 650 KB) en `dist/wasm`, el motor de Python en `dist/runtime` y el webview en `dist/webview`. El código carga los wasm de `dist/wasm` si están y, si no (desarrollo, pruebas), de `node_modules`. Las dependencias pasaron a `devDependencies` (se empaquetan con esbuild) y `vsce` corre con `--no-dependencies`; el `pnpm-lock.yaml` cambia en consecuencia.
- **Comandos nuevos** (paleta): «Prysel: Ejecutar el archivo», «Interrumpir la ejecución» y «Reiniciar el motor», además de «Abrir lienzo». Ejecutar el archivo funciona sin abrir el lienzo. `activate()` devuelve una pequeña API (`state(uri?)`: parser, motor, estado de cada sentencia, salida, webviews que cargaron, documento y sesiones) para otras extensiones y para las pruebas.
- **Prueba de extremo a extremo** (`packages/extension/e2e`, `pnpm e2e:extension`): empaqueta el `.vsix`, lo **instala en un VS Code aislado** (carpetas de usuario y de extensiones temporales: no toca el del usuario) y lanza `Code.exe` con pruebas **dentro** del proceso de extensiones. No forma parte de `pnpm verify` (necesita VS Code y Python instalados; `VSCODE_EXE` y `PRYSEL_PYTHON` si no están en un sitio habitual). Comprueba: instalada y activada desde el `.vsix`, los cuatro comandos, un webview de verdad que carga y avisa, el parser cargado desde el wasm empaquetado, ejecutar todo (estados «al día» y salida), editar el archivo (lo que depende queda «desactualizado»), volver a ejecutar y reiniciar. Pasa.
- **Dos fallos que solo aparecieron en un VS Code real:**
  1. **El diagrama se vaciaba al pulsar sobre él.** Al dar el foco al lienzo (un webview), `onDidChangeActiveTextEditor` se dispara con `undefined` y la extensión olvidaba el documento que enseñaba. Ahora sin editor de texto se sigue con el mismo documento (y al cerrarse, pasa a lo que haya abierto). Con prueba de regresión.
  2. **Un parser que fallaba una vez no volvía a intentarse:** se guardaba la promesa rechazada para siempre. Ahora la siguiente petición lo reintenta y el motivo queda en `state().parser`.
- **Depurar un webview real:** VS Code admite `--remote-debugging-port`; con el protocolo de Chrome se lee el DOM y la consola del webview y se captura la ventana (`Page.captureScreenshot`) sin herramientas extra. Así se vio el lienzo real, dentro de VS Code y cargado desde el `.vsix`.

**No probado:** la extensión de Python de verdad (`ms-python`, `environments.getActiveEnvironmentPath`): el VS Code aislado no la lleva, así que se ejerció el ajuste `prysel.python`; la resolución por `ms-python` sigue probada solo con la API simulada. Tampoco se ha publicado en el Marketplace (`vsce publish` necesita un publicador y un token) ni hay icono `.png`.

**Observado, sin resolver:** en un panel estrecho (unos 370 px junto al editor) el diagrama ajustado a la vista queda muy pequeño. El «ajustar a la vista» reduce todo el programa a lo ancho; conviene un zoom mínimo o un ajuste por altura.

## Paso 9: el zoom del diagrama en un panel estrecho

**Qué pasaba:** la extensión abre el lienzo junto al editor, en un panel de unos 370 px. El diagrama se ajusta al ancho (se lee como un documento y se recorre hacia abajo), pero la distribución plegaba las filas a 1680 px pensando en una pantalla grande: en el panel estrecho el ajuste lo reducía a ≈ 0,2 y los nodos dejaban de leerse.

**Qué hace ahora** (`ui/src/fit.ts`, `Canvas`): el largo de fila (`maxRun` de la distribución) sale del ancho que tiene el lienzo. `runFor(ancho)` pide una fila que, a un zoom legible (0,75), ocupe justo ese ancho, en saltos de 80 px (redimensionar el panel no rehace el diagrama a cada píxel), sin bajar de 720 px (cabe una tarjeta de una línea de las más anchas) y sin cambiar nada en una pantalla grande (≥ 1260 px: la fila de siempre). Lo observa un `ResizeObserver`, así que también sigue al panel cuando se redimensiona. Solo en un lienzo de trabajo (que se ajusta al ancho); las ilustraciones y la galería no cambian. El programa gana en alto lo que pierde en ancho.

**Medido** con el mismo programa de 12 nodos:

| Ancho del lienzo               | Antes (zoom) | Ahora (zoom) |
| ------------------------------ | ------------ | ------------ |
| 374 px (panel junto al editor) | 0,21         | **0,40**     |
| 574 px                         | 0,33         | **0,64**     |
| 849 px                         | ≈ 0,50       | **0,73**     |
| 1474 px                        | 0,89         | 0,89 (igual) |

**Límite:** en 374 px una tarjeta de una línea de las más anchas (500–800 px con varios resultados o muchos argumentos) sigue quedando a ≈ 0,4: el diagrama se lee, pero con letra pequeña; más no cabe sin recortar el contenido. Para leer de cerca, el panel se puede ensanchar o pasar a densidad expandida.
