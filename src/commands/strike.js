import {
  SlashCommandBuilder,
  InteractionContextType,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  escapeMarkdown,
} from 'discord.js';
import { ensureOfficer, isOfficer } from '../permissions.js';
import { errorEmbed } from '../ui/errorEmbed.js';
import { notifyStrike } from '../logChannel.js';
import { resolvePresent } from '../services/memberPresence.js';
import {
  MAX_REASON_LENGTH,
  loadStrikes,
  activeStrikes,
  removedCount,
  lastKnownName,
  summarizeActive,
  addStrike,
  removeLatestStrike,
  clearStrikes,
} from '../services/strikesStore.js';
import { LIST_PAGE_SIZE, strikeColor, toUnix, displayUser, checkPages, buildCheckEmbed, buildListEmbed } from '../ui/strikesEmbed.js';
import { t, tn, userLang, localizedDescription } from '../i18n.js';

const CONFIRM_TIMEOUT_MS = 30_000;
const PAGER_TIMEOUT_MS = 5 * 60_000;
const CONFIRM_COLOR = 0xed4245;
// Un listado de strikes no debe pingar a nadie, ni un motivo con "@everyone".
const NO_PINGS = { parse: [] };

const userOption = (o) => localizedDescription(o.setName('user'), 'cmd.strike.opt.user.description').setRequired(true);

// Comando de administración: nombre, subcomandos y opciones solo en inglés,
// como /squads y /config. El filtro real se hace en runtime, en execute().
export const data = localizedDescription(new SlashCommandBuilder().setName('strike'), 'cmd.strike.description')
  .setContexts(InteractionContextType.Guild)
  .addSubcommand((sub) =>
    localizedDescription(sub.setName('add'), 'cmd.strike.add.description')
      .addUserOption(userOption)
      .addStringOption((o) =>
        localizedDescription(o.setName('reason'), 'cmd.strike.opt.reason.description')
          .setRequired(true)
          .setMaxLength(MAX_REASON_LENGTH),
      ),
  )
  .addSubcommand((sub) =>
    localizedDescription(sub.setName('remove'), 'cmd.strike.remove.description')
      .addUserOption(userOption)
      .addStringOption((o) =>
        localizedDescription(o.setName('reason'), 'cmd.strike.opt.removeReason.description')
          .setRequired(false)
          .setMaxLength(MAX_REASON_LENGTH),
      ),
  )
  .addSubcommand((sub) => localizedDescription(sub.setName('clear'), 'cmd.strike.clear.description').addUserOption(userOption))
  .addSubcommand((sub) => localizedDescription(sub.setName('check'), 'cmd.strike.check.description').addUserOption(userOption))
  .addSubcommand((sub) => localizedDescription(sub.setName('list'), 'cmd.strike.list.description'));

const replyError = (interaction, title, body) =>
  interaction.reply({ embeds: [errorEmbed(title, body)], ephemeral: true, allowedMentions: NO_PINGS });

