# Notas: las notas de la clase
notas = [7, 4, 9, 6]

# Media: la nota media
print("Media:", sum(notas) / len(notas))

# Mejor: la nota más alta
print("Mejor:", max(notas))

# Aprobados: cuántos aprueban
print("Aprobados:", len([n for n in notas if n >= 5]))
