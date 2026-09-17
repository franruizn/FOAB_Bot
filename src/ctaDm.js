import { CTA_PATH } from './dataPaths.js';
import { marcarLocalizable } from './services/ctaStore.js';
import { buildAsignacionDmEmbed, buildReasignacionDmEmbed } from './ui/ctaDmEmbed.js';

// Los DM cerrados son normales: nunca deben hacer fallar la operación que
// los disparó. Un fallo se registra en cta.noLocalizables (ver
// services/ctaStore.marcarLocalizable) para que el panel del caller lo
// muestre y le avisen por voz — no en el canal de logs, que es para fallos
// que necesitan intervención de un oficial, no "a este jugador no le
// llegó un DM".

async function enviarDm(client, cta, userId, embed) {
  try {
    const user = await client.users.fetch(userId);
    await user.send({ embeds: [embed] });
    await marcarLocalizable(CTA_PATH, cta.id, userId, true);
    return true;
  } catch (error) {
    console.error(`[cta] No se pudo mandar el DM a ${userId} (CTA ${cta.id}):`, error?.message ?? error);
    await marcarLocalizable(CTA_PATH, cta.id, userId, false).catch(() => {});
    return false;
  }
}

/**
 * @param {import('discord.js').Client} client
 * @param {object} cta
 * @param {string} userId
 * @param {{ rolKey: string, partyNombre: string }} datos
 * @returns {Promise<boolean>} true si el DM salió
 */
export function notificarAsignacion(client, cta, userId, { rolKey, partyNombre }) {
  return enviarDm(client, cta, userId, buildAsignacionDmEmbed({ cta, rolKey, partyNombre }));
}

/**
 * @param {import('discord.js').Client} client
 * @param {object} cta
 * @param {string} userId
 * @param {{ rolKey: string, partyNombre: string, rolAnteriorKey: string, partyAnteriorNombre: string }} datos
 * @returns {Promise<boolean>}
 */
export function notificarReasignacion(client, cta, userId, { rolKey, partyNombre, rolAnteriorKey, partyAnteriorNombre }) {
  return enviarDm(
    client,
    cta,
    userId,
    buildReasignacionDmEmbed({ cta, rolKey, partyNombre, rolAnteriorKey, partyAnteriorNombre }),
  );
}

/**
 * Manda el DM de asignación a varios jugadores de golpe (autorrellenar):
 * uno por persona, en paralelo. Quien llama decide si espera a que
 * terminen (/cta ping, para poder contar cuántos fallaron) o los dispara
 * sin bloquear (autorrellenar, que no debe retrasar la respuesta del panel).
 * @param {import('discord.js').Client} client
 * @param {object} cta
 * @param {Array<{ userId: string, rolKey: string, partyNombre: string }>} asignaciones
 * @returns {Promise<{ enviados: number, fallidos: number }>}
 */
export async function notificarAsignacionesEnLote(client, cta, asignaciones) {
  const resultados = await Promise.all(
    asignaciones.map(({ userId, rolKey, partyNombre }) => notificarAsignacion(client, cta, userId, { rolKey, partyNombre })),
  );
  const enviados = resultados.filter(Boolean).length;
  return { enviados, fallidos: resultados.length - enviados };
}
