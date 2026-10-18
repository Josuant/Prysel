# Modelo de datos: define libros y socios con sus campos
class Libro:
    def __init__(self, titulo, autor):
        self.titulo = titulo
        self.autor = autor
        self.prestado = False

class Socio:
    def __init__(self, nombre):
        self.nombre = nombre

MULTA_POR_DIA_RETRASO = 2

# Registrar préstamo: anota qué socio pide qué libro
def registrar_prestamo(libro, socio, dias, lista_prestamos):
    # Validar el libro
    if libro.prestado:
        raise ValueError("El libro ya está prestado")

    # Validar los días
    if dias <= 0:
        raise ValueError("Los días deben ser mayores que 0")

    # Anotar el préstamo
    prestamo = Prestamo(libro, socio, dias)
    libro.prestado = True
    lista_prestamos.append(prestamo)
    return prestamo

# Registrar devolución: cierra préstamo y calcula multa por retraso
class Prestamo:
    def __init__(self, libro, socio, dias):
        self.libro = libro
        self.socio = socio
        self.dias = dias
        self.devuelto = False
        self.multa = 0
        self.retraso = 0

    def registrar_devolucion(self, dias_reales):
        # Comprobar el estado del préstamo
        if self.devuelto:
            raise ValueError("El préstamo ya fue devuelto")

        # Validar los días reales
        if dias_reales <= 0:
            raise ValueError("Los días reales deben ser mayores que 0")

        # Cerrar el préstamo
        self.devuelto = True
        self.libro.prestado = False

        # Calcular la multa por retraso
        retraso = dias_reales - self.dias
        if retraso > 0:
            self.retraso = retraso
            self.multa = retraso * MULTA_POR_DIA_RETRASO

# Informe final: resume préstamos, devoluciones y multas
def informe_final(lista_prestamos):
    # Listar los préstamos
    for prestamo in lista_prestamos:
        devuelto = "sí" if prestamo.devuelto else "no"
        print(prestamo.libro.titulo, prestamo.socio.nombre, devuelto, prestamo.multa)

    # Resumir los préstamos
    total = len(lista_prestamos)
    devueltos = 0
    multas = 0
    for prestamo in lista_prestamos:
        if prestamo.devuelto:
            devueltos += 1
        multas += prestamo.multa

    # Devolver el resumen
    return total, devueltos, multas

libro1 = Libro("El Quijote", "Cervantes")

libro2 = Libro("La Regenta", "Clarín")

socio1 = Socio("Ana")

socio2 = Socio("Luis")

prestamos = []

p1 = registrar_prestamo(libro1, socio1, 10, prestamos)

p2 = registrar_prestamo(libro2, socio2, 5, prestamos)

p1.registrar_devolucion(14)

p2.registrar_devolucion(5)

total, devueltos, multas = informe_final(prestamos)

# Ejecutar ejemplo: arranca con casos concretos y muestra resultados
print("Total préstamos:", total)

print("Devueltos:", devueltos)

print("Multas totales:", multas)
