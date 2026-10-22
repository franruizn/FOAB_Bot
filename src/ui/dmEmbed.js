import { EmbedBuilder } from 'discord.js';
import { truncateList } from './textTruncate.js';
import { t, tn } from '../i18n.js';

const INFO_COLOR = 0x5865f2;
const SUCCESS_COLOR = 0x00ff9d;
const LIST_MAX_LENGTH = 900; // por lista, para que varias quepan en los 4096 de la descripción

function joinedList(items, lang) {
  return truncateList(items, LIST_MAX_LENGTH, {
    separator: ', ',
    formatSuffix: (count) => t('common.more', lang, { count }),
  });
}

const mentionList = (ids, lang) => joinedList(ids.map((id) => `<@${id}>`), lang);
const tokenList = (tokens, lang) => joinedList(tokens.map((token) => `\`${token}\``), lang);

/**
 * Acompaña a la previsualización (el mensaje exacto va en el `content` de
 * la misma respuesta): a cuántos va y quién no se resolvió. Efímera: idioma
 * de quien la lee.
 * @param {{ recipientCount: number, optedOutCount: number, botCount: number, unresolved: string[], lang: string }} params
 */
export function buildDmPreviewEmbed({ recipientCount, optedOutCount, botCount, unresolved, lang }) {
  const lines = [t('dm.preview.recipients', lang, { count: recipientCount })];
  if (optedOutCount > 0) lines.push(tn('dm.preview.optedOut', optedOutCount, lang));
  if (botCount > 0) lines.push(tn('dm.preview.bots', botCount, lang));
  if (unresolved.length > 0) {
    lines.push(t('dm.preview.unresolved', lang, { list: tokenList(unresolved, lang) }));
  }
  lines.push(t('dm.preview.footer', lang));

  return new EmbedBuilder().setColor(INFO_COLOR).setTitle(t('dm.preview.title', lang)).setDescription(lines.join('\n'));
}

/** @param {{ processed: number, total: number, lang: string }} params */
export function buildDmProgressContent({ processed, total, lang }) {
  return t('dm.progress', lang, { processed, total });
}

/**
 * Resumen final, para el canal (visible) y para el canal de logs.
 * @param {{ sent: string[], dmClosed: string[], failed: string[], optedOut: string[], botCount: number, unresolved: string[], lang: string }} result
 * @returns {string}
 */
export function buildDmResultSummary({ sent, dmClosed, failed, optedOut, botCount, unresolved, lang }) {
  const lines = [t('dm.result.sent', lang, { count: sent.length })];
  if (dmClosed.length > 0) lines.push(t('dm.result.dmClosed', lang, { count: dmClosed.length, list: mentionList(dmClosed, lang) }));
  if (failed.length > 0) lines.push(t('dm.result.failed', lang, { count: failed.length, list: mentionList(failed, lang) }));
  if (optedOut.length > 0) lines.push(t('dm.result.optedOut', lang, { count: optedOut.length, list: mentionList(optedOut, lang) }));
  if (botCount > 0) lines.push(t('dm.result.bots', lang, { count: botCount }));
  if (unresolved.length > 0) {
    lines.push(t('dm.result.unresolved', lang, { count: unresolved.length, list: tokenList(unresolved, lang) }));
  }
  return lines.join('\n\n');
}

/** @param {{ senderMention: string, summary: string, lang: string }} params */
export function buildDmResultEmbed({ senderMention, summary, lang }) {
  return new EmbedBuilder()
    .setColor(SUCCESS_COLOR)
    .setTitle(t('dm.result.title', lang))
    .setDescription(t('dm.result.sender', lang, { sender: senderMention, summary }))
    .setTimestamp(new Date());
}
