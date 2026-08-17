# API interna de albionbb (attendance)

No es una API oficial ni documentada por albionbb: esto es ingeniería inversa
hecha inspeccionando `fetch()` real desde la página `/guilds/<guildId>/attendance`
en cada uno de los tres frontends (`europe.albionbb.com`, `albionbb.com`,
`east.albionbb.com`), instrumentando `window.fetch` en el navegador y
disparando el filtro de la UI para forzar la llamada (la carga inicial de la
página es SSR de Nuxt y no genera una petición visible en el Network tab).

## Endpoint

```
GET https://api.albionbb.com/{server}/stats/guilds/{guildId}
```

### Mapeo de servidor

Confirmado probando cada subdominio contra cada código: un código válido
responde `404 "Guild not found"` (el guildId de prueba no existe, pero la ruta
sí); un código inválido responde `404 "404 page not found"` (routing genérico,
ruta no reconocida).

| Nuestro `server` | Subdominio del sitio | Código de la API |
|---|---|---|
| `europe`   | `europe.albionbb.com` | `eu` |
| `americas` | `albionbb.com` (título de la página: "Albionbb West") | `us` |
| `asia`     | `east.albionbb.com` | `asia` |

Nota: `east` (el nombre del subdominio) **no** es el código de la API — la API
usa `asia`. `west`/`americas` tampoco son válidos como código — es `us`.

### Query params (confirmados por prueba directa)

| Param | Ejemplo | Efecto |
|---|---|---|
| `start` | `2026-08-01` | Fecha ISO (solo día). Filtra battles desde esta fecha. |
| `end` | `2026-08-16` | Fecha ISO. Filtra hasta esta fecha. Si `start > end`, devuelve `[]` (sin error, sin auto-corrección). |
| `minPlayers` | `10` | La UI lo manda por defecto en 10, pero probado con `minPlayers=1` y sin el parámetro el resultado es idéntico contra este guild — su efecto exacto (¿mínimo de jugadores por batalla contada, o algo distinto?) no quedó 100% aclarado; se pasa tal cual lo manda la UI. |

Ningún parámetro es obligatorio. Sin `start`/`end` devuelve el histórico
completo (probado: 518 entradas sin filtro vs. 166 con un rango de ~2 semanas,
contra el mismo guild).

### Sin paginación en servidor

Confirmado: la respuesta es un único array JSON con **todas** las entradas que
matchean los filtros, no un objeto `{items, page, total}` ni cabeceras de
paginación. La tabla de la UI pagina 25 por página **solo en cliente**, sobre
este mismo array ya completo — exactamente como sospechaba el prompt. No hace
falta iterar páginas.

### Respuesta

```json
[
  {
    "name": "Sziahogyvagy",
    "guildName": "Skoggangr",
    "allianceName": "OMW",
    "lastBattle": "2026-08-16T20:20:43.238Z",
    "attendance": 76,
    "kills": 32,
    "deaths": 25,
    "killFame": 16961296,
    "deathFame": 18955220,
    "heal": 4171870,
    "damage": 27988,
    "avgIp": 1592,
    "roles": [61, 2, 6, 5, 2, 0]
  }
]
```

Headers de respuesta observados: `content-type: application/json; charset=utf-8`,
`cache-control: public, max-age=1800` (el propio albionbb cachea 30 min en su
CDN/edge).

### La columna `roles` (las 6 columnas sin cabecera de texto)

Verificado que **suman exactamente `attendance`**: `61+2+6+5+2+0 = 76` ✓,
`37+2+4+25+3+0 = 71` ✓ (comprobado contra varias filas).

Los 6 `<th>` correspondientes no tienen texto ni `title`/`aria-label` — son
solo un SVG inline cada uno, y no pude activar el tooltip real (hover
sintético vía JS no lo dispara; no tuve captura de pantalla disponible en esta
sesión para confirmarlo visualmente). La identificación de cada rol es por
**forma e icono**, no por una etiqueta de texto confirmada:

| Índice | Color | Forma del icono | Rol inferido |
|---|---|---|---|
| 0 | azul `#0369A1` | escudo (path idéntico al glifo "shield" de Material Design Icons) | **Tank** |
| 1 | dorado `#CA8A04` | bandera/estandarte (glifo "flag") | **Support** (banner) |
| 2 | verde `#15803D` | cruz/plus con esquinas redondeadas | **Healer** |
| 3 | rojo `#B91C1C`, trazo | dos espadas cruzadas (glifo "swords") | **DPS melee** |
| 4 | rojo `#B91C1C`, relleno | arco y flecha | **DPS a distancia** |
| 5 | gris `#94A3B8` | cabeza de caballo (viewBox 512, estilo Font Awesome) | **Battlemount / montado** |

**Esto es una inferencia con confianza media-alta, no una confirmación
textual.** Antes de mostrar estas etiquetas en Discord como si fueran
oficiales, sería bueno que alguien del gremio las contraste visualmente en la
propia web (pasar el cursor sobre las columnas suele mostrar un tooltip que yo
no pude disparar aquí). Dejé los nombres de campo en el código fáciles de
renombrar si alguna etiqueta resulta incorrecta.

## Actualización: verificado con Node.js puro (sin navegador)

**Resuelto.** En una sesión posterior, este mismo entorno resultó tener salida
a internet general desde Node (no solo desde el navegador embebido). Se
confirmó con `fetch()` nativo de Node, sin cookies ni contexto de navegador:

```
GET https://api.albionbb.com/eu/stats/guilds/95VpWaVRTBuiBAw4XVvpZw?start=...&end=... -> 200 OK, 195 jugadores
```

`services/albionbbApi.js` funciona contra el endpoint real desde un proceso
Node.js normal — no hizo falta el plan B (SQLite). El riesgo de Cloudflare
descrito abajo no se materializó en esta prueba; queda la duda de si el
entorno de producción real del bot (hosting distinto) se comporta igual, pero
ya no es una incógnita completa.

`europe.albionbb.com` sirve `cdn-cgi/challenge-platform/...` (Cloudflare Bot
Management activo en el sitio), pero aparentemente no bloquea peticiones
directas a `api.albionbb.com` sin ese contexto de navegador.
