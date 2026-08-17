import { EmbedBuilder } from 'discord.js';

const ERROR_COLOR = 0xed4245;

/**
 * Construye un embed rojo de error legible para el usuario final.
 * @param {string} title
 * @param {string} description
 * @returns {EmbedBuilder}
 */
export function errorEmbed(title, description) {
  return new EmbedBuilder().setColor(ERROR_COLOR).setTitle(title).setDescription(description);
}
