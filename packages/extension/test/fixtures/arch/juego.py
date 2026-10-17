# Mundo: dónde está cada cosa
posicion = 0
meta = 5

# Leer jugada: cuánto avanza
def leer_jugada(turno):
    return 1 + turno % 2

# Mover: aplica la jugada
def mover(posicion, pasos):
    return posicion + pasos

# Dibujar: enseña el tablero
def dibujar(posicion):
    print("." * posicion + "O")

# Bucle del juego: repite hasta llegar a la meta
turno = 0
while posicion < meta:
    pasos = leer_jugada(turno)
    posicion = mover(posicion, pasos)
    dibujar(posicion)
    turno += 1
