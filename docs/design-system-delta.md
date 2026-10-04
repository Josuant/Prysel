# Diferencias respecto al design system publicado

El design system original (artifact «Prysel») nació con tres reglas muy marcadas: _todo monoespaciado, color reservado al estado, nodos rectangulares con una sola sombra_. La dirección actual pide otra cosa: tarjetas claras con insignias de color, iconos, chips de estado y, sobre todo, **nodos editables gráficamente**, con forma, borde, relleno, transparencia y sombra cargados de significado según la construcción de Python que representan.

**El artifact publicado no se ha tocado.** `packages/design-tokens/src/tokens.base.json` es una copia literal (su hash SHA-256 se verifica en un test) y todo lo nuevo vive en `tokens.theme.json`. Cuando la dirección quede validada, conviene volcar estos cambios al DS.

## Cómo se expresan las diferencias

El tema solo puede hacer tres cosas, y el generador las verifica:

1. **Añadir tokens** (insignias, chips, bordes de tarjeta, radios, sombras suaves).
2. **Añadir tipografía**: una familia `sans` para la interfaz, junto a la `mono` del DS, que se queda para el código y los valores.
3. **Cambiar el valor de un token del DS**, solo dentro de `overrides` y **siempre con una razón escrita** — un test exige que cada una esté justificada, y otro falla si el token no existe (protege contra erratas).

Los 14 overrides actuales están en `tokens.theme.json`; en resumen: el lienzo es papel (un blanco roto apenas cálido; en oscuro, un grafito), `ink-faint` se oscurece, `line` se reserva para bordes de controles reales, el acento violeta se ajusta para poder usarse como texto, los colores de estado se alinean con sus chips y la sombra se suaviza en dos capas.

## Reglas que cambian

| Antes (README del DS)                                                     | Ahora                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| «Nunca colorees un nodo por su tipo»                                      | El tipo se lee en una **insignia** pastel con icono. La forma y el icono siguen siendo los portadores principales: un test exige que cada tipo sea único en (silueta, trazo, relleno).                                                                                                                 |
| Todo el lenguaje en una familia monoespaciada                             | **Sans para la interfaz** (nombres, insignias, etiquetas) y **mono solo para el código y los valores**, que es donde significa algo.                                                                                                                                                                   |
| Glifos tipográficos (`○ ◉ ● ▣ ƒ ×`)                                       | Un set de **iconos de trazo** de 24×24, legibles a 13 px en cualquier fuente del sistema. Los estados conservan icono propio además de color.                                                                                                                                                          |
| «Un Node se dibuja con borde sólido y `radius-md`»                        | La tarjeta es la base, y su **recorte** dice el papel: punta de flecha, borde plano, esquina cortada, pestaña, muescas, capas apiladas.                                                                                                                                                                |
| Sin regla sobre transparencia ni desenfoque                               | **Vidrio** (desenfoque de fondo) = complejidad encapsulada · **translúcido** = diferido o ajeno · **rayado** = su interfaz se está generando · `dead` = código inalcanzable.                                                                                                                           |
| El nodo es una representación que se lee                                  | El nodo **se manipula**: cada tipo declara su editor (`control`) y un test exige que todo lo que no sea un contenedor tenga uno.                                                                                                                                                                       |
| Control fino, datos gruesos (`stroke-control` 1.5 px, `stroke-data` 4 px) | **Al revés**, y por legibilidad: el **control** es continuo y grueso (3 px) porque es el orden de ejecución, la columna vertebral; los **datos** son finos y punteados (2 px) porque son dependencias. En un algoritmo denso, lo que manda ha de pesar más. Ambos tokens son del tema, no del DS base. |
| Todos los nodos tienen entrada y salida                                   | Un literal no tiene entrada; `return` y `raise` no tienen salida; la condición tiene dos salidas separadas de verdad.                                                                                                                                                                                  |
| Un Node se dibuja siempre como tarjeta                                    | Leída hacia abajo (diagrama de flujo), una **decisión es su pregunta** en una píldora (`¿ campo operador valor ?`) y, debajo, **un rombo pequeño** donde se parte el camino: el «sí» sale por su vértice de abajo y el «no» por el de la derecha. Su firma de tipo (`card-fork`) sigue siendo única.   |
| Control y datos se dibujan a la vez                                       | En el diagrama de flujo **solo se dibuja la secuencia** (trazo de 2 px en `flow-line`, esquinas amplias, punta, punto de unión y «sí»/«no» en pastillas junto al vértice); los datos son chips, nunca cables. Los canales gruesos/punteados de arriba quedan para la lectura a lo ancho.               |

