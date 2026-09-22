import { EmbedBuilder } from 'discord.js';

const INFO_COLOR = 0x5865f2;
const SUCCESS_COLOR = 0x00ff9d;

/**
 * Previsualización antes de crear el rol: cuántos se resolvieron y, sobre
 * todo, la lista de quienes NO se resolvieron tal y como venían escritos —
 * en una lista de 25 nombres a mano, alguno va a tener una errata, y el
 * oficial tiene que verla antes de crear el rol, no después.
 * @param {{ rolName: string, resolvedCount: number, unresolved: string[] }} params
 */
export function buildCrearRolPreviewEmbed({ rolName, resolvedCount, unresolved }) {
  const lines = [`Rol a crear: **${rolName}**`, `Se han resuelto **${resolvedCount}** persona(s).`];

  if (unresolved.length > 0) {
    lines.push(`\nNo se han podido resolver (revisa la ortografía):\n${unresolved.map((token) => `\`${token}\``).join(', ')}`);
  }

  return new EmbedBuilder().setColor(INFO_COLOR).setTitle('Previsualización de /crear-rol').setDescription(lines.join('\n'));
}

/**
 * @param {{ roleMention: string, assignedCount: number, totalResolved: number, unresolved: string[], failedMentions: string[] }} params
 */
export function buildCrearRolResultEmbed({ roleMention, assignedCount, totalResolved, unresolved, failedMentions }) {
  const lines = [`Rol creado: ${roleMention}`, `Asignado a **${assignedCount}** de ${totalResolved} persona(s) resuelta(s).`];

  if (unresolved.length > 0) {
    lines.push(`No se pudieron resolver: ${unresolved.map((token) => `\`${token}\``).join(', ')}`);
  }
  if (failedMentions.length > 0) {
    lines.push(`No se les pudo asignar el rol: ${failedMentions.join(', ')}`);
  }

  return new EmbedBuilder().setColor(SUCCESS_COLOR).setTitle('Rol creado').setDescription(lines.join('\n\n'));
}
