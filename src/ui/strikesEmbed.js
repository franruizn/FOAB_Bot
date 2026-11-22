import { EmbedBuilder, escapeMarkdown } from 'discord.js';
import { t, tn } from '../i18n.js';

const GREEN = 0x57f287;
const YELLOW = 0xfee75c;
const RED = 0xed4245;

export const LIST_PAGE_SIZE = 20;
// La descripción admite 4096. Se deja margen para la línea de retirados. Va en
// la descripción y no en un field: 20 líneas de /strike list con su mención,
// recuento y fecha pasan de los 1024 de un field.
const CHECK_PAGE_MAX_LENGTH = 3800;

/** Verde 0, amarillo 1-2, rojo 3 o más. */
export function strikeColor(count) {
  if (count === 0) return GREEN;
  return count < 3 ? YELLOW : RED;
}

export const toUnix = (iso) => Math.floor(Date.parse(iso) / 1000);

/**
 * Mención si sigue en el servidor; si se fue, el nombre guardado con la marca.
 * @param {string} userId
 * @param {string | null} userName
 * @param {boolean} present
 * @param {string} lang
 */
export function displayUser(userId, userName, present, lang) {
  if (present) return `<@${userId}>`;
  return t('strike.leftServer', lang, { name: userName ? escapeMarkdown(userName) : userId });
}

/**
 * Parte los strikes activos en páginas que caben en una descripción: un motivo
 * de 200 caracteres puede casi duplicarse al escapar el markdown, así que aquí
 * el límite es de longitud y no un número fijo de strikes.
 * @param {Array<{ reason: string, addedBy: string, addedAt: string }>} active - del más antiguo al más reciente
 * @param {string} lang
 * @returns {string[]} texto de cada página; al menos una
 */
export function checkPages(active, lang) {
  const newestFirst = [...active].reverse();
  const pages = [];
  let current = '';
  newestFirst.forEach((strike, index) => {
    const entry = t('strike.check.entry', lang, {
      n: index + 1,
      reason: escapeMarkdown(strike.reason),
      by: strike.addedBy,
      when: toUnix(strike.addedAt),
    });
    const next = current ? `${current}\n\n${entry}` : entry;
    if (current && next.length > CHECK_PAGE_MAX_LENGTH) {
      pages.push(current);
      current = entry;
    } else {
      current = next;
    }
  });
  pages.push(current);
  return pages;
}

/**
 * @param {{ who: string, pageText: string, count: number, removed: number, page: number, pageCount: number, lang: string }} params
 */
export function buildCheckEmbed({ who, pageText, count, removed, page, pageCount, lang }) {
  const parts = [t('strike.check.user', lang, { who })];
  parts.push(count === 0 ? t('strike.check.clean', lang) : pageText);
  if (removed > 0) parts.push(tn('strike.check.removed', removed, lang));
  const embed = new EmbedBuilder()
    .setColor(strikeColor(count))
    .setTitle(tn('strike.check.title', count, lang))
    .setDescription(parts.join('\n\n'));
  if (pageCount > 1) embed.setFooter({ text: t('strike.page', lang, { page: page + 1, total: pageCount }) });
  return embed;
}

/**
 * @param {{ rows: Array<{ userId: string, userName: string | null, count: number, latestAt: string }>, present: Set<string>, totalUsers: number, totalStrikes: number, page: number, pageCount: number, lang: string }} params
 */
export function buildListEmbed({ rows, present, totalUsers, totalStrikes, page, pageCount, lang }) {
  if (totalUsers === 0) {
    return new EmbedBuilder().setColor(GREEN).setTitle(t('strike.list.title', lang)).setDescription(t('strike.list.empty', lang));
  }
  const lines = rows.map((row) =>
    tn('strike.list.line', row.count, lang, {
      who: displayUser(row.userId, row.userName, present.has(row.userId), lang),
      when: toUnix(row.latestAt),
    }),
  );
  const header = t('strike.list.header', lang, {
    users: tn('strike.list.users', totalUsers, lang),
    strikes: tn('strike.list.strikes', totalStrikes, lang),
  });
  const embed = new EmbedBuilder()
    .setColor(strikeColor(Math.max(...rows.map((row) => row.count))))
    .setTitle(t('strike.list.title', lang))
    .setDescription(`${header}\n\n${lines.join('\n')}`);
  if (pageCount > 1) embed.setFooter({ text: t('strike.page', lang, { page: page + 1, total: pageCount }) });
  return embed;
}

/**
 * El informe semanal, en tantos embeds como haga falta: va sin botones, así
 * que todos los usuarios tienen que caber en mensajes consecutivos. Cada embed
 * va en su propio mensaje (el límite de 6000 caracteres es por mensaje).
 * @param {{ rows: Array<{ userId: string, userName: string | null, count: number, latestAt: string }>, present: Set<string>, changes: { added: number, removed: number }, sinceMs: number, lateSlot?: number | null, lang: string }} params
 * @returns {EmbedBuilder[]}
 */
export function buildReportEmbeds({ rows, present, changes, sinceMs, lateSlot = null, lang }) {
  const intro = [];
  if (lateSlot !== null) intro.push(t('strikeReport.late', lang, { when: Math.floor(lateSlot / 1000) }));
  if (rows.length > 0) {
    const strikes = rows.reduce((sum, row) => sum + row.count, 0);
    intro.push(
      t('strike.list.header', lang, {
        users: tn('strike.list.users', rows.length, lang),
        strikes: tn('strike.list.strikes', strikes, lang),
      }),
    );
  } else {
    intro.push(t('strike.list.empty', lang));
  }
  intro.push(
    t('strikeReport.changes', lang, {
      added: tn('strikeReport.added', changes.added, lang),
      removed: tn('strikeReport.removed', changes.removed, lang),
      since: Math.floor(sinceMs / 1000),
    }),
  );

  const pages = [];
  let current = intro.join('\n');
  let separator = '\n\n';
  for (const row of rows) {
    const line = tn('strike.list.line', row.count, lang, {
      who: displayUser(row.userId, row.userName, present.has(row.userId), lang),
      when: toUnix(row.latestAt),
    });
    if (current.length + separator.length + line.length > CHECK_PAGE_MAX_LENGTH) {
      pages.push(current);
      current = line;
    } else {
      current += separator + line;
    }
    separator = '\n';
  }
  pages.push(current);

  const color = strikeColor(rows.length > 0 ? rows[0].count : 0);
  return pages.map((description, index) => {
    const embed = new EmbedBuilder().setColor(color).setTitle(t('strikeReport.title', lang)).setDescription(description);
    if (pages.length > 1) embed.setFooter({ text: t('strike.page', lang, { page: index + 1, total: pages.length }) });
    return embed;
  });
}
