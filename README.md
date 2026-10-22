# FOAB Bot

Bot de Discord para el gremio: kills/deaths por squad (`/getkills`), gestión de
squads (`/squads`) y asistencia a batallas (`/attendance`), sobre datos de la
API oficial de Albion Online y de albionbb (ver [docs/albionbb-api.md](docs/albionbb-api.md)).

## Setup

```bash
npm install
cp .env.example .env   # y rellena los valores
```

Variables requeridas en `.env`: ver [`.env.example`](.env.example). En el `.env`
solo va lo que es del bot (token, ids, `DATA_DIR`, `TZ`, `DM_OWNER_ID`). Lo que
es de cada servidor de Discord vive en su `config.json` (ver abajo).

## Datos por servidor

El bot es multiservidor: cada servidor de Discord tiene su propia carpeta en
`DATA_DIR`, aislada del resto:

```
DATA_DIR/
  guilds/
    <guildId>/
      config.json     rol de oficiales, canal de logs, gremio de Albion...
      squads.json
      raffles.json
      backups/
  backups/            copia previa a la migración multiservidor
  dm.json             estado de /dm (es del bot, no de un servidor)
```

`config.json` se crea con valores vacíos la primera vez que el bot lo necesita.
Se edita con `/config` (ver abajo), no a mano.

## Configurar un servidor: `/config`

Lo primero al añadir el bot a un servidor es `/config view`: enseña cada valor,
marca los que faltan y dice qué comandos no funcionan todavía por ello.

`/config` exige el permiso nativo de **Administrador** de Discord, no el rol de
oficiales (en un servidor recién añadido todavía no hay rol de oficiales que
exigir). Se comprueba en tiempo de ejecución: aunque alguien cambie quién lo ve
desde los ajustes de integraciones del servidor, sin Administrador no hace nada.
El resto de comandos de gestión siguen usando el rol de oficiales.

| Subcomando | Campo | Sin él |
|---|---|---|
| `/config officer role:<rol>` | `officerRoleId` | `/squads`, `/raffle`, `/create-role` y `/health` no funcionan |
| `/config logs channel:<canal>` | `logChannelId` | los cambios y errores no quedan registrados |
| `/config raffle-role role:<rol>` | `raffleRoleId` | opcional: `/raffle` no menciona a ningún rol |
| `/config dm-optout role:<rol>` | `dmOptoutRoleId` | opcional: nadie puede excluirse de `/dm` |
| `/config server value:<europe\|americas\|asia>` | `albionServer` | por defecto `europe` |
| `/config guild name:<gremio>` | `albionGuild` | `/getkills` no funciona |
| `/config albionbb value:<id>` | `albionbbGuildId` | `/attendance` no funciona |
| `/config language value:<en\|es>` | `idioma` | por defecto, el idioma del servidor de Discord |
| `/config reset field:<subcomando>` | — | vuelve el campo a su valor por defecto |

- `/config guild` acepta **un solo** gremio, el principal. Los demás se siguen
  como squads de gremio: `/squads create name:<gremio> is-guild:true`.
- Cada cambio se valida antes de guardarse: el canal de logs tiene que ser de
  texto y el bot tiene que poder escribir en él; el id de albionbb se comprueba
  contra albionbb en el servidor configurado (acepta también la URL de la
  página del gremio).
- Cada cambio queda registrado en el canal de logs, con el antes y el después.

Un comando al que le falta configuración no da "error inesperado": dice qué
falta y con qué `/config` se arregla.

### Migración desde la versión de un solo servidor

Al arrancar, si `DATA_DIR` todavía tiene la estructura vieja (`squads.json`
suelto en la raíz) y no existe `guilds/`, el bot migra una sola vez:

1. copia todo `DATA_DIR` a `DATA_DIR/backups/pre-multiguild-<fecha>/`;
2. mueve `squads.json`, `raffles.json` y `backups/` a `guilds/<GUILD_ID>/`;
3. crea su `config.json` con los valores que había en el `.env`
   (`OFFICER_ROLE_ID`, `LOG_CHANNEL_ID`, `RAFFLE_ROLE_ID`, `DM_OPTOUT_ROLE_ID`,
   `ALBION_SERVER`, `ALBIONBB_GUILD_ID`). `albionGuild` toma el primer gremio de
   la lista vieja; si había más, lo avisa por log.

