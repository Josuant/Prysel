"""
El motor de ejecución de Prysel: un proceso de Python que mantiene un espacio de nombres vivo y
ejecuta, sentencia a sentencia, lo que el lienzo le pide.

Habla con la extensión por líneas de JSON sobre un socket local (el puerto es el primer argumento,
y una clave en `PRYSEL_TOKEN` se envía al conectar): una petición por línea de ida y un evento por
línea de vuelta. Todo lo que el programa del usuario escriba en `stdout`/`stderr` se
captura y se reenvía como evento, así que el canal del protocolo nunca se mezcla con él.

Solo usa la biblioteca estándar: cualquier librería de ciencia de datos (numpy, pandas, torch…) se
reconoce por su forma (`shape`, `dtype`, `columns`), sin importarla.

Peticiones:
  {"op": "run", "id": "n1", "code": "...", "watch": ["df"]}   ejecuta y resume los nombres pedidos
  {"op": "vars"}                                              resume lo que hay definido
  {"op": "reset"}                                             empieza con un espacio de nombres vacío
  {"op": "interrupt"}                                         corta lo que se esté ejecutando
  {"op": "shutdown"}

Eventos: ready, stream, result, value, figure, error, done, vars.
"""

import ast
import base64
import ctypes
import io
import json
import math
import os
import queue
import reprlib
import socket
import sys
import threading
import time
import traceback
import types
import warnings

MAX_TEXT = 4_000
# Valores por vuelta de un bucle: cuántos puntos se guardan como mucho, cuántas vueltas se guardan todas
# y cada cuánto se avisa. Un bucle de un millón de vueltas no puede costar un millón de mensajes.
MAX_POINTS = 600
FIRST_ALL = 256
EMIT_EVERY = 0.15
RECORD_EVERY = 0.25
MAX_SERIES = 200
MAX_LOOP_NAMES = 12
MAX_ROWS = 8
MAX_COLUMNS = 40
MAX_ITEMS = 12
THUMBNAIL = 256

_channel = None
_send_lock = threading.Lock()


def _clean(value, depth=0):
    """Un valor listo para JSON: sin NaN ni infinitos, y con un tope de profundidad."""
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if isinstance(value, (str, int, bool)) or value is None:
        return value
    # Un evento con un resumen dentro (evento → resumen → tabla → filas → fila) llega a 5 niveles.
    if depth > 8:
        return str(value)
    if isinstance(value, dict):
        return {str(k): _clean(v, depth + 1) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_clean(v, depth + 1) for v in value]
    return str(value)


def emit(event):
    line = json.dumps(_clean(event), ensure_ascii=False) + "\n"
    with _send_lock:
        _channel.sendall(line.encode("utf-8"))


class _Stream:
    """Sustituye a `sys.stdout`/`sys.stderr` mientras corre el código del usuario."""

    def __init__(self, name):
        self.name = name
        self.run = None
        self.encoding = "utf-8"

    def write(self, text):
        if text and self.run is not None:
            emit({"ev": "stream", "id": self.run, "name": self.name, "text": text})
        return len(text)

    def flush(self):
        pass

    def isatty(self):
        return False


def _short(text, limit=200):
    text = text if isinstance(text, str) else str(text)
    return text if len(text) <= limit else text[: limit - 1] + "…"


def _safe_repr(obj, limit=200):
    try:
        return _short(repr(obj), limit).replace("\n", " ")
    except Exception:
        return "<sin representación>"


def _shape_of(obj):
    try:
        shape = getattr(obj, "shape", None)
        if shape is None:
            return None
        return [int(n) for n in shape]
    except Exception:
        return None


def _table(frame, nulls_too=True):
    """Cabecera, tipos y nulos de algo con forma de DataFrame (`columns` y `dtypes`)."""
    columns = list(frame.columns)[:MAX_COLUMNS]
    info = []
    try:
        nulls = frame.isna().sum() if nulls_too else None
    except Exception:
        nulls = None
    for name in columns:
        entry = {"name": str(name), "dtype": str(frame.dtypes[name])}
        if nulls is not None:
            entry["nulls"] = int(nulls[name])
        info.append(entry)
    head = frame.head(MAX_ROWS)
    rows = [[_clean(cell) for cell in row] for row in head[columns].values.tolist()]
    return {"columns": info, "rows": rows}


def _image(obj):
    """Un PNG en miniatura de una imagen de PIL, o de un array con forma de imagen."""
    try:
        if type(obj).__module__.startswith("PIL."):
            picture = obj.copy()
        else:
            return None
        picture.thumbnail((THUMBNAIL, THUMBNAIL))
        buffer = io.BytesIO()
        picture.convert("RGBA").save(buffer, format="PNG")
        return base64.b64encode(buffer.getvalue()).decode("ascii")
    except Exception:
        return None


