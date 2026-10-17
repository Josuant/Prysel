"""
Pantalla: lo que un programa enseña y se usa de verdad. Suena, tiene botones y teclas que se pulsan, escribe
y dibuja. Es de Prysel: en la web todo esto se ve, se oye y se toca en el nodo «Pantalla» del lienzo.

    import pantalla

    def tocar_do():
        pantalla.sonar("do", 0.5)

    pantalla.titulo("Piano")
    pantalla.boton("do", tocar_do)
    pantalla.tecla("a", tocar_do)
    pantalla.mostrar()

Las funciones que se pasan a `boton`, `tecla` o `cada` se llaman cuando se pulsa (o pasa el tiempo). Lo demás
(`sonar`, `texto`, `rect`…) se puede llamar en cualquier momento.

Funciona en tres sitios:

- **En la web** (Prysel): quien lo aloja pone `_send`, y cada llamada le llega como un mensaje: suena, se
  dibuja, y cada pulsación vuelve aquí (`_dispatch`).
- **Al mirarlo sin nadie delante** (cuando Prysel ejecuta el programa para ver qué hace, con
  `PRYSEL_SIMULAR`): `mostrar()` pulsa cada botón y cada tecla una vez, para ver qué hacen.
- **En una consola**: los botones son un menú numerado que se elige escribiendo, y las notas se escriben.
"""

import json as _json
import os as _os
import re as _re

# Lo pone quien aloja el programa (la web): una función que recibe cada orden como texto JSON.
_send = None

_handlers = {}
_buttons = []
_keys = []
_timers = []
_next = 0
# Dónde va la siguiente nota de una melodía (en segundos desde ahora): `sonar` las encadena sin esperar.
_cursor = 0.0
_title = None

_NOTES = {"do": 0, "re": 2, "mi": 4, "fa": 5, "sol": 7, "la": 9, "si": 11}
_LETTERS = {"c": 0, "d": 2, "e": 4, "f": 5, "g": 7, "a": 9, "b": 11}
_NOTE = _re.compile(r"^(do|re|mi|fa|sol|la|si|[a-g])\s*(#|♯|b|♭)?\s*(-?\d)?$")


def _emit(op, **data):
    if _send is not None:
        _send(_json.dumps({"op": op, **data}, ensure_ascii=False))


def _keep(function, kind):
    global _next
    if not callable(function):
        raise TypeError(f"{kind} necesita una función a la que llamar (sin paréntesis): {function!r}")
    _next += 1
    _handlers[_next] = function
    return _next


def frecuencia(nota):
    """Los hercios de una nota: «do», «la#», «sol3», «C4», «Bb»… o un número (ya en hercios)."""
    if isinstance(nota, (int, float)) and not isinstance(nota, bool):
        return float(nota)
    found = _NOTE.match(str(nota).strip().lower())
    if not found:
        raise ValueError(f"No conozco la nota «{nota}»: usa do, re, mi, fa, sol, la, si (o C, D, E…).")
    name, accidental, octave = found.groups()
    step = _NOTES.get(name, _LETTERS.get(name, 0))
    if accidental in ("#", "♯"):
        step += 1
    elif accidental in ("b", "♭"):
        step -= 1
    midi = 12 * ((int(octave) if octave is not None else 4) + 1) + step
    return round(440.0 * 2 ** ((midi - 69) / 12), 2)


def _simulating():
    return _os.environ.get("PRYSEL_SIMULAR") == "1"


# ───────────────────────── lo que se ve y se oye ─────────────────────────


def titulo(texto):
    """El título de la pantalla."""
    global _title
    _title = str(texto)
    if _send is not None:
        _emit("title", text=_title)
    else:
        print(f"== {_title} ==")


def texto(*partes, sep=" "):
    """Una línea de texto en la pantalla (debajo de las anteriores)."""
    line = sep.join(str(parte) for parte in partes)
    if _send is not None:
        _emit("text", text=line)
    else:
        print(line)


def limpiar_texto():
    """Borra las líneas de texto de la pantalla."""
    _emit("clearText")


