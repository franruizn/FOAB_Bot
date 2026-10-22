import { SlashCommandBuilder, PermissionFlagsBits, InteractionContextType, ChannelType, escapeMarkdown } from 'discord.js';
import { getConfig, updateConfig, defaultConfig, ALBION_SERVERS, LANGUAGES } from '../services/guildStore.js';
import { CONFIG_FIELDS, fieldBySub, fieldLabel } from '../services/configFields.js';
import { loadConfig, isValidGuildName, MAX_GUILD_NAME_LENGTH } from '../services/config.js';
import { getGuildAttendance, AlbionbbApiError } from '../services/albionbbApi.js';
import { isAdministrator } from '../permissions.js';
import { notifyConfigChange } from '../logChannel.js';
import { buildConfigViewEmbed, buildConfigChangeEmbed, formatValue } from '../ui/configEmbed.js';
import { errorEmbed } from '../ui/errorEmbed.js';
import { t, userLang, langFromLocale, localizedDescription, LocalizedError } from '../i18n.js';

const LOG_CHANNEL_TYPES = [ChannelType.GuildText, ChannelType.GuildAnnouncement];
// Lo que necesita el bot en el canal de logs: los avisos son embeds y los
// textos largos de /dm van como fichero adjunto.
const LOG_CHANNEL_PERMISSIONS = [
  [PermissionFlagsBits.ViewChannel, 'config.perm.viewChannel'],
  [PermissionFlagsBits.SendMessages, 'config.perm.sendMessages'],
  [PermissionFlagsBits.EmbedLinks, 'config.perm.embedLinks'],
  [PermissionFlagsBits.AttachFiles, 'config.perm.attachFiles'],
];
const ALBIONBB_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
// Quien copia la URL de la página del gremio en albionbb en vez del id:
// https://europe.albionbb.com/guilds/<id>/attendance
const ALBIONBB_URL_ID_PATTERN = /\/guilds\/([A-Za-z0-9_-]+)/;
const ALBIONBB_CHECK_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Entrada de /config que no se puede guardar: se explica y no se toca nada. */
class ConfigInputError extends LocalizedError {
  constructor(key, values) {
    super(key, values);
    this.name = 'ConfigInputError';
  }
}

// Solo para tests: comprobar un id en albionbb sin salir a la red.
let albionbbCheckImpl = (server, albionbbGuildId) => {
  const end = new Date();
  const start = new Date(end.getTime() - ALBIONBB_CHECK_DAYS * DAY_MS);
  return getGuildAttendance(server, albionbbGuildId, {
    start: start.toISOString().slice(0, 10),
    end: end.toISOString().slice(0, 10),
  });
};
export function __setAlbionbbCheckForTests(fn) {
  albionbbCheckImpl = fn;
}

const roleSub = (name, descriptionKey, optionKey) => (sub) =>
  localizedDescription(sub.setName(name), descriptionKey).addRoleOption((o) =>
    localizedDescription(o.setName('role'), optionKey).setRequired(true),
  );

// Comando de administración: un único nombre (en inglés) para el comando, sus
// subcomandos y sus opciones, sin localizar, para que cualquier guía sirva a
// todos. Las descripciones sí se traducen.
//
// Administrador y no rol de oficiales: en un servidor recién añadido no hay
// rol de oficiales que exigir. setDefaultMemberPermissions solo lo esconde
// del picker (y se puede sobrescribir en los ajustes del servidor); el
// filtro real es isAdministrator() en runtime.
export const data = localizedDescription(new SlashCommandBuilder().setName('config'), 'cmd.config.description')
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .setContexts(InteractionContextType.Guild)
  .addSubcommand((sub) => localizedDescription(sub.setName('view'), 'cmd.config.view.description'))
  .addSubcommand(roleSub('officer', 'cmd.config.officer.description', 'cmd.config.opt.role.officer'))
  .addSubcommand((sub) =>
    localizedDescription(sub.setName('logs'), 'cmd.config.logs.description').addChannelOption((o) =>
      localizedDescription(o.setName('channel'), 'cmd.config.opt.channel.description')
        .setRequired(true)
        .addChannelTypes(...LOG_CHANNEL_TYPES),
    ),
  )
  .addSubcommand(roleSub('raffle-role', 'cmd.config.raffleRole.description', 'cmd.config.opt.role.raffle'))
  .addSubcommand(roleSub('dm-optout', 'cmd.config.dmOptout.description', 'cmd.config.opt.role.dmOptout'))
  .addSubcommand((sub) =>
    localizedDescription(sub.setName('server'), 'cmd.config.server.description').addStringOption((o) =>
      localizedDescription(o.setName('value'), 'cmd.config.opt.value.server')
        .setRequired(true)
        // Los servidores de Albion no se traducen: son los valores de la API.
        .addChoices(...[...ALBION_SERVERS].map((server) => ({ name: server, value: server }))),
    ),
  )
  .addSubcommand((sub) =>
    localizedDescription(sub.setName('guild'), 'cmd.config.guild.description').addStringOption((o) =>
      localizedDescription(o.setName('name'), 'cmd.config.opt.name.description').setRequired(true),
    ),
  )
  .addSubcommand((sub) =>
    localizedDescription(sub.setName('albionbb'), 'cmd.config.albionbb.description').addStringOption((o) =>
      localizedDescription(o.setName('value'), 'cmd.config.opt.value.albionbb').setRequired(true),
    ),
  )
  .addSubcommand((sub) =>
    localizedDescription(sub.setName('language'), 'cmd.config.language.description').addStringOption((o) =>
      localizedDescription(o.setName('value'), 'cmd.config.opt.value.language')
        .setRequired(true)
        // Cada idioma con su propio nombre: así lo reconoce quien lo habla.
        .addChoices({ name: 'English', value: 'en' }, { name: 'Español', value: 'es' }),
    ),
  )
  .addSubcommand((sub) =>
    localizedDescription(sub.setName('reset'), 'cmd.config.reset.description').addStringOption((o) =>
      localizedDescription(o.setName('field'), 'cmd.config.opt.field.description')
        .setRequired(true)
        // Las choices son los nombres de los subcomandos: tampoco se traducen.
        .addChoices(...CONFIG_FIELDS.map((field) => ({ name: field.sub, value: field.sub }))),
    ),
  );

