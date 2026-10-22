import { SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, escapeMarkdown } from 'discord.js';
import { loadConfig, ConfigError } from '../services/config.js';
import {
  SquadCommandError,
  createSquad,
  deleteSquad,
  addPlayers,
  removePlayer,
  renameSquad,
  movePlayer,
  describeSquad,
} from '../services/squadsStore.js';
import { mutationEmbed, infoEmbed } from '../ui/squadsEmbed.js';
import { errorEmbed } from '../ui/errorEmbed.js';
import { ensureOfficer, isOfficer } from '../permissions.js';
import { notifySquadMutation } from '../logChannel.js';
import { t, tn, userLang, guildLang, localizedDescription } from '../i18n.js';

const READ_ONLY_SUBCOMMANDS = new Set(['list', 'show', 'find']);
const CONFIRM_TIMEOUT_MS = 30_000;
const AUTOCOMPLETE_LIMIT = 25;

const squadOption = (descriptionKey) => (o) =>
  localizedDescription(o.setName('squad'), descriptionKey).setRequired(true).setAutocomplete(true);
const playerOption = (o) =>
  localizedDescription(o.setName('player'), 'cmd.squads.opt.player.description').setRequired(true).setAutocomplete(true);

// Comando de administración: un único nombre (en inglés) para el comando, sus
// subcomandos y sus opciones, sin localizar, para que cualquier guía sirva a
// todos. Las descripciones sí se traducen.
//
// Visible para todos en el picker de Discord a propósito: el filtro real es
// ensureOfficer() (officerRoleId del servidor) en runtime, no un permiso de
// Discord por servidor que haya que reconfigurar a mano en cada uno.
export const data = localizedDescription(new SlashCommandBuilder().setName('squads'), 'cmd.squads.description')
  .addSubcommand((sub) => localizedDescription(sub.setName('list'), 'cmd.squads.list.description'))
  .addSubcommand((sub) =>
    localizedDescription(sub.setName('show'), 'cmd.squads.show.description').addStringOption(
      squadOption('cmd.squads.opt.squad.description'),
    ),
  )
  .addSubcommand((sub) =>
    localizedDescription(sub.setName('create'), 'cmd.squads.create.description')
      .addStringOption((o) => localizedDescription(o.setName('name'), 'cmd.squads.opt.name.description').setRequired(true))
      .addBooleanOption((o) =>
        localizedDescription(o.setName('is-guild'), 'cmd.squads.opt.isGuild.description').setRequired(false),
      ),
  )
  .addSubcommand((sub) =>
    localizedDescription(sub.setName('delete'), 'cmd.squads.delete.description').addStringOption(
      squadOption('cmd.squads.opt.squad.description'),
    ),
  )
  .addSubcommand((sub) =>
    localizedDescription(sub.setName('add'), 'cmd.squads.add.description')
      .addStringOption(squadOption('cmd.squads.opt.squad.description'))
      .addStringOption((o) =>
        localizedDescription(o.setName('players'), 'cmd.squads.opt.players.description').setRequired(true),
      ),
  )
  .addSubcommand((sub) =>
    localizedDescription(sub.setName('remove'), 'cmd.squads.remove.description')
      .addStringOption(squadOption('cmd.squads.opt.squad.description'))
      .addStringOption(playerOption),
  )
  .addSubcommand((sub) =>
    localizedDescription(sub.setName('rename'), 'cmd.squads.rename.description')
      .addStringOption(squadOption('cmd.squads.opt.currentSquad.description'))
      .addStringOption((o) =>
        localizedDescription(o.setName('new-name'), 'cmd.squads.opt.newName.description').setRequired(true),
      ),
  )
  .addSubcommand((sub) =>
    localizedDescription(sub.setName('move'), 'cmd.squads.move.description')
      .addStringOption(playerOption)
      .addStringOption(squadOption('cmd.squads.opt.targetSquad.description')),
  )
  .addSubcommand((sub) =>
    localizedDescription(sub.setName('find'), 'cmd.squads.find.description').addStringOption(playerOption),
  );