**No quites esas variables del `.env` hasta que la migración haya corrido**: son
la única fuente de la que sale el `config.json`. Después ya no se leen.

Si falta `GUILD_ID`, el bot **no arranca** y no mueve nada (mover los datos al
servidor equivocado es peor que no arrancar). Si `guilds/` ya existe, no hace
nada.

## Entrar y salir de servidores

- **Al añadir el bot a un servidor** se crea su carpeta con un `config.json`
  por defecto y se publica una bienvenida de tres líneas (en el canal de
  sistema, o en el primero donde pueda escribir) pidiendo a un administrador
  que ejecute `/config view`, en el idioma del servidor de Discord
  (`preferredLocale`: si está en español, el bot empieza en español). Empieza
  **sin squads**: el semilla
  (`src/config/squads.seed.json`) es solo para `npm run smoke` y nunca se copia
  a un servidor.
- **Al echarlo, no se borra nada**: su `config.json` pasa a `"activo": false`
  con la fecha en `"inactivoDesde"`. Si lo vuelven a añadir, recupera su
  configuración y sus squads tal cual.
- Al arrancar se reconcilia contra la lista real de servidores, porque las
  entradas y salidas con el bot apagado no generan eventos.
- **`ALLOWED_GUILD_IDS`** (opcional, ids separados por comas): si está
  definida, el bot sale de cualquier servidor fuera de la lista (al entrar y al
  arrancar) y lo deja en el log, sin crearle carpeta. Vacía, acepta cualquiera.

`/health` muestra en cuántos servidores está el bot y cuántos tienen la
configuración completa.

## Idiomas

Los comandos son los mismos para todo el mundo, pero Discord los muestra con el
nombre y la descripción del idioma del **cliente** de cada usuario
(`setNameLocalizations` / `setDescriptionLocalizations`, con `es-ES` y
`es-419`). No hay comandos duplicados: `/raffle` y `/sorteo` son el mismo.

| Inglés (canónico) | Cliente en español |
|---|---|
| `/getkills` | `/getkills` |
| `/attendance player days` | `/asistencia jugador dias` |
| `/raffle minutes role` | `/sorteo minutos rol` |
| `/create-role name list` | `/crear-rol nombre lista` |
| `/health` | `/estado` |
| `/dm role list` | `/dm rol lista` |
| `/squads …` | `/squads …` (igual) |
| `/config …` | `/config …` (igual) |

`/squads` y `/config` son de administración: su nombre, sus subcomandos y sus
opciones son **solo en inglés**, para que cualquier guía sirva a todos. Sus
descripciones sí se traducen.

Las **respuestas** del bot no pueden seguir siempre al cliente: un mensaje
público es uno solo y lo lee todo el servidor.

- **Efímeras** (confirmaciones, errores, previsualizaciones): en el idioma del
  cliente de quien las provocó.
- **Públicas** (el embed de `/getkills`, `/attendance`, el anuncio y el
  resultado de un sorteo, el progreso de `/dm`, el canal de logs, la
  bienvenida): en el idioma del servidor, `"idioma"` en su `config.json`, que se
  cambia con `/config language`.

Todos los textos están en `src/i18n.js`, uno por frase completa y con
marcadores `{valor}`. Si falta una clave en español se usa la inglesa y queda en
el log. No se traducen los nombres de jugadores, de squads y de gremios, ni los
servidores de Albion (`europe`, `americas`, `asia`).

## Squads de jugadores y de gremio

`squads.json` tiene dos tipos de squad, y `isGuild` es obligatorio en todos:

```json
{
  "squads": {
    "foab":     { "isGuild": false, "members": ["FokinFran", "DanyHM"] },
    "Dementia": { "isGuild": true,  "members": [] }
  }
}
```

