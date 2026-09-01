import { PermissionFlagsBits } from 'discord.js';

// Prompt C6: el rol de Discord propio de cada CTA. Se da a quien se apunta y
// se quita a quien se desapunta — el punto de tenerlo es poder pingar de
// golpe a los inscritos. Es PERMANENTE: nada de este módulo lo borra salvo
// el rollback de una creación que se quedó a medias (ver borrarRolCta).

export class CtaRoleError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CtaRoleError';
  }
}

const ROLE_NAME_MAX_LENGTH = 100;
const MAX_GUILD_ROLES = 250;
const ROLE_WARNING_THRESHOLD = 200;
// "<nombre>_<ddMM-HHmm>": termina en un guion bajo + 4 dígitos + guion +
// 4 dígitos. Se usa en /cta roles para reconocer qué roles del servidor son
// de una CTA (no hay ningún registro aparte: el propio nombre del rol, más
// su createdAt nativo de Discord, son la única fuente — el rol es
// permanente y puede sobrevivir a reinicios/redeploys sin problema).
export const CTA_ROLE_NAME_PATTERN = /_\d{4}-\d{4}$/;

function pad2(n) {
  return String(n).padStart(2, '0');
}

/**
 * "ddMM-HHmm" en hora local del proceso — sin año: el nombre del rol es
 * corto a propósito, y createdAt (nativo del rol en Discord) ya guarda la
 * fecha completa para cuando haga falta (ver /cta roles).
 * @param {Date} date
 * @returns {string}
 */
function formatRoleTimestamp(date) {
  return `${pad2(date.getDate())}${pad2(date.getMonth() + 1)}-${pad2(date.getHours())}${pad2(date.getMinutes())}`;
}

/**
 * Recorta espacios, colapsa espacios repetidos, y rechaza "@everyone"/"@here"
 * (Discord tampoco los admite como nombre de rol; lo comprobamos antes para
 * dar un mensaje claro en vez de dejar que la API lo rechace sin contexto).
 * @param {string} nombre
 * @returns {string}
 */
function sanitizeRoleBaseName(nombre) {
  const cleaned = nombre.trim().replace(/\s+/g, ' ');
  if (/^@everyone$/i.test(cleaned) || /^@here$/i.test(cleaned)) {
    throw new CtaRoleError('El nombre de la CTA no puede ser "@everyone" ni "@here" (Discord no admite ese nombre de rol).');
  }
  return cleaned;
}

/**
 * "<nombre>_<ddMM-HHmm>", recortando el nombre lo que haga falta para que
 * el total nunca supere el límite de Discord (100 caracteres). El sufijo de
 * fecha nunca se recorta: es lo que lo hace reconocible y lo distingue de
 * otra CTA con el mismo nombre.
 * @param {string} nombre
 * @param {Date} createdAt
 * @returns {string}
 */
export function buildRoleName(nombre, createdAt) {
  const base = sanitizeRoleBaseName(nombre);
  const suffix = `_${formatRoleTimestamp(createdAt)}`;
  const maxBaseLength = ROLE_NAME_MAX_LENGTH - suffix.length;
  const truncatedBase = base.length > maxBaseLength ? base.slice(0, maxBaseLength).trimEnd() : base;
  return `${truncatedBase}${suffix}`;
}

/**
 * Las 3 comprobaciones previas, en el orden del prompt. Lanza CtaRoleError
 * con el mensaje exacto de qué arreglar si alguna falla. Si pasan las tres
 * pero el servidor ya tiene 200+ roles, no lanza — devuelve un aviso para
 * que quien llama lo muestre (la CTA se crea igual).
 * @param {import('discord.js').Guild} guild
 * @returns {Promise<{ warning: string | null }>}
 */
async function precheckCtaRole(guild) {
  const me = guild.members.me ?? (await guild.members.fetch(guild.client.user.id));

  if (!me.permissions.has(PermissionFlagsBits.ManageRoles)) {
    throw new CtaRoleError(
      'El bot necesita el permiso "Gestionar roles" para crear el rol de la CTA. ' +
        'Dáselo en Ajustes del servidor → Roles.',
    );
  }

  // Un rol nuevo nace en la posición 1 (justo encima de @everyone, que está
  // en la 0). El bot no puede asignar/quitar un rol igual o por encima del
  // suyo, así que su rol más alto tiene que estar por encima de esa posición.
  if (me.roles.highest.position <= 1) {
    throw new CtaRoleError(
      'El rol del bot está demasiado bajo en la jerarquía de roles: un rol nuevo nace justo encima de ' +
        '@everyone (posición 1), y el bot no puede gestionar un rol igual o por encima del suyo. ' +
        'Sube el rol del bot en Ajustes del servidor → Roles.',
    );
  }

  const roleCount = guild.roles.cache.size;
  if (roleCount >= MAX_GUILD_ROLES) {
    throw new CtaRoleError(
      `El servidor ya tiene ${roleCount} roles, el máximo que admite Discord (${MAX_GUILD_ROLES}). ` +
        'Borra roles antiguos a mano antes de crear otra CTA (usa /cta roles para ver cuáles son).',
    );
  }

  const countAfterCreating = roleCount + 1;
  const warning =
    countAfterCreating >= ROLE_WARNING_THRESHOLD
      ? `El servidor tendrá ${countAfterCreating} roles (el máximo de Discord es ${MAX_GUILD_ROLES}). ` +
        'Considera borrar roles de CTA antiguos con /cta roles.'
      : null;

  return { warning };
}

