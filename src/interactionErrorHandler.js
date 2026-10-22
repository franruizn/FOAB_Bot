import { InvalidLinkError } from './services/albionbb.js';
import { AlbionApiError } from './services/albionApi.js';
import { AlbionbbApiError } from './services/albionbbApi.js';
import { ConfigError } from './services/config.js';
import { MissingConfigError } from './services/configFields.js';
import { errorEmbed } from './ui/errorEmbed.js';
import { isOfficer } from './permissions.js';
import { t, replyLang } from './i18n.js';

/**
 * Clasifica un error y arma el embed correspondiente en `lang`. Los errores
 * "conocidos" (entrada de usuario o fallos esperados de la API) se loguean en
 * una línea; cualquier error no reconocido se loguea con el stack completo,
 * ya que ahí sí puede tratarse de un bug real. `known: false` marca justo ese
 * último caso, para que el llamador decida si avisa en el canal de logs del
 * servidor.
 * @param {unknown} error
 * @param {string} lang
 * @returns {{ embed: import('discord.js').EmbedBuilder, officerOnly: boolean, known: boolean }}
 */
function classifyError(error, lang) {
  if (error instanceof InvalidLinkError) {
    console.error(`InvalidLinkError: ${error.message}`);
    return {
      embed: errorEmbed(t('error.invalidLink.title', lang), `${error.localized(lang)}\n\n${t('error.invalidLink.example', lang)}`),
      officerOnly: false,
      known: true,
    };
  }

  if (error instanceof AlbionApiError && error.status === 404) {
    console.error(`AlbionApiError 404 (battleId=${error.battleId})`);
    return {
      embed: errorEmbed(t('error.battleNotFound.title', lang), t('error.battleNotFound.body', lang)),
      officerOnly: false,
      known: true,
    };
  }

  if (error instanceof AlbionApiError && error.status >= 500) {
    console.error(`AlbionApiError ${error.status} (battleId=${error.battleId})`);
    return {
      embed: errorEmbed(t('error.albionDown.title', lang), t('error.albionDown.body', lang)),
      officerOnly: false,
      known: true,
    };
  }

  if (error instanceof AlbionbbApiError && error.status === 404) {
    console.error(`AlbionbbApiError 404 (guildId=${error.guildId})`);
    return {
      embed: errorEmbed(t('error.albionbbGuildNotFound.title', lang), t('error.albionbbGuildNotFound.body', lang)),
      officerOnly: false,
      known: true,
    };
  }

  if (error instanceof AlbionbbApiError) {
    console.error(`AlbionbbApiError ${error.status} (guildId=${error.guildId})`);
    return {
      embed: errorEmbed(t('error.albionbbDown.title', lang), t('error.albionbbDown.body', lang)),
      officerOnly: false,
      known: true,
    };
  }

  // A diferencia de ConfigError (un fichero roto, detalle para oficiales),
  // esto es un servidor a medio configurar: lo ve quien lo ejecutó, porque
  // el mensaje ya dice qué falta y con qué comando se arregla.
  if (error instanceof MissingConfigError) {
    console.error(`MissingConfigError (${error.field})`);
    return {
      embed: errorEmbed(t('common.missingConfig.title', lang), error.localized(lang)),
      officerOnly: false,
      known: true,
    };
  }

  if (error instanceof ConfigError) {
    console.error(`ConfigError (${error.reason}) en "${error.path}": ${error.message}`);
    return {
      embed: errorEmbed(t('error.config.title', lang), error.localized(lang)),
      officerOnly: true,
      known: true,
    };
  }

  console.error('Error inesperado en interacción:', error?.stack ?? error);
  return {
    embed: errorEmbed(t('error.unexpected.title', lang), t('error.unexpected.body', lang)),
    officerOnly: false,
    known: false,
  };
}

/**
 * Maneja cualquier error lanzado durante la ejecución de un comando: clasifica
 * el error, construye el embed adecuado (ocultando detalle técnico de
 * ConfigError a quien no sea oficial) y responde por el canal correcto según
 * el estado de la interacción. El idioma sigue la regla de src/i18n.js: si la
 * respuesta ya era pública (deferReply sin ephemeral), la lee el servidor; si
 * no, solo quien ejecutó el comando.
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {unknown} error
 * @returns {Promise<{ known: boolean }>} known=false si el error cayó en el genérico (no tipado)
 */
export async function handleInteractionError(interaction, error) {
  const lang = await replyLang(interaction).catch(() => 'en');
  const { embed, officerOnly, known } = classifyError(error, lang);

  const visibleEmbed =
    officerOnly && !(await isOfficer(interaction).catch(() => false))
      ? errorEmbed(t('error.configHidden.title', lang), t('error.configHidden.body', lang))
      : embed;

  const replyPayload = { embeds: [visibleEmbed], ephemeral: true };

  if (interaction.deferred || interaction.replied) {
    await interaction.editReply(replyPayload);
  } else {
    await interaction.reply(replyPayload);
  }

  return { known };
}