/**
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 */
export async function execute(interaction) {
  // Todas las respuestas de /config son efímeras: idioma de quien lo ejecuta.
  const lang = userLang(interaction);

  if (!isAdministrator(interaction)) {
    await interaction.reply({
      embeds: [errorEmbed(t('common.noPermission.title', lang), t('config.noAdmin', lang))],
      ephemeral: true,
    });
    return;
  }

  const subcommand = interaction.options.getSubcommand();
  await interaction.deferReply({ ephemeral: true });

  if (subcommand === 'view') {
    const config = await getConfig(interaction.guildId);
    await interaction.editReply({ embeds: [buildConfigViewEmbed({ config, guild: interaction.guild, lang })] });
    return;
  }

  try {
    if (subcommand === 'reset') {
      const field = fieldBySub(interaction.options.getString('field', true));
      if (!field) throw new Error('Campo de /config reset desconocido');
      // El idioma por defecto es el del servidor de Discord, no null.
      const value =
        field.key === 'idioma'
          ? langFromLocale(interaction.guild?.preferredLocale)
          : defaultConfig(interaction.guildId)[field.key];
      await applyChange(interaction, field, value, null, lang);
      return;
    }

    const field = fieldBySub(subcommand);
    if (!field) throw new Error(`Subcomando desconocido: ${subcommand}`);
    const { value, note } = await VALIDATORS[field.sub](interaction);
    await applyChange(interaction, field, value, note ? t(note.key, lang, note.values) : null, lang);
  } catch (error) {
    if (error instanceof ConfigInputError) {
      await interaction.editReply({ embeds: [errorEmbed(t('config.rejected.title', lang), error.localized(lang))] });
      return;
    }
    throw error;
  }
}

/**
 * Guarda el campo (escritura atómica, bajo el candado de config.json), lo
 * deja registrado en el canal de logs (en el idioma del servidor) y responde
 * con el antes y el después (en el de quien lo ejecutó).
 */
async function applyChange(interaction, field, value, note, lang) {
  const { guildId } = interaction;
  if ((await getConfig(guildId))[field.key] === value) {
    await interaction.editReply({
      embeds: [
        errorEmbed(
          t('config.unchanged.title', lang),
          t('config.unchanged.body', lang, { label: fieldLabel(field, lang), value: formatValue(field, value, lang) }),
        ),
      ],
    });
    return;
  }

  const { previous, config } = await updateConfig(guildId, {
    [field.key]: value,
    configuradoEn: new Date().toISOString(),
    configuradoPor: interaction.user.id,
  });
  const before = previous[field.key];

  await notifyConfigChange(interaction.client, {
    guildId,
    actorTag: interaction.user.tag,
    actorId: interaction.user.id,
    field,
    before,
    after: value,
    // Al quitar el canal de logs, el aviso va al que deja de serlo: si no,
    // ese cambio sería justo el único sin rastro.
    logChannelId: field.key === 'logChannelId' && !value ? previous.logChannelId ?? undefined : undefined,
  });

  await interaction.editReply({
    embeds: [buildConfigChangeEmbed({ field, before, after: value, note, config, guild: interaction.guild, lang })],
  });
}

