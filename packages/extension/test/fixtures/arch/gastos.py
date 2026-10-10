# Lista de gastos: los gastos de ejemplo
gastos = [
    {"nombre": "Pan", "precio": 2.5},
    {"nombre": "Cine", "precio": 9.0},
]

# Añadir gasto: pide nombre y precio y lo guarda
def anadir_gasto():
    nombre = input("Nombre: ")
    precio = float(input("Precio: "))
    gastos.append({"nombre": nombre, "precio": precio})

# Mostrar total: suma todos los precios
def mostrar_total():
    total = 0
    for gasto in gastos:
        total += gasto["precio"]
    print("Total:", total)

# Buscar más caro: encuentra el gasto de mayor precio
def buscar_mas_caro():
    caro = gastos[0]
    for gasto in gastos:
        if gasto["precio"] > caro["precio"]:
            caro = gasto
    print("El más caro:", caro["nombre"])

# Menú: deja elegir qué hacer hasta salir
while True:
    opcion = input("1 añadir, 2 total, 3 caro, 4 salir: ")
    if opcion == "1":
        anadir_gasto()
    elif opcion == "2":
        mostrar_total()
    elif opcion == "3":
        buscar_mas_caro()
    else:
        break
