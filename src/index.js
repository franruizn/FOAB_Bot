import 'dotenv/config';
import { Client, Collection, Events, GatewayIntentBits, Partials } from 'discord.js';
import * as getkills from './commands/getkills.js';
import * as squads from './commands/squads.js';
import * as attendance from './commands/attendance.js';
import * as comp from './commands/comp.js';
import * as cta from './commands/cta.js';
import * as maestria from './commands/maestria.js';
import * as health from './commands/health.js';
import * as sorteo from './commands/sorteo.js';
import { handleInteractionError } from './interactionErrorHandler.js';
import { ensureSquadsConfig } from './dataPaths.js';
import { waitForPendingWrites } from './services/squadsStore.js';
import { waitForPendingRaffleWrites } from './services/rafflesStore.js';
import { waitForPendingCtaWrites } from './services/ctaStore.js';
import { notifyUncontrolledError } from './logChannel.js';
import { initializeRaffles } from './raffleScheduler.js';
import { initializeCtaTimers } from './ctaScheduler.js';
import { flushPendingEmbedRefreshes } from './ctaEmbedSync.js';
import { validarCredenciales } from './services/sheets.js';

const { DISCORD_TOKEN } = process.env;

if (!DISCORD_TOKEN) {
  throw new Error('Falta la variable de entorno DISCORD_TOKEN');
}

// --- que el proceso nunca muera en silencio: logueamos el stack completo
// antes de salir. Con restart: unless-stopped, Docker vuelve a levantarlo. ---

process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason instanceof Error ? reason.stack : reason);
  process.exit(1);
});

process.on('uncaughtException', (error) => {
  console.error('[uncaughtException]', error?.stack ?? error);
  process.exit(1);
});

// GuildMessageReactions no es un intent privilegiado (no requiere activarlo
// en el Developer Portal). Los partials son necesarios para /sorteo: tras un
// reinicio el mensaje del sorteo no está en caché, y sin Partials.Message /
// Partials.Reaction las reacciones de un mensaje no cacheado llegan
// incompletas.
// GuildVoiceStates NO es un intent privilegiado (no hace falta activarlo en
// el Developer Portal). Lo necesita /cta voz para ver quién está en el
// canal de voz del oficial que lo ejecuta.
//
// GuildMembers SÍ es un intent PRIVILEGIADO: hay que activar "Server
// Members Intent" en el Developer Portal del bot (pestaña Bot), si no
// `guild.members.fetch()` falla en producción. Lo necesita /cta sync para
// reconciliar el rol de una CTA abierta (services/ctaRole.js,
// reconciliarRolDeCta) contra quién está inscrito de verdad ahora mismo.
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMembers,
  ],
  partials: [Partials.Message, Partials.Reaction, Partials.Channel],
});

client.commands = new Collection();
for (const command of [getkills, squads, attendance, comp, cta, maestria, health, sorteo]) {
  client.commands.set(command.data.name, command);
}

client.once(Events.ClientReady, async (readyClient) => {
  console.log(`Sesión iniciada como ${readyClient.user.tag}`);
  try {
    await initializeRaffles(readyClient);
  } catch (error) {
    console.error('[raffle] Error inicializando sorteos pendientes:', error?.stack ?? error);
  }
  try {
    await initializeCtaTimers(readyClient);
  } catch (error) {
    console.error('[cta] Error inicializando las CTAs activas:', error?.stack ?? error);
  }
  try {
    // validarCredenciales() nunca lanza (su resultado ES la respuesta): esto
    // solo salta si algo revienta antes de eso. Se comprueba una vez al
    // arrancar para que un login/credenciales rotas se note en el log desde
    // el minuto uno, en vez de esperar a que falle en caliente al cerrar la
    // primera CTA del día.
    const resultado = await validarCredenciales();
    console.log(JSON.stringify({ timestamp: isoLocal(), type: 'startup', component: 'sheets', ...resultado }));
  } catch (error) {
    console.error('[sheets] Error inesperado validando las credenciales de Google Sheets:', error?.stack ?? error);
  }
});

/**
 * Igual que Date#toISOString(), pero con el offset de la zona horaria del
 * PROCESO (la que fije `TZ`, ver .env.example) en vez de forzar UTC ("Z"):
 * estos logs se leen en vivo (`docker logs`) para depurar, y la hora tiene
 * que ser la real del gremio, no la UTC. Sigue siendo ISO-8601 con offset
 * explícito, así que sigue siendo ordenable/parseable igual que un "Z".
 */
function isoLocal(fecha = new Date()) {
  const pad = (n, len = 2) => String(n).padStart(len, '0');
  const offsetMin = -fecha.getTimezoneOffset();
  const signo = offsetMin >= 0 ? '+' : '-';
  const offset = `${signo}${pad(Math.floor(Math.abs(offsetMin) / 60))}:${pad(Math.abs(offsetMin) % 60)}`;
  return (
    `${fecha.getFullYear()}-${pad(fecha.getMonth() + 1)}-${pad(fecha.getDate())}` +
    `T${pad(fecha.getHours())}:${pad(fecha.getMinutes())}:${pad(fecha.getSeconds())}.${pad(fecha.getMilliseconds(), 3)}${offset}`
  );
}