/**
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 */
export async function execute(interaction) {
  const subcommand = interaction.options.getSubcommand();
  // Todo efímero: la disciplina de cada uno no se expone en el canal donde se
  // lance el comando. El rastro público para oficiales es el canal de logs.
  const lang = userLang(interaction);

  // check es lo único abierto: cada uno puede ver los suyos, aunque el servidor
  // no tenga rol de oficiales. Los de otra persona, solo un oficial.
  if (subcommand === 'check') {
    const isSelf = interaction.options.getUser('user', true).id === interaction.user.id;
    if (!isSelf && !(await isOfficer(interaction))) {
      await replyError(interaction, t('common.noPermission.title', lang), t('strike.error.checkOthers', lang));
      return;
    }
  } else if (!(await ensureOfficer(interaction))) {
    return;
  }

  if (subcommand === 'list') {
    await interaction.deferReply({ ephemeral: true });
    await handleList(interaction, lang);
    return;
  }

  const target = interaction.options.getUser('user', true);
  if (target.bot) {
    await replyError(interaction, t('strike.error.title', lang), t('strike.error.bot', lang));
    return;
  }
  // Un oficial no se pone strikes ni se perdona los suyos: eso le toca a otro.
  if (subcommand !== 'check' && target.id === interaction.user.id) {
    const body = subcommand === 'add' ? t('strike.error.self', lang) : t('strike.error.selfRemove', lang);
    await replyError(interaction, t('strike.error.title', lang), body);
    return;
  }

  let reason = null;
  if (subcommand === 'add' || subcommand === 'remove') {
    const raw = interaction.options.getString('reason');
    reason = raw?.trim() || null;
    // Discord deja enviar un motivo de solo espacios.
    if (subcommand === 'add' && !reason) {
      await replyError(interaction, t('strike.error.title', lang), t('strike.error.emptyReason', lang));
      return;
    }
    if (reason && reason.length > MAX_REASON_LENGTH) {
      await replyError(interaction, t('strike.error.title', lang), t('strike.error.longReason', lang, { max: MAX_REASON_LENGTH }));
      return;
    }
  }

  await interaction.deferReply({ ephemeral: true });
  switch (subcommand) {
    case 'add':
      await handleAdd(interaction, target, reason, lang);
      return;
    case 'remove':
      await handleRemove(interaction, target, reason, lang);
      return;
    case 'clear':
      await handleClear(interaction, target, lang);
      return;
    case 'check':
      await handleCheck(interaction, target, lang);
      return;
    default:
      throw new Error(`Subcomando desconocido: ${subcommand}`);
  }
}

/**
 * Aviso al canal de logs sin esperarlo: un canal borrado o lento no puede
 * retrasar ni tumbar la respuesta al oficial.
 */
function announce(client, params) {
  notifyStrike(client, params).catch((error) => {
    console.error('[strike] No se pudo avisar en el canal de logs:', error?.message ?? error);
  });
}

/**
 * Respuesta a un cambio YA guardado. Si falla no se propaga: el manejador
 * general diría "error inesperado, inténtalo de nuevo", y reintentar aquí es
 * poner el mismo strike dos veces. El rastro ya está en el canal de logs.
 * @param {{ editReply: (payload: object) => Promise<unknown> }} responder
 * @param {object} payload
 */
async function respondCommitted(responder, payload) {
  try {
    await responder.editReply(payload);
  } catch (error) {
    console.error('[strike] Cambio guardado, pero no se pudo responder al oficial:', error?.message ?? error);
  }
}

/**
 * El apodo en este servidor: es lo que la gente reconoce cuando alguien se va
 * y la mención deja de resolver. null si ya no está en el servidor.
 */
function serverName(interaction, target) {
  const member = interaction.options.getMember('user');
  if (!member) return null;
  return member.displayName ?? member.nick ?? globalName(target);
}

const globalName = (user) => user.globalName ?? user.username;

const logBase = (interaction, target, storedName) => ({
  guildId: interaction.guildId,
  actorId: interaction.user.id,
  actorTag: interaction.user.tag,
  targetId: target.id,
  targetName: serverName(interaction, target) ?? storedName ?? globalName(target),
});

async function handleAdd(interaction, target, reason, lang) {
  const { strike, activeCount } = await addStrike(interaction.guildId, {
    userId: target.id,
    userName: serverName(interaction, target),
    fallbackName: globalName(target),
    reason,
    addedBy: interaction.user.id,
  });

  announce(interaction.client, { ...logBase(interaction, target, strike.userName), action: 'add', reason: strike.reason, total: activeCount });

  await respondCommitted(interaction, {
    embeds: [
      new EmbedBuilder()
        .setColor(strikeColor(activeCount))
        .setTitle(t('strike.add.title', lang))
        .setDescription(
          [
            t('strike.add.body', lang, { user: target.id, reason: escapeMarkdown(strike.reason) }),
            tn('strike.activeNow', activeCount, lang),
          ].join('\n\n'),
        ),
    ],
    allowedMentions: NO_PINGS,
  });
}

