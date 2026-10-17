# Leer ventas: las ventas de la semana
ventas = [120, -5, 80, 0, 200, 45]

# Limpiar: quita las que no valen
validas = [v for v in ventas if v > 0]

# Resumir: calcula el total y la media
total = sum(validas)
media = total / len(validas)

# Mostrar: enseña el resumen
print("Total:", total)
print("Media:", media)
