# Prysel

El comportamiento de tu código Python, visible y editable en un lienzo dentro de VS Code.

- **Abrir el lienzo:** «Prysel: Abrir lienzo» (paleta de comandos) con un archivo `.py` activo. Cada sentencia es un nodo; lo que cambias en el lienzo se escribe en el archivo.
- **Ejecutar:** «Prysel: Ejecutar el archivo», o los botones del lienzo. Cada nodo muestra su estado, el tipo y la forma de lo que produce, y sus valores se pueden fijar en visores (tablas, figuras, curvas). Los bucles se recorren vuelta a vuelta y las cadenas de métodos (`df.groupby(...).sum()`) se ven paso a paso.
- **Intérprete:** el que elijas en la extensión de Python, o el ajuste `prysel.python`, o `python` del PATH. Ejecutar código exige confiar en el espacio de trabajo.

Los resultados de una ejecución solo viven en el lienzo: no se escriben en el archivo.
