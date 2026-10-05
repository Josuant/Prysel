import type { TemplateId } from '@prysel/morphology'
import type { Decider, JevAnswer, JevRequest } from './client.ts'
import type { Intent, PlaceId } from './engine.ts'

/**
 * Un decisor local: contesta a las mismas preguntas que Jev, por palabras clave. No entiende: reconoce.
 * Sirve para las pruebas (es determinista y no usa la red) y para ver la tubería entera sin clave. No
 * sustituye a Jev: en la interfaz se dice siempre quién decidió.
 */

/** Minúsculas y sin acentos (la `ñ` pasa a `n`): las palabras clave se escriben así. */
const plain = (text: string) => text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()

const SURE = 0.9
const UNSURE = 0.2

/** De más concreto a menos: «crea una etapa» es una etapa, no añadir. */
const INTENT_WORDS: [Intent, RegExp][] = [
  // Querer entender un tema va antes que nada: «la reproduccion humana» no es «reproducir el programa».
  [
    'ensenar',
    /explicame (como|que|por que|el|la|los|las)\b|como funciona|que es (un|una|el|la)\b|ensename|quiero (aprender|entender)/,
  ],
  ['paso_a_paso', /paso a paso|\btraza\b|\breproduce\b|\breproducir\b/],
  ['deshacer', /\bdesha[zc]/],
  ['rehacer', /\breha[zc]/],
  ['etapa', /\betapa|\bseccion|\bfase\b/],
  ['narrar', /\bleccion|\bnarra|\banimacion|explicame el programa|explica el programa/],
  ['renombrar', /\brenombr|cambia(le)? el nombre|\bllama(lo|la|le)\b/],
  [
    'modificar',
    /\bcambia|\bmodific|\brefactor|\bcorrige|\barregla|\bsimplific|en lugar de|en vez de|\bahora que\b|\bhaz que\b/,
  ],
  ['eliminar', /\belimin|\bborra|\bquita|\bsuprim/],
  ['explicar', /\bexplic|que hace|para que sirve/],
  [
    'plegar',
    /\bplieg|\bplega|\bdesplieg|\bdesplega|\babre\b|\babrir\b|\bcierra|\bcolapsa|\bexpande/,
  ],
  ['ejecutar', /\bejecut|\bcorre\b|\blanza el/],
  ['enfocar', /\benfoc|\bve a\b|\bir a\b|\bmuestra|\bensena|\bllevame|\bbusca|\bdonde esta/],
  [
    'componer',
    /\balgoritmo|\bprograma que|\bfuncion que|\bbucle que|\bque (sume|calcule|cuente|busque|ordene|imprima|devuelva)/,
  ],
  ['agregar', /\banad|\bagreg|\bcrea|\bpon\b|\bponme|\binserta|\bmete|\bnuev[oa]\b|\bescribe/],
]

const PIECE_WORDS: [TemplateId, RegExp][] = [
  ['function', /\bfuncion/],
  ['while', /\bmientras|\bwhile\b/],
  ['for', /\bbucle|\brepit|para cada|\brecorr|\bfor\b/],
  ['ifelse', /\balternativa|\bsi no\b|\bsino\b|dos caminos/],
  ['if', /\bdecision|\bcondicion|\bcomprueba|\bif\b|\bsi\b/],
  ['try', /\bintenta|\btry\b|si falla/],
  ['print', /\bimprim|\bmuestra|\bprint\b/],
  ['input', /\bpide|\bpregunta|\binput\b/],
  ['return', /\bdevuelv|\bdevolver|\breturn\b/],
  ['import', /\bimport/],
  ['break', /sal del bucle|\bbreak\b/],
  ['continue', /siguiente vuelta|\bcontinue\b/],
  ['raise', /lanza un error|\braise\b/],
  ['with', /\bwith\b|\barchivo|\brecurso/],
  ['list', /\blista/],
  ['dict', /\bdiccionario/],
  ['boolean', /\bverdadero|\bfalso|\bbooleano/],
  ['text', /\btexto|\bcadena|\bmensaje/],
  ['call', /\bllamada|\bllama a\b/],
  ['operation', /\boperacion|\bsuma|\bresta|\bmultiplic|\bcalcula/],
  ['variable', /\bvariable|\bnumero|\bcontador/],
]

