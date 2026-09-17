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
