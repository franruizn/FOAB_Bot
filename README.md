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

## Google Sheets (cuenta de servicio)

El bot escribe en una hoja de cálculo (lista de apuntados a CTA, por ejemplo)
usando una **cuenta de servicio** de Google, no OAuth de usuario — el bot corre
sin nadie delante y no puede completar un flujo de consentimiento interactivo.

### Setup (una sola vez)

1. Andá a [console.cloud.google.com](https://console.cloud.google.com) y creá un proyecto.
2. En ese proyecto, habilitá la **Google Sheets API**.
3. IAM y administración → Cuentas de servicio → Crear cuenta de servicio.
4. En esa cuenta de servicio: Claves → Añadir clave → JSON → descargar. Ese
   fichero es lo único que necesitás del lado de Google.
5. Copiá el email de la cuenta de servicio (termina en `.iam.gserviceaccount.com`).
6. En la hoja de cálculo: **Compartir** → pegá ese email → dale permiso de
   **Editor**. Sin este paso la API responde 403 aunque las credenciales sean
   correctas — el bot te lo va a decir explícitamente si te olvidás.

### Dónde va el JSON

El fichero descargado va montado como archivo dentro de `DATA_DIR`, **nunca**
en el `.env` (es multilínea; meterlo en una variable de entorno obliga a
escapados frágiles). Mismo patrón que `squads.json`:

```bash
cp ruta/al/descargado.json data/google-credentials.json
```

En Docker, esto significa copiarlo dentro del `data/` del Droplet (el mismo
directorio bind-mounted que ya usa `squads.json`/`raffles.json`) y darle el
mismo dueño que el resto:

```bash
sudo chown 1001:1001 data/google-credentials.json
```

### Variables de entorno

```bash
GOOGLE_CREDENTIALS_PATH=./data/google-credentials.json
CTA_SHEET_ID=<el ID de la hoja, de la URL entre /d/ y /edit>
CTA_SHEET_TAB=<nombre exacto de la pestaña>
CTA_RANGO_INICIO=P3
```

`CTA_RANGO_INICIO` es la celda donde empieza el bloque de 4 columnas (nombre,
rol1, rol2, rol3) que gestiona `src/services/sheets.js`. Igual que
`CTA_SHEET_ID` y `CTA_SHEET_TAB`, es solo el valor de **arranque**: los tres
se pueden cambiar en caliente sin tocar `.env` ni reiniciar con
`/cta hoja`/`/cta pestana`/`/cta rango` (ver más abajo).

### Verificar que funciona

```bash
npm run verify:sheets
```

Escribe 3 filas de prueba en la hoja y las vuelve a limpiar. Tiene que pasar
esto **antes** de que exista ningún comando de Discord que use la hoja — si
falla, el error te dice si es un problema de credenciales, de permisos
(compartir la hoja), o de configuración (`CTA_SHEET_TAB` mal escrito, etc.).

Además, el bot valida estas credenciales **al arrancar** (no en la primera
escritura): busca una línea `"action":"validarCredenciales"` en los logs del
arranque. `"result":"ok"` confirma el email de la cuenta de servicio;
`"result":"error"` te dice exactamente qué está mal (fichero inexistente,
JSON corrupto, faltan campos); `"result":"sin-configurar"` significa que
`GOOGLE_CREDENTIALS_PATH` ni siquiera está puesto (no es un error si todavía
no usas `/cta`).

## `/cta`: rol de Discord, permisos e intent

Además de la hoja, `/cta` crea y gestiona un rol de Discord propio por cada
CTA (se lo da a quien se apunta, se lo quita a quien se desapunta). Esto
necesita permisos y un intent que las demás funciones del bot no requieren:

1. **Permiso "Gestionar roles"**: dáselo al rol del bot en el servidor
   (Ajustes del servidor → Roles → el rol del bot → activa "Gestionar
   roles"). No hace falta re-invitar al bot para esto, se puede activar
   directamente ahí.
2. **Jerarquía**: el rol del bot tiene que estar **por encima** de la
   posición 1 (justo encima de @everyone) — cualquier otro rol propio que ya
   tenga el bot por encima de @everyone es suficiente. Si el rol del bot
   queda demasiado abajo, `/cta` lo rechaza explicándolo antes de crear nada.
3. **Intent "Server Members"** (privilegiado): actívalo en
   [Discord Developer Portal](https://discord.com/developers/applications) →
   tu aplicación → **Bot** → **Privileged Gateway Intents** → **Server
   Members Intent**. El código ya lo declara (`GatewayIntentBits.GuildMembers`
   en `src/index.js`), pero sin activarlo también aquí el bot no puede
   arrancar con ese intent — `guild.members.fetch()` fallaría, y con eso
   `/cta sync` y `/cta roles` darían resultados incompletos o directamente
   fallarían.
4. **`CTA_OFFICER_ROLE_ID`** en `.env`: el ID del rol de oficial para `/cta`
   (un único valor, igual de forma que `OFFICER_ROLE_ID` — separado de esa
   variable por si algún día se quiere un rol distinto para `/cta` que para
   `/squads`/`/health`/`/sorteo`, pero hoy pueden apuntar al mismo rol).
5. **Registrar el comando**: `/cta` es un slash command nuevo (con
   subcomandos `abrir`/`sync`/`roles`/`cerrar`/`hoja`/`pestana`/`rango`) —
   hace falta `npm run deploy:dev` o `deploy:prod` (ver "Registrar los slash
   commands" arriba) igual que con cualquier comando nuevo; no aparece solo
   por reiniciar el bot.

Ninguna dependencia nueva de npm: `/cta` reutiliza `discord.js` (ya
instalado) y `google-auth-library` (añadido cuando se montó la hoja) — no
hace falta tocar `package.json` para esto en producción, con `git pull` +
rebuild de la imagen alcanza.

### `/cta cerrar`, `/cta hoja`, `/cta pestana`, `/cta rango`

Cuatro subcomandos de oficial, sin variables de `.env` nuevas — no hace
falta tocar la configuración de producción para que funcionen, solo
desplegar el código y registrar los slash commands (paso 5 arriba):

- **`/cta cerrar`**: corta la CTA activa antes de tiempo. Mismo camino que
  el cierre automático (fuerza la hoja pendiente, deshabilita los botones,
  publica la lista final) — la única diferencia es que lo dispara un
  oficial en vez del temporizador. Si no hay ninguna CTA activa, avisa en
  vez de fallar.
- **`/cta hoja <id>`**: cambia en caliente qué hoja de Google Sheets usa
  `/cta`, sin tocar `CTA_SHEET_ID` en `.env` ni reiniciar el bot. Acepta
  tanto el ID suelto como la URL completa (se queda solo con el trozo entre
  `/d/` y la siguiente `/`). Recuerda compartir la hoja nueva con la cuenta
  de servicio si no lo estaba ya.
- **`/cta pestana <nombre>`**: igual que `/cta hoja`, pero para
  `CTA_SHEET_TAB` (el nombre exacto de la pestaña dentro de la hoja).
- **`/cta rango <celda>`**: igual que `/cta hoja`, pero para
  `CTA_RANGO_INICIO`. Valida el formato de la celda (ej. `P3`) antes de
  guardar nada, con el mismo `parseCellRef()` que usa cada escritura real —
  un error tipográfico se ve al momento, no en la siguiente escritura.

Los tres cambios (hoja/pestaña/rango) se persisten en
`DATA_DIR/cta-sheet-config.json` — sobreviven a un reinicio del bot, y
solo afectan a la **siguiente** escritura (no a una ya agrupada en la
ventana de 2s). Cada cambio avisa en `LOG_CHANNEL_ID` (si está configurado)
con quién lo hizo y a qué valor. Tras cualquiera de los tres, conviene
correr `/cta sync` (con una CTA activa) para comprobar que la nueva
hoja/pestaña/rango funciona de verdad.

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