## Reglas que se conservan

- El estado nunca se lleva en el relleno: vive en un chip con icono propio, y funciona en escala de grises.
- `state-error` solo en el punto de fractura.
- Los Spaces son de trazo discontinuo y sin relleno.
- El tamaño mide complejidad (logarítmico, con tope), no importancia.
- Una sola sombra, y solo para lo que el usuario mira.
- Movimiento con significado; `prefers-reduced-motion` respetado.

## Hallazgos para el DS

1. **`ink-faint` no tenía margen de contraste.** En el DS original daba 4.81:1 sobre `void` en tema claro, así que cualquier tinte encima lo rompía. Oscurecerlo es lo que permite componer insignias y campos.
2. **Hacía falta separar `line` de «borde de tarjeta».** Un borde decorativo de tarjeta no necesita 3:1 (la tarjeta se identifica por su relleno y su contenido), pero el borde de un campo editable sí. Por eso ahora hay `line` (3:1, controles) y `border-card` (decorativo).
3. **El DS no define cuerpos semánticos.** Los 18 editores (`text`, `number`, `table`, `condition`, `stats`…) son nuevos y deberían volver al DS como componentes propios.

## Cuaderno 2D (tema v3)

Pedido del usuario con cinco referencias: un editor de nodos que se lee como código en píldoras (Enso), un
selector con iconos de color en cuadraditos suaves, un constructor de flujos con su barra y su paleta, un editor
de prompts con palabras de color y un «proceso» con una línea que fluye entre hitos. El objetivo: un Jupyter
Notebook en 2D, amable para quien empieza y con fondo para quien ya sabe. Lo que cambia, siempre con tokens
(un test sigue prohibiendo colores literales en el CSS):

| Pieza             | Cómo se ve ahora                                                                                                                                                                                                                                            |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Lienzo            | Papel (`void` claro `#f4f3ef`, oscuro `#111215`) con una retícula de puntos que se intuye. En la extensión ocupa todo, sin marco.                                                                                                                           |
| Pasos             | Leídos como cuaderno (`MorphNode flow`), una línea es una **píldora** y lo demás una **tarjeta** redondeada; se dibujan sin recorte (`ShapeGeometry.radius`), así llevan una **sombra suave de verdad** (`shadow-card`, `shadow-lift` al pasar por encima). |
| Selección         | Aro del acento con un halo; la línea de su secuencia se enciende en violeta con un brillo suave.                                                                                                                                                            |
| Tipo de un paso   | Un **icono de color en un cuadradito pastel** (insignia solo con icono), no una etiqueta de texto.                                                                                                                                                          |
| Campos            | Son parte de la frase: **sin caja** hasta que se pasa por encima o se escribe; un hueco por rellenar es una casilla discontinua; lo escrito se colorea por lo que es (`syntax-number`, `syntax-string`, `syntax-keyword`).                                  |
| Chips (variables) | **Palabras de color**: relleno pastel de su clase de valor (`value-*-bg`), texto en su tono fuerte (`value-*-fg`, ≥ 4.5:1, con test), un relieve abajo como una tecla; al pasar se levantan. La × de un chip en su casilla aparece al pasar.                |
| Números           | Un chip de número se pulsa y abre una **tarjeta con bocadillo**: el valor grande, un deslizador (de 0 a la siguiente potencia de diez) y el valor exacto; nada se escribe hasta «Guardar».                                                                  |
| Territorios       | Un velo muy suave del color de su familia y un borde que apenas se ve, sin pestaña de carpeta; su cabecera es una frase (`para [h] en [alturas]`).                                                                                                          |
| Barra             | A la izquierda, qué se ve (archivo, función); a la derecha, **Ejecutar** (sólido, con la flecha para las variantes), el estado del motor en una píldora con su punto, y «Paso a paso» / «Lección» como secundarias; deshacer y rehacer solo con icono.      |
| Sobre el lienzo   | La densidad arriba a la derecha, **acercar / alejar / encuadrar** abajo a la derecha y **Añadir paso** abajo a la izquierda.                                                                                                                                |
| Añadir            | Una **paleta con buscador** (sin tildes ni mayúsculas, también por la palabra de Python) y, por entrada, su icono en un cuadradito de color y una frase que dice para qué sirve. Bajo cada paso, un **«+»** sobre la espina añade el siguiente ahí mismo.   |
| Paso a paso       | Una tarjeta al pie con botones redondos, una línea de tiempo con un **rombo por cada momento** de la lección, la velocidad como selector y las variables como chips.                                                                                        |
| Número de línea   | Una pista que aparece al pasar por un paso: en reposo no ensucia el diagrama.                                                                                                                                                                               |