/**
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 */
export async function execute(interaction) {
  if (!(await ensureOfficer(interaction))) return;

  const subcommand = interaction.options.getSubcommand();
  const ephemeral = !READ_ONLY_SUBCOMMANDS.has(subcommand);
  // list/show/find son públicos (los lee el canal): idioma del servidor. Las
  // mutaciones son efímeras: idioma de quien las hace. El aviso al canal de
  // logs va siempre en el del servidor (lo resuelve logChannel.js).
  const lang = ephemeral ? userLang(interaction) : await guildLang(interaction.guildId);

  await interaction.deferReply({ ephemeral });

  try {
    switch (subcommand) {
      case 'list':
        await handleList(interaction, lang);
        return;
      case 'show':
        await handleShow(interaction, lang);
        return;
      case 'create':
        await handleCreate(interaction, lang);
        return;
      case 'delete':
        await handleDelete(interaction, lang);
        return;
      case 'add':
        await handleAdd(interaction, lang);
        return;
      case 'remove':
        await handleRemove(interaction, lang);
        return;
      case 'rename':
        await handleRename(interaction, lang);
        return;
      case 'move':
        await handleMove(interaction, lang);
        return;
      case 'find':
        await handleFind(interaction, lang);
        return;
      default:
        throw new Error(`Subcomando desconocido: ${subcommand}`);
    }
  } catch (error) {
    // SquadCommandError (validación de entrada) y ConfigError (el resultado
    // de la mutación no pasó el validador de config.js) son errores
    // esperados y accionables por quien ejecuta el comando: se muestran tal
    // cual, sin pasar por el handler genérico de src/interactionErrorHandler.js.
    if (error instanceof SquadCommandError || error instanceof ConfigError) {
      await interaction.editReply({
        content: null,
        embeds: [errorEmbed(t('squads.error.title', lang), error.localized(lang))],
        components: [],
      });
      return;
    }
    throw error;
  }
}

function confirmRow(confirmId, cancelId, confirmKey, lang) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(confirmId).setLabel(t(confirmKey, lang)).setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(cancelId).setLabel(t('common.cancel', lang)).setStyle(ButtonStyle.Secondary),
  );
}

// Un squad de gremio con 40 personas y uno de jugadores con 40 nombres no son
// lo mismo: cada tipo en su sección y con su icono.
async function handleList(interaction, lang) {
  const config = await loadConfig(interaction.guildId);
  const squads = config.squadOrder.map((key) => config.squads.get(key));
  const playerLines = squads
    .filter((squad) => !squad.isGuild)
    .map((squad) => tn('squads.list.playerLine', squad.members.size, lang, { squad: escapeMarkdown(squad.display) }));
  const guildLines = squads
    .filter((squad) => squad.isGuild)
    .map((squad) => t('squads.list.guildLine', lang, { squad: escapeMarkdown(squad.display) }));

  const sections = [];
  if (playerLines.length > 0) sections.push(`${t('squads.list.playersHeader', lang)}\n${playerLines.join('\n')}`);
  if (guildLines.length > 0) sections.push(`${t('squads.list.guildsHeader', lang)}\n${guildLines.join('\n')}`);

  await interaction.editReply({
    embeds: [
      infoEmbed({
        title: t('squads.list.title', lang),
        description: sections.length > 0 ? sections.join('\n\n') : t('squads.list.empty', lang),
      }),
    ],
  });
}