def sonar(nota, segundos=0.4, esperar=True):
    """Suena una nota («do», «la#4», «C5» o unos hercios) durante unos segundos.

    Las notas seguidas forman una melodía: cada una suena cuando acaba la anterior, sin tener que esperar
    con `time.sleep`. Con `esperar=False` suena a la vez que la siguiente (un acorde).
    """
    global _cursor
    hertz = frecuencia(nota)
    segundos = max(0.03, float(segundos))
    if _send is not None:
        _emit("sound", hz=hertz, secs=segundos, delay=round(_cursor, 3), note=str(nota))
    else:
        print(f"suena {nota}")
    if esperar:
        _cursor += segundos


def silencio(segundos):
    """Un silencio en una melodía: la siguiente nota suena un poco más tarde."""
    global _cursor
    _cursor += max(0.0, float(segundos))


# ───────────────────────── lo que se pulsa ─────────────────────────


def boton(etiqueta, al_pulsar, color=None):
    """Un botón en la pantalla. Al pulsarlo se llama a `al_pulsar()` (una función, sin paréntesis)."""
    ident = _keep(al_pulsar, "boton")
    _buttons.append((ident, str(etiqueta)))
    _emit("button", id=ident, label=str(etiqueta), color=color)
    return ident


def tecla(nombre, al_pulsar):
    """Una tecla del teclado («a», «espacio», «izquierda»…). Al pulsarla se llama a `al_pulsar()`."""
    ident = _keep(al_pulsar, "tecla")
    _keys.append((ident, str(nombre)))
    _emit("key", id=ident, key=str(nombre))
    return ident


def cada(segundos, funcion):
    """Llama a `funcion()` cada tantos segundos (para lo que se mueve solo: un juego, un reloj)."""
    ident = _keep(funcion, "cada")
    _timers.append(ident)
    _emit("timer", id=ident, secs=max(0.03, float(segundos)))
    return ident


def parar():
    """Para lo que se repite con `cada`."""
    _timers.clear()
    _emit("stop")


# ───────────────────────── lo que se dibuja ─────────────────────────


def lienzo(ancho=400, alto=300, fondo="white"):
    """Un lienzo para dibujar, de `ancho` por `alto` píxeles. (0, 0) es la esquina de arriba a la izquierda."""
    _emit("canvas", w=int(ancho), h=int(alto), bg=str(fondo))


def borrar():
    """Borra lo dibujado en el lienzo."""
    _emit("clear")


def rect(x, y, ancho, alto, color="black"):
    _emit("draw", shape="rect", x=x, y=y, w=ancho, h=alto, color=str(color))


def circulo(x, y, radio, color="black"):
    _emit("draw", shape="circle", x=x, y=y, r=radio, color=str(color))


def linea(x1, y1, x2, y2, color="black", grosor=2):
    _emit("draw", shape="line", x=x1, y=y1, x2=x2, y2=y2, color=str(color), width=grosor)


def escribir(x, y, texto, color="black", tamano=16):
    """Escribe un texto en el lienzo, en (x, y)."""
    _emit("draw", shape="text", x=x, y=y, text=str(texto), color=str(color), size=tamano)


# ───────────────────────── ponerlo en marcha ─────────────────────────


def mostrar():
    """Pone la pantalla en marcha: desde aquí, se usa.

    En la web no hace falta esperar a nada (cada pulsación llega sola). Al mirarlo sin nadie delante, se
    pulsa cada botón y cada tecla una vez. En una consola, los botones se eligen por su número.
    """
    if _send is not None:
        _emit("ready")
        return
    if _simulating():
        for ident, label in list(_buttons):
            print(f"[pulso «{label}»]")
            _dispatch(ident)
        for ident, key in list(_keys):
            print(f"[tecla «{key}»]")
            _dispatch(ident)
        for ident in list(_timers)[:3]:
            for _ in range(3):
                _dispatch(ident)
        return
    _console()


def _console():
    options = list(_buttons) + [(ident, f"tecla {key}") for ident, key in _keys]
    if not options:
        return
    while True:
        print()
        for number, (_, label) in enumerate(options, 1):
            print(f"  {number}) {label}")
        chosen = input("Elige un número (Intro para salir): ").strip()
        if chosen == "":
            return
        if chosen.isdigit() and 1 <= int(chosen) <= len(options):
            _dispatch(options[int(chosen) - 1][0])
        else:
            print("Ese número no está en la lista.")


def _dispatch(ident, *args):
    """Lo pulsado (o lo que se repite) llega aquí: se llama a su función. Una melodía empieza desde ahora."""
    global _cursor
    _cursor = 0.0
    function = _handlers.get(int(ident))
    if function is None:
        return
    function(*args)