def summarize(obj, light=False):
    """Lo que el lienzo enseña de un valor: su tipo, su forma y una vista corta. Nunca el dato entero."""
    cls = type(obj)
    out = {"type": cls.__name__, "module": cls.__module__.split(".")[0]}
    shape = _shape_of(obj)
    if shape is not None:
        out["shape"] = shape
    dtype = getattr(obj, "dtype", None)
    if dtype is not None and not callable(dtype):
        out["dtype"] = str(dtype)
    device = getattr(obj, "device", None)
    if device is not None and not callable(device) and not isinstance(device, str):
        out["device"] = str(device)
    elif isinstance(device, str):
        out["device"] = device
    nbytes = getattr(obj, "nbytes", None)
    if isinstance(nbytes, int):
        out["bytes"] = nbytes

    if isinstance(obj, (bool, int, float, complex)) or obj is None:
        out["repr"] = _safe_repr(obj)
        return out
    if isinstance(obj, str):
        out["length"] = len(obj)
        out["repr"] = _safe_repr(obj)
        return out
    if isinstance(obj, (list, tuple, set, frozenset)):
        out["length"] = len(obj)
        out["items"] = [_safe_repr(v, 60) for v in list(obj)[:MAX_ITEMS]]
        return out
    if isinstance(obj, dict):
        out["length"] = len(obj)
        out["items"] = [
            f"{_safe_repr(k, 30)}: {_safe_repr(v, 40)}" for k, v in list(obj.items())[:MAX_ITEMS]
        ]
        return out
    if hasattr(obj, "columns") and hasattr(obj, "dtypes") and hasattr(obj, "head"):
        try:
            out["table"] = _table(obj, not light)
        except Exception as error:
            out["repr"] = f"<{_short(str(error), 80)}>"
        return out
    if hasattr(obj, "shape") and hasattr(obj, "dtype"):
        # Un array o un tensor: unos pocos elementos bastan para reconocerlo.
        try:
            # Un array o un tensor se aplana; una serie de pandas no tiene `reshape`, pero sí `head`.
            flat = obj.reshape(-1)[:MAX_ITEMS] if hasattr(obj, "reshape") else obj.head(MAX_ITEMS)
            out["sample"] = [_clean(v) for v in flat.tolist()]
            if hasattr(obj, "min") and getattr(obj, "size", 0) and str(dtype)[:1] in "fiu":
                out["range"] = [_clean(obj.min().item()), _clean(obj.max().item())]
        except Exception:
            pass
        return out
    picture = _image(obj)
    if picture is not None:
        out["image"] = picture
        out["size"] = list(getattr(obj, "size", []))
        return out
    if isinstance(obj, types.ModuleType):
        out["repr"] = getattr(obj, "__name__", "módulo")
        return out
    if callable(obj):
        out["repr"] = _safe_repr(obj, 80)
        return out
    out["repr"] = _safe_repr(obj)
    return out


class _Touched(ast.NodeVisitor):
    """Los nombres que un fragmento define o cambia en el espacio de nombres: lo que se vuelve a resumir.

    Cuenta lo que se asigna, importa o define, y también el objeto sobre el que se llama a un método
    (`xs.append(1)`, `model.fit(X)`), porque es lo que suele mutar. No entra en el cuerpo de una
    función, una clase ni una comprensión: sus variables son locales.
    """

    def __init__(self):
        self.names = []
        # Los que el fragmento solo recibió como receptor de una llamada (`plt.plot(...)`): no los definió.
        self.receivers = set()

    def add(self, name, receiver=False):
        if name not in self.names:
            self.names.append(name)
        if receiver:
            self.receivers.add(name)
        else:
            self.receivers.discard(name)

    def visit_Name(self, node):
        if isinstance(node.ctx, (ast.Store, ast.Del)):
            self.add(node.id)

    def visit_FunctionDef(self, node):
        self.add(node.name)
        for decorator in node.decorator_list:
            self.visit(decorator)

    visit_AsyncFunctionDef = visit_FunctionDef

    def visit_ClassDef(self, node):
        self.add(node.name)

    def visit_Lambda(self, node):
        pass

    visit_ListComp = visit_SetComp = visit_DictComp = visit_GeneratorExp = visit_Lambda

    def visit_Import(self, node):
        for alias in node.names:
            self.add(alias.asname or alias.name.split(".")[0])

    visit_ImportFrom = visit_Import

    def visit_ExceptHandler(self, node):
        if node.name:
            self.add(node.name)
        self.generic_visit(node)

    def visit_Call(self, node):
        target = node.func
        while isinstance(target, (ast.Attribute, ast.Subscript, ast.Call)):
            target = target.func if isinstance(target, ast.Call) else target.value
        if isinstance(target, ast.Name) and isinstance(node.func, ast.Attribute):
            self.add(target.id, receiver=target.id not in self.names)
        self.generic_visit(node)


def touched(tree):
    visitor = _Touched()
    visitor.visit(tree)
    return visitor.names, visitor.receivers


def _capture(value):
    """Lo que se guarda de un valor en cada vuelta: un número si lo es y, si no, una descripción corta."""
    try:
        if isinstance(value, bool):
            return "True" if value else "False"
        if isinstance(value, (int, float)):
            return value if isinstance(value, int) or math.isfinite(value) else str(value)
        if value is None:
            return "None"
        shape = getattr(value, "shape", None)
        if shape is not None and not isinstance(value, type):
            dims = [int(n) for n in shape]
            size = 1
            for n in dims:
                size *= n
            if size == 1 and hasattr(value, "item"):
                got = value.item()
                if isinstance(got, bool):
                    return "True" if got else "False"
                if isinstance(got, (int, float)):
                    return got if isinstance(got, int) or math.isfinite(got) else str(got)
            return f"{type(value).__name__} " + "\u00d7".join(str(n) for n in dims)
        if isinstance(value, str):
            return _short(repr(value), 32)
        if isinstance(value, (list, tuple, set, frozenset, dict)):
            return f"{type(value).__name__} #{len(value)}"
        return type(value).__name__
    except Exception:
        return "?"


_MISSING = object()


class _Series:
    """Lo que valen, vuelta a vuelta, los nombres que cambia un bucle."""

    def __init__(self, names):
        self.names = list(names)
        self.count = 0
        self.stride = 1
        self.idx = []
        self.vals = {name: [] for name in self.names}
        self.recorded_at = 0.0
        self.emitted_at = 0.0
        self.dirty = False
        self.done = False

    def record(self, n, frame):
        scope = frame.f_locals
        for name in self.names:
            value = scope.get(name, _MISSING)
            if value is _MISSING:
                value = frame.f_globals.get(name, _MISSING)
            self.vals[name].append(None if value is _MISSING else _capture(value))
        self.idx.append(n)
        self.recorded_at = time.perf_counter()
        self.dirty = True
        if len(self.idx) > MAX_POINTS:
            # Demasiados puntos: se queda uno de cada dos y desde ahora se guarda la mitad de las vueltas.
            self.idx = self.idx[::2]
            for name in self.names:
                self.vals[name] = self.vals[name][::2]
            self.stride *= 2


