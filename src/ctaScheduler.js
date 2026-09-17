import { CTA_PATH } from './dataPaths.js';
import { ctasActivas, migrarCtaSiHaceFalta } from './services/ctaStore.js';
import { cerrarCtaCompleta } from './ctaCierre.js';

// ctaId -> Timeout. Cada CTA tiene el suyo (a diferencia del mutex de
// escritura, que es global): solo vive en memoria, se reconstruye desde
// cta.json en initializeCtaTimers() tras un reinicio.
const activeTimers = new Map();

// El cierre por temporizador ahora tiene efectos en Discord (editar el
// mensaje, publicar la composición final), así que necesita el client. Se
// guarda aquí en vez de pasarlo por parámetro en cada programarCierre():
// el temporizador se arma en initializeCtaTimers()/al abrir una CTA, mucho
// antes de que se sepa cuándo va a dispararse.
let discordClient = null;

/**
 * Cierra una CTA por vencimiento de su temporizador: mismo cierre completo
 * (datos + Discord + hoja) que /cta cerrar manual, ver ctaCierre.js.
 */
async function cerrarPorTimer(ctaId) {
  activeTimers.delete(ctaId);
  if (!discordClient) {
    console.error(`[cta] No hay client de Discord listo todavía para cerrar por temporizador la CTA ${ctaId}.`);
    return;
  }
  await cerrarCtaCompleta(discordClient, ctaId, { razon: 'timer' });
}

/**
 * Programa el cierre de `cta` para dentro de (cierraEn - ahora) ms.
 * @param {{ id: string, cierraEn: string }} cta
 */
export function programarCierre(cta) {
  const delayMs = Math.max(0, new Date(cta.cierraEn).getTime() - Date.now());
  const timer = setTimeout(() => {
    cerrarPorTimer(cta.id).catch((error) => {
      console.error(`[cta] Error cerrando por temporizador la CTA ${cta.id}:`, error?.stack ?? error);
    });
  }, delayMs);
  activeTimers.set(cta.id, timer);
}

/**
 * Cancela (si existe) el temporizador en memoria de una CTA, sin tocar el
 * fichero. Debe llamarse siempre que una CTA se cierre por una vía distinta
 * a este propio temporizador (ej. un futuro /cta cerrar manual), para no
 * dejar un setTimeout huérfano que intente cerrar una CTA que ya no existe.
 * @param {string} ctaId
 */
export function cancelarTemporizador(ctaId) {
  const timer = activeTimers.get(ctaId);
  if (timer) {
    clearTimeout(timer);
    activeTimers.delete(ctaId);
  }
}

/**
 * Al arrancar: migra cta.json si hace falta (formato viejo -> nuevo, vacío)
 * y luego recorre TODAS las CTAs activas — las vencidas se cierran de
 * inmediato, las que siguen vivas se reprograman con su tiempo restante.
 * Requiere el client (a diferencia de la versión de solo-datos anterior):
 * el cierre ahora edita el mensaje de Discord, así que debe llamarse tras
 * ClientReady, no antes de login().
 * @param {import('discord.js').Client} client
 */
export async function initializeCtaTimers(client) {
  discordClient = client;
  await migrarCtaSiHaceFalta(CTA_PATH);

  const activas = await ctasActivas(CTA_PATH);
  if (activas.length === 0) return;

  const now = Date.now();
  console.log(`[cta] Reanudando ${activas.length} CTA(s) activa(s) desde ${CTA_PATH}.`);

  for (const cta of activas) {
    if (new Date(cta.cierraEn).getTime() <= now) {
      await cerrarPorTimer(cta.id).catch((error) => {
        console.error(`[cta] Error cerrando la CTA vencida ${cta.id}:`, error?.stack ?? error);
      });
    } else {
      programarCierre(cta);
    }
  }
}