async function handleRemove(interaction, target, reason, lang) {
  const { strike, activeCount } = await removeLatestStrike(interaction.guildId, {
    userId: target.id,
    removedBy: interaction.user.id,
    reason,
  });

  if (!strike) {
    await interaction.editReply({
      embeds: [new EmbedBuilder().setColor(strikeColor(0)).setDescription(t('strike.none', lang, { user: target.id }))],
      allowedMentions: NO_PINGS,
    });
    return;
  }

  announce(interaction.client, {
    ...logBase(interaction, target, strike.userName),
    action: 'remove',
    reason: strike.reason,
    removedReason: reason,
    addedAt: strike.addedAt,
    total: activeCount,
  });

  const lines = [
    t('strike.remove.body', lang, {
      user: target.id,
      reason: escapeMarkdown(strike.reason),
      when: toUnix(strike.addedAt),
    }),
  ];
  if (reason) lines.push(t('strike.remove.why', lang, { reason: escapeMarkdown(reason) }));
  lines.push(tn('strike.remaining', activeCount, lang));

  await respondCommitted(interaction, {
    embeds: [new EmbedBuilder().setColor(strikeColor(activeCount)).setTitle(t('strike.remove.title', lang)).setDescription(lines.join('\n\n'))],
    allowedMentions: NO_PINGS,
  });
}

async function handleClear(interaction, target, lang) {
  const active = activeStrikes(await loadStrikes(interaction.guildId), target.id);
  if (active.length === 0) {
    await interaction.editReply({
      embeds: [new EmbedBuilder().setColor(strikeColor(0)).setDescription(t('strike.none', lang, { user: target.id }))],
      allowedMentions: NO_PINGS,
    });
    return;
  }

  const confirmId = `strike-clear-confirm-${interaction.id}`;
  const cancelId = `strike-clear-cancel-${interaction.id}`;
  const prompt = await interaction.editReply({
    embeds: [
      new EmbedBuilder()
        .setColor(CONFIRM_COLOR)
        .setTitle(t('strike.clear.confirm.title', lang))
        .setDescription(tn('strike.clear.confirm.body', active.length, lang, { user: target.id })),
    ],
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(confirmId).setLabel(t('strike.clear.button', lang)).setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId(cancelId).setLabel(t('common.cancel', lang)).setStyle(ButtonStyle.Secondary),
      ),
    ],
    allowedMentions: NO_PINGS,
  });

  let button;
  try {
    button = await prompt.awaitMessageComponent({
      filter: (i) => i.user.id === interaction.user.id && (i.customId === confirmId || i.customId === cancelId),
      time: CONFIRM_TIMEOUT_MS,
    });
  } catch {
    await interaction.editReply({ content: t('strike.clear.expired', lang), embeds: [], components: [] });
    return;
  }

  if (button.customId === cancelId) {
    await button.update({ content: t('strike.clear.cancelled', lang), embeds: [], components: [] });
    return;
  }

  await button.deferUpdate();
  const { cleared, activeCount } = await clearStrikes(interaction.guildId, {
    userId: target.id,
    removedBy: interaction.user.id,
    ids: active.map((s) => s.id),
  });

  if (cleared === 0) {
    await button.editReply({ content: t('strike.clear.gone', lang), embeds: [], components: [], allowedMentions: NO_PINGS });
    return;
  }

  announce(interaction.client, { ...logBase(interaction, target, active.at(-1).userName), action: 'clear', cleared, total: activeCount });

  const lines = [tn('strike.clear.done', cleared, lang, { user: target.id })];
  // Otro oficial puso uno mientras el botón estaba pendiente: ese no se ha visto.
  if (activeCount > 0) lines.push(tn('strike.remaining', activeCount, lang));
  await respondCommitted(button, {
    content: null,
    embeds: [new EmbedBuilder().setColor(strikeColor(activeCount)).setTitle(t('strike.clear.title', lang)).setDescription(lines.join('\n\n'))],
    components: [],
    allowedMentions: NO_PINGS,
  });
}

