import { CTA_PATH } from './dataPaths.js';
import { ctaActiva, cerrarCta, CtaError } from './services/ctaStore.js';
import { cancelPendingEmbedRefresh } from './ctaEmbedSync.js';
import { flushSheetSync } from './ctaSheetSync.js';
import { buildCtaClosedEmbed, buildCtaButtons, buildCtaFinalListEmbed, buildCtaSheetUrl } from './ui/ctaEmbed.js';

// Solo puede haber una CTA activa a la vez (a diferencia de /sorteo, que
// admite varios en paralelo en canales distintos), así que un único timer
// en memoria basta: no hace falta un Map por id.
let activeTimer = null;

function clearActiveTimer() {
  if (activeTimer) {
    clearTimeout(activeTimer);
    activeTimer = null;
  }
}

function logCtaClose({ cerrada, reason }) {
  console.log(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      type: 'cta',
      action: 'cerrar',
      id: cerrada.id,
      inscritos: cerrada.inscritos.length,
      reason,
    }),
  );
}

/**
 * Edita el mensaje original (embed cerrado + botones deshabilitados) y
 * publica la lista final como un mensaje nuevo. Nunca toca la hoja: lo
 * apuntado se queda. Si el canal o el mensaje ya no existen, se loguea y no
 * rompe el cierre: cta.json ya quedó cerrado de todas formas.
 * @param {import('discord.js').Client} client
 * @param {object} cerrada - lo que devuelve cerrarCta()
 */
async function publishClose(client, cerrada) {
  let channel;
  try {
    channel = await client.channels.fetch(cerrada.channelId);
  } catch (error) {
    console.error(`[cta] No se pudo obtener el canal ${cerrada.channelId} de la CTA ${cerrada.id}:`, error?.message ?? error);
    return;
  }

  try {
    await channel.messages.fetch(cerrada.messageId).then((message) =>
      message.edit({
        embeds: [
          buildCtaClosedEmbed({
            title: cerrada.nombre,
            inscritosCount: cerrada.inscritos.length,
            sheetUrl: buildCtaSheetUrl(),
            sincronizada: cerrada.sincronizada !== false,
          }),
        ],
        components: [buildCtaButtons(cerrada.id, { disabled: true })],
      }),
    );
  } catch (error) {
    console.error(`[cta] No se pudo editar el mensaje ${cerrada.messageId} de la CTA ${cerrada.id}:`, error?.message ?? error);
  }

  await channel
    .send({ embeds: [buildCtaFinalListEmbed({ title: cerrada.nombre, inscritos: cerrada.inscritos, sheetUrl: buildCtaSheetUrl() })] })
    .catch((error) => {
      console.error(`[cta] No se pudo publicar la lista final de la CTA ${cerrada.id}:`, error?.stack ?? error);
    });
}

async function closeNow(client, reason) {
  clearActiveTimer();

  // La CTA sigue "activa" en este punto (cerrarCta() todavía no corrió):
  // fuerza cualquier escritura de la hoja agrupada pendiente ANTES de
  // cerrar, para no perder una alta/baja de último segundo que cayó dentro
  // de la ventana de 2s justo al llegar el plazo — una vez cerrada,
  // performOneSync() ya no encontraría la CTA como activa y no haría nada.
  const antesDeCerrar = await ctaActiva(CTA_PATH).catch(() => null);
  if (antesDeCerrar) {
    await flushSheetSync(client, antesDeCerrar.id).catch((error) => {
      console.error(`[cta] Error forzando la sincronización final de la hoja al cerrar (CTA ${antesDeCerrar.id}):`, error?.stack ?? error);
    });
  }

  let cerrada;
  try {
    cerrada = await cerrarCta(CTA_PATH);
  } catch (error) {
    // Ya se cerró por otra vía entre que se disparó esto y que se ejecuta
    // (p.ej. /cta cerrar justo cuando iba a cerrar el timer, o una carrera
    // con initializeCta): no es un fallo real.
    if (error instanceof CtaError) return null;
    console.error('[cta] Error cerrando la CTA:', error?.stack ?? error);
    return null;
  }

  cancelPendingEmbedRefresh(cerrada.id);
  logCtaClose({ cerrada, reason });
  await publishClose(client, cerrada);
  return cerrada;
}

/**
 * Cierra la CTA activa AHORA, sin esperar a su cierraEn — usado por
 * /cta cerrar (un oficial la corta antes de tiempo). Mismo camino que el
 * cierre automático: fuerza la hoja pendiente, cierra, cancela el timer
 * programado, deshabilita los botones y publica la lista final.
 * @param {import('discord.js').Client} client
 * @returns {Promise<object | null>} la CTA cerrada, o null si no había ninguna activa
 */
export async function cerrarCtaManualmente(client) {
  return closeNow(client, 'manual');
}

/**
 * Programa el cierre automático de `activa` para su `cierraEn`. Reemplaza
 * cualquier timer previo (solo puede haber una CTA activa a la vez).
 * @param {import('discord.js').Client} client
 * @param {{ id: string, cierraEn: string }} activa
 */
export function scheduleCtaClose(client, activa) {
  clearActiveTimer();
  const delayMs = Math.max(0, new Date(activa.cierraEn).getTime() - Date.now());
  activeTimer = setTimeout(() => {
    closeNow(client, 'timer').catch((error) => {
      console.error('[cta] Error inesperado cerrando la CTA:', error?.stack ?? error);
    });
  }, delayMs);
}

/**
 * Al arrancar: si la CTA guardada en disco ya venció, se cierra de
 * inmediato; si sigue viva, se reprograma el timer con el tiempo restante.
 * Mismo patrón que raffleScheduler.initializeRaffles() — el setTimeout no
 * sobrevive a un reinicio, así que hay que reconstruirlo desde cta.json.
 * @param {import('discord.js').Client} client
 */
export async function initializeCta(client) {
  const activa = await ctaActiva(CTA_PATH);
  if (!activa) return;

  const now = Date.now();
  const cierraEnMs = new Date(activa.cierraEn).getTime();

  if (cierraEnMs <= now) {
    console.log(`[cta] La CTA ${activa.id} venció mientras el bot estaba caído. Cerrando de inmediato.`);
    await closeNow(client, 'startup-expired');
  } else {
    console.log(`[cta] Reanudando la CTA ${activa.id}, cierra en ${cierraEnMs - now}ms.`);
    scheduleCtaClose(client, activa);
  }
}
