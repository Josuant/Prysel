import pantalla

# Las teclas: qué nota toca cada una
NOTAS = ["do", "re", "mi", "fa", "sol", "la", "si"]
ANCHO = 44

# Dibujar el piano: una tecla blanca por nota, que se pulsa
def tocar(nota):
    def suena():
        pantalla.sonar(nota, 0.5)
        pantalla.texto("Suena", nota)
    return suena

def dibujar():
    for i, nota in enumerate(NOTAS):
        x = 10 + i * ANCHO
        pantalla.rect(x, 20, ANCHO - 4, 120, "blanco")
        pantalla.escribir(x + 10, 110, nota, "gris oscuro")
        pantalla.zona(x, 20, ANCHO - 4, 120, tocar(nota))

# Poner en marcha: el lienzo, el piano y la pantalla
pantalla.titulo("Piano")
pantalla.lienzo(330, 160, "azul marino")
dibujar()
pantalla.mostrar()