async function handleShow(interaction, lang) {
  const config = await loadConfig(interaction.guildId);
  const key = interaction.options.getString('squad', true).trim().toLowerCase();
  const squad = config.squads.get(key);
  if (!squad) throw new SquadCommandError('squadsError.notFound', { squad: key });

  let description;
  if (squad.isGuild) {
    description = t('squads.show.guild', lang, { guild: escapeMarkdown(squad.guildName) });
  } else {
    const members = [...squad.members.values()].sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' }));
    description = members.length > 0 ? members.map((name) => escapeMarkdown(name)).join('\n') : '—';
  }

  await interaction.editReply({
    embeds: [infoEmbed({ title: t('squads.show.title', lang, { squad: squad.display }), description })],
  });
}

function squadLabel(key, isGuild) {
  return isGuild ? key : key.toUpperCase();
}

async function handleCreate(interaction, lang) {
  const input = interaction.options.getString('name', true);
  const isGuild = interaction.options.getBoolean('is-guild') ?? false;
  const { report } = await createSquad(interaction.guildId, input, { isGuild });
  const squad = squadLabel(report.key, report.isGuild);
  const title = (l) => t(report.isGuild ? 'squads.create.title.guild' : 'squads.create.title.players', l, { squad });
  const body = (l) =>
    report.isGuild
      ? t('squads.create.body.guild', l, { guild: escapeMarkdown(report.key) })
      : t('squads.create.body.players', l);

  await interaction.editReply({
    embeds: [mutationEmbed({ title: title(lang), description: body(lang), actorTag: interaction.user.tag, lang })],
  });

  await notifySquadMutation(interaction.client, {
    guildId: interaction.guildId,
    actorTag: interaction.user.tag,
    subcommand: 'create',
    summary: (l) => `${title(l)}\n${body(l)}`,
  });
}

async function handleDelete(interaction, lang) {
  const input = interaction.options.getString('squad', true);
  const key = input.trim().toLowerCase();
  const config = await loadConfig(interaction.guildId);
  const squad = config.squads.get(key);
  if (!squad) throw new SquadCommandError('squadsError.notFound', { squad: key });

  const confirmId = `squads-delete-confirm-${interaction.id}`;
  const cancelId = `squads-delete-cancel-${interaction.id}`;

  const message = await interaction.editReply({
    content: squad.isGuild
      ? t('squads.delete.ask.guild', lang, { squad: escapeMarkdown(squad.display) })
      : tn('squads.delete.ask.players', squad.members.size, lang, { squad: squad.display }),
    embeds: [],
    components: [confirmRow(confirmId, cancelId, 'squads.delete.confirm', lang)],
  });

  let buttonInteraction;
  try {
    buttonInteraction = await message.awaitMessageComponent({
      filter: (i) => i.user.id === interaction.user.id,
      time: CONFIRM_TIMEOUT_MS,
    });
  } catch {
    await interaction.editReply({ content: t('squads.delete.expired', lang), components: [] });
    return;
  }

  if (buttonInteraction.customId === cancelId) {
    await buttonInteraction.update({ content: t('squads.delete.cancelled', lang), components: [] });
    return;
  }

  const { report } = await deleteSquad(interaction.guildId, key);
  const label = squadLabel(report.key, report.isGuild);
  const title = (l) => t('squads.delete.title', l, { squad: label });
  const body = (l) =>
    report.isGuild
      ? t('squads.delete.body.guild', l, { guild: escapeMarkdown(report.key) })
      : tn('squads.delete.body.players', report.removedMembers.length, l);

  await buttonInteraction.update({
    content: null,
    embeds: [mutationEmbed({ title: title(lang), description: body(lang), actorTag: interaction.user.tag, lang })],
    components: [],
  });

  await notifySquadMutation(interaction.client, {
    guildId: interaction.guildId,
    actorTag: interaction.user.tag,
    subcommand: 'delete',
    summary: (l) => `${title(l)}\n${body(l)}`,
  });
}

