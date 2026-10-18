# Los gastos: lo que se gastó en cada cosa
gastos = {"comida": 120, "transporte": 45, "ocio": 60}
LIMITE = 200

# Sumar: el total del mes
def total(cuentas):
    suma = 0
    for valor in cuentas.values():
        suma = suma + valor
    return suma

# Avisar: si se pasa del límite
def aviso(gastado, limite):
    if gastado > limite:
        return "Te pasaste por " + str(gastado - limite)
    return "Vas bien: te quedan " + str(limite - gastado)

# Arrancar: enseñar el total y el aviso
gastado = total(gastos)
print("Total:", gastado)
print(aviso(gastado, LIMITE))
