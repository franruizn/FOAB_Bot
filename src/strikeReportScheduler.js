import { getConfig, listarGuilds } from './services/guildStore.js';
import { loadStrikesFile, markReportSent, summarizeActive, countChanges } from './services/strikesStore.js';
import { parseSchedule, slotsAround, overdueSlot } from './services/strikeReportSchedule.js';
import { resolvePresence } from './services/memberPresence.js';
import { buildReportEmbeds } from './ui/strikesEmbed.js';
import { notifyStrikeReport } from './logChannel.js';
import { guildLang } from './i18n.js';

// Informe semanal de strikes: un setTimeout por servidor, a la hora exacta de
// su siguiente cita. Un temporizador muere con el proceso, así que lo que
// sobrevive a un despliegue es lastReportAt (strikes.json): al arrancar se
// compara con la última cita y, si quedó sin mandar, sale ahora con una nota.

const FIRST_REPORT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** @type {Map<string, { timer: NodeJS.Timeout }>} */
const scheduled = new Map();
/** @type {Map<string, Promise<void>>} */
const queues = new Map();

/**
 * Todo lo de un servidor va en fila: un /config a mitad de un envío no puede
 * dejar dos temporizadores. Nunca rechaza: esto corre dentro de un setTimeout
 * y un rechazo sin capturar tumbaría el proceso.
 */
function enqueue(guildId, task) {
  const run = (queues.get(guildId) ?? Promise.resolve()).then(task).catch((error) => {
    console.error(`[strike-report] Error en el servidor ${guildId}:`, error?.stack ?? error);
  });
  queues.set(guildId, run);
  run.then(() => {
    if (queues.get(guildId) === run) queues.delete(guildId);
  });
  return run;
}

function clearTimer(guildId) {
  const entry = scheduled.get(guildId);
  if (entry) clearTimeout(entry.timer);
  scheduled.delete(guildId);
}

/** El horario del servidor si le toca informe: activo, con horario y con canal. */
function reportSchedule(config) {
  if (!config.activo || !config.logChannelId) return null;
  return parseSchedule(config.strikeReport);
}

/**
 * Pone el temporizador de la siguiente cita posterior a `afterMs`. Si no se
 * puede leer la config se sigue con el horario conocido: perder el temporizador
 * aquí sería dejar de mandar informes sin que nadie se entere.
 */
async function arm(client, guildId, afterMs, knownSchedule = null) {
  clearTimer(guildId);
  let schedule = knownSchedule;
  try {
    schedule = reportSchedule(await getConfig(guildId));
  } catch (error) {
    console.error(`[strike-report] No se pudo leer la config de ${guildId}:`, error?.message ?? error);
  }
  if (!schedule) return;

  const { next } = slotsAround(afterMs, schedule);
  const entry = {};
  entry.timer = setTimeout(() => {
    enqueue(guildId, async () => {
      // Se canceló o reprogramó mientras este disparo esperaba en la fila.
      if (scheduled.get(guildId) !== entry) return;
      await fire(client, guildId, next, schedule);
    });
  }, Math.max(next - Date.now(), 0));
  // El bot ya se mantiene vivo por su conexión a Discord.
  entry.timer.unref?.();
  scheduled.set(guildId, entry);
}

async function fire(client, guildId, slot, schedule) {
  // setTimeout puede saltar un milisegundo antes de la cita: sin este max,
  // lastReportAt quedaría antes de ella y el próximo arranque la repetiría.
  const reportAt = Math.max(Date.now(), slot);
  try {
    const config = await getConfig(guildId);
    if (reportSchedule(config)) await sendReport(client, guildId, { reportAt });
  } catch (error) {
    console.error(`[strike-report] No se pudo generar el informe de ${guildId}:`, error?.stack ?? error);
  } finally {
    await arm(client, guildId, reportAt, schedule);
  }
}

/**
 * Manda el informe y actualiza lastReportAt AUNQUE falle el envío (canal
 * borrado, permisos retirados): si no, cada arranque reintentaría el mismo.
 * Se marca después de enviar: si el bot cae justo entre medias, un informe
 * repetido es mejor que uno perdido.
 */
async function sendReport(client, guildId, { reportAt, lateSlot = null }) {
  const { strikes, lastReportAt } = await loadStrikesFile(guildId);
  try {
    const sinceMs = lastReportAt ? Date.parse(lastReportAt) : reportAt - FIRST_REPORT_WINDOW_MS;
    const rows = summarizeActive(strikes);
    const { gone } = await resolvePresence(client.guilds?.cache?.get(guildId), rows.map((row) => row.userId));
    const lang = await guildLang(guildId);
    const embeds = buildReportEmbeds({
      rows,
      gone,
      changes: countChanges(strikes, sinceMs, reportAt),
      sinceMs,
      lateSlot,
      lang,
    });
    await notifyStrikeReport(client, guildId, embeds);
  } catch (error) {
    console.error(`[strike-report] Falló el informe de ${guildId}:`, error?.stack ?? error);
  } finally {
    await markReportSent(guildId, new Date(reportAt).toISOString());
  }
}

/**
 * Vuelve a calcular el temporizador de un servidor tras cambiar su horario o
 * su canal, o al volver a entrar en él. No manda nada.
 * @param {import('discord.js').Client} client
 * @param {string} guildId
 */
export function syncStrikeReport(client, guildId) {
  return enqueue(guildId, () => arm(client, guildId, Date.now()));
}

/**
 * Al salir de un servidor.
 * @param {string} guildId
 */
export function cancelStrikeReport(guildId) {
  clearTimer(guildId);
}

/**
 * Al arrancar: manda el informe que quedara pendiente y programa el siguiente.
 * Un servidor no impide los demás.
 * @param {import('discord.js').Client} client
 * @param {{ allowed?: Set<string> | null }} [options]
 */
export async function initializeStrikeReports(client, { allowed = null } = {}) {
  const guildIds = (await listarGuilds()).filter((id) => client.guilds.cache.has(id) && (!allowed || allowed.has(id)));

  await Promise.all(
    guildIds.map((guildId) =>
      enqueue(guildId, async () => {
        const config = await getConfig(guildId);
        const schedule = parseSchedule(config.strikeReport);
        if (!config.activo || !schedule) return;
        if (!config.logChannelId) {
          console.warn(`[strike-report] El servidor ${guildId} tiene informe semanal pero no canal de logs: no se programa.`);
          return;
        }

        const now = Date.now();
        try {
          // Un servidor caído (outage de Discord) no recibiría el atrasado y
          // se daría por enviado: se deja para el siguiente arranque.
          if (client.guilds.cache.get(guildId).available !== false) {
            const { lastReportAt } = await loadStrikesFile(guildId);
            const lateSlot = overdueSlot(now, schedule, lastReportAt, config.strikeReportDesde);
            if (lateSlot !== null) await sendReport(client, guildId, { reportAt: now, lateSlot });
          }
        } catch (error) {
          console.error(`[strike-report] No se pudo comprobar el informe atrasado de ${guildId}:`, error?.stack ?? error);
        } finally {
          await arm(client, guildId, now, schedule);
        }
      }),
    ),
  );
}

/** Solo para tests: servidores con temporizador puesto. */
export function __scheduledGuildsForTests() {
  return [...scheduled.keys()];
}
