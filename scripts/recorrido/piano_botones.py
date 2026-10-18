import pantalla

# Las notas: las del piano y su melodía
TECLAS = ["do", "re", "mi", "fa", "sol"]
MELODIA = ["do", "do", "re", "do", "fa", "mi"]

# Tocar: cada tecla y la melodía entera
def tocar(nota):
    return lambda: pantalla.sonar(nota, 0.4)

def tocar_melodia():
    for nota in MELODIA:
        pantalla.sonar(nota, 0.3)
    pantalla.texto("Melodía tocada")

# Poner en marcha: un botón por tecla, una tecla del teclado por botón, y la melodía
pantalla.titulo("Piano con botones")
for nota, letra in zip(TECLAS, "asdfg"):
    pantalla.boton(nota, tocar(nota))
    pantalla.tecla(letra, tocar(nota))
pantalla.boton("Tocar la melodía", tocar_melodia, color="amarillo")
pantalla.mostrar()
