import { CTA_PATH } from './dataPaths.js';
import { ctaActiva, marcarSincronizacion } from './services/ctaStore.js';
import * as realSheets from './services/sheets.js';
import { notifyCtaDesync } from './logChannel.js';
import { scheduleEmbedRefresh } from './ctaEmbedSync.js';
import { createDebouncer } from './debounce.js';

const SYNC_DEBOUNCE_MS = 2000;
const SHEET_ROLE_COLUMNS = 3; // rol1, rol2, rol3 — ancho fijo del bloque en la hoja

// DECISIÓN DELIBERADA, no simplificar: este agrupador es una instancia
// INDEPENDIENTE de createDebouncer(), separada de la de ctaEmbedSync.js, no
// una compartida. Unificarlos acoplaría la reedición del embed (Discord) a
// la escritura de la hoja (Google): un fallo o una lentitud de Google
// retrasaría también el contador del footer, que no depende de la hoja
// para nada. El coste de mantenerlos separados es un desfase visual
// transitorio de un par de segundos entre "el footer" y "la hoja" durante
// una ráfaga muy rápida — nunca pérdida de datos, y mucho más barato que
// ese acoplamiento. No fusionar esto en un único agrupador compartido.
let debouncer = createDebouncer(SYNC_DEBOUNCE_MS);

/**
 * SOLO para tests: reconstruye el agrupador con otro retardo (p.ej. 0, para
 * no esperar los 2s reales en la suite). Nada de producción llama a esto.
 * @param {number} [ms]
 */
export function __setDebounceMsForTests(ms) {
  debouncer = createDebouncer(ms ?? SYNC_DEBOUNCE_MS);
}

// services/sheets.js necesita credenciales reales de Google para hacer
// nada — inutilizable en un test permanente. Este es el único punto de
// costura: por defecto usa el cliente real, y SOLO los tests lo sustituyen
// por un doble en memoria (ver src/ctaSheetSync.test.js), para poder probar
// el agrupador/single-flight/reintento sin red. Nada de producción llama a
// esto.
let sheetsClient = realSheets;

export function __setSheetsClientForTests(client) {
  sheetsClient = client ?? realSheets;
}

// Un solo vuelo de escribirBloque por CTA a la vez: si una alta/baja llega
// MIENTRAS ya hay una escritura en curso (posible con reintentos largos de
// C1: hasta 1+2+4=7s), no se lanza una segunda petición en paralelo — eso
// reintroduciría justo la carrera que "reescribe el bloque entero" quiere
// eliminar (una respuesta de red fuera de orden podría pisar el estado más
// nuevo con uno viejo). En vez de eso, se marca "dirty" y, al terminar la
// que está en vuelo, se repite una vez más con el estado ya actualizado.
const inFlight = new Map(); // ctaId -> Promise
const dirty = new Set();

function filaDeInscrito(inscrito) {
  const roles = Array.from({ length: SHEET_ROLE_COLUMNS }, (_, i) => inscrito.roles[i] ?? '');
  return [inscrito.nombre, ...roles];
}

/**
 * Un intento de sincronización: relee el estado ACTUAL de cta.json (nunca
 * el que había cuando se programó) y manda el bloque P3:S completo. Nunca
 * deja que esto tumbe la interacción de Discord que lo disparó: quien
 * llama a scheduleSheetSync() no espera este resultado.
 */