class _Instrument(ast.NodeTransformer):
    """Reescribe los bucles de un fragmento para anotar, en cada vuelta, lo que valen los nombres que cambian.

    Cada bucle queda envuelto así (los números de línea no se mueven, así que los errores siguen
    señalando la línea de siempre):

        __prysel_loop__(frag, clave, nombres)
        try:
            for x in xs:
                try:
                    <cuerpo>
                finally:
                    __prysel_tick__(frag, clave)
        finally:
            __prysel_end__(frag, clave)

    El `finally` de cada vuelta también corre con `break`, `continue` y una excepción: la última vuelta
    queda anotada aunque no acabe.
    """

    LOOPS = (ast.For, ast.AsyncFor, ast.While)

    def __init__(self, frag):
        self.frag = frag

    def hook(self, name, node, *extra):
        call = ast.Call(
            func=ast.Name(id=name, ctx=ast.Load()),
            args=[ast.Constant(self.frag), ast.Constant(f"{node.lineno}:{node.col_offset}"), *extra],
            keywords=[],
        )
        return ast.copy_location(ast.Expr(value=call), node)

    def wrap(self, block):
        out = []
        for stmt in block:
            if not isinstance(stmt, self.LOOPS):
                out.append(stmt)
                continue
            visitor = _Touched()
            visitor.visit(stmt)
            names = [
                n for n in visitor.names if n not in visitor.receivers and not n.startswith("_")
            ][:MAX_LOOP_NAMES]
            listing = ast.Tuple(elts=[ast.Constant(n) for n in names], ctx=ast.Load())
            out.append(self.hook("__prysel_loop__", stmt, ast.copy_location(listing, stmt)))
            guarded = ast.Try(
                body=[stmt],
                handlers=[],
                orelse=[],
                finalbody=[self.hook("__prysel_end__", stmt)],
            )
            out.append(ast.copy_location(guarded, stmt))
        return out

    def visit(self, node):
        node = self.generic_visit(node)
        for field in ("body", "orelse", "finalbody"):
            block = getattr(node, field, None)
            if isinstance(block, list) and block and isinstance(block[0], ast.stmt):
                setattr(node, field, self.wrap(block))
        if isinstance(node, self.LOOPS):
            each = ast.Try(
                body=node.body,
                handlers=[],
                orelse=[],
                finalbody=[self.hook("__prysel_tick__", node)],
            )
            node.body = [ast.copy_location(each, node.body[0])]
        return node


def instrument(tree, frag):
    """El árbol con los bucles anotados; si algo falla, el árbol de siempre (ejecutar es lo que importa)."""
    if not any(isinstance(n, _Instrument.LOOPS) for n in ast.walk(tree)):
        return tree
    try:
        return ast.fix_missing_locations(_Instrument(frag).visit(tree))
    except Exception:
        return tree


def _spine(expression):
    """Una cadena de llamadas, índices y atributos, de la raíz hacia fuera (como la ve el analizador).

    Los atributos del principio (`os.path`, `self.model`) son el camino hasta el receptor, no pasos.
    """
    steps = []
    current = expression
    while True:
        if isinstance(current, ast.Call) and isinstance(current.func, ast.Attribute):
            steps.append(("call", current))
            current = current.func.value
        elif isinstance(current, ast.Attribute):
            steps.append(("attr", current))
            current = current.value
        elif isinstance(current, ast.Subscript):
            steps.append(("index", current))
            current = current.value
        else:
            break
    steps.reverse()
    lead = 0
    while lead < len(steps) and steps[lead][0] == "attr":
        lead += 1
    receiver = current if lead == 0 else steps[lead - 1][1]
    return receiver, steps[lead:]


class _Chains(ast.NodeTransformer):
    """Envuelve cada paso de una cadena para anotar lo que vale tras él, sin evaluar nada dos veces.

        df.groupby("a").sum()   →   __prysel_step__(f, k, 2, 2, __prysel_step__(f, k, 1, 2,
                                        __prysel_step__(f, k, 0, 2, df).groupby("a")).sum())

    Solo el valor de una sentencia (`x = …`, `…`, `return …`): es lo que el lienzo enseña como cadena.
    """

    def __init__(self, frag):
        self.frag = frag

    def wrap(self, node, index, total, key):
        call = ast.Call(
            func=ast.Name(id="__prysel_step__", ctx=ast.Load()),
            args=[
                ast.Constant(self.frag),
                ast.Constant(key),
                ast.Constant(index),
                ast.Constant(total),
                node,
            ],
            keywords=[],
        )
        return ast.copy_location(call, node)

    def rewrite(self, expression):
        if not isinstance(expression, (ast.Call, ast.Attribute, ast.Subscript)):
            return expression
        receiver, steps = _spine(expression)
        if len(steps) < 2:
            return expression
        key = f"{expression.lineno}:{expression.col_offset}"
        total = len(steps)
        current = self.wrap(receiver, 0, total, key)
        for i, (kind, node) in enumerate(steps, start=1):
            if kind == "call":
                node.func.value = current
            else:
                node.value = current
            current = self.wrap(node, i, total, key)
        return current

    def visit_Assign(self, node):
        self.generic_visit(node)
        node.value = self.rewrite(node.value)
        return node

    def visit_AnnAssign(self, node):
        self.generic_visit(node)
        if node.value is not None:
            node.value = self.rewrite(node.value)
        return node

    def visit_AugAssign(self, node):
        self.generic_visit(node)
        node.value = self.rewrite(node.value)
        return node

    def visit_Expr(self, node):
        self.generic_visit(node)
        node.value = self.rewrite(node.value)
        return node

    def visit_Return(self, node):
        self.generic_visit(node)
        if node.value is not None:
            node.value = self.rewrite(node.value)
        return node

    def visit_Lambda(self, node):
        return node


def instrument_chains(tree, frag):
    """El árbol con las cadenas anotadas; si algo falla, el de siempre."""
    try:
        if isinstance(tree, ast.Expression):
            tree.body = _Chains(frag).rewrite(tree.body)
            return ast.fix_missing_locations(tree)
        return ast.fix_missing_locations(_Chains(frag).visit(tree))
    except Exception:
        return tree


class _TraceLimit(BaseException):
    """Se llegó al tope de pasos de una traza: se corta la ejecución."""


class _NoMoreInput(BaseException):
    """El programa pidió otro dato por teclado y ya no quedaban respuestas de ejemplo: se queda ahí."""