// ApplicationCommandOptionType.SUB_COMMAND = 1, SUB_COMMAND_GROUP = 2.
function extractOptionsForLog(interaction) {
  const flat = {};
  const path = [];
  let node = interaction.options.data;

  while (node.length > 0 && (node[0].type === 1 || node[0].type === 2)) {
    path.push(node[0].name);
    node = node[0].options ?? [];
  }

  for (const opt of node) {
    flat[opt.name] = opt.value;
  }
  if (path.length > 0) flat._subcommand = path.join(' ');
  return flat;
}

function logCommand({ interaction, durationMs, result, error }) {
  const entry = {
    timestamp: isoLocal(),
    type: 'command',
    command: interaction.commandName,
    user: interaction.user?.tag ?? 'unknown',
    userId: interaction.user?.id ?? null,
    guildId: interaction.guildId ?? null,
    options: extractOptionsForLog(interaction),
    durationMs,
    result,
  };
  if (error) entry.error = error instanceof Error ? error.message : String(error);
  console.log(JSON.stringify(entry));
}

function logComponentInteraction({ interaction, kind, durationMs, result, error }) {
  const entry = {
    timestamp: isoLocal(),
    type: 'component',
    kind,
    customId: interaction.customId,
    user: interaction.user?.tag ?? 'unknown',
    userId: interaction.user?.id ?? null,
    guildId: interaction.guildId ?? null,
    durationMs,
    result,
  };
  if (error) entry.error = error instanceof Error ? error.message : String(error);
  console.log(JSON.stringify(entry));
}

let isShuttingDown = false;

client.on(Events.InteractionCreate, async (interaction) => {
  if (isShuttingDown) return; // no aceptar trabajo nuevo mientras cerramos

  // Botones y selects de una CTA (Apuntarse/Tentativo/Salir/Panel del
  // caller, y el panel de inscripción) son componentes PERSISTENTES: siguen
  // vivos horas y sobreviven a un reinicio del bot, así que se enrutan por
  // customId aquí (el dispatcher global) en vez de con un collector local
  // como hace /squads con su confirmación de borrado (que solo vive 30s).
  // Solo se intercepta lo que parsea como customId de CTA: todo lo demás
  // (confirmaciones de /squads, /comp) sigue yendo a sus propios
  // awaitMessageComponent() sin que este bloque los toque.
  if ((interaction.isButton() || interaction.isStringSelectMenu()) && cta.isCtaComponent(interaction.customId)) {
    const startedAt = Date.now();
    const kind = interaction.isButton() ? 'button' : 'select';
    try {
      if (interaction.isButton()) {
        await cta.handleButton(interaction);
      } else {
        await cta.handleSelectMenu(interaction);
      }
      logComponentInteraction({ interaction, kind, durationMs: Date.now() - startedAt, result: 'ok' });
    } catch (error) {
      logComponentInteraction({ interaction, kind, durationMs: Date.now() - startedAt, result: 'error', error });
      const { known } = await handleInteractionError(interaction, error);
      if (!known) {
        await notifyUncontrolledError(client, { commandName: `cta (${kind})`, actorTag: interaction.user.tag, error });
      }
    }
    return;
  }

  if (interaction.isAutocomplete()) {
    const command = client.commands.get(interaction.commandName);
    if (!command?.autocomplete) return;
    try {
      await command.autocomplete(interaction);
    } catch (error) {
      console.error(`Error en autocomplete de /${interaction.commandName}:`, error);
      // Las interacciones de autocomplete solo se responden con respond(),
      // nunca con reply/editReply.
      await interaction.respond([]).catch(() => {});
    }
    return;
  }

  if (!interaction.isChatInputCommand()) return;

  const command = client.commands.get(interaction.commandName);
  if (!command) {
    console.error(`Comando desconocido: ${interaction.commandName}`);
    return;
  }

  const startedAt = Date.now();
  try {
    await command.execute(interaction);
    logCommand({ interaction, durationMs: Date.now() - startedAt, result: 'ok' });
  } catch (error) {
    logCommand({ interaction, durationMs: Date.now() - startedAt, result: 'error', error });

    const { known } = await handleInteractionError(interaction, error);
    if (!known) {
      await notifyUncontrolledError(client, {
        commandName: interaction.commandName,
        actorTag: interaction.user.tag,
        error,
      });
    }
  }
});

// --- SIGTERM: cierre limpio. Docker manda esto en cada redeploy/restart. ---

async function shutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(JSON.stringify({ timestamp: isoLocal(), type: 'shutdown', msg: `Señal ${signal} recibida, cerrando...` }));

  try {
    // Fuerza cualquier reedición de embed de CTA agrupada (2s) pendiente
    // ANTES de esperar las escrituras: una reedición puede depender del
    // estado que la última escritura acaba de dejar.
    await flushPendingEmbedRefreshes();
    // Espera cualquier escritura de squads.json, raffles.json o cta.json ya
    // en curso (tmp + rename) antes de desconectar, para no cortarla a mitad.
    await Promise.all([waitForPendingWrites(), waitForPendingRaffleWrites(), waitForPendingCtaWrites()]);
  } catch (error) {
    console.error('[shutdown] Error esperando escrituras pendientes:', error?.stack ?? error);
  }

  client.destroy();
  console.log(JSON.stringify({ timestamp: isoLocal(), type: 'shutdown', msg: 'Cerrado limpiamente.' }));
  process.exit(0);
}

process.on('SIGTERM', () => {
  shutdown('SIGTERM').catch((error) => {
    console.error('[shutdown] Error inesperado cerrando:', error?.stack ?? error);
    process.exit(1);
  });
});

await ensureSquadsConfig();
client.login(DISCORD_TOKEN);
