/**
 * Comprueba en runtime si quien invocó la interacción tiene el rol de
 * oficiales (OFFICER_ROLE_ID). No confiar solo en setDefaultMemberPermissions:
 * eso es una guía de UI en Discord, no una restricción real.
 * @param {import('discord.js').Interaction} interaction
 * @returns {boolean}
 */
export function isOfficer(interaction) {
  const officerRoleId = process.env.OFFICER_ROLE_ID;
  if (!officerRoleId) return false;
  return interaction.member?.roles?.cache?.has(officerRoleId) ?? false;
}

/**
 * Igual que isOfficer(), pero con su propio rol (CTA_OFFICER_ROLE_ID) en vez
 * de OFFICER_ROLE_ID. Usado por /cta: un rol de oficial separado, por si en
 * algún momento se quiere que no sea el mismo que el de /squads. Un único
 * valor global (no por servidor) — el bot corre en un solo servidor, no
 * hace falta diferenciar por guildId.
 * @param {import('discord.js').Interaction} interaction
 * @returns {boolean}
 */
export function isCtaOfficer(interaction) {
  const officerRoleId = process.env.CTA_OFFICER_ROLE_ID;
  if (!officerRoleId) return false;
  return interaction.member?.roles?.cache?.has(officerRoleId) ?? false;
}
