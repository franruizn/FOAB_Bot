import { CTA_PATH, MAESTRIA_PATH } from './dataPaths.js';
import { cerrarCta, guardarCierrePendiente, pendienteDeVolcarDeCanal, quitarCierrePendiente } from './services/ctaStore.js';
import { volcarHojaDeCierre } from './services/ctaSheet.js';
import { registrarCierreDeCta, leerMaestria } from './services/maestria.js';
import { sincronizarMaestriaHoja } from './services/maestriaSheet.js';
import { buildCtaEmbed } from './ui/ctaEmbed.js';
import { cancelarReedicion } from './ctaEmbedSync.js';
import { notifyCtaSheetDesync } from './logChannel.js';

// Punto único de cierre, compartido por /cta cerrar (manual) y el
// temporizador (ctaScheduler.js): deshabilita los botones, publica la
// composición final y marca el embed como cerrado, pero NUNCA borra el rol
// de Discord ni las asignaciones — esas siguen existiendo tal cual quedaron,
// solo el registro de la CTA como "activa" desaparece.
//
// Orden fijo, en este orden por un motivo concreto cada uno:
//   1. Congelar (cerrarCta(): fuera de "activas", ninguna mutación puede
//      tocarla ya).
//   2. maestria.json: local, fuente de verdad, tiene que quedar registrado
//      SIN DEPENDER de la red.
//   3. La hoja de la CTA: pestaña propia, un único volcado.
//   4. La pestaña "Maestría".
//   5. Discord: deshabilitar botones y publicar la composición final. Nunca
//      depende de 3/4 — un fallo de Google no puede dejar el evento en un
//      limbo con los botones activos.

/**
 * @param {import('discord.js').Client} client
 * @param {string} ctaId
 * @param {{ razon?: string, sheetImpls?: object, maestriaSheetImpls?: object }} [options] - las dos últimas,
 *   para tests: se pasan tal cual a volcarHojaDeCierre()/sincronizarMaestriaHoja().
 * @returns {Promise<object>} la CTA tal como quedó justo antes de cerrarse (con razonCierre y sheetVolcadoPendiente)
 */
export async function cerrarCtaCompleta(client, ctaId, { razon = 'manual', sheetImpls, maestriaSheetImpls } = {}) {
  // Cancela cualquier reedición de EMBED agrupada pendiente ANTES de tocar
  // nada: sin esto, una reedición en segundo plano podría dispararse justo
  // después y pisar la edición final de cierre. (La hoja ya no tiene
  // agrupador propio: se escribe una sola vez, más abajo.)
  cancelarReedicion(ctaId);

  // 1. Congela el estado.
  const ctaCerrada = await cerrarCta(CTA_PATH, ctaId, { razon });

  // 2. maestria.json ANTES de tocar la red y con independencia de que la
  // hoja falle. Solo cuenta asignaciones FINALES ("in finished events"),
  // nunca las de en medio del evento.
  try {
    await registrarCierreDeCta(MAESTRIA_PATH, ctaCerrada);
  } catch (error) {
    console.error(`[cta] Fallo registrando la maestría del cierre de la CTA ${ctaId}:`, error?.stack ?? error);
  }

  // 3. La hoja de la CTA: un único volcado. Si falla, no se falla el
  // cierre: se deja una marca de "pendiente de volcar" (con el tabName ya
  // creado, si llegó a crearse) para que /cta sync reintente.
  let sheetVolcadoPendiente = false;
  try {
    const resultado = await volcarHojaDeCierre(ctaCerrada, sheetImpls);
    if (!resultado.omitido) ctaCerrada.sheetTabName = resultado.tabName;
  } catch (error) {
    console.error(`[cta] Fallo volcando la hoja al cerrar la CTA ${ctaId}:`, error?.stack ?? error);
    sheetVolcadoPendiente = true;
    if (error?.tabName) ctaCerrada.sheetTabName = error.tabName;
    await guardarCierrePendiente(CTA_PATH, ctaCerrada).catch((guardarError) => {
      console.error(
        `[cta] Y ADEMÁS no se pudo guardar la marca de "pendiente de volcar" de la CTA ${ctaId}:`,
        guardarError?.stack ?? guardarError,
      );
    });
    await notifyCtaSheetDesync(client, { ctaId, ctaNombre: ctaCerrada.nombre, error }).catch(() => {});
  }

  // 4. La pestaña "Maestría": nombre fijo, se reescribe ENTERA en cada
  // cierre, así que un fallo de hoy se autocorrige en el próximo (no lleva
  // marca de "pendiente" propia). Independiente del resultado del paso 3.
  try {
    const maestria = await leerMaestria(MAESTRIA_PATH);
    await sincronizarMaestriaHoja(maestria, maestriaSheetImpls);
  } catch (error) {
    console.error(`[cta] Fallo sincronizando la pestaña "Maestría" al cerrar la CTA ${ctaId}:`, error?.stack ?? error);
  }

  // 5. Discord: no depende de 3/4.
  if (ctaCerrada.messageId) {
    try {
      const channel = await client.channels.fetch(ctaCerrada.channelId);
      const message = await channel.messages.fetch(ctaCerrada.messageId);
      const { embeds, components } = buildCtaEmbed({ cta: ctaCerrada, cerrada: true, volcadoPendiente: sheetVolcadoPendiente });
      await message.edit({ embeds, components });
    } catch (error) {
      console.error(`[cta] No se pudo editar el mensaje de cierre de la CTA ${ctaId}:`, error?.stack ?? error);
    }
  }

  return { ...ctaCerrada, sheetVolcadoPendiente };
}

/**
 * Reintento manual del volcado a la hoja de la última CTA cerrada de
 * `channelId` (el que dejó una marca de "pendiente de volcar" al fallar en
 * cerrarCtaCompleta()). Usado por /cta sync. No toca maestria.json ni la
 * pestaña "Maestría": esas ya quedaron resueltas en el cierre (o se
 * autocorrigen solas en el próximo), esto es solo el volcado de la CTA.
 * @param {string} channelId
 * @param {{ sheetImpls?: object }} [options] - para tests, ver cerrarCtaCompleta()
 * @returns {Promise<{ ok: true, omitido: boolean, ctaNombre: string } | { ok: false, nada: true } | { ok: false, error: unknown }>}
 */
export async function reintentarVolcadoDeCanal(channelId, { sheetImpls } = {}) {
  const pendiente = await pendienteDeVolcarDeCanal(CTA_PATH, channelId);
  if (!pendiente) {
    return { ok: false, nada: true };
  }

  try {
    const resultado = await volcarHojaDeCierre(pendiente, sheetImpls);
    await quitarCierrePendiente(CTA_PATH, channelId);
    return { ok: true, omitido: resultado.omitido, ctaNombre: pendiente.nombre };
  } catch (error) {
    if (error?.tabName && error.tabName !== pendiente.sheetTabName) {
      await guardarCierrePendiente(CTA_PATH, { ...pendiente, sheetTabName: error.tabName }).catch(() => {});
    }
    return { ok: false, error };
  }
}