/**
 * Corre las 3 comprobaciones previas y, si pasan, crea el rol propio de la
 * CTA. Nada de esto publica ningún mensaje ni toca cta.json.
 * @param {import('discord.js').Guild} guild
 * @param {string} nombre - nombre de la actividad, ya validado (1-60 caracteres) por quien llama
 * @param {string} ctaId
 * @param {Date} createdAt
 * @returns {Promise<{ roleId: string, roleNombre: string, warning: string | null }>}
 */
export async function crearRolCta(guild, nombre, ctaId, createdAt) {
  const roleName = buildRoleName(nombre, createdAt);
  const { warning } = await precheckCtaRole(guild);

  let role;
  try {
    role = await guild.roles.create({
      name: roleName,
      mentionable: true,
      hoist: false,
      reason: `CTA ${ctaId}`,
    });
  } catch (error) {
    // No sugerir causas: para llegar aquí, precheckCtaRole() YA confirmó que
    // el bot tiene ManageRoles, que su rol está por encima de la posición 1,
    // y que hay cupo. El motivo de este fallo es otro (rate limit, nombre
    // duplicado, algo puntual de la API) — solo mostrar el error real evita
    // mandar a alguien a revisar un permiso que ya sabemos que está bien.
    throw new CtaRoleError(
      `Las comprobaciones previas (permiso, jerarquía, cupo) pasaron, pero Discord rechazó la creación del rol: ${error.message}`,
    );
  }

  return { roleId: role.id, roleNombre: role.name, warning };
}

/**
 * Deshace una creación de CTA que se quedó a medias (el rol ya existe pero
 * el mensaje no se llegó a publicar, o crearCta() rechazó después). Es la
 * ÚNICA función que borra un rol de CTA — el rollback de una creación
 * fallida es la única excepción a "el rol es permanente". Nunca lanza: un
 * fallo al limpiar no debe tapar el error real que se esté reportando.
 * @param {import('discord.js').Guild} guild
 * @param {string} roleId
 */
export async function borrarRolCta(guild, roleId) {
  try {
    await guild.roles.delete(roleId, 'Rollback: la CTA no llegó a crearse');
  } catch (error) {
    console.error(`[cta] No se pudo borrar el rol ${roleId} al deshacer una CTA:`, error?.stack ?? error);
  }
}

/**
 * Cuadra la membresía del rol contra `activa.inscritos`: quien está
 * inscrito y no tiene el rol lo recibe; quien tiene el rol y no está
 * inscrito lo pierde. Arregla de paso a quien se fue del servidor y volvió
 * (sigue en la hoja pero perdió el rol al salir).
 *
 * Hace guild.members.fetch() primero: sin eso, tanto member.roles.cache
 * como role.members pueden estar incompletos (si no está en caché) y la
 * reconciliación daría falsos positivos — de un lado pensaría que a alguien
 * le falta el rol cuando en realidad ya lo tiene, o de dar de baja a quien
 * sí está inscrito. Requiere el intent privilegiado GuildMembers.
 * @param {import('discord.js').Guild} guild
 * @param {object} activa - CTA activa (de ctaActiva())
 * @returns {Promise<{ altas: number, bajas: number, omitidos: number }>}
 */
export async function reconciliarRolCta(guild, activa) {
  if (!activa.roleId) {
    return { altas: 0, bajas: 0, omitidos: 0 };
  }

  await guild.members.fetch();

  const role = await guild.roles.fetch(activa.roleId).catch(() => null);
  if (!role) {
    throw new CtaRoleError(
      `El rol de esta CTA (${activa.roleId}) ya no existe en el servidor — alguien debió de borrarlo a mano.`,
    );
  }

  const inscritoIds = new Set(activa.inscritos.map((i) => i.userId));
  const reason = `CTA ${activa.id} — sync`;

  let altas = 0;
  let bajas = 0;
  let omitidos = 0;

  for (const userId of inscritoIds) {
    const member = guild.members.cache.get(userId);
    if (!member) {
      omitidos++; // se fue del servidor: sigue en la hoja/JSON, pero no hay a quién dar el rol
      continue;
    }
    if (member.roles.cache.has(role.id)) continue; // ya lo tiene: no hace falta la llamada

    try {
      await member.roles.add(role.id, reason);
      altas++;
    } catch (error) {
      console.error(`[cta] No se pudo dar el rol a ${userId} en /cta sync:`, error?.stack ?? error);
      omitidos++;
    }
  }

  for (const member of role.members.values()) {
    if (inscritoIds.has(member.id)) continue;

    try {
      await member.roles.remove(role.id, reason);
      bajas++;
    } catch (error) {
      console.error(`[cta] No se pudo quitar el rol a ${member.id} en /cta sync:`, error?.stack ?? error);
      omitidos++;
    }
  }

  return { altas, bajas, omitidos };
}
