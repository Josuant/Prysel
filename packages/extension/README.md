# Prysel

El comportamiento de tu código Python, visible y editable en un lienzo dentro de VS Code.

- **Abrir el lienzo:** «Prysel: Abrir lienzo» (paleta de comandos) con un archivo `.py` activo. Cada sentencia es un nodo; lo que cambias en el lienzo se escribe en el archivo.
- **Ejecutar:** «Prysel: Ejecutar el archivo», o los botones del lienzo. Cada nodo muestra su estado, el tipo y la forma de lo que produce, y sus valores se pueden fijar en visores (tablas, figuras, curvas). Los bucles se recorren vuelta a vuelta y las cadenas de métodos (`df.groupby(...).sum()`) se ven paso a paso.
- **Paso a paso:** «Prysel: Reproducir el programa paso a paso» (o el botón «▶ Paso a paso»). El programa se graba línea a línea y se recorre en el lienzo, hacia delante y hacia atrás: un anillo marca el nodo por el que va, los chips enseñan lo que valía cada nombre en ese paso, y la barra de abajo muestra la pila, las variables y lo impreso (← → y Espacio en el teclado).
- **Lecciones:** un `.lesson.json` junto al `.py` (`factorial.py` → `factorial.lesson.json`) añade notas a mano al diagrama y las cuenta en su momento de la ejecución. «Prysel: Crear o abrir la lección de este archivo» crea uno de partida; hay un ejemplo en `examples/lecciones`. El formato está descrito en `docs/lecciones.md`.
- **Explicar este archivo:** «Prysel: Explicar este archivo con IA (genera su lección)» graba la traza y le pide a un modelo que la explique, ancla por ancla, sobre lo que de verdad pasó; nada se guarda si no pasa la validación. Proveedor en `prysel.aiProvider` (`auto`, `vscode` o `anthropic`); la clave de Anthropic se guarda con «Prysel: Configurar la clave de Anthropic» (nunca en un ajuste de texto).
- **Entender:** al reproducir, los botones «Entender» enseñan la tabla de variables, la pila de llamadas, el árbol de llamadas, la memoria (quién apunta a qué, con los alias a la vista) y las listas como celdas o barras con lo que cambió resaltado. Una lección también puede hacer preguntas («¿qué valdrá `total`?») y comprobar la respuesta con lo que de verdad pasó.
- **Intérprete:** el que elijas en la extensión de Python, o el ajuste `prysel.python`, o `python` del PATH. Ejecutar código exige confiar en el espacio de trabajo.

Los resultados de una ejecución solo viven en el lienzo: no se escriben en el archivo.

La letra de las notas es [Caveat](https://github.com/googlefonts/caveat), bajo la licencia SIL Open Font License 1.1 (`OFL-Caveat.txt`).
