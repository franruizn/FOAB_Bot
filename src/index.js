import 'dotenv/config';
import { Client, Collection, Events, GatewayIntentBits, Partials } from 'discord.js';
import * as getkills from './commands/getkills.js';
import * as squads from './commands/squads.js';
import * as attendance from './commands/attendance.js';
import * as health from './commands/health.js';
import * as sorteo from './commands/sorteo.js';
import * as crearRol from './commands/crearRol.js';
import * as dm from './commands/dm.js';
import { handleInteractionError } from './interactionErrorHandler.js';
import { ensureSquadsConfig } from './dataPaths.js';
import { waitForPendingWrites } from './services/squadsStore.js';
import { waitForPendingRaffleWrites } from './services/rafflesStore.js';
import { notifyUncontrolledError, notifyDmInterrupted } from './logChannel.js';
import { initializeRaffles, handleRaffleReactionAdd } from './raffleScheduler.js';
import { takeInterruptedDmSend, waitForPendingDmWrites } from './services/massDm.js';
import { DM_STATE_PATH } from './dataPaths.js';

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
//
// GuildMembers SÍ es un intent PRIVILEGIADO: hay que activar "Server
// Members Intent" en el Developer Portal del bot (pestaña Bot), si no
// `guild.members.fetch()` falla en producción. Lo necesitan /crear-rol y
// /dm para resolver a los miembros del servidor.
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.GuildMembers,
  ],
  partials: [Partials.Message, Partials.Reaction, Partials.Channel],
});

client.commands = new Collection();
for (const command of [getkills, squads, attendance, health, sorteo, crearRol, dm]) {
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
    // Un /dm cortado por el reinicio NO se reanuda (reenviar a quien ya lo
    // recibió es peor que no enviar): solo se avisa de cuántos salieron.
    const interrumpido = await takeInterruptedDmSend(DM_STATE_PATH);
    if (interrumpido) {
      console.warn(`[dm] Envío interrumpido: ${interrumpido.sentIds.length}/${interrumpido.total} enviados. No se reanuda.`);
      await notifyDmInterrupted(readyClient, interrumpido);
    }
  } catch (error) {
    console.error('[dm] Error comprobando envíos interrumpidos:', error?.stack ?? error);
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

client.on(Events.MessageReactionAdd, (reaction, user) => {
  handleRaffleReactionAdd(reaction, user).catch((error) => {
    console.error('[raffle] Error procesando messageReactionAdd:', error?.stack ?? error);
  });
});

let isShuttingDown = false;

client.on(Events.InteractionCreate, async (interaction) => {
  if (isShuttingDown) return; // no aceptar trabajo nuevo mientras cerramos

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
    // Espera cualquier escritura de squads.json, raffles.json o dm.json ya
    // en curso (tmp + rename) antes de desconectar, para no cortarla a mitad.
    await Promise.all([waitForPendingWrites(), waitForPendingRaffleWrites(), waitForPendingDmWrites()]);
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