// --- validación por subcomando: devuelven { value, note } o lanzan ConfigInputError ---
// note: { key, values } de i18n, que se traduce al idioma de quien lo ejecutó.

function validateRole(interaction, everyoneKey) {
  const role = interaction.options.getRole('role', true);
  // El rol @everyone tiene el mismo id que el servidor.
  if (role.id === interaction.guildId) throw new ConfigInputError(everyoneKey);
  if (role.managed) throw new ConfigInputError('config.error.managedRole', { role: role.name });
  return { value: role.id, note: null };
}

async function validateLogChannel(interaction) {
  const option = interaction.options.getChannel('channel', true);
  const channel = await interaction.guild.channels.fetch(option.id).catch(() => null);
  if (!channel || !LOG_CHANNEL_TYPES.includes(channel.type)) throw new ConfigInputError('config.error.logChannelType');

  const me = interaction.guild.members.me ?? (await interaction.guild.members.fetchMe());
  const permissions = channel.permissionsFor(me);
  const missing = LOG_CHANNEL_PERMISSIONS.filter(([flag]) => !permissions?.has(flag)).map(([, key]) => key);
  if (missing.length > 0) {
    // Los permisos se traducen al idioma de quien lo lea, no al construir el
    // error: van como lista de claves y MissingPermissionsError los resuelve.
    throw new MissingPermissionsError(channel.id, missing);
  }
  return { value: channel.id, note: null };
}

/** Canal de logs sin los permisos que necesita el bot, con su lista traducible. */
class MissingPermissionsError extends ConfigInputError {
  constructor(channelId, permissionKeys) {
    super('config.error.logChannelPerms', { channel: channelId, permissions: permissionKeys.map((key) => t(key)).join(', ') });
    this.permissionKeys = permissionKeys;
  }

  localized(lang) {
    const permissions = this.permissionKeys.map((key) => t(key, lang)).join(', ');
    return t(this.key, lang, { ...this.values, permissions });
  }
}

async function validateAlbionServer(interaction) {
  const server = interaction.options.getString('value', true);
  if (!ALBION_SERVERS.has(server)) throw new ConfigInputError('config.error.server', { servers: [...ALBION_SERVERS].join(', ') });
  const { albionbbGuildId } = await getConfig(interaction.guildId);
  return { value: server, note: albionbbGuildId ? { key: 'config.note.serverAlbionbb' } : null };
}

async function validateMainGuild(interaction) {
  const input = interaction.options.getString('name', true);
  if (input.includes(',')) throw new ConfigInputError('config.error.guildComma');

  const name = input.trim();
  if (!isValidGuildName(name)) throw new ConfigInputError('config.error.guildLength', { max: MAX_GUILD_NAME_LENGTH });

  // El gremio principal ya es MAIN ZERG: si además hubiera un squad de
  // gremio siguiéndolo, /getkills contaría a todos dos veces.
  const squads = await loadConfig(interaction.guildId);
  const clash = squads.guildToSquad.get(name.toLowerCase());
  if (clash) {
    throw new ConfigInputError('config.error.guildClash', { guild: escapeMarkdown(squads.squads.get(clash).display) });
  }

  return { value: name, note: { key: 'config.note.guildExact' } };
}

async function validateAlbionbbId(interaction) {
  const input = interaction.options.getString('value', true).trim();
  const id = input.match(ALBIONBB_URL_ID_PATTERN)?.[1] ?? input;
  if (!ALBIONBB_ID_PATTERN.test(id)) throw new ConfigInputError('config.error.albionbbFormat');

  const { albionServer } = await getConfig(interaction.guildId);
  try {
    await albionbbCheckImpl(albionServer, id);
  } catch (error) {
    if (error instanceof AlbionbbApiError && error.status === 404) {
      throw new ConfigInputError('config.error.albionbbNotFound', { id, server: albionServer });
    }
    console.error(`[config] No se pudo comprobar el id de albionbb ${id} (${albionServer}):`, error);
    return { value: id, note: { key: 'config.note.albionbbUnreachable' } };
  }
  return { value: id, note: null };
}

function validateLanguage(interaction) {
  const language = interaction.options.getString('value', true);
  if (!LANGUAGES.has(language)) throw new ConfigInputError('config.error.language', { languages: [...LANGUAGES].join(', ') });
  return { value: language, note: null };
}

const VALIDATORS = {
  officer: (interaction) => validateRole(interaction, 'config.error.everyone.officer'),
  logs: validateLogChannel,
  'raffle-role': (interaction) => validateRole(interaction, 'config.error.everyone.raffle'),
  'dm-optout': (interaction) => validateRole(interaction, 'config.error.everyone.dmOptout'),
  server: validateAlbionServer,
  guild: validateMainGuild,
  albionbb: validateAlbionbbId,
  language: validateLanguage,
};
