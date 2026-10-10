# Definir el problema: establece objetivo, genes y aptitud
import random

objetivo = "encontrar la cadena"
genes = "abcdefghijklmnopqrstuvwxyz "
longitud = 10
objetivo_texto = "hola mundo"

# Evaluar población
def evaluar_poblacion(poblacion):
    return [calcular_aptitud(individuo) for individuo in poblacion]

# Generar población inicial: crea individuos aleatorios
def generar_poblacion(tamano):
    poblacion = []
    for _ in range(tamano):
        individuo = ""
        for _ in range(longitud):
            individuo += random.choice(genes)
        poblacion.append(individuo)
    return poblacion

# Evaluar población: calcula la aptitud de cada individuo
def calcular_aptitud(individuo):
    aciertos = 0
    for i in range(longitud):
        if individuo[i] == objetivo_texto[i]:
            aciertos += 1
    return aciertos

# Seleccionar padres
def seleccionar_padres(poblacion, aptitudes):
    ordenados = sorted(range(len(poblacion)), key=lambda i: aptitudes[i], reverse=True)
    return poblacion[ordenados[0]], poblacion[ordenados[1]]


# Cruzar y mutar: genera descendencia con variación
def cruzar_y_mutar(padre1, padre2):
    punto = random.randint(1, longitud - 1)
    hijo = padre1[:punto] + padre2[punto:]
    if random.random() < 0.1:
        posicion = random.randint(0, longitud - 1)
        hijo = hijo[:posicion] + random.choice(genes) + hijo[posicion + 1:]
    return hijo

# Reemplazar población: forma la nueva generación
def reemplazar_poblacion(poblacion, aptitudes, tamano):
    ordenados = sorted(range(len(poblacion)), key=lambda i: aptitudes[i], reverse=True)
    nueva = [poblacion[i] for i in ordenados[:2]]
    while len(nueva) < tamano:
        padre1, padre2 = seleccionar_padres(poblacion, aptitudes)
        nueva.append(cruzar_y_mutar(padre1, padre2))
    return nueva

# Iterar hasta condición: repite el ciclo y devuelve el mejor
def algoritmo_genetico(tamano, generaciones):
    poblacion = generar_poblacion(tamano)
    for _ in range(generaciones):
        aptitudes = evaluar_poblacion(poblacion)
        if max(aptitudes) == longitud:
            break
        poblacion = reemplazar_poblacion(poblacion, aptitudes, tamano)
    aptitudes = evaluar_poblacion(poblacion)
    mejor = poblacion[aptitudes.index(max(aptitudes))]
    return mejor