def _scripted_input(answers, out):
    """Un `input` que no espera a nadie: contesta lo que se le dio, en orden, y lo deja escrito en la salida
    como se vería en la pantalla (la pregunta y, detrás, lo tecleado)."""
    pending = [str(answer) for answer in answers]

    def ask(prompt=""):
        out.write(str(prompt))
        if not pending:
            raise _NoMoreInput()
        answer = pending.pop(0)
        out.write(answer + "\n")
        return answer

    return ask


_COMPREHENSIONS = {"<listcomp>", "<setcomp>", "<dictcomp>", "<genexpr>"}

# `reprlib` recorta sin construir la representación entera: una lista enorme no cuesta un paso de traza.
_SHORT = reprlib.Repr()
_SHORT.maxlist = _SHORT.maxtuple = _SHORT.maxset = _SHORT.maxfrozenset = 8
_SHORT.maxdict = 6
_SHORT.maxstring = 40
_SHORT.maxother = 40
_SHORT.maxlevel = 3


# Hasta cuántos elementos se graba una lista entera: para verla como celdas (ordenar, buscar) hacen falta todos.
_LIST_LIMIT = 40


def _items(value):
    """Los elementos de una lista o tupla de escalares, tal como los enseña la traza; `None` si no lo es."""
    items = []
    for item in value:
        if item is None or isinstance(item, (bool, int)):
            items.append(item)
        elif isinstance(item, float):
            items.append(item if math.isfinite(item) else str(item))
        elif isinstance(item, str) and len(item) <= 12:
            items.append(repr(item))
        else:
            return None
    return items


# En modo ancho (lo pide quien va a dibujar el valor con su forma, no a enseñarlo en una celda), una rejilla
# pequeña se graba entera: hasta estas filas y columnas.
_WIDE = False
_GRID_ROWS = 12
_GRID_COLS = 16


def _grid(value):
    """El texto entero de una rejilla pequeña (una lista de listas de escalares); `None` si no lo es."""
    if not isinstance(value, (list, tuple)) or not 0 < len(value) <= _GRID_ROWS:
        return None
    rows = []
    for row in value:
        if not isinstance(row, (list, tuple)) or not 0 < len(row) <= _GRID_COLS:
            return None
        items = _items(row)
        if items is None:
            return None
        cells = ", ".join(item if isinstance(item, str) else repr(item) for item in items)
        rows.append(f"[{cells}]" if isinstance(row, list) else f"({cells}{',' if len(row) == 1 else ''})")
    text = ", ".join(rows)
    return f"[{text}]" if isinstance(value, list) else f"({text}{',' if len(rows) == 1 else ''})"


def _show(value):
    """Lo que enseña una traza de un valor: un número tal cual, una lista corta de escalares entera
    (`{"l": [...], "n": largo, "t": "list"|"tuple"}`), y lo demás como texto corto."""
    if isinstance(value, bool) or value is None:
        return value
    if _WIDE:
        grid = _grid(value)
        if grid is not None:
            return grid
    if isinstance(value, (list, tuple)) and len(value) <= _LIST_LIMIT:
        items = _items(value)
        if items is not None:
            return {"l": items, "n": len(value), "t": "list" if isinstance(value, list) else "tuple"}
    if isinstance(value, (int, float)):
        return value if isinstance(value, int) or math.isfinite(value) else str(value)
    try:
        text = _SHORT.repr(value)
    except Exception:
        return f"<{type(value).__name__}>"
    return text if len(text) <= 70 else text[:69] + "…"


def _identity(value):
    """Lo que identifica un objeto mutable (dos nombres con el mismo `id` son el mismo objeto)."""
    if value is None or isinstance(value, (bool, int, float, str, bytes, tuple, frozenset)):
        return None
    return id(value)


# Los objetos del propio programa (instancias de sus clases) que se graban por paso: sus atributos, y a
# qué otros objetos apuntan. Es lo que deja dibujar una lista enlazada, un árbol o un grafo tal como es.
_HEAP_OBJECTS = 40
_HEAP_FIELDS = 12
_HEAP_REFS = 20


def _is_object(value):
    """Una instancia de una clase del programa (no de la biblioteca estándar ni de un módulo externo)."""
    kind = type(value)
    return (
        getattr(kind, "__module__", None) == "__main__"
        and not isinstance(value, type)
        and not callable(value)
        and (hasattr(value, "__dict__") or hasattr(kind, "__slots__"))
    )


def _fields(value):
    """Los atributos de un objeto: su `__dict__` o, si usa `__slots__`, esos."""
    found = {}
    try:
        found.update(vars(value))
    except TypeError:
        pass
    for slot in getattr(type(value), "__slots__", ()) or ():
        if isinstance(slot, str) and not slot.startswith("__") and hasattr(value, slot):
            found[slot] = getattr(value, slot)
    return {name: v for name, v in found.items() if not name.startswith("__")}


def _heap_value(value, reached):
    """Lo que se graba de un atributo: una referencia a otro objeto (`{"r": id}`), una lista de ellas
    (`{"rl": [...]}`, con `None` para los huecos), o el valor como en cualquier variable."""
    if _is_object(value):
        reached.append(value)
        return {"r": id(value)}
    if isinstance(value, (list, tuple)) and 0 < len(value) <= _HEAP_REFS:
        if all(item is None or _is_object(item) for item in value) and any(
            item is not None for item in value
        ):
            refs = []
            for item in value:
                if item is None:
                    refs.append(None)
                else:
                    reached.append(item)
                    refs.append(id(item))
            return {"rl": refs}
    return _show(value)


