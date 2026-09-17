import { createDebouncer } from './debounce.js';
import { CTA_PATH } from './dataPaths.js';
import { ctaPorId } from './services/ctaStore.js';
import { buildCtaEmbed } from './ui/ctaEmbed.js';

// Agrupa las reediciones del embed de una CTA en una ventana de 2s: con
// veinte altas seguidas, se edita el mensaje UNA vez al final de la
// ventana, no veinte veces (eso es rate limit tirado a la basura). Cada CTA
// tiene su propia key en el debouncer, así que dos CTAs en canales
// distintos no se bloquean entre sí.
const EMBED_REFRESH_WINDOW_MS = 2000;
const debouncer = createDebouncer(EMBED_REFRESH_WINDOW_MS);

async function reeditarMensaje(client, ctaId) {
  const cta = await ctaPorId(CTA_PATH, ctaId);
  if (!cta || !cta.messageId) return; // se cerró entre medias, o aún no se publicó

  let channel;
  try {
    channel = await client.channels.fetch(cta.channelId);
  } catch (error) {
    console.error(`[cta] No se pudo obtener el canal ${cta.channelId} para reeditar la CTA ${ctaId}:`, error?.stack ?? error);
    return;
  }

  const { embeds, components } = buildCtaEmbed({ cta });
  try {
    const message = await channel.messages.fetch(cta.messageId);
    await message.edit({ embeds, components });
  } catch (error) {
    console.error(`[cta] No se pudo reeditar el mensaje de la CTA ${ctaId}:`, error?.stack ?? error);
  }
}

/**
 * Marca la CTA `ctaId` para reeditar su embed dentro de la ventana de 2s.
 * Llamar a esto tras cualquier cambio (inscribir, asignar, mover...): el
 * lector siempre acaba viendo el embed reflejando la última mutación, sin
 * gastar una edición de Discord por cada una.
 * @param {import('discord.js').Client} client
 * @param {string} ctaId
 */
export function programarReedicion(client, ctaId) {
  debouncer.trigger(ctaId, () => reeditarMensaje(client, ctaId));
}

/**
 * Ejecuta ya cualquier reedición pendiente, sin esperar a la ventana.
 * Pensado para el shutdown: no dejar un embed desactualizado si el proceso
 * se reinicia justo después de una mutación.
 * @returns {Promise<void>}
 */
export function flushPendingEmbedRefreshes() {
  return debouncer.flushAll();
}

/**
 * Descarta cualquier reedición pendiente de `ctaId` sin ejecutarla. Para
 * usar justo antes de la edición final de cierre: sin esto, una reedición
 * agrupada podría dispararse después y pisar el embed ya marcado como
 * cerrado con una versión "abierta" desactualizada.
 * @param {string} ctaId
 */
export function cancelarReedicion(ctaId) {
  debouncer.cancel(ctaId);
}
