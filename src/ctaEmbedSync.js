import { CTA_PATH } from './dataPaths.js';
import { ctaActiva } from './services/ctaStore.js';
import { buildCtaEmbed, buildCtaSheetUrl } from './ui/ctaEmbed.js';
import { createDebouncer } from './debounce.js';

const REFRESH_DEBOUNCE_MS = 2000;

// Mismo mecanismo de agrupación que ctaSheetSync.js (ver debounce.js), para
// no gastar rate limit de Discord reeditando el mensaje en cada pulsación:
// solo cambia un número (el footer), así que una ráfaga de altas/bajas
// produce como mucho una edición cada 2s.
//
// DECISIÓN DELIBERADA, no simplificar: este agrupador y el de
// ctaSheetSync.js son dos instancias INDEPENDIENTES de createDebouncer(),
// no una compartida. Unificarlos acoplaría la reedición del embed (Discord)
// a la escritura de la hoja (Google): un fallo o una lentitud de Google
// retrasaría también el contador del footer, que no depende de la hoja
// para nada. El coste de mantenerlos separados es un desfase visual
// transitorio de un par de segundos entre "el footer" y "la hoja" durante
// una ráfaga muy rápida — nunca pérdida de datos, y mucho más barato que
// ese acoplamiento. No fusionar esto en un único agrupador compartido.
let debouncer = createDebouncer(REFRESH_DEBOUNCE_MS);

/**
 * SOLO para tests: reconstruye el agrupador con otro retardo (p.ej. 0, para
 * no esperar los 2s reales en la suite). Nada de producción llama a esto.
 * @param {number} [ms]
 */
export function __setDebounceMsForTests(ms) {
  debouncer = createDebouncer(ms ?? REFRESH_DEBOUNCE_MS);
}

async function applyRefresh(client, ctaId) {
  // Relee el estado ACTUAL, nunca el que había cuando se programó: si
  // llegaron más cambios durante la espera, la reedición ya los refleja.
  const activa = await ctaActiva(CTA_PATH);
  if (!activa || activa.id !== ctaId) return; // cerró/cambió mientras esperábamos: nada que reeditar

  const channel = await client.channels.fetch(activa.channelId);
  const message = await channel.messages.fetch(activa.messageId);

  const cierraEnUnixSeconds = Math.floor(new Date(activa.cierraEn).getTime() / 1000);

  const embed = buildCtaEmbed({
    title: activa.nombre,
    cierraEnUnixSeconds,
    inscritosCount: activa.inscritos.length,
    sheetUrl: buildCtaSheetUrl(),
    sincronizada: activa.sincronizada !== false,
  });

  await message.edit({ embeds: [embed] });
}

/**
 * Programa (o reinicia, si ya había una esperando) la reedición del mensaje
 * de `ctaId`. Debounce clásico de 2s: cada llamada durante la ventana
 * reinicia la espera, así que una ráfaga produce una sola edición al final.
 * @param {import('discord.js').Client} client
 * @param {string} ctaId
 */
export function scheduleEmbedRefresh(client, ctaId) {
  debouncer.trigger(ctaId, () => applyRefresh(client, ctaId));
}

/**
 * Cancela cualquier reedición pendiente de `ctaId` sin ejecutarla. Se usa al
 * cerrar la CTA: el cierre hace su propia edición (embed cerrado + botones
 * deshabilitados) y no debe dejar viva una reedición "en abierto" que llegue
 * después y la pise.
 * @param {string} ctaId
 */
export function cancelPendingEmbedRefresh(ctaId) {
  debouncer.cancel(ctaId);
}

/**
 * Ejecuta YA cualquier reedición pendiente (sin esperar los 2s) y espera a
 * que termine. Pensado para el shutdown: así el footer no se queda una
 * revisión atrás — es la única señal de vida del mensaje — tras un reinicio.
 * @returns {Promise<void>}
 */
export async function flushPendingEmbedRefreshes() {
  await debouncer.flushAll();
}