def _heap(roots):
    """Los objetos del programa alcanzables desde `roots` (variables), con sus atributos: `id → objeto`."""
    objects = {}
    pending = []
    for value in roots:
        if _is_object(value):
            pending.append(value)
        elif isinstance(value, (list, tuple, dict)) and 0 < len(value) <= _HEAP_REFS:
            # Una lista (o un diccionario) de objetos del programa: se graba como un objeto más, con sus
            # referencias, para que la variable que la nombra lleve hasta ellos (su `id` es el de la variable).
            items = list(value.values()) if isinstance(value, dict) else list(value)
            if not any(_is_object(item) for item in items):
                continue
            reached = []
            if isinstance(value, dict):
                fields = {_short(str(k), 20): _heap_value(v, reached) for k, v in value.items()}
            else:
                fields = {"elementos": _heap_value(value, reached)}
            objects[str(id(value))] = {"c": type(value).__name__, "f": fields}
            pending.extend(reached)
    while pending and len(objects) < _HEAP_OBJECTS:
        value = pending.pop(0)
        key = str(id(value))
        if key in objects:
            continue
        reached = []
        fields = {}
        for name, attr in list(_fields(value).items())[:_HEAP_FIELDS]:
            fields[name] = _heap_value(attr, reached)
        objects[key] = {"c": type(value).__name__, "f": fields}
        pending.extend(reached)
    return objects


def _is_data(name, value):
    """Una variable de datos: no las definiciones (funciones, clases, módulos) ni los nombres internos."""
    if name.startswith("__"):
        return False
    return not (
        callable(value) or isinstance(value, (types.ModuleType, type))
    )


def _comprehension_only(tree):
    """Los nombres que solo existen como variable de una comprensión: no son variables del programa.

    Desde Python 3.12 una comprensión se ejecuta en el marco de quien la contiene y su variable aparece
    entre los locales, pero para quien lee el código no es una variable más (y desaparece al acabar).
    """
    stores = {}
    targets = {}
    for node in ast.walk(tree):
        if isinstance(node, ast.Name) and isinstance(node.ctx, ast.Store):
            stores[node.id] = stores.get(node.id, 0) + 1
        elif isinstance(node, ast.arg):
            stores[node.arg] = stores.get(node.arg, 0) + 1
        elif isinstance(node, ast.comprehension):
            for part in ast.walk(node.target):
                if isinstance(part, ast.Name):
                    targets[part.id] = targets.get(part.id, 0) + 1
    return frozenset(name for name, count in targets.items() if stores.get(name, 0) == count)


# ── modo seguro (código que nadie del usuario escribió: el que genera una IA para «Explicar un tema») ──

# Deliberadamente corta: lo justo para explicar algoritmos y estructuras de datos sin acceso al sistema.
# Créditos: docs/lecciones.md §5. Ampliar solo con módulos que no puedan tocar nada fuera del proceso.
SAFE_MODULES = frozenset(
    {
        "math",
        "random",
        "itertools",
        "functools",
        "collections",
        "dataclasses",
        "typing",
        "string",
        "statistics",
        "fractions",
        "decimal",
        "enum",
        "re",
        "heapq",
        "bisect",
        "copy",
        "operator",
        "textwrap",
    }
)
# Nombres que abren una puerta fuera del sandbox (archivos, otro código, otros módulos) aunque el módulo
# que los trae ya esté en SAFE_MODULES o sea un builtin.
SAFE_FORBIDDEN_NAMES = frozenset(
    {"open", "exec", "eval", "compile", "__import__", "input", "breakpoint", "globals", "locals", "vars"}
)
# Atributos con los que, encadenados, se llega a clases y módulos que no se importaron (el escape clásico
# de un sandbox de Python: `().__class__.__bases__[0].__subclasses__()…`).
SAFE_FORBIDDEN_ATTRS = frozenset(
    {
        "__globals__",
        "__builtins__",
        "__subclasses__",
        "__bases__",
        "__mro__",
        "__code__",
        "__closure__",
        "__loader__",
        "__getattribute__",
        "__reduce__",
        "__reduce_ex__",
    }
)


class _UnsafeCode(Exception):
    """El código no cumple el modo seguro: qué lo rompe y en qué línea, para pedirle a la IA que lo corrija."""

    def __init__(self, message, line):
        super().__init__(message)
        self.line = line


def _check_safe(tree):
    """Recorre el árbol antes de ejecutar nada: un módulo o un nombre fuera de la lista corta el paso."""
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                top = alias.name.split(".")[0]
                if top not in SAFE_MODULES:
                    raise _UnsafeCode(
                        f'el módulo «{alias.name}» no está permitido en modo seguro', node.lineno
                    )
        elif isinstance(node, ast.ImportFrom):
            top = (node.module or "").split(".")[0]
            if node.level > 0 or top not in SAFE_MODULES:
                raise _UnsafeCode(
                    f'el módulo «{node.module or "."}» no está permitido en modo seguro', node.lineno
                )
        elif isinstance(node, ast.Name) and node.id in SAFE_FORBIDDEN_NAMES:
            raise _UnsafeCode(f'«{node.id}» no está permitido en modo seguro', node.lineno)
        elif isinstance(node, ast.Attribute) and node.attr in SAFE_FORBIDDEN_ATTRS:
            raise _UnsafeCode(f'acceder a «{node.attr}» no está permitido en modo seguro', node.lineno)