async function handleCheck(interaction, target, lang) {
  const strikes = await loadStrikes(interaction.guildId);
  const active = activeStrikes(strikes, target.id);
  const removed = removedCount(strikes, target.id);
  // getMember sale de los datos resueltos de la propia interacción: null es
  // que no está en el servidor.
  const present = interaction.options.getMember('user') !== null;
  const who = displayUser(target.id, lastKnownName(strikes, target.id) ?? globalName(target), present, lang);
  const pages = checkPages(active, lang);

  await paginate(interaction, pages.length, lang, async (page) => ({
    embeds: [buildCheckEmbed({ who, pageText: pages[page], count: active.length, removed, page, pageCount: pages.length, lang })],
  }));
}

async function handleList(interaction, lang) {
  const summary = summarizeActive(await loadStrikes(interaction.guildId));
  const totalStrikes = summary.reduce((sum, row) => sum + row.count, 0);
  const pageCount = Math.max(1, Math.ceil(summary.length / LIST_PAGE_SIZE));

  await paginate(interaction, pageCount, lang, async (page) => {
    const rows = summary.slice(page * LIST_PAGE_SIZE, (page + 1) * LIST_PAGE_SIZE);
    // Solo los de esta página: es lo que se va a enseñar.
    const present = await resolvePresent(interaction.guild, rows.map((row) => row.userId));
    return { embeds: [buildListEmbed({ rows, present, totalUsers: summary.length, totalStrikes, page, pageCount, lang })] };
  });
}

function pagerRow(prevId, nextId, page, pageCount, lang, expired = false) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(prevId)
      .setLabel(t('strike.button.prev', lang))
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(expired || page === 0),
    new ButtonBuilder()
      .setCustomId(nextId)
      .setLabel(t('strike.button.next', lang))
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(expired || page >= pageCount - 1),
  );
}

/**
 * Publica la primera página y, si hay más, atiende los botones durante 5
 * minutos. Los clics y el cierre van en cola: dos clics rápidos no pueden
 * pintar las páginas desordenadas, ni un clic tardío reactivar los botones ya
 * caducados. Nada aquí puede lanzar fuera: en un listener, un rechazo sin
 * capturar tumbaría el proceso (ver unhandledRejection en index.js).
 */
async function paginate(interaction, pageCount, lang, render) {
  const prevId = `strike-page-prev-${interaction.id}`;
  const nextId = `strike-page-next-${interaction.id}`;
  let page = 0;

  const first = await render(page);
  if (pageCount <= 1) {
    await interaction.editReply({ ...first, components: [], allowedMentions: NO_PINGS });
    return;
  }

  const message = await interaction.editReply({
    ...first,
    components: [pagerRow(prevId, nextId, page, pageCount, lang)],
    allowedMentions: NO_PINGS,
  });

  const collector = message.createMessageComponentCollector({
    filter: (i) => i.user.id === interaction.user.id && (i.customId === prevId || i.customId === nextId),
    time: PAGER_TIMEOUT_MS,
  });

  let queue = Promise.resolve();
  const enqueue = (task) => {
    queue = queue.then(task).catch((error) => {
      console.error('[strike] Error en la paginación:', error?.message ?? error);
    });
  };

  collector.on('collect', (button) => {
    enqueue(async () => {
      await button.deferUpdate();
      page = Math.min(Math.max(page + (button.customId === nextId ? 1 : -1), 0), pageCount - 1);
      const payload = await render(page);
      await interaction.editReply({
        ...payload,
        components: [pagerRow(prevId, nextId, page, pageCount, lang)],
        allowedMentions: NO_PINGS,
      });
    });
  });

  collector.on('end', () => {
    enqueue(() =>
      interaction.editReply({
        components: [pagerRow(prevId, nextId, page, pageCount, lang, true)],
        allowedMentions: NO_PINGS,
      }),
    );
  });
}
