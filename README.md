# FOAB Bot

Bot de Discord para el gremio: kills/deaths por squad (`/getkills`), gestión de
squads (`/squads`) y asistencia a batallas (`/attendance`), sobre datos de la
API oficial de Albion Online y de albionbb (ver [docs/albionbb-api.md](docs/albionbb-api.md)).

## Setup

```bash
npm install
cp .env.example .env   # y rellena los valores
```

Variables requeridas en `.env`: ver [`.env.example`](.env.example).

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

`/squads` escribe `squads.json` en tiempo de ejecución (altas, bajas, cambios de
squad). Ese fichero **no vive dentro de la imagen**: vive en `DATA_DIR` (`/data`
en el contenedor), montado como volumen. Si alguna vez lo ejecutas sin ese
volumen montado, el bot arranca igual pero con el fichero semilla vacío/de
ejemplo que trae la imagen — y lo dice bien claro por log
(`[dataPaths] "..." no existía...`). Si ves ese aviso en producción, algo está
mal montado: para el contenedor y revisa el volumen antes de dejar que nadie
use `/squads`.

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
podrá escribir `squads.json` ni sus backups y `/squads` fallará con un error
de permisos.

En este primer arranque, `data/` está vacío: el bot copia el fichero semilla
(`src/config/squads.seed.json`, horneado en la imagen) a `data/squads.json` y
lo dice por log. A partir de ahí, `data/squads.json` es la fuente de verdad —
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
así que `squads.json` y los backups sobreviven. Esto es justo lo que arregla
todo este mecanismo — antes de `DATA_DIR`, este paso borraba las ediciones de
los oficiales.

### Recuperar un backup

Cada escritura de `/squads` deja una copia en `data/backups/squads-<timestamp>.json`
antes de aplicar el cambio (se conservan las últimas 10). Para restaurar una:

```bash
docker compose stop bot
ls data/backups/                                    # elige el timestamp que quieras
cp data/backups/squads-2026-08-17T10-23-45-123Z.json data/squads.json
docker compose start bot
```

No hace falta reconstruir la imagen ni tocar el contenedor para esto — `data/`
es un directorio normal en el host, se edita directamente. Para el bot antes
de tocar `squads.json` a mano: si edita el fichero mientras el proceso está
escribiendo (por un `/squads` en curso), el resultado no es predecible.