- **De jugadores** (`isGuild: false`): una lista de nombres. Un squad recién
  creado está vacío y sigue siendo de jugadores: cuenta cero, nunca recoge a
  nadie por gremio.
- **De gremio** (`isGuild: true`): **el nombre del squad es el nombre del gremio
  de Albion** que sigue (con sus espacios y mayúsculas). `members` se ignora: los
  miembros salen del gremio en cada batalla. Por eso **renombrar un squad de
  gremio cambia a qué gremio sigue** (`/squads rename` lo avisa y pide
  confirmación). Se crea con `/squads create name:<gremio> is-guild:true`; no
  puede ser el gremio principal (`albionGuild`), que ya es MAIN ZERG.

En `/getkills` son dos secciones que no se mezclan:

- **Gremio principal**: `kills(MAIN ZERG) + suma(squads de jugadores) == TOTAL`.
- **Gremios seguidos**: cada uno sobre su gremio, con su propio subtotal. No
  entran en el TOTAL (no son del gremio principal); el conjunto sale en una línea
  aparte, `COMBINED`. Sus jugadores no cuentan como enemigos.

Si un jugador está en un squad de jugadores y además es de un gremio seguido,
cuenta en el squad de jugadores, y queda un aviso en el log y en `/health`.

Un `squads.json` en el formato viejo (squads como arrays y una lista `guilds`) se
convierte solo la primera vez que se carga, con backup: los arrays pasan a
`{ "isGuild": false, "members": [...] }` y los gremios de la lista vieja que no
son el principal pasan a squads de gremio.

## Arrancar el bot

```bash
npm start
```

## Registrar los slash commands

El registro de comandos es un paso **aparte** de arrancar el bot — hay que
correrlo cada vez que cambian los comandos (nombre, opciones, subcomandos),
no en cada arranque.

**`npm run deploy:prod` (global) es el modo normal**: un solo registro vale
para todos los servidores donde esté el bot, también los que lo añadan
después.

| Script | Cuándo usarlo | Qué registra | Propagación |
|---|---|---|---|
| `npm run deploy:prod` | Siempre (producción) | Todos los comandos menos `/dm`, globales; `/dm` solo en `DM_GUILD_ID` | **Hasta 1 hora** |
| `npm run deploy:dev` | Mientras desarrollas | Todos, `/dm` incluido, en `GUILD_ID` | Instantánea |
| `npm run deploy:clean` | Antes del primer `deploy:prod`, y al dejar de desarrollar | Borra los comandos de guild de `GUILD_ID` | Instantánea |

- **La propagación global tarda hasta una hora.** Tras un `deploy:prod`, un
  comando nuevo o cambiado puede no verse todavía en algunos servidores (o
  verse con las opciones viejas). No es un fallo: espera antes de tocar nada.
- **Antes del primer `deploy:prod`, corre `npm run deploy:clean`** sobre el
  servidor de desarrollo. Si no, ahí cada comando sale **duplicado** (el de
  guild de `deploy:dev` y el global). Lo mismo cada vez que vuelvas de
  `deploy:dev` a producción.
- **`/dm` no es global.** Global, saldría en la lista de todos los servidores
  y cualquiera que lo probara recibiría un rechazo: ruido, y además enseña que
  existe. Se registra como comando de guild solo en `DM_GUILD_ID` (el servidor
  donde está `DM_OWNER_ID`). Quién puede usarlo sigue siendo solo
  `DM_OWNER_ID`, global al bot: `/config` no lo toca y ningún administrador
  puede concederlo. Si `DM_GUILD_ID` falta, `deploy:prod` avisa y no registra
  `/dm` en ninguna parte. Si `GUILD_ID` y `DM_GUILD_ID` son el mismo
  servidor, `deploy:clean` conserva `/dm`.
- Los comandos globales solo se ofrecen dentro de servidores, no por mensaje
  directo (y el bot rechaza cualquiera que llegue por DM).

### Después de renombrar un comando

Para Discord, cambiar el nombre de un comando es crear uno nuevo, no renombrar
el viejo. Así pasó con `/sorteo` → `/raffle` y `/crear-rol` → `/create-role`
(y los subcomandos de `/config`):

