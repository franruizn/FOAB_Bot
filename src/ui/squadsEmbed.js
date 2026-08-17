import { EmbedBuilder } from 'discord.js';

const SUCCESS_COLOR = 0x00ff9d;
const INFO_COLOR = 0x5865f2;

/**
 * Embed de una mutación exitosa: qué cambió y quién lo hizo.
 * @param {{ title: string, description: string, actorTag: string }} params
 * @returns {EmbedBuilder}
 */
export function mutationEmbed({ title, description, actorTag }) {
  return new EmbedBuilder()
    .setColor(SUCCESS_COLOR)
    .setTitle(title)
    .setDescription(description)
    .setFooter({ text: `Editado por ${actorTag}` })
    .setTimestamp(new Date());
}

/**
 * Embed neutral de solo lectura (list/show), sin "quién lo hizo".
 * @param {{ title: string, description: string }} params
 * @returns {EmbedBuilder}
 */
export function infoEmbed({ title, description }) {
  return new EmbedBuilder().setColor(INFO_COLOR).setTitle(title).setDescription(description || '—');
}
