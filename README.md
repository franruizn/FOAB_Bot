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
Todavía no hay ningún comando para editarlo: de momento se edita a mano, con el
bot parado.

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

## Arrancar el bot

```bash
npm start
```

## Registrar los slash commands

El registro de comandos es un paso **aparte** de arrancar el bot — hay que
correrlo cada vez que cambian los comandos (nombre, opciones, subcomandos),
no en cada arranque.

| Script | Cuándo usarlo | Alcance | Propagación |
|---|---|---|---|
| `npm run deploy:dev` | Mientras desarrollas | Un solo servidor (`GUILD_ID` en `.env`) | Instantánea |
| `npm run deploy:prod` | Al publicar una versión estable | Todos los servidores donde esté el bot | Hasta 1 hora |
| `npm run deploy:clean` | Al pasar de dev a prod (o viceversa) | Borra los comandos de guild de `GUILD_ID` | Instantánea |

**Por qué existe `deploy:clean`:** si registras los comandos en modo `guild`
(dev) y luego también en modo `global` (prod) sin limpiar, Discord muestra
**cada comando duplicado** en ese servidor (uno de guild, otro global). Antes
de pasar a producción en un servidor que usaste para desarrollo, corre
`npm run deploy:clean` para borrar los comandos de guild y quedarte solo con
los globales.

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
