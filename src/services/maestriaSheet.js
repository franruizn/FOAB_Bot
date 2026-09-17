import { asegurarPestanaExacta, escribirBloqueCompleto } from './sheets.js';
import { sheetsConfigurado } from './ctaSheet.js';

// Espejo de maestria.json en Google Sheets: una pestaña fija ("Maestría"),
// reescrita ENTERA tras cada cierre de CTA. La hoja nunca se lee de vuelta
// (leer de la hoja metería una llamada de red en el camino del
// autorrellenado, que tiene que responder en menos de 3s) — maestria.json
// es la única fuente de verdad, esto solo la refleja.

const TAB_MAESTRIA = 'Maestría';
const AVISO_CABECERA =
  'Esta pestaña se reescribe por completo en cada cierre de CTA — no es la fuente de verdad (esa es maestria.json). Si la editas a mano, se pierde en el siguiente cierre.';

function nombresDeRoles(maestria) {
  const roles = new Set();
  for (const jugador of Object.values(maestria.jugadores ?? {})) {
    for (const rolKey of Object.keys(jugador.roles ?? {})) roles.add(rolKey);
  }
  return [...roles].sort();
}

/**
 * Una fila por jugador (ordenados por nombre), una columna por rol (el
 * contador crudo en la celda — esto es la hoja, no una interfaz de
 * jugadores: aquí sí se ve el número), y una columna final con el total de
 * eventos. Primera fila: el aviso de "no editar a mano".
 * @param {object} maestria - lo que devuelve services/maestria.js leerMaestria()
 * @returns {string[][]}
 */
export function filasDeMaestria(maestria) {
  const roles = nombresDeRoles(maestria);
  const cabecera = ['Jugador', ...roles, 'Total'];

  const jugadoresOrdenados = Object.values(maestria.jugadores ?? {}).sort((a, b) =>
    a.nombre.localeCompare(b.nombre, 'en', { sensitivity: 'base' }),
  );

  const filas = jugadoresOrdenados.map((jugador) => {
    const valores = roles.map((rolKey) => String(jugador.roles[rolKey] ?? 0));
    const total = roles.reduce((acc, rolKey) => acc + (jugador.roles[rolKey] ?? 0), 0);
    return [jugador.nombre, ...valores, String(total)];
  });

  return [[AVISO_CABECERA], cabecera, ...filas];
}

/**
 * Sincroniza la pestaña "Maestría" con el estado actual de maestria.json.
 * No-op silencioso si Sheets no está configurado. A diferencia de la
 * pestaña de una CTA (services/ctaSheet.js), esta es de nombre fijo y se
 * reescribe en cada cierre: un fallo de hoy se autocorrige en el próximo
 * cierre, así que quien llama a esto solo necesita loguear el error, no
 * llevar una marca de "pendiente de volcar" persistente.
 * @param {object} maestria
 * @param {{ asegurarPestanaImpl?: typeof asegurarPestanaExacta, escribirBloqueImpl?: typeof escribirBloqueCompleto }} [impls] - para tests
 * @returns {Promise<{ omitido: true } | { omitido: false }>}
 */
export async function sincronizarMaestriaHoja(
  maestria,
  { asegurarPestanaImpl = asegurarPestanaExacta, escribirBloqueImpl = escribirBloqueCompleto } = {},
) {
  if (!sheetsConfigurado()) {
    return { omitido: true };
  }

  const spreadsheetId = process.env.CTA_SHEET_ID;
  await asegurarPestanaImpl(spreadsheetId, TAB_MAESTRIA);
  await escribirBloqueImpl(spreadsheetId, TAB_MAESTRIA, filasDeMaestria(maestria));
  return { omitido: false };
}