async function handleAdd(interaction, lang) {
  const squadInput = interaction.options.getString('squad', true);
  const playersInput = interaction.options.getString('players', true);
  const { report } = await addPlayers(interaction.guildId, squadInput, playersInput);
  const squad = report.key.toUpperCase();

  const body = (l) => {
    const lines = [];
    if (report.added.length > 0) {
      lines.push(t('squads.add.added', l, { names: report.added.map((name) => escapeMarkdown(name)).join(', ') }));
    }
    if (report.alreadyInSquad.length > 0) {
      lines.push(t('squads.add.already', l, { names: report.alreadyInSquad.map((name) => escapeMarkdown(name)).join(', ') }));
    }
    for (const { name, otherSquad } of report.crossSquadWarnings) {
      lines.push(t('squads.add.crossSquad', l, { name: escapeMarkdown(name), other: otherSquad.toUpperCase(), squad: report.key }));
    }
    return lines.join('\n') || t('squads.add.noChanges', l);
  };
  const title = (l) => t('squads.updated.title', l, { squad });

  await interaction.editReply({
    embeds: [mutationEmbed({ title: title(lang), description: body(lang), actorTag: interaction.user.tag, lang })],
  });

  await notifySquadMutation(interaction.client, {
    guildId: interaction.guildId,
    actorTag: interaction.user.tag,
    subcommand: 'add',
    summary: (l) => `${title(l)}\n${body(l)}`,
  });
}

async function handleRemove(interaction, lang) {
  const squadInput = interaction.options.getString('squad', true);
  const playerInput = interaction.options.getString('player', true);
  const { report } = await removePlayer(interaction.guildId, squadInput, playerInput);
  const title = (l) => t('squads.updated.title', l, { squad: report.key.toUpperCase() });
  const body = (l) => t('squads.remove.body', l, { name: escapeMarkdown(report.removedName) });

  await interaction.editReply({
    embeds: [mutationEmbed({ title: title(lang), description: body(lang), actorTag: interaction.user.tag, lang })],
  });

  await notifySquadMutation(interaction.client, {
    guildId: interaction.guildId,
    actorTag: interaction.user.tag,
    subcommand: 'remove',
    summary: (l) => `${title(l)}\n${body(l)}`,
  });
}

async function handleRename(interaction, lang) {
  const squadInput = interaction.options.getString('squad', true);
  const newInput = interaction.options.getString('new-name', true);

  // En un squad de gremio el nombre ES el gremio que sigue: renombrarlo
  // cambia de gremio, y eso se avisa y se confirma antes de hacerlo.
  const current = await describeSquad(interaction.guildId, squadInput);
  let reply = (payload) => interaction.editReply(payload);
  if (current.isGuild) {
    const confirmId = `squads-rename-confirm-${interaction.id}`;
    const cancelId = `squads-rename-cancel-${interaction.id}`;
    const message = await interaction.editReply({
      content: t('squads.rename.ask', lang, {
        current: escapeMarkdown(current.key),
        next: escapeMarkdown(newInput.trim()),
      }),
      embeds: [],
      components: [confirmRow(confirmId, cancelId, 'squads.rename.confirm', lang)],
    });

    let buttonInteraction;
    try {
      buttonInteraction = await message.awaitMessageComponent({
        filter: (i) => i.user.id === interaction.user.id,
        time: CONFIRM_TIMEOUT_MS,
      });
    } catch {
      await interaction.editReply({ content: t('squads.rename.expired', lang), components: [] });
      return;
    }
    if (buttonInteraction.customId === cancelId) {
      await buttonInteraction.update({ content: t('squads.rename.cancelled', lang), components: [] });
      return;
    }
    await buttonInteraction.deferUpdate();
    reply = (payload) => buttonInteraction.editReply(payload);
  }

  const { report } = await renameSquad(interaction.guildId, squadInput, newInput);
  const body = (l) =>
    escapeMarkdown(
      report.isGuild
        ? t('squads.rename.body.guild', l, { old: report.oldKey, new: report.newKey })
        : t('squads.rename.body.players', l, { old: report.oldKey.toUpperCase(), new: report.newKey.toUpperCase() }),
    );

  await reply({
    content: null,
    embeds: [mutationEmbed({ title: t('squads.rename.title', lang), description: body(lang), actorTag: interaction.user.tag, lang })],
    components: [],
  });

  await notifySquadMutation(interaction.client, {
    guildId: interaction.guildId,
    actorTag: interaction.user.tag,
    subcommand: 'rename',
    summary: body,
  });
}

