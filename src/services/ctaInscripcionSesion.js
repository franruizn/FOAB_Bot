// Estado en memoria del panel efímero de inscripción, mientras el usuario
// interactúa con los selects de "roles" y "preferido" antes de pulsar
// Confirmar. Discord NO junta las selecciones de varios select menus por sí
// solo: cada uno dispara su propia interacción, así que hay que acumular el
// estado en algún sitio entre una y otra. Se usa el id del mensaje efímero
// como clave (estable entre las interacciones de ESE panel).
//
// Vive solo en memoria a propósito: si el bot se reinicia a mitad de un
// panel a medio rellenar, el usuario no pierde ninguna inscripción ya
// confirmada (eso vive en cta.json) — solo tendría que reabrir el panel con
// "Apuntarse".

const SESSION_TTL_MS = 10 * 60 * 1000; // 10 minutos, igual que otros paneles efímeros del bot

const sesiones = new Map(); // messageId -> { ...datos, expira: Timeout }

/**
 * @param {string} messageId
 * @param {object} datos
 */
export function crearSesion(messageId, datos) {
  limpiarSesion(messageId);
  const expira = setTimeout(() => sesiones.delete(messageId), SESSION_TTL_MS);
  sesiones.set(messageId, { ...datos, expira });
}

/**
 * @param {string} messageId
 * @returns {object | null}
 */
export function obtenerSesion(messageId) {
  return sesiones.get(messageId) ?? null;
}

/**
 * @param {string} messageId
 * @param {object} patch
 * @returns {object | null} la sesión actualizada, o null si ya no existía
 */
export function actualizarSesion(messageId, patch) {
  const sesion = sesiones.get(messageId);
  if (!sesion) return null;
  Object.assign(sesion, patch);
  return sesion;
}

/**
 * @param {string} messageId
 */
export function limpiarSesion(messageId) {
  const sesion = sesiones.get(messageId);
  if (sesion) clearTimeout(sesion.expira);
  sesiones.delete(messageId);
}
