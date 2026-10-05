# Intermediario para TypeSafe

La web de Prysel llama a las IAs directamente desde el navegador. Anthropic y DeepSeek lo permiten; la API de TypeSafe (el motor JEV) no, así que hace falta un intermediario que reenvíe las peticiones. Sin él, la web decide con el motor local.

`typesafe-worker.js` es ese intermediario: un Worker de Cloudflare (gratis) que reenvía cada petición a `api.typesafe.ai` con la clave que manda la página. No guarda nada ni lleva ninguna clave dentro.

## Publicarlo (desde el navegador, también desde el móvil)

1. Entra en [dash.cloudflare.com](https://dash.cloudflare.com) → **Workers & Pages** → **Create** → **Create Worker**.
2. Ponle un nombre (por ejemplo `prysel-jev`) y pulsa **Deploy**.
3. **Edit code**: borra lo que hay, pega el contenido de `typesafe-worker.js` y pulsa **Deploy**.
4. Copia la dirección del Worker (`https://prysel-jev.<tu-cuenta>.workers.dev`).
5. En Prysel: ☰ → **Ajustes → Inteligencia artificial** → **Intermediario para TypeSafe**, pega la dirección y guarda.

Si publicas la web en otra dirección, añádela a `ALLOWED` en el código del Worker.