async function handleMove(interaction, lang) {
  const playerInput = interaction.options.getString('player', true);
  const squadInput = interaction.options.getString('squad', true);
  const { report } = await movePlayer(interaction.guildId, playerInput, squadInput);
  const body = (l) =>
    t('squads.move.body', l, {
      name: escapeMarkdown(report.name),
      from: report.fromKey.toUpperCase(),
      to: report.toKey.toUpperCase(),
    });

  await interaction.editReply({
    embeds: [mutationEmbed({ title: t('squads.move.title', lang), description: body(lang), actorTag: interaction.user.tag, lang })],
  });

  await notifySquadMutation(interaction.client, {
    guildId: interaction.guildId,
    actorTag: interaction.user.tag,
    subcommand: 'move',
    summary: body,
  });
}

async function handleFind(interaction, lang) {
  const config = await loadConfig(interaction.guildId);
  const playerInput = interaction.options.getString('player', true).trim();
  const nameLower = playerInput.toLowerCase();
  const squadKey = config.playerToSquad.get(nameLower);

  const squad = squadKey ? config.squads.get(squadKey) : null;
  const content = squad
    ? t('squads.find.found', lang, { player: escapeMarkdown(squad.members.get(nameLower)), squad: squad.display })
    : t('squads.find.notFound', lang, { player: escapeMarkdown(playerInput) });

  await interaction.editReply({ content });
}

/**
 * @param {import('discord.js').AutocompleteInteraction} interaction
 */
export async function autocomplete(interaction) {
  // Mismo filtro que execute(): quien no puede usar /squads tampoco recibe
  // sus squads ni sus jugadores como sugerencias.
  if (!(await isOfficer(interaction))) {
    await interaction.respond([]);
    return;
  }

  const focused = interaction.options.getFocused(true);
  const subcommand = interaction.options.getSubcommand(false);

  let config;
  try {
    config = await loadConfig(interaction.guildId);
  } catch {
    await interaction.respond([]);
    return;
  }

  let choices = [];

  if (focused.name === 'squad') {
    // create no tiene autocomplete habilitado en el builder (la clave es nueva).
    // add/remove/move solo tienen sentido sobre squads de jugadores: los de
    // gremio no tienen lista que editar.
    const playersOnly = ['add', 'remove', 'move'].includes(subcommand);
    choices = config.squadOrder
      .filter((key) => !playersOnly || !config.squads.get(key).isGuild)
      .map((key) => {
        const squad = config.squads.get(key);
        return { name: squad.isGuild ? `🛡️ ${squad.display}` : squad.display, value: key };
      });
  } else if (focused.name === 'player' && subcommand === 'remove') {
    const squadInput = interaction.options.getString('squad');
    const squadKey = squadInput?.trim().toLowerCase();
    const squad = squadKey ? config.squads.get(squadKey) : null;
    choices = squad ? [...squad.members.values()].map((name) => ({ name, value: name })) : [];
  } else if (focused.name === 'player') {
    // find / move: cualquier jugador conocido
    choices = [...config.playerToSquad].map(([nameLower, squadKey]) => {
      const name = config.squads.get(squadKey).members.get(nameLower);
      return { name, value: name };
    });
  }

  const query = focused.value.toLowerCase();
  const filtered = choices.filter((choice) => choice.name.toLowerCase().includes(query)).slice(0, AUTOCOMPLETE_LIMIT);

  await interaction.respond(filtered);
}
