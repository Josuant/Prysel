/* global fetch, Response, Headers */
// Intermediario para llamar a TypeSafe (el motor JEV) desde la web de Prysel.
//
// La API de TypeSafe no admite llamadas desde páginas web (no envía las cabeceras CORS), así que el
// navegador corta la petición. Este Worker de Cloudflare la reenvía tal cual, con la clave que manda la
// página, y añade esas cabeceras. No guarda nada ni necesita la clave: la pone el usuario en Ajustes.
//
// Solo atiende a los orígenes de ALLOWED: cámbialos si publicas la web en otro sitio.

const TARGET = 'https://api.typesafe.ai/v1/systemone'
const ALLOWED = ['https://josuant.github.io', 'http://localhost:5174']

function cors(origin) {
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'authorization, content-type',
    'access-control-max-age': '86400',
    vary: 'origin',
  }
}

export default {
  async fetch(request) {
    const origin = request.headers.get('origin') ?? ''
    if (!ALLOWED.includes(origin)) return new Response('Origen no permitido', { status: 403 })
    if (request.method === 'OPTIONS')
      return new Response(null, { status: 204, headers: cors(origin) })
    if (request.method !== 'POST') {
      return new Response('Solo POST', { status: 405, headers: cors(origin) })
    }
    const upstream = await fetch(TARGET, {
      method: 'POST',
      headers: {
        authorization: request.headers.get('authorization') ?? '',
        'content-type': 'application/json',
      },
      body: await request.text(),
    })
    const headers = new Headers(cors(origin))
    headers.set('content-type', upstream.headers.get('content-type') ?? 'application/json')
    return new Response(upstream.body, { status: upstream.status, headers })
  },
}
