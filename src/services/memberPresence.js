const MEMBER_FETCH_TIMEOUT_MS = 5_000;
// Máximo de ids que admite Discord en una petición de miembros por gateway.
const MEMBER_FETCH_BATCH = 100;

/**
 * Ids de `userIds` que siguen en el servidor. Si Discord no responde NO se
 * puede afirmar que se hayan ido: se devuelven como presentes y sale la
 * mención, en vez de marcar a medio gremio como "se fue".
 * @param {import('discord.js').Guild | null | undefined} guild
 * @param {string[]} userIds
 * @returns {Promise<Set<string>>}
 */
export async function resolvePresent(guild, userIds) {
  if (!guild) return new Set(userIds);
  const present = new Set(userIds.filter((id) => guild.members.cache.has(id)));
  const unknown = userIds.filter((id) => !present.has(id));
  try {
    for (let i = 0; i < unknown.length; i += MEMBER_FETCH_BATCH) {
      const batch = unknown.slice(i, i + MEMBER_FETCH_BATCH);
      const fetched = await guild.members.fetch({ user: batch, time: MEMBER_FETCH_TIMEOUT_MS });
      for (const id of fetched.keys()) present.add(id);
    }
    return present;
  } catch (error) {
    console.error('[strike] No se pudo comprobar quién sigue en el servidor:', error?.message ?? error);
    return new Set(userIds);
  }
}
