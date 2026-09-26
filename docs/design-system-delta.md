# Diferencias respecto al design system publicado

El design system original (artifact «Prysel») nació con tres reglas muy marcadas: _todo monoespaciado, color reservado al estado, nodos rectangulares con una sola sombra_. La dirección actual pide otra cosa: tarjetas claras con insignias de color, iconos, chips de estado y, sobre todo, **nodos editables gráficamente**, con forma, borde, relleno, transparencia y sombra cargados de significado según la construcción de Python que representan.

**El artifact publicado no se ha tocado.** `packages/design-tokens/src/tokens.base.json` es una copia literal (su hash SHA-256 se verifica en un test) y todo lo nuevo vive en `tokens.theme.json`. Cuando la dirección quede validada, conviene volcar estos cambios al DS.

## Cómo se expresan las diferencias

El tema solo puede hacer tres cosas, y el generador las verifica:

1. **Añadir tokens** (insignias, chips, bordes de tarjeta, radios, sombras suaves).
2. **Añadir tipografía**: una familia `sans` para la interfaz, junto a la `mono` del DS, que se queda para el código y los valores.
3. **Cambiar el valor de un token del DS**, solo dentro de `overrides` y **siempre con una razón escrita** — un test exige que cada una esté justificada, y otro falla si el token no existe (protege contra erratas).

Los 14 overrides actuales están en `tokens.theme.json`; en resumen: la escala de grises pasa de crema cálido a neutro frío, `ink-faint` se oscurece, `line` se reserva para bordes de controles reales, el acento violeta se ajusta para poder usarse como texto, los colores de estado se alinean con sus chips y la sombra se suaviza en dos capas.

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
| Un Node se dibuja siempre como tarjeta                                    | Leída hacia abajo (diagrama de flujo), la **condición es un rombo** (`diamond`) con la pregunta dentro: el «sí» sale por el vértice de abajo y el «no» por el de la derecha. Solo cambia la silueta en ese modo; su firma de tipo (`card-fork`) sigue siendo única.                                    |
| Control y datos se dibujan a la vez                                       | En el diagrama de flujo **solo se dibuja la secuencia** (trazo fino continuo de 1,6 px en `ink-muted`, con punta, punto de unión y «sí»/«no» junto al vértice); los datos son chips, nunca cables. Los canales gruesos/punteados de arriba quedan para la lectura a lo ancho.                          |

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