## Etapas: el algoritmo a la vista

Un nivel entre la función y la sentencia: la **fase** de un algoritmo con nombre («Probar», «Juzgar», «Criar»), que abre un comentario de sección (ver «Etapas» en `spatial-grammar.md`). Sin tokens nuevos: sale todo de los del tema v3.

| Pieza             | Cómo se ve                                                                                                                                                                                                                                                                                |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tipo              | `space.section` («Etapa»): contenedor (trazo discontinuo, sin relleno, sin editor, como manda el DS) con silueta `card-tab`, única en su terna. Su icono es una **escalera** (`section`).                                                                                                 |
| Etapa plegada     | Una **tarjeta de cuaderno** (radio 16, `shadow-card`): el **número** del esquema (`2.3`) en un cuadradito del acento, el título, el subtítulo en tinta suave y, debajo, lo que **usa** (chips de contorno discontinuo) → lo que **deja** (chips `value-any`, con su valor al ejecutarse). |
| Si no cabe        | Lo que usa y lo que deja pasan a dos filas; en cada una se ve lo que cabe y el resto se cuenta («+2»).                                                                                                                                                                                    |
| Etapa abierta     | Un **marco discontinuo** muy tenue (radio 22), sin el velo de color de un bucle o de una función, con esa misma cabecera arriba. La secuencia entra por su borde.                                                                                                                         |
| Etapa de un bucle | Si la etapa es solo un bucle, no hay marco dentro de marco: el número y el título de la etapa van en la **cabecera del bucle**, entre su icono y su editor.                                                                                                                               |
| Subprocesos       | Pastillas «↗ nombre» del color de las funciones (`value-fn`), al final de la línea de una llamada, de la pregunta de una decisión o de la cabecera de un paso, y al pie de una etapa plegada. Abren lo que se llama; sustituyen al chevron de una llamada.                                |
| Lo que esconde    | Al pie de la etapa plegada, glifos en tinta tenue: ↻ bucle, ◇ decisión, globo si imprime o enseña algo.                                                                                                                                                                                   |
| Parámetros        | Las constantes del programa (`GRAVEDAD`, `ELITE`) van primero en la cajita del programa, con el rótulo **«Parámetros»** (o «Parámetros y funciones»), en versalitas tenues como el de una celda de configuración.                                                                         |
| Construcción      | Una etapa a la que la reproducción aún no ha llegado se atenúa como un paso (`opacity-pending`), y se enciende en cuanto se ejecuta algo de lo que tiene dentro.                                                                                                                          |