class _Tracer:
    """Graba, línea a línea, qué pasa al ejecutar un programa: es la verdad sobre la que se explica.

    Un evento por cada llamada (`call`), línea a punto de ejecutarse (`line`), retorno (`return`) y
    excepción (`exception`), con la línea, la profundidad de la pila, el marco y **solo lo que cambió**
    en las variables del marco (`ch`), y lo que se imprimió desde el evento anterior (`o`).
    """

    def __init__(self, filename, limit, out, hidden=frozenset(), finish=0.0):
        self.filename = filename
        self.hidden = hidden
        self.limit = limit
        self.out = out
        # Al llegar al tope de pasos, en vez de cortar: dejar de grabar y dejar que el programa acabe (con
        # este tope de segundos). Lo que imprima hasta el final sí se recoge: es su resultado.
        self.finish = finish
        self.coasting = False
        self.deadline = 0.0
        self.ticks = 0
        self.events = []
        self.stack = []
        self.by_frame = {}
        self.next_id = 1
        self.printed = 0
        # Lo último que se grabó de cada objeto del programa: solo se vuelve a grabar si cambió.
        self.heap_last = {}

    def heap_changes(self, frame):
        """Los objetos del programa alcanzables desde las variables de este marco que cambiaron (o son nuevos)."""
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            values = [v for name, v in list(frame.f_locals.items()) if _is_data(name, v)]
        changed = {}
        for key, obj in _heap(values).items():
            try:
                text = json.dumps(obj, sort_keys=True, default=str)
            except (TypeError, ValueError):
                continue
            if self.heap_last.get(key) != text:
                self.heap_last[key] = text
                changed[key] = obj
        return changed

    def record(self, event):
        text = self.out.getvalue()
        if len(text) > self.printed:
            event["o"] = text[self.printed :]
            self.printed = len(text)
        self.events.append(event)
        if len(self.events) >= self.limit:
            if self.finish <= 0:
                raise _TraceLimit()
            self.coasting = True
            self.deadline = time.perf_counter() + self.finish

    def coast(self, frame, event, arg):
        """Ya no se graba: solo se vigila, de vez en cuando, que el programa no se quede dando vueltas."""
        self.ticks += 1
        if self.ticks & 255 == 0 and time.perf_counter() > self.deadline:
            raise _TraceLimit()
        return self.coast

    def changes(self, record, frame):
        """Las variables de datos que cambiaron (o son nuevas) desde el último evento de este marco."""
        current = {}
        # En Python 3.12 una comprensión comparte marco con quien la contiene y leer sus locales puede avisar.
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            items = list(frame.f_locals.items())
        for name, value in items:
            if name not in self.hidden and _is_data(name, value):
                current[name] = (_show(value), _identity(value))
        changed = {}
        ids = {}
        for name, entry in current.items():
            if record["last"].get(name) != entry:
                changed[name] = entry[0]
                if entry[1] is not None:
                    ids[name] = entry[1]
        record["last"] = current
        return changed, ids

    def global_trace(self, frame, event, arg):
        if self.coasting:
            return self.coast(frame, event, arg)
        code = frame.f_code
        if code.co_filename != self.filename or code.co_name in _COMPREHENSIONS:
            return None
        if event != "call":
            return None
        module = code.co_name == "<module>"
        record = {"id": 0 if module else self.next_id, "last": {}, "depth": len(self.stack)}
        if not module:
            self.next_id += 1
        self.by_frame[id(frame)] = record
        self.stack.append(record)
        if not module:
            changed, ids = self.changes(record, frame)
            entry = {"k": "call", "l": code.co_firstlineno, "d": record["depth"], "f": record["id"], "fn": code.co_name}
            if changed:
                entry["ch"] = changed
            if ids:
                entry["ids"] = ids
            heap = self.heap_changes(frame)
            if heap:
                entry["h"] = heap
            self.record(entry)
        return self.local_trace

    def local_trace(self, frame, event, arg):
        if self.coasting:
            return self.coast(frame, event, arg)
        record = self.by_frame.get(id(frame))
        if record is None:
            return None
        entry = {"l": frame.f_lineno, "d": record["depth"], "f": record["id"]}
        if event == "line":
            entry["k"] = "line"
        elif event == "return":
            # El programa acaba (`end`); una función devuelve un valor (`return`).
            entry["k"] = "end" if record["id"] == 0 else "return"
            if record["id"] != 0:
                entry["v"] = _show(arg)
        elif event == "exception":
            entry["k"] = "exception"
            entry["e"] = f"{arg[0].__name__}: {_short(str(arg[1]), 120)}"
        else:
            return self.local_trace
        changed, ids = self.changes(record, frame)
        heap = self.heap_changes(frame)
        # Una comprensión de una línea repite esa línea a cada vuelta sin cambiar nada visible: no es un paso.
        if event == "line" and not changed and not heap and record.get("line") == frame.f_lineno:
            return self.local_trace
        record["line"] = frame.f_lineno
        if changed:
            entry["ch"] = changed
        if ids:
            entry["ids"] = ids
        if heap:
            entry["h"] = heap
        try:
            self.record(entry)
        finally:
            if event == "return":
                self.by_frame.pop(id(frame), None)
                if self.stack and self.stack[-1] is record:
                    self.stack.pop()
        return self.local_trace


