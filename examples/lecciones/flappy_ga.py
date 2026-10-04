import random

random.seed(88)

GRAVEDAD = 0.7
IMPULSO = 4.0
VELOCIDAD_MAXIMA = 6.0
VELOCIDAD_TUBERIA = 2.0
HUECO = 12.0
ALTO = 30.0
X_PAJARO = 0.0
BONO_POR_TUBERIA = 15
MAX_TICKS = 18


class Pajaro:
    """Un pájaro: su altura, su velocidad, y el genoma que decide cuándo aletea."""

    def __init__(self, genoma):
        self.altura = ALTO / 2
        self.velocidad = 0.0
        self.genoma = genoma
        self.tuberias_superadas = 0
        self.vivo = True

    def decidir(self, distancia, hueco_altura):
        """El cerebro del pájaro: cuatro números deciden si aletea, sin ninguna red neuronal."""
        peso_altura, peso_velocidad, peso_distancia, sesgo = self.genoma
        diferencia = self.altura - hueco_altura
        entrada = (
            peso_altura * diferencia + peso_velocidad * self.velocidad + peso_distancia * distancia + sesgo
        )
        return entrada > 0

    def mover(self, aletea):
        if aletea:
            self.velocidad = IMPULSO
        else:
            self.velocidad -= GRAVEDAD
        self.velocidad = max(-VELOCIDAD_MAXIMA, min(VELOCIDAD_MAXIMA, self.velocidad))
        self.altura += self.velocidad
        if self.altura <= 0 or self.altura >= ALTO:
            self.vivo = False


def volar(genoma):
    """Un vuelo entero con un genoma: cuántos pasos sobrevive y cuántas tuberías consigue pasar."""
    # Preparar el vuelo: el pájaro y la primera tubería
    pajaro = Pajaro(genoma)
    tuberia_x = 15.0
    hueco_y = random.uniform(HUECO / 2 + 2, ALTO - HUECO / 2 - 2)

    # Volar: un paso cada vez, hasta chocar o agotar el tiempo
    for tick in range(1, MAX_TICKS + 1):
        # Decidir y moverse: el cerebro elige, la física manda
        distancia = tuberia_x - X_PAJARO
        aletea = pajaro.decidir(distancia, hueco_y)
        pajaro.mover(aletea)
        altura = pajaro.altura

        # La tubería avanza: si llega al pájaro fuera del hueco, choca
        tuberia_x -= VELOCIDAD_TUBERIA
        if -1 < tuberia_x - X_PAJARO < 1 and abs(altura - hueco_y) > HUECO / 2:
            pajaro.vivo = False

        # Tubería superada: aparece otra y suma un punto
        if tuberia_x < X_PAJARO:
            tuberia_x = 15.0
            hueco_y = random.uniform(HUECO / 2 + 2, ALTO - HUECO / 2 - 2)
            pajaro.tuberias_superadas += 1

        # ¿Sigue vivo? Si no, el vuelo acaba aquí
        if not pajaro.vivo:
            break

    # Aptitud: lo que aguantó, más un premio por cada tubería
    aptitud = tick + pajaro.tuberias_superadas * BONO_POR_TUBERIA
    return aptitud, pajaro.tuberias_superadas


def genoma_aleatorio():
    return tuple(random.uniform(-2.5, 2.5) for _ in range(4))


def cruzar(madre, padre):
    """El genoma hijo toma cada número de uno de los dos padres, al azar."""
    return tuple(m if random.random() < 0.5 else p for m, p in zip(madre, padre))


def mutar(genoma, fuerza=0.3):
    """Un empujón pequeño y al azar a cada número: así aparece variación que la selección no inventó."""
    return tuple(gen + random.uniform(-fuerza, fuerza) for gen in genoma)


TAMANO_POBLACION = 4
GENERACIONES = 5
ELITE = 2


def entrenar():
    """La evolución: cada generación vuela, se juzga y da hijos a partir de las mejores."""
    # Población inicial: genomas al azar, nadie sabe volar todavía
    poblacion = [genoma_aleatorio() for _ in range(TAMANO_POBLACION)]
    mejor_aptitud_historica = 0
    mejor_genoma_historico = poblacion[0]

    # Evolución: cada generación se prueba, se juzga y tiene hijos
    for generacion in range(1, GENERACIONES + 1):
        # Probar: cada pájaro vuela con su genoma y se mide su aptitud
        resultados = [volar(genoma) for genoma in poblacion]
        aptitudes = [aptitud for aptitud, _ in resultados]
        aptitud_media = sum(aptitudes) / TAMANO_POBLACION

        # Juzgar: el mejor de esta generación, y si bate el récord
        orden = sorted(range(TAMANO_POBLACION), key=lambda i: aptitudes[i], reverse=True)
        mejor_indice = orden[0]
        mejor_aptitud = aptitudes[mejor_indice]
        mejor_genoma = poblacion[mejor_indice]
        if mejor_aptitud > mejor_aptitud_historica:
            mejor_aptitud_historica = mejor_aptitud
            mejor_genoma_historico = mejor_genoma
        print(f"Generación {generacion}: mejor aptitud = {mejor_aptitud}, media = {aptitud_media:.1f}")

        # Criar: la élite son los padres; cada hijo es un cruce con alguna mutación
        padres = [poblacion[i] for i in orden[:ELITE]]
        nueva_poblacion = list(padres)
        while len(nueva_poblacion) < TAMANO_POBLACION:
            madre = random.choice(padres)
            padre = random.choice(padres)
            hija = mutar(cruzar(madre, padre))
            nueva_poblacion.append(hija)

        # Relevo: la nueva generación sustituye a la vieja
        poblacion = nueva_poblacion

    # Resultado: el mejor genoma de toda la evolución
    print(f"Mejor genoma: {mejor_genoma_historico}, aptitud {mejor_aptitud_historica}")


if __name__ == "__main__":
    entrenar()
