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
import socket
import sys
import threading
import time
import traceback
import types

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
    if depth > 4:
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


def _table(frame):
    """Cabecera, tipos y nulos de algo con forma de DataFrame (`columns` y `dtypes`)."""
    columns = list(frame.columns)[:MAX_COLUMNS]
    info = []
    try:
        nulls = frame.isna().sum()
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


def summarize(obj):
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
            out["table"] = _table(obj)
        except Exception as error:
            out["repr"] = f"<{_short(str(error), 80)}>"
        return out
    if hasattr(obj, "shape") and hasattr(obj, "dtype"):
        # Un array o un tensor: unos pocos elementos bastan para reconocerlo.
        try:
            flat = obj.reshape(-1)[:MAX_ITEMS]
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


class Runner:
    def __init__(self):
        self.loops = {}
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
        tree = instrument(tree, run)
        body = compile(tree, name, "exec")
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
                    emit({"ev": "reset"})
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
