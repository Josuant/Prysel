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