class Runner:
    def __init__(self):
        self.loops = {}
        self.chain_now = {}
        self.chain_count = {}
        self.current = None
        self.namespace = self.fresh()
        self.stdout = _Stream("stdout")
        self.stderr = _Stream("stderr")
        self.main = threading.get_ident()
        self.requests = queue.Queue()
        self.running = threading.Event()

    def fresh(self):
        """Un espacio de nombres vacío, con los ganchos con los que los bucles anotan sus vueltas."""
        return {
            "__name__": "__main__",
            "__prysel_loop__": self.loop_start,
            "__prysel_tick__": self.loop_tick,
            "__prysel_end__": self.loop_end,
            "__prysel_step__": self.chain_step,
        }

    # ── los bucles ─────────────────────────────────────────────────────────────

    def loop_start(self, frag, key, names):
        self.loops[(frag, key)] = _Series(names)
        # Solo se recuerdan las últimas series: un programa largo no las acumula sin fin.
        while len(self.loops) > MAX_SERIES:
            self.loops.pop(next(iter(self.loops)))

    def loop_tick(self, frag, key):
        series = self.loops.get((frag, key))
        if series is None:
            return
        n = series.count
        series.count += 1
        if (
            n < FIRST_ALL
            or n % series.stride == 0
            or time.perf_counter() - series.recorded_at > RECORD_EVERY
        ):
            series.record(n, sys._getframe(1))
            if time.perf_counter() - series.emitted_at > EMIT_EVERY:
                self.emit_series(frag, key, series)

    def loop_end(self, frag, key):
        series = self.loops.get((frag, key))
        if series is None:
            return
        series.done = True
        # El último valor es el que queda al acabar el bucle: siempre se anota.
        if series.count > 0 and (not series.idx or series.idx[-1] != series.count - 1):
            series.record(series.count - 1, sys._getframe(1))
        series.dirty = True
        self.emit_series(frag, key, series)

    def emit_series(self, frag, key, series):
        series.emitted_at = time.perf_counter()
        series.dirty = False
        emit(
            {
                "ev": "iter",
                "id": self.current,
                "frag": frag,
                "loop": key,
                "n": series.count,
                "idx": series.idx,
                "names": series.vals,
                "done": series.done,
            }
        )

    def flush_loops(self):
        for (frag, key), series in list(self.loops.items()):
            if series.dirty:
                self.emit_series(frag, key, series)

    # ── la traza ───────────────────────────────────────────────────────────────

    def trace(self, request):
        """Ejecuta un programa entero, en un espacio de nombres aparte, grabando qué pasa línea a línea.

        `safe`: código que nadie del usuario escribió (lo generó una IA para «Explicar un tema»). Antes de
        ejecutar nada se recorre el árbol (`_check_safe`); si toca un módulo o un nombre fuera de la lista
        corta, ni se compila: se devuelve el mismo evento de error que un fallo normal, con el motivo exacto
        para poder pedirle a la IA que lo corrija.
        """
        global _WIDE
        run = request.get("id", "trace")
        limit = int(request.get("limit", 5000))
        safe = bool(request.get("safe", False))
        wide = bool(request.get("wide", False))
        # Respuestas de teclado dadas de antemano (para ver funcionar un programa que pide datos), y una
        # semilla para que su azar salga igual cada vez que se vuelve a mirar.
        inputs = request.get("inputs")
        seed = request.get("seed")
        filename = f"<prysel-trace:{run}>"
        out = io.StringIO()
        source = request.get("code", "")
        error = None
        try:
            tree = ast.parse(source)
            hidden = _comprehension_only(tree)
            if safe:
                _check_safe(tree)
        except SyntaxError:
            hidden = frozenset()
        except _UnsafeCode as unsafe:
            hidden = frozenset()
            error = {"name": "UnsafeCode", "message": str(unsafe), "line": unsafe.line}
        # `finish`: al llegar al tope de pasos, el programa sigue sin grabarse hasta acabar (con un tope de
        # segundos), para no quedarse sin saber qué da.
        finish = request.get("finish")
        budget = 0.0 if not finish else (2.5 if finish is True else float(finish))
        tracer = _Tracer(filename, limit, out, hidden, budget)
        finished = False
        namespace = {"__name__": "__main__"}
        if isinstance(inputs, list):
            namespace["input"] = _scripted_input(inputs, out)
        truncated = False
        if error is None:
            saved = sys.stdout, sys.stderr
            sys.stdout = sys.stderr = out
            self.running.set()
            try:
                code = compile(source, filename, "exec")
                _WIDE = wide
                if seed is not None:
                    import random as _random

                    _random.seed(seed)
                sys.settrace(tracer.global_trace)
                try:
                    exec(code, namespace)
                finally:
                    sys.settrace(None)
                    _WIDE = False
                # Acabó, aunque de lo último no haya quedado grabado el paso a paso.
                truncated = tracer.coasting
                finished = tracer.coasting
            except _TraceLimit:
                truncated = True
            except _NoMoreInput:
                # No es un fallo del programa: se acabó el ejemplo. Queda dicho, para contarlo así.
                truncated = True
                error = {"name": "NoMoreInput", "message": "Se quedó esperando otra respuesta.", "line": None}
            except BaseException as caught:  # incluye KeyboardInterrupt y SystemExit
                line = None
                for frame in traceback.extract_tb(caught.__traceback__):
                    if frame.filename == filename:
                        line = frame.lineno
                if isinstance(caught, SyntaxError) and caught.filename == filename:
                    line = caught.lineno
                error = {"name": type(caught).__name__, "message": _short(str(caught), 300), "line": line}
            finally:
                self.running.clear()
                sys.stdout, sys.stderr = saved
        emit(
            {
                "ev": "trace",
                "id": run,
                "events": tracer.events,
                "truncated": truncated,
                "finished": finished,
                "error": error,
                "output": out.getvalue()[-MAX_TEXT:],
            }
        )

    # ── las cadenas ────────────────────────────────────────────────────────────

    def chain_step(self, frag, key, index, total, value):
        """Anota lo que vale una cadena tras cada paso y devuelve el valor tal cual."""
        slot = (frag, key)
        if index == 0:
            count = self.chain_count.get(slot, (0, 0.0))[0] + 1
            now = time.perf_counter()
            # Una cadena dentro de un bucle no se anota en cada vuelta: las primeras, de vez en cuando y,
            # si cada llamada es lenta, todas.
            record = count <= 3 or count % 64 == 0 or now - self.chain_count.get(slot, (0, 0.0))[1] > 0.25
            self.chain_count[slot] = (count, now if record else self.chain_count.get(slot, (0, 0.0))[1])
            self.chain_now[slot] = [None] * (total + 1) if record else None
        recorded = self.chain_now.get(slot)
        if recorded is not None:
            try:
                summary = summarize(value, light=True)
                summary.pop("image", None)
                recorded[index] = summary
            except Exception:
                pass
            if index == total:
                self.emit_chain(frag, key)
        return value

    def emit_chain(self, frag, key):
        recorded = self.chain_now.pop((frag, key), None)
        if recorded is not None:
            emit({"ev": "steps", "id": self.current, "frag": frag, "chain": key, "previews": recorded})

    def flush_chains(self):
        # Una cadena que falló a medias: se avisa de los pasos que llegaron a evaluarse.
        for frag, key in list(self.chain_now):
            self.emit_chain(frag, key)

    # ── ejecución ──────────────────────────────────────────────────────────────

    def compile(self, code, run):
        """Divide el código como Jupyter: si acaba en una expresión, su valor es el resultado."""
        name = f"<prysel:{run}>"
        tree = ast.parse(code, name, "exec")
        tail = None
        if tree.body and isinstance(tree.body[-1], ast.Expr) and not code.rstrip().endswith(";"):
            tail = ast.Expression(tree.body.pop().value)
        names, receivers = touched(tree)
        if tail is not None:
            more, more_receivers = touched(tail)
            names += [n for n in more if n not in names]
            receivers |= {n for n in more_receivers if n not in names[: len(names) - len(more)]}
        tree = instrument_chains(instrument(tree, run), run)
        body = compile(tree, name, "exec")
        if tail is not None:
            tail = instrument_chains(tail, run)
        last = compile(tail, name, "eval") if tail is not None else None
        return body, last, names, receivers

    def run(self, request):
        run = request.get("id", "run")
        code = request.get("code", "")
        started = time.perf_counter()
        self.stdout.run = self.stderr.run = run
        saved = sys.stdout, sys.stderr
        sys.stdout, sys.stderr = self.stdout, self.stderr
        ok = True
        names, receivers = [], set()
        self.running.set()
        self.current = run
        try:
            body, last, names, receivers = self.compile(code, run)
            exec(body, self.namespace)
            if last is not None:
                value = eval(last, self.namespace)
                if value is not None:
                    self.namespace["_"] = value
                    emit({"ev": "result", "id": run, "summary": summarize(value)})
        except BaseException as error:  # incluye KeyboardInterrupt (interrupción) y SystemExit
            ok = False
            self.report(run, error, code)
        finally:
            self.running.clear()
            self.flush_loops()
            self.flush_chains()
            sys.stdout, sys.stderr = saved
            self.stdout.run = self.stderr.run = None
        asked = request.get("watch", [])
        for name in [*names, *[n for n in asked if n not in names]]:
            if name not in self.namespace:
                continue
            value = self.namespace[name]
            # Un módulo que solo recibió una llamada (`plt.plot(...)`) no cambió: no se resume, salvo que sea lo que define.
            if isinstance(value, types.ModuleType) and name in receivers and name not in asked:
                continue
            emit({"ev": "value", "id": run, "name": name, "summary": summarize(value)})
        self.figures(run)
        emit({"ev": "done", "id": run, "ok": ok, "ms": round((time.perf_counter() - started) * 1000, 1)})

    def report(self, run, error, code):
        frames = traceback.extract_tb(error.__traceback__)
        mine = [f for f in frames if f.filename == f"<prysel:{run}>"]
        line = mine[-1].lineno if mine else None
        if isinstance(error, SyntaxError) and error.filename == f"<prysel:{run}>":
            line = error.lineno
        shown = [f for f in frames if f.filename != __file__]
        text = "".join(traceback.format_list(shown)) + "".join(
            traceback.format_exception_only(type(error), error)
        )
        # El nombre interno del fragmento no le dice nada a quien lee.
        text = text.replace(f'File "<prysel:{run}>"', "Fragmento")
        emit(
            {
                "ev": "error",
                "id": run,
                "ename": type(error).__name__,
                "evalue": _short(str(error), 500),
                "line": line,
                "traceback": _short(text, MAX_TEXT),
            }
        )

    def figures(self, run):
        pyplot = sys.modules.get("matplotlib.pyplot")
        if pyplot is None:
            return
        try:
            for number in pyplot.get_fignums():
                figure = pyplot.figure(number)
                buffer = io.BytesIO()
                figure.savefig(buffer, format="png", dpi=80, bbox_inches="tight")
                emit(
                    {
                        "ev": "figure",
                        "id": run,
                        "mime": "image/png",
                        "data": base64.b64encode(buffer.getvalue()).decode("ascii"),
                    }
                )
                pyplot.close(figure)
        except Exception as error:
            emit({"ev": "stream", "id": run, "name": "stderr", "text": f"[prysel] figura: {error}\n"})

    # ── el bucle ───────────────────────────────────────────────────────────────

    def lines(self):
        """Las líneas que llegan por el canal, ya decodificadas."""
        pending = b""
        while True:
            chunk = _channel.recv(65536)
            if not chunk:
                break
            pending += chunk
            while b"\n" in pending:
                line, pending = pending.split(b"\n", 1)
                yield line.decode("utf-8", "replace")

    def reader(self):
        for line in self.lines():
            line = line.strip()
            if not line:
                continue
            try:
                request = json.loads(line)
            except ValueError:
                continue
            op = request.get("op")
            if op == "interrupt":
                # Se interrumpe desde aquí: el hilo principal está ocupado ejecutando código.
                if self.running.is_set():
                    ctypes.pythonapi.PyThreadState_SetAsyncExc(
                        ctypes.c_ulong(self.main), ctypes.py_object(KeyboardInterrupt)
                    )
                continue
            self.requests.put(request)
        self.requests.put({"op": "shutdown"})

    def serve(self, port):
        global _channel
        # El protocolo va por un socket local, no por la entrada estándar: en Windows, una lectura
        # bloqueada sobre esa tubería serializa otras operaciones sobre ella y cuelga imports como el
        # de numpy. Con un socket, el hilo lector espera sin estorbar a nadie.
        _channel = socket.create_connection(("127.0.0.1", port))
        hello = {"ev": "hello", "token": os.environ.get("PRYSEL_TOKEN", "")}
        _channel.sendall((json.dumps(hello) + "\n").encode())
        # El programa del usuario no tiene entrada: `input()` acaba con EOFError, no se queda esperando.
        sys.stdin = io.StringIO("")
        sys.path.insert(0, os.getcwd())
        threading.Thread(target=self.reader, daemon=True).start()
        emit({"ev": "ready", "python": sys.version.split()[0], "cwd": os.getcwd(), "pid": os.getpid()})
        while True:
            try:
                request = self.requests.get()
                op = request.get("op")
                if op == "shutdown":
                    return
                if op == "run":
                    self.run(request)
                elif op == "reset":
                    self.namespace = self.fresh()
                    self.loops.clear()
                    self.chain_now.clear()
                    self.chain_count.clear()
                    emit({"ev": "reset"})
                elif op == "trace":
                    self.trace(request)
                elif op == "vars":
                    names = {
                        n: summarize(v)
                        for n, v in self.namespace.items()
                        if not n.startswith("_") and type(v).__name__ != "module"
                    }
                    emit({"ev": "vars", "id": request.get("id"), "vars": names})
            except KeyboardInterrupt:
                # La interrupción llegó justo después de acabar: no hay nada que cortar.
                continue


if __name__ == "__main__":
    Runner().serve(int(sys.argv[1]))
