import 'dotenv/config';
import { Client, Collection, Events, GatewayIntentBits, Partials } from 'discord.js';
import * as getkills from './commands/getkills.js';
import * as squads from './commands/squads.js';
import * as attendance from './commands/attendance.js';
import * as health from './commands/health.js';
import * as sorteo from './commands/sorteo.js';
import * as cta from './commands/cta.js';
import { handleInteractionError } from './interactionErrorHandler.js';
import { ensureSquadsConfig } from './dataPaths.js';
import { waitForPendingWrites } from './services/squadsStore.js';
import { waitForPendingRaffleWrites } from './services/rafflesStore.js';
import { waitForPendingCtaWrites } from './services/ctaStore.js';
import { notifyUncontrolledError } from './logChannel.js';
import { initializeRaffles } from './raffleScheduler.js';
import { initializeCta } from './ctaScheduler.js';
import { flushPendingEmbedRefreshes } from './ctaEmbedSync.js';
import { flushActiveCtaSheetSync } from './ctaSheetSync.js';
import { validarCredencialesSheetsAlArrancar } from './services/sheets.js';

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
// GuildMembers SÍ es un intent privilegiado: hay que activarlo a mano en
// Discord Developer Portal -> tu app -> Bot -> "Server Members Intent",
// además de declararlo aquí. Sin los dos, guild.members.fetch() falla (o
// devuelve una caché incompleta) y /cta sync / /cta roles darían falsos
// positivos al contar miembros con el rol de una CTA.
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessageReactions, GatewayIntentBits.GuildMembers],
  partials: [Partials.Message, Partials.Reaction, Partials.Channel],
});

client.commands = new Collection();
for (const command of [getkills, squads, attendance, health, sorteo, cta]) {
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
    await initializeCta(readyClient);
  } catch (error) {
    console.error('[cta] Error inicializando la CTA activa:', error?.stack ?? error);
  }
});

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
    timestamp: new Date().toISOString(),
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
    timestamp: new Date().toISOString(),
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

  // Botones y el modal de /cta son componentes PERSISTENTES: siguen vivos
  // horas y sobreviven a un reinicio del bot, así que se enrutan por
  // customId aquí (el dispatcher global) en vez de con un collector local
  // como hace /squads con su confirmación de borrado (que solo vive 30s).
  if (interaction.isButton() && cta.isCtaComponent(interaction.customId)) {
    const startedAt = Date.now();
    try {
      await cta.handleButton(interaction);
      logComponentInteraction({ interaction, kind: 'button', durationMs: Date.now() - startedAt, result: 'ok' });
    } catch (error) {
      logComponentInteraction({ interaction, kind: 'button', durationMs: Date.now() - startedAt, result: 'error', error });
      const { known } = await handleInteractionError(interaction, error);
      if (!known) {
        await notifyUncontrolledError(client, { commandName: 'cta (botón)', actorTag: interaction.user.tag, error });
      }
    }
    return;
  }

  if (interaction.isModalSubmit() && cta.isCtaComponent(interaction.customId)) {
    const startedAt = Date.now();
    try {
      await cta.handleModalSubmit(interaction);
      logComponentInteraction({ interaction, kind: 'modal', durationMs: Date.now() - startedAt, result: 'ok' });
    } catch (error) {
      logComponentInteraction({ interaction, kind: 'modal', durationMs: Date.now() - startedAt, result: 'error', error });
      const { known } = await handleInteractionError(interaction, error);
      if (!known) {
        await notifyUncontrolledError(client, { commandName: 'cta (modal)', actorTag: interaction.user.tag, error });
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
  console.log(JSON.stringify({ timestamp: new Date().toISOString(), type: 'shutdown', msg: `Señal ${signal} recibida, cerrando...` }));

  try {
    // Espera cualquier escritura de squads.json, raffles.json o cta.json ya
    // en curso (tmp + rename) antes de desconectar, para no cortarla a mitad.
    await Promise.all([waitForPendingWrites(), waitForPendingRaffleWrites(), waitForPendingCtaWrites()]);

    // Fuerza la sincronización de la hoja de /cta agrupada (2s) pendiente
    // ANTES de vaciar la reedición del embed: si la hoja acaba de fallar o
    // recuperarse aquí mismo, eso puede disparar una reedición nueva (el
    // aviso de "desincronizada" en el footer) que también hay que vaciar,
    // no dejarla a medias para el próximo arranque.
    await flushActiveCtaSheetSync(client);
    await flushPendingEmbedRefreshes();
  } catch (error) {
    console.error('[shutdown] Error esperando escrituras pendientes:', error?.stack ?? error);
  }

  client.destroy();
  console.log(JSON.stringify({ timestamp: new Date().toISOString(), type: 'shutdown', msg: 'Cerrado limpiamente.' }));
  process.exit(0);
}

process.on('SIGTERM', () => {
  shutdown('SIGTERM').catch((error) => {
    console.error('[shutdown] Error inesperado cerrando:', error?.stack ?? error);
    process.exit(1);
  });
});

await ensureSquadsConfig();
// Valida las credenciales de Google Sheets AQUÍ, al arrancar — no esperar a
// que alguien pulse "Apuntarse" en la primera CTA. Nunca lanza (ver su
// propio comentario): un fallo queda en los logs del arranque, no tumba el
// resto del bot (getkills/squads/attendance/health/sorteo no dependen de esto).
await validarCredencialesSheetsAlArrancar();
client.login(DISCORD_TOKEN);