const PLACE_WORDS: [PlaceId, RegExp][] = [
  ['camino_no', /\bsi no\b|\belse\b|camino falso|camino del no|rama del no|\bno se cumple/],
  ['camino_si', /camino verdadero|camino del si|rama del si|\bse cumple/],
  ['dentro', /\bdentro|en el cuerpo/],
  ['despues', /\bdespues|\bdetras|\btras\b|\bdebajo/],
  ['principio', /\bprincipio|\binicio|\bcomienzo/],
  ['final', /\bfinal\b/],
]

/** Lo que un código no debería hacer sin que nadie lo haya pedido: tocar archivos, la red o el sistema. */
const RISKY =
  /\bos\.(remove|unlink|rmdir|system)|\bshutil\.|\bsubprocess\b|\brequests\.|\burllib\b|\bsocket\b|\beval\(|\bexec\(/

const first = <T>(table: readonly [T, RegExp][], text: string): T | undefined =>
  table.find(([, pattern]) => pattern.test(text))?.[0]

const pick = (option: string, confidence: number): JevAnswer => ({
  type: 'choice',
  choice: option,
  confidence,
  probabilities: { [option]: confidence },
})

/** Palabras de una orden que no nombran nada del programa. */
const COMMON = new Set(
  (
    'anade agrega crea pon inserta mete nuevo nueva elimina borra quita renombra enfoca muestra ' +
    'explica ejecuta dentro despues detras tras final principio para cada bucle funcion variable ' +
    'decision etapa paso linea este esta esto del los las una uno que con como por favor'
  ).split(' '),
)

/** A qué opción de `objetivo` se refiere la orden: por su línea, o por una palabra de su texto. */
function targetIn(text: string, options: Record<string, string | null>): JevAnswer {
  const refs = Object.entries(options).filter(([ref]) => /^[pe]\d+$/.test(ref))
  const line = /\blinea (\d+)/.exec(text)?.[1]
  if (line !== undefined) {
    const at = refs.find(([, description]) =>
      new RegExp(`línea ${line}(\\b|$)`).test(description ?? ''),
    )
    if (at) return pick(at[0], SURE)
  }
  const words = text.split(/[^a-z0-9_]+/).filter((word) => word.length >= 3 && !COMMON.has(word))
  // Lo que va entre comillas angulares es el texto del elemento: ahí se busca.
  const heads = refs.map(([ref, description]) => {
    const head = plain(/«(.*)»/.exec(description ?? '')?.[1] ?? '')
    return { ref, names: head.split(/[^a-z0-9_]+/), what: plain(description ?? '').split(' ')[0] }
  })
  for (const word of words) {
    const hits = heads.filter((entry) => entry.names.includes(word))
    // Si la orden dice qué es («el bucle…», «la función…»), gana lo que lo sea.
    const typed = hits.find((entry) => entry.what !== undefined && text.includes(entry.what))
    const found = typed ?? hits[0]
    if (found) return pick(found.ref, SURE)
  }
  if ('ultimo' in options && /\beso\b|lo de antes|lo ultimo|acabas de/.test(text)) {
    return pick('ultimo', SURE)
  }
  if ('seleccionado' in options && /\b(esto|este|esta|aqui|seleccionad[oa])\b/.test(text)) {
    return pick('seleccionado', SURE)
  }
  return pick('ninguno', SURE)
}

export function localDecider(): Decider {
  return {
    id: 'local',
    decide(request: JevRequest) {
      const state = request.state as { orden?: unknown; codigo?: unknown }
      const text = plain(typeof state.orden === 'string' ? state.orden : '')
      const intent = first(INTENT_WORDS, text)
      const answers: Record<string, JevAnswer> = {}
      for (const [id, question] of Object.entries(request.questions)) {
        if (id === 'es_orden') {
          answers[id] = { type: 'noul', noul: intent === undefined ? 0.1 : SURE }
        } else if (id === 'varias') {
          answers[id] = { type: 'noul', noul: /\by (luego|despues)\b|;/.test(text) ? SURE : 0.05 }
        } else if (id === 'alcance') {
          // Lo claramente pequeno va directo; lo demas, con su plan.
          const small =
            /\bfuncion\b|\bbucle\b|\bvariable\b|\blinea\b/.test(text) &&
            !/\bprograma\b|\balgoritmo/.test(text)
          answers[id] = pick(small ? 'directo' : 'esquema', SURE)
        } else if (/^r\d+$/.test(id) && question.type === 'noul') {
          // ¿Hace falta leer este trozo? Si la orden nombra algo de su título, sí.
          const title = plain(question.instructions.split('Líneas').pop() ?? '')
          const words = text.split(/[^a-z0-9_]+/).filter((w) => w.length >= 4 && !COMMON.has(w))
          answers[id] = { type: 'noul', noul: words.some((w) => title.includes(w)) ? SURE : 0.1 }
        } else if (id === 'camara' || id === 'ritmo') {
          // Lo que abre un bloque se enseña con lo que lo rodea, y merece una pausa.
          const code = typeof state.codigo === 'string' ? state.codigo : ''
          const opens = /^\s*(def|for|while|if|with)\b.*:\s*$/m.test(code)
          const key = opens || /^\s*(return|print)\b/m.test(code)
          answers[id] =
            id === 'camara'
              ? pick(opens ? 'conjunto' : 'acercar', SURE)
              : pick(key ? 'pausa' : 'seguir', SURE)
        } else if (id === 'etapa' && question.type === 'choice') {
          // La etapa cuyo título o explicación comparte alguna palabra con el código; si ninguna, no se sabe.
          const code = plain(typeof state.codigo === 'string' ? state.codigo : '')
          const names = code.split(/[^a-z0-9]+/).filter((word) => word.length >= 4)
          // La que más palabras comparta; en un empate, la más avanzada (el código va hacia delante).
          let hit: [string, number] | null = null
          for (const [option, description] of Object.entries(question.criteria)) {
            const words = plain(description ?? '').split(/[^a-z0-9]+/)
            const shared = names.filter((name) =>
              words.some((word) => word.length >= 4 && word.startsWith(name.slice(0, 5))),
            ).length
            if (shared > 0 && (hit === null || shared >= hit[1])) hit = [option, shared]
          }
          answers[id] = hit ? pick(hit[0], SURE) : pick('e1', UNSURE)
        } else if (id === 'ayuda') {
          const code = typeof state.codigo === 'string' ? state.codigo : ''
          answers[id] = {
            type: 'noul',
            noul: /exp\(|\*\*|sqrt\(|log\(|tanh\(/.test(code) ? SURE : 0.1,
          }
        } else if (id === 'rango') {
          answers[id] = pick('de -6 a 6', SURE)
        } else if (id === 'encaja' || id === 'pertinente') {
          answers[id] = { type: 'noul', noul: SURE }
        } else if (id === 'cumple') {
          answers[id] = { type: 'noul', noul: SURE }
        } else if (id === 'seguro') {
          const code = typeof state.codigo === 'string' ? state.codigo : ''
          answers[id] = { type: 'noul', noul: RISKY.test(code) ? 0.1 : SURE }
        } else if (id === 'accion') {
          answers[id] = intent === undefined ? pick('otra', UNSURE) : pick(intent, SURE)
        } else if (id === 'pieza') {
          const piece = first(PIECE_WORDS, text)
          answers[id] = piece === undefined ? pick('ninguna', SURE) : pick(piece, SURE)
        } else if (id === 'donde') {
          const place = first(PLACE_WORDS, text)
          answers[id] = place === undefined ? pick('final', UNSURE) : pick(place, SURE)
        } else if (id === 'objetivo' && question.type === 'choice') {
          answers[id] = targetIn(text, question.criteria)
        }
      }
      return Promise.resolve({ answers, ms: 0 })
    },
  }
}
