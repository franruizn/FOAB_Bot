import { ChannelType, PermissionFlagsBits } from 'discord.js';
import { getConfig, setConfig, existeConfig, listarGuilds } from './services/guildStore.js';
import { t, langFromLocale } from './i18n.js';

// Entrar y salir de servidores. Los datos de un servidor NUNCA se borran al
// echar al bot: se marca activo=false con la fecha, y si lo vuelven a añadir
// recupera su config y sus squads tal cual.
//
// Un servidor nuevo empieza con config.json por defecto y SIN squads.json:
// no se copia ningún semilla, los jugadores de un gremio no son de otro.

const WRITE_PERMISSIONS = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages];

/**
 * ALLOWED_GUILD_IDS=<id>,<id>: si está definida, el bot solo se queda en
 * esos servidores. Vacía o sin definir: acepta cualquiera (null).
 * @param {string | undefined} raw
 * @returns {Set<string> | null}
 */
export function parseAllowedGuildIds(raw = process.env.ALLOWED_GUILD_IDS) {
  const ids = (raw ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
  return ids.length > 0 ? new Set(ids) : null;
}

function logEvent(msg, extra = {}) {
  console.log(JSON.stringify({ timestamp: new Date().toISOString(), type: 'guild', msg, ...extra }));
}

/**
 * El canal de sistema si el bot puede escribir en él; si no, el primer canal
 * de texto (por orden en la lista) donde pueda. null si no hay ninguno.
 * @param {import('discord.js').Guild} guild
 */
export function findWelcomeChannel(guild) {
  const me = guild.members.me;
  if (!me) return null;
  const canWrite = (channel) =>
    channel?.type === ChannelType.GuildText && (channel.permissionsFor(me)?.has(WRITE_PERMISSIONS) ?? false);

  if (canWrite(guild.systemChannel)) return guild.systemChannel;
  return (
    [...guild.channels.cache.values()].filter(canWrite).sort((a, b) => a.rawPosition - b.rawPosition)[0] ?? null
  );
}

/**
 * @param {import('discord.js').Guild} guild
 * @param {string} key - welcome.new / welcome.back
 * @param {string} lang - idioma del servidor: la bienvenida la lee todo el canal
 */
async function sendWelcome(guild, key, lang) {
  const channel = findWelcomeChannel(guild);
  if (!channel) {
    logEvent('Sin canal donde escribir la bienvenida', { guildId: guild.id });
    return;
  }
  await channel.send(t(key, lang)).catch((error) => {
    console.error(`[guild] No se pudo enviar la bienvenida a ${guild.id}:`, error?.message ?? error);
  });
}

/**
 * El bot está en `guild` (acaba de entrar, o lo comprueba al arrancar).
 * - Fuera de ALLOWED_GUILD_IDS: sale y lo registra, sin crear nada en disco.
 * - Nuevo: crea su carpeta con config.json por defecto, con el idioma del
 *   servidor de Discord (preferredLocale), y da la bienvenida en ese idioma.
 * - Vuelve tras haberlo echado: lo reactiva con todo lo que tenía.
 * - Ya activo: solo actualiza el nombre.
 * En los dos últimos, si no tiene idioma (una config de antes de que
 * existiera) se le pone el de su preferredLocale.
 * @param {import('discord.js').Guild} guild
 * @param {{ allowed: Set<string> | null }} options
 * @returns {Promise<'left' | 'new' | 'returned' | 'active'>}
 */
export async function onGuildPresent(guild, { allowed }) {
  if (allowed && !allowed.has(guild.id)) {
    logEvent('Servidor fuera de ALLOWED_GUILD_IDS: el bot sale', { guildId: guild.id, nombre: guild.name });
    await guild.leave().catch((error) => {
      console.error(`[guild] No se pudo salir del servidor ${guild.id}:`, error?.message ?? error);
    });
    return 'left';
  }

  // Un servidor de Discord en español arranca con el bot en español sin que
  // nadie lo configure.
  const localeLang = langFromLocale(guild.preferredLocale);

  if (!(await existeConfig(guild.id))) {
    await getConfig(guild.id); // crea config.json por defecto
    await setConfig(guild.id, { nombre: guild.name, idioma: localeLang });
    logEvent('Servidor nuevo', { guildId: guild.id, nombre: guild.name, idioma: localeLang });
    await sendWelcome(guild, 'welcome.new', localeLang);
    return 'new';
  }

  const { activo, nombre, idioma } = await getConfig(guild.id);
  const lang = idioma ?? localeLang;
  if (!activo) {
    await setConfig(guild.id, { activo: true, inactivoDesde: null, nombre: guild.name, idioma: lang });
    logEvent('Servidor recuperado: conserva su configuración y sus squads', { guildId: guild.id, nombre: guild.name });
    await sendWelcome(guild, 'welcome.back', lang);
    return 'returned';
  }

  if (nombre !== guild.name || idioma !== lang) await setConfig(guild.id, { nombre: guild.name, idioma: lang });
  return 'active';
}

/**
 * Han echado al bot de `guild` (o se ha borrado el servidor). No borra nada:
 * marca activo=false con la fecha. Un servidor que deja de estar disponible
 * por una caída de Discord también emite guildDelete, con available=false:
 * ese no se toca.
 * @param {import('discord.js').Guild} guild
 * @returns {Promise<boolean>} true si se marcó como inactivo
 */
export async function onGuildRemoved(guild) {
  if (guild.available === false) return false;
  // Uno del que salió por ALLOWED_GUILD_IDS nunca llegó a tener carpeta.
  if (!(await existeConfig(guild.id))) return false;

  await setConfig(guild.id, { activo: false, inactivoDesde: new Date().toISOString() });
  logEvent('Bot fuera del servidor: datos conservados, marcado inactivo', { guildId: guild.id, nombre: guild.name });
  return true;
}

/**
 * Al arrancar: los eventos de entrada y salida que pasaron con el bot
 * apagado no llegan nunca, así que se reconcilia contra la lista real de
 * servidores. La caché de un cliente listo incluye también los servidores
 * caídos (unavailable), así que uno que no está en ella es uno del que han
 * echado al bot.
 * @param {import('discord.js').Client} client
 * @param {{ allowed: Set<string> | null }} options
 */
export async function reconcileGuilds(client, { allowed }) {
  for (const guild of client.guilds.cache.values()) {
    if (guild.available === false) continue;
    try {
      await onGuildPresent(guild, { allowed });
    } catch (error) {
      console.error(`[guild] Error reconciliando el servidor ${guild.id}:`, error?.stack ?? error);
    }
  }

  for (const guildId of await listarGuilds()) {
    if (client.guilds.cache.has(guildId)) continue;
    try {
      if ((await getConfig(guildId)).activo) await onGuildRemoved({ id: guildId, name: null, available: true });
    } catch (error) {
      console.error(`[guild] Error marcando inactivo el servidor ${guildId}:`, error?.stack ?? error);
    }
  }
}