async function performOneSync(client, ctaId) {
  const activa = await ctaActiva(CTA_PATH);
  if (!activa || activa.id !== ctaId) return; // cerró/cambió mientras esperábamos: nada que hacer

  const filas = activa.inscritos.map(filaDeInscrito);

  try {
    await sheetsClient.escribirBloque(filas); // ya reintenta 429/5xx con backoff (prompt C1); no reintenta 403/4xx
    if (activa.sincronizada === false) {
      const actualizada = await marcarSincronizacion(CTA_PATH, ctaId, true);
      if (actualizada) scheduleEmbedRefresh(client, ctaId); // quita el aviso del footer
    }
  } catch (error) {
    console.error(`[cta] Fallo sincronizando la hoja de la CTA ${ctaId}:`, error?.stack ?? error);
    const actualizada = await marcarSincronizacion(CTA_PATH, ctaId, false).catch(() => null);
    if (actualizada) {
      // Solo se avisa en la TRANSICIÓN a desincronizada, no en cada intento
      // fallido de una caída prolongada — si no, serían decenas de avisos
      // repetidos por el mismo problema.
      await notifyCtaDesync(client, { ctaId, channelId: activa.channelId, error }).catch((notifyError) => {
        console.error('[cta] Error avisando la desincronización en el canal de logs:', notifyError?.stack ?? notifyError);
      });
      scheduleEmbedRefresh(client, ctaId); // muestra el aviso en el footer
    }
    throw error; // para que syncSheetNow() (usado por /cta sync) pueda informar al oficial
  }
}

async function runSync(client, ctaId) {
  const existing = inFlight.get(ctaId);
  if (existing) {
    dirty.add(ctaId);
    return existing;
  }

  const promise = (async () => {
    let lastError = null;
    do {
      dirty.delete(ctaId);
      lastError = null;
      try {
        await performOneSync(client, ctaId);
      } catch (error) {
        lastError = error;
      }
    } while (dirty.has(ctaId));
    if (lastError) throw lastError;
  })();

  inFlight.set(ctaId, promise);
  try {
    await promise;
  } finally {
    inFlight.delete(ctaId);
  }
}

/**
 * Agrupa (debounce con reinicio, 2s) la escritura del bloque completo de la
 * hoja tras una alta/baja/creación. Si llegan varios cambios de la misma
 * CTA dentro de la ventana, solo se manda UNA escritura con el estado más
 * reciente — así 20 altas seguidas no son 20 peticiones a la API de Sheets
 * (el límite es 60/min/proyecto).
 * @param {import('discord.js').Client} client
 * @param {string} ctaId
 */
export function scheduleSheetSync(client, ctaId) {
  debouncer.trigger(ctaId, () => runSync(client, ctaId));
}

/**
 * Fuerza YA la sincronización de `ctaId` (cancela la espera agrupada si la
 * había, o se une a una ya en vuelo) y espera a que termine. No-op si no
 * hay nada pendiente ni en vuelo — para no gastar una escritura de más.
 * Se usa al cerrar la CTA y en el shutdown (SIGTERM): no se puede perder
 * una alta de último segundo que cayó dentro de la ventana de 2s.
 * @param {import('discord.js').Client} client
 * @param {string} ctaId
 */
export async function flushSheetSync(client, ctaId) {
  if (!debouncer.has(ctaId) && !inFlight.has(ctaId)) return;
  debouncer.cancel(ctaId);
  await runSync(client, ctaId);
}

/**
 * Igual que flushSheetSync(), pero para la CTA activa actual (si hay una).
 * Pensado para el shutdown, donde no se conoce de antemano el id.
 * @param {import('discord.js').Client} client
 */
export async function flushActiveCtaSheetSync(client) {
  const activa = await ctaActiva(CTA_PATH).catch(() => null);
  if (!activa) return;
  await flushSheetSync(client, activa.id).catch((error) => {
    console.error(`[cta] Error forzando la sincronización final de la hoja (CTA ${activa.id}):`, error?.stack ?? error);
  });
}

/**
 * Reintento manual e inmediato, sin pasar por el agrupador. Usado por
 * /cta sync. A diferencia de flushSheetSync(), esto SIEMPRE intenta (aunque
 * no hubiera nada pendiente): es un pedido explícito de un oficial.
 * Lanza si falla, para que el comando se lo diga.
 * @param {import('discord.js').Client} client
 * @param {string} ctaId
 */
export async function syncSheetNow(client, ctaId) {
  debouncer.cancel(ctaId); // evita una escritura duplicada momentos después
  await runSync(client, ctaId);
}
