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
