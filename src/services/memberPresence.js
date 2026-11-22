const MEMBER_FETCH_TIMEOUT_MS = 5_000;
// Máximo de ids que admite Discord en una petición de miembros por gateway.
const MEMBER_FETCH_BATCH = 100;

/**
 * Quién sigue en el servidor, en tres grupos que no se pisan:
 * - present: confirmado dentro.
 * - gone: Discord respondió y no está.
 * - unknown: no se pudo comprobar (lote fallido, servidor sin caché). No se
 *   afirma nada: ni que siga ni que se haya ido.
 * Un lote fallido solo afecta a los suyos.
 * @param {import('discord.js').Guild | null | undefined} guild
 * @param {string[]} userIds
 * @returns {Promise<{ present: Set<string>, gone: Set<string>, unknown: Set<string> }>}
 */
export async function resolvePresence(guild, userIds) {
  const present = new Set();
  const gone = new Set();
  const unknown = new Set();
  if (!guild) return { present, gone, unknown: new Set(userIds) };

  const pending = [];
  for (const id of userIds) {
    if (guild.members.cache.has(id)) present.add(id);
    else pending.push(id);
  }

  for (let i = 0; i < pending.length; i += MEMBER_FETCH_BATCH) {
    const batch = pending.slice(i, i + MEMBER_FETCH_BATCH);
    try {
      const fetched = await guild.members.fetch({ user: batch, time: MEMBER_FETCH_TIMEOUT_MS });
      for (const id of batch) (fetched.has(id) ? present : gone).add(id);
    } catch (error) {
      console.error(`[strike] No se pudo comprobar un lote de ${batch.length} miembros:`, error?.message ?? error);
      for (const id of batch) unknown.add(id);
    }
  }
  return { present, gone, unknown };
}
