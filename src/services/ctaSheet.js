import { crearPestana, escribirBloqueCompleto } from './sheets.js';

// Orquesta CTA <-> Google Sheets: sabe mapear una CTA al bloque de filas
// nuevo y decide cuándo crear pestaña vs. reescribir. sheets.js no sabe nada
// de CTAs; este fichero no sabe nada de HTTP.
//
// CAMBIO DE FORMATO respecto a la versión anterior del bot: antes la hoja
// tenía 4 columnas (nombre + 3 roles de texto libre) en un bloque fijo
// (CTA_RANGO_INICIO). ESTO YA NO ES COMPATIBLE: el modelo nuevo es por
// columnas [nombre, rol asignado, party, roles que puede jugar, tentativo],
// y cada CTA tiene su PROPIA pestaña en vez de compartir un único bloque —
// así dos CTAs simultáneas no se pisan.
//
// La hoja se escribe UNA SOLA VEZ, al cerrar la CTA (ver ctaCierre.js): no
// hay nadie mirándola mientras el evento está abierto (el embed de Discord
// ya muestra el estado en vivo), así que reescribirla en cada alta/
// movimiento era latencia y cuota de API tirados. Este módulo no sabe nada
// de "pendiente de volcar" ni de reintentos — eso vive en services/
// ctaStore.js (cerradasPendientes) y se orquesta desde ctaCierre.js.

const CABECERA = ['Nombre', 'Rol asignado', 'Party', 'Roles que puede jugar', 'Tentativo'];

/**
 * @returns {boolean} true si hay credenciales y spreadsheet configurados
 */
export function sheetsConfigurado() {
  return Boolean(process.env.GOOGLE_CREDENTIALS_PATH && process.env.CTA_SHEET_ID);
}

function nombreDeRol(cta, rolKey) {
  return cta.comp.roles[rolKey]?.nombre ?? rolKey;
}

function asignacionDeUsuario(cta, userId) {
  for (const [key, asignacion] of Object.entries(cta.asignaciones)) {
    if (asignacion.userId !== userId) continue;
    const [partyIdx, slotIdx] = key.split(':').map(Number);
    const party = cta.comp.parties[partyIdx];
    const rolKey = party.slots[slotIdx];
    return { partyNombre: party.nombre, rolNombre: nombreDeRol(cta, rolKey) };
  }
  return null;
}

/**
 * Construye el bloque completo (cabecera + una fila por inscrito) para una
 * CTA, en el orden en que aparecen en `cta.inscritos`.
 * @param {object} cta
 * @returns {string[][]}
 */
export function filasDeCta(cta) {
  const filas = cta.inscritos.map((inscrito) => {
    const asignacion = asignacionDeUsuario(cta, inscrito.userId);
    return [
      inscrito.nombre,
      asignacion?.rolNombre ?? '',
      asignacion?.partyNombre ?? '',
      inscrito.roles.map((rolKey) => nombreDeRol(cta, rolKey)).join(', '),
      inscrito.tentativo ? 'Sí' : 'No',
    ];
  });
  return [CABECERA, ...filas];
}

/**
 * Vuelca el estado final de una CTA YA CERRADA a su propia pestaña: la crea
 * si hace falta (o reutiliza `cta.sheetTabName` si ya se creó en un intento
 * anterior que falló solo en la escritura) y escribe el bloque completo.
 * No-op silencioso si Sheets no está configurado (no hay CTA_SHEET_ID/
 * GOOGLE_CREDENTIALS_PATH) — no es un error, es una instalación sin hoja.
 *
 * Nombre de la pestaña: el mismo que el rol de Discord de la CTA
 * (`cta.roleNombre`, con el formato "<nombre>_<ddMM-HHmm>", ver
 * services/ctaRole.js) — así se pueden correlacionar a simple vista, y ya
 * lleva su propio sufijo anti-colisión para cuando dos CTAs se llaman igual
 * ("ZvZ" cada noche). Si aun así el nombre choca en la hoja, crearPestana()
 * añade uno incremental propio ("... (2)") en vez de sobrescribir.
 *
 * Si la creación de la pestaña sale bien pero la escritura falla, el nombre
 * ya creado se cuelga como `error.tabName` en la excepción que se relanza,
 * para que quien llama pueda guardarlo y no volver a crear una pestaña
 * duplicada en el reintento.
 * @param {object} cta - la CTA cerrada (ctaCerrada de ctaStore.cerrarCta(), o
 *   una entrada de cerradasPendientes en un reintento)
 * @param {{ crearPestanaImpl?: typeof crearPestana, escribirBloqueImpl?: typeof escribirBloqueCompleto }} [impls] - para tests
 * @returns {Promise<{ omitido: true } | { omitido: false, tabName: string }>}
 */
export async function volcarHojaDeCierre(
  cta,
  { crearPestanaImpl = crearPestana, escribirBloqueImpl = escribirBloqueCompleto } = {},
) {
  if (!sheetsConfigurado()) {
    return { omitido: true };
  }

  const spreadsheetId = process.env.CTA_SHEET_ID;
  const tabName = cta.sheetTabName ?? (await crearPestanaImpl(spreadsheetId, cta.roleNombre ?? cta.nombre));

  try {
    await escribirBloqueImpl(spreadsheetId, tabName, filasDeCta(cta));
  } catch (error) {
    if (error && typeof error === 'object') error.tabName = tabName;
    throw error;
  }

  return { omitido: false, tabName };
}