- **Globales:** `deploy:prod` reemplaza la lista entera, así que los nombres
  viejos desaparecen solos, con la misma hora de propagación.
- **De guild:** si el servidor de desarrollo tiene comandos de un
  `deploy:dev` antiguo, ahí siguen los viejos junto a los nuevos hasta que
  corras `npm run deploy:clean`. Haz siempre `deploy:clean` y luego
  `deploy:prod`.
- **Avisa en el canal del gremio:** la gente tiene memoria muscular con los
  nombres viejos. Con el cliente en español seguirán viendo `/sorteo` y
  `/crear-rol`, pero los subcomandos de `/config` y las opciones de `/squads`
  pasan a estar en inglés.

El modo también se puede fijar con la variable de entorno `DEPLOY_SCOPE`
(`guild` | `global` | `clean`, por defecto `guild`) en vez del argumento CLI —
por ejemplo si lo lanzas desde un proceso que ya trae `DEPLOY_SCOPE` en su
entorno. El argumento CLI (lo que usan los scripts de `npm`) tiene prioridad
sobre la env var.

## Tests

```bash
npm test        # unit tests (node:test)
npm run smoke   # valida el pipeline real (API oficial + agregación) sin Discord
```

## Despliegue en VPS con Docker

El bot escribe sus datos en tiempo de ejecución (`/squads`, sorteos, config de
cada servidor). Esos ficheros **no viven dentro de la imagen**: viven en
`DATA_DIR` (`/data` en el contenedor), montado como volumen. Si alguna vez lo
ejecutas sin ese volumen montado, el bot arranca con un `DATA_DIR` vacío: ningún
servidor tiene squads ni config. Si en producción ves que `/squads` no encuentra
nada, revisa el volumen antes de tocar nada más.

### Primer arranque

```bash
git clone <repo> && cd FOAB_Bot
cp .env.example .env   # y rellena los valores reales
mkdir -p data
sudo chown -R 1001:1001 data   # 1001 = UID/GID del usuario "foab" del Dockerfile
docker compose up -d --build
```

El `chown` es necesario porque el contenedor corre como usuario no-root
(UID 1001, fijado explícitamente en el `Dockerfile` para que este número no
cambie de un build a otro). Si el volumen `./data` queda con otro dueño (por
defecto, `root`, o el usuario que ejecutó `docker compose`), el proceso no
podrá escribir en `data/guilds/` y `/squads` fallará con un error de permisos.

`data/guilds/<guildId>/squads.json` es la fuente de verdad de cada servidor —
edítalo solo a través de `/squads`, nunca a mano mientras el bot corre (no
pasa por el mutex ni por la validación).

Después de este primer arranque, registra los slash commands (es un paso
aparte, ver arriba) — normalmente `npm run deploy:prod` desde tu máquina o
`docker compose exec bot npm run deploy:prod` desde el propio contenedor.

### Actualizar (redeploy)

```bash
git pull
docker compose up -d --build
```

`data/` no se toca en un rebuild/redeploy: es un volumen aparte de la imagen,
así que `guilds/` y los backups sobreviven. Esto es justo lo que arregla
todo este mecanismo — antes de `DATA_DIR`, este paso borraba las ediciones de
los oficiales.

### Recuperar un backup

Cada escritura de `/squads` deja una copia en
`data/guilds/<guildId>/backups/squads-<timestamp>.json` antes de aplicar el cambio
(se conservan las últimas 10 por servidor). Para restaurar una:

```bash
docker compose stop bot
ls data/guilds/<guildId>/backups/                   # elige el timestamp que quieras
cp data/guilds/<guildId>/backups/squads-2026-08-17T10-23-45-123Z.json data/guilds/<guildId>/squads.json
docker compose start bot
```

No hace falta reconstruir la imagen ni tocar el contenedor para esto — `data/`
es un directorio normal en el host, se edita directamente. Para el bot antes
de tocar `squads.json` a mano: si edita el fichero mientras el proceso está
escribiendo (por un `/squads` en curso), el resultado no es predecible.
