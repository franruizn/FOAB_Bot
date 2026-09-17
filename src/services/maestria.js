import { createMutex, readJsonFile, backupCurrentFile, atomicWriteJson } from './fileStore.js';

// Fuente de verdad de la maestría por (jugador, rol): cuántas veces CERRÓ
// una CTA con esa persona asignada a ese rol. Equivalente a los "weapon
// mastery levels" de la web.
//
// Se cuenta al CERRAR, nunca al asignar: el caller mueve gente sin parar
// antes del mass, y contar en cada asignación inflaría el contador de un
// rol que esa persona nunca llegó a jugar de verdad ("in finished events").
//
// El contador (veces jugadas) es el dato; las estrellas son su
// PRESENTACIÓN. El número crudo no se muestra en ninguna interfaz — ni
// selects, ni embeds, ni /maestria — solo estrellas, siempre calculadas
// aquí (un único sitio para los umbrales).

const MAESTRIA_VERSION = 1;
const BACKUP_PREFIX = 'maestria';

// Cuántos cierres consecutivos de historialRoles[rolKey] hacen falta para
// que jugadorQueRepiteRol() avise: "esto lo lleva cubriendo siempre la
// misma persona".
const HISTORIAL_ROTACION = 5;

const NIVELES_ESTRELLAS = [
  { minVeces: 60, estrellas: 5 },
  { minVeces: 30, estrellas: 4 },
  { minVeces: 15, estrellas: 3 },
  { minVeces: 5, estrellas: 2 },
  { minVeces: 1, estrellas: 1 },
];

const { withWriteLock, waitForPendingWrites: waitForPendingMaestriaWrites } = createMutex();
export { waitForPendingMaestriaWrites };

function defaultMaestria() {
  return { version: MAESTRIA_VERSION, jugadores: {}, historialRoles: {} };
}

/**
 * @param {string} filePath
 * @returns {Promise<{
 *   version: number,
 *   jugadores: Record<string, { nombre: string, roles: Record<string, number>, ultimo: Record<string, string> }>,
 *   historialRoles: Record<string, string[]>,
 * }>}
 */
export async function leerMaestria(filePath) {
  return readJsonFile(filePath, defaultMaestria());
}

/**
 * Veces jugadas (dato crudo). Solo para desempatar en autorrellenar() y
 * para ordenar listados — NUNCA para pintarlo directamente, usa
 * nivelEstrellas()/nivelDeVeces() para eso.
 * @param {object} maestria - lo que devuelve leerMaestria()
 * @param {string} userId
 * @param {string} rolKey
 * @returns {number}
 */
export function vecesJugado(maestria, userId, rolKey) {
  return maestria?.jugadores?.[userId]?.roles?.[rolKey] ?? 0;
}

/**
 * @param {number} veces
 * @returns {number} 0-5
 */
export function nivelDeVeces(veces) {
  for (const nivel of NIVELES_ESTRELLAS) {
    if (veces >= nivel.minVeces) return nivel.estrellas;
  }
  return 0;
}

/**
 * Estrellas a pintar (0-5): la presentación de vecesJugado(). 0 -> sin
 * historial, se pinta sin estrellas (nunca "★ 0").
 * @param {object} maestria
 * @param {string} userId
 * @param {string} rolKey
 * @returns {number}
 */
export function nivelEstrellas(maestria, userId, rolKey) {
  return nivelDeVeces(vecesJugado(maestria, userId, rolKey));
}

/**
 * "★★★" para n=3, "" para n=0 — nunca "★ 0". Único sitio que decide cómo se
 * ven las estrellas como texto; todo lo demás llama a esto.
 * @param {number} n
 * @returns {string}
 */
export function estrellasTexto(n) {
  return n > 0 ? '★'.repeat(n) : '';
}

/**
 * @param {object} maestria
 * @param {string} userId
 * @param {string} rolKey
 * @returns {string | null} ISO timestamp del último cierre en que jugó ese rol, o null
 */
export function ultimaVez(maestria, userId, rolKey) {
  return maestria?.jugadores?.[userId]?.ultimo?.[rolKey] ?? null;
}

/**
 * Si `rolKey` lo cubrió la MISMA persona en los últimos HISTORIAL_ROTACION
 * cierres (registrados en historialRoles), devuelve su userId; si no hay
 * historial suficiente o se alternó, devuelve null. Solo información para
 * que el caller decida si quiere rotar — autorrellenar() nunca actúa sobre
 * esto por su cuenta.
 * @param {object} maestria
 * @param {string} rolKey
 * @returns {string | null}
 */
export function jugadorQueRepiteRol(maestria, rolKey) {
  const historial = maestria?.historialRoles?.[rolKey] ?? [];
  if (historial.length < HISTORIAL_ROTACION) return null;
  const [primero, ...resto] = historial;
  return resto.every((id) => id === primero) ? primero : null;
}

/**
 * Suma 1 al contador (jugador, rol) de cada asignación FINAL de una CTA que
 * se acaba de cerrar — una vez por persona y rol, sin importar cuántas
 * veces la hayan movido antes del cierre. No-op si nadie quedó asignado.
 * Debe llamarse con la CTA ya cerrada a nivel de datos (o su snapshot justo
 * antes), nunca durante el evento.
 * @param {string} filePath
 * @param {object} cta - con comp.parties[].slots, inscritos e asignaciones
 * @returns {Promise<{ actualizados: number }>}
 */
export async function registrarCierreDeCta(filePath, cta) {
  const entradas = Object.entries(cta.asignaciones ?? {});
  if (entradas.length === 0) return { actualizados: 0 };

  return withWriteLock(async () => {
    const current = await leerMaestria(filePath);
    const ahora = new Date().toISOString();

    for (const [key, asignacion] of entradas) {
      const [partyIdx, slotIdx] = key.split(':').map(Number);
      const rolKey = cta.comp.parties[partyIdx]?.slots?.[slotIdx];
      if (!rolKey) continue; // clave inconsistente; no reventar el cierre por esto

      const userId = asignacion.userId;
      const inscrito = cta.inscritos.find((i) => i.userId === userId);
      const nombre = inscrito?.nombre ?? userId;

      const jugador = current.jugadores[userId] ?? (current.jugadores[userId] = { nombre, roles: {}, ultimo: {} });
      jugador.nombre = nombre; // se refresca en cada cierre: el apodo puede haber cambiado
      jugador.roles[rolKey] = (jugador.roles[rolKey] ?? 0) + 1;
      jugador.ultimo[rolKey] = ahora;

      const historial = current.historialRoles[rolKey] ?? (current.historialRoles[rolKey] = []);
      historial.push(userId);
      if (historial.length > HISTORIAL_ROTACION) historial.splice(0, historial.length - HISTORIAL_ROTACION);
    }

    await backupCurrentFile(filePath, BACKUP_PREFIX);
    await atomicWriteJson(filePath, current);
    return { actualizados: entradas.length };
  });
}
