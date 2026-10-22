import { EmbedBuilder } from 'discord.js';
import { t, tn } from '../i18n.js';

const INFO_COLOR = 0x5865f2;
const SUCCESS_COLOR = 0x00ff9d;

const tokenList = (tokens) => tokens.map((token) => `\`${token}\``).join(', ');

/**
 * Previsualización antes de crear el rol: cuántos se resolvieron y, sobre
 * todo, la lista de quienes NO se resolvieron tal y como venían escritos —
 * en una lista de 25 nombres a mano, alguno va a tener una errata, y el
 * oficial tiene que verla antes de crear el rol, no después.
 * @param {{ rolName: string, resolvedCount: number, unresolved: string[], lang: string }} params
 */
export function buildCrearRolPreviewEmbed({ rolName, resolvedCount, unresolved, lang }) {
  const lines = [t('createRole.preview.role', lang, { role: rolName }), tn('createRole.preview.resolved', resolvedCount, lang)];

  if (unresolved.length > 0) {
    lines.push(t('createRole.preview.unresolved', lang, { list: tokenList(unresolved) }));
  }

  return new EmbedBuilder()
    .setColor(INFO_COLOR)
    .setTitle(t('createRole.preview.title', lang))
    .setDescription(lines.join('\n'));
}

/**
 * @param {{ roleMention: string, assignedCount: number, totalResolved: number, unresolved: string[], failedMentions: string[], lang: string }} params
 */
export function buildCrearRolResultEmbed({ roleMention, assignedCount, totalResolved, unresolved, failedMentions, lang }) {
  const lines = [
    t('createRole.result.role', lang, { role: roleMention }),
    tn('createRole.result.assigned', totalResolved, lang, { assigned: assignedCount }),
  ];

  if (unresolved.length > 0) {
    lines.push(t('createRole.result.unresolved', lang, { list: tokenList(unresolved) }));
  }
  if (failedMentions.length > 0) {
    lines.push(t('createRole.result.failed', lang, { list: failedMentions.join(', ') }));
  }

  return new EmbedBuilder()
    .setColor(SUCCESS_COLOR)
    .setTitle(t('createRole.result.title', lang))
    .setDescription(lines.join('\n\n'));
}
