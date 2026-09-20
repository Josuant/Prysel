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

Una conexión no es una línea que une dos cajas: es una relación computacional, y de ella se derivan grosor, punta y curvatura. El color queda libre para el estado.

| Relación     | Significado                                         | Cómo se ve                                    |
| ------------ | --------------------------------------------------- | --------------------------------------------- |
| `dependency` | B usa el valor que produce A                        | Trazo fino con punta                          |
| `transform`  | El dato entra y sale distinto (el flujo principal)  | Trazo grueso: pesa más en el programa         |
| `branch`     | Una salida de una decisión                          | Trazo fino con su etiqueta encima             |
| `merge`      | Varias fuentes en un mismo destino                  | Convergen antes de entrar                     |
| `feedback`   | El control vuelve atrás                             | Discontinuo y por debajo: va contra el tiempo |
| `reference`  | Se alude a algo sin que fluya un dato (un `import`) | Punteado y tenue                              |

`branch` y `merge` comparten el trazo de una dependencia **a propósito**: lo que las distingue es la topología, no el estilo.

## Puertos con nombre

Éste era el problema concreto: cuando dos conexiones llegan al mismo nodo, no se sabe cuál alimenta qué.

La solución es que **los puertos no se declaran, se miden**. Cada editor marca sus campos conectables (`data-slot`), el nodo los mide tras el layout y dibuja un puerto a la altura exacta de cada uno. Una arista con `toPort` aterriza ahí.

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

## La prueba de densidad

«¿Se entiende?» es una opinión hasta que se mide. `analyze()` calcula las propiedades que la literatura de dibujo de grafos asocia a la legibilidad, y `generateProgram()` fabrica programas sintéticos con forma de script real (cadena principal, decisiones que se vuelven a juntar, bucles, imports, constantes compartidas). `node packages/spatial/scripts/density.ts` imprime la tabla.

| Pasos | Nodos | Solapes | Cruces/conexión | Hacia atrás | Nodo al encajar | Proporción | ms   |
| ----- | ----- | ------- | --------------- | ----------- | --------------- | ---------- | ---- |
| 6     | 15    | 0       | 0,00            | 0           | **136 px**      | 4,7:1      | 1,4  |
| 12    | 27    | 0       | 0,39            | 0           | 68 px           | 8,4:1      | 1,4  |
| 25    | 49    | 0       | 0,43            | 0           | 35 px           | 13,7:1     | 3,3  |
| 50    | 92    | 0       | 0,24            | 0           | 18 px           | 26,4:1     | 4,7  |
| 100   | 178   | 0       | 0,13            | 0           | 9 px            | 51,8:1     | 16,8 |
| 200   | 350   | 0       | 0,06            | 0           | 5 px            | 102,4:1    | 63,5 |

**Lo que aguanta:** ningún nodo se pisa a ningún tamaño, ninguna conexión de flujo va hacia atrás, los cruces por conexión _bajan_ al crecer el programa (0,43 → 0,06) y colocar 350 nodos tarda 64 ms.

**Lo que no:** «nodo al encajar» es el ancho que le queda a un nodo si el programa entero se mete en una pantalla de 1920×1080. Por debajo de unos 90 px un nodo deja de leerse, y eso ocurre **a partir de los 12 pasos**. La causa es estructural: una región lineal nunca se pliega, así que el lienzo solo crece a lo ancho y la proporción se dispara hasta 102:1.

Esto salió midiendo, no mirando: con seis nodos el diagrama parecía perfecto. La sección «La prueba de densidad» de la galería lo enseña con un programa generado de 20 pasos.

### Candidatos para resolverlo

1. **Plegado en serpentina.** Cuando una región lineal supera un presupuesto de ancho, salta a la fila siguiente — igual que un texto. Mantiene «se lee como una frase» y llevaría la proporción cerca de 1:1.
2. **Colapso automático por abstracción.** Un archivo largo no se enseña plano: sus funciones se colapsan y se entra en ellas. La gramática ya tiene la profundidad; faltaría decidir el umbral a partir del cual colapsa sola.
3. **Orientación vertical** para secuencias de pasos, como apunta la tabla original de topologías.

No son excluyentes: (1) arregla un script plano y (2) arregla un archivo con estructura.

## Lo que falta

- **El plegado de una región lineal larga** (ver la prueba de densidad): es la deuda que bloquea conectar un parser.
- `timeline` y `hub-and-spoke` como topologías propias (hoy caen en `pipeline` y `fan-out`).
- Orientación vertical para secuencias de pasos: la gramática asume horizontal.
- Enrutado de aristas que esquive nodos (hoy son curvas directas).
- Movimiento: la transición entre dos layouts cuando el programa cambia, que es la quinta dimensión de la gramática y hoy no está animada.
