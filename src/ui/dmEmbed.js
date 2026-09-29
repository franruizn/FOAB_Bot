import { EmbedBuilder } from 'discord.js';
import { truncateList } from './textTruncate.js';

const INFO_COLOR = 0x5865f2;
const SUCCESS_COLOR = 0x00ff9d;
const LIST_MAX_LENGTH = 900; // por lista, para que varias quepan en los 4096 de la descripción

function mentionList(ids) {
  return truncateList(
    ids.map((id) => `<@${id}>`),
    LIST_MAX_LENGTH,
    { separator: ', ', formatSuffix: (n) => `… +${n} más` },
  );
}

function tokenList(tokens) {
  return truncateList(
    tokens.map((token) => `\`${token}\``),
    LIST_MAX_LENGTH,
    { separator: ', ', formatSuffix: (n) => `… +${n} más` },
  );
}

/**
 * Acompaña a la previsualización (el mensaje exacto va en el `content` de
 * la misma respuesta): a cuántos va y quién no se resolvió.
 * @param {{ recipientCount: number, optedOutCount: number, botCount: number, unresolved: string[] }} params
 */
export function buildDmPreviewEmbed({ recipientCount, optedOutCount, botCount, unresolved }) {
  const lines = [`Destinatarios: **${recipientCount}**.`];
  if (optedOutCount > 0) lines.push(`De ellos, **${optedOutCount}** tienen el rol de exclusión y se saltarán.`);
  if (botCount > 0) lines.push(`Se saltarán **${botCount}** bot(s).`);
  if (unresolved.length > 0) {
    lines.push(`\nNo se han podido resolver (revisa la ortografía):\n${tokenList(unresolved)}`);
  }
  lines.push('\nArriba está el mensaje **exacto** que recibirán. Envío: uno por segundo.');

  return new EmbedBuilder().setColor(INFO_COLOR).setTitle('Previsualización de /dm').setDescription(lines.join('\n'));
}

/** @param {{ processed: number, total: number }} params */
export function buildDmProgressContent({ processed, total }) {
  return `📨 Enviando /dm… ${processed}/${total}`;
}

/**
 * Resumen final, para el canal (visible) y para el canal de logs.
 * @param {{ sent: string[], dmClosed: string[], failed: string[], optedOut: string[], botCount: number, unresolved: string[] }} result
 * @returns {string}
 */
export function buildDmResultSummary({ sent, dmClosed, failed, optedOut, botCount, unresolved }) {
  const lines = [`✅ Recibieron el mensaje: **${sent.length}**.`];
  if (dmClosed.length > 0) lines.push(`🔒 DMs cerrados (**${dmClosed.length}**): ${mentionList(dmClosed)}`);
  if (failed.length > 0) lines.push(`⚠️ Otros fallos de envío (**${failed.length}**): ${mentionList(failed)}`);
  if (optedOut.length > 0) lines.push(`🙅 Saltados por el rol de exclusión (**${optedOut.length}**): ${mentionList(optedOut)}`);
  if (botCount > 0) lines.push(`🤖 Bots saltados: **${botCount}**.`);
  if (unresolved.length > 0) lines.push(`❓ No se pudieron resolver (**${unresolved.length}**): ${tokenList(unresolved)}`);
  return lines.join('\n\n');
}

/** @param {{ senderMention: string, summary: string }} params */
export function buildDmResultEmbed({ senderMention, summary }) {
  return new EmbedBuilder()
    .setColor(SUCCESS_COLOR)
    .setTitle('📨 /dm enviado')
    .setDescription(`Enviado por ${senderMention}.\n\n${summary}`)
    .setTimestamp(new Date());
}
