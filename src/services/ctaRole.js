// Crea el rol de Discord de una CTA: comprobaciones de permisos/jerarquía/
// cupo ANTES de tocar nada, nombre "<nombre>_<ddMM-HHmm>" en la zona horaria
// del servidor del bot, y un sufijo incremental si dos CTAs caen en el
// mismo minuto. Sin dependencia directa de discord.js más allá del objeto
// `guild` que ya trae el propio cliente (duck-typed, testeable sin un
// client real).

const ROLE_NAME_MAX_LENGTH = 100; // límite real de Discord para el nombre de un rol
const ROLE_LIMIT_WARNING = 200;
const ROLE_LIMIT_MAX = 250;

export class CtaRoleError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CtaRoleError';
  }
}

function contieneMencionMasiva(texto) {
  const normalizado = String(texto ?? '').toLowerCase();
  return normalizado.includes('@everyone') || normalizado.includes('@here');
}

/**
 * dd/MM-HH:mm en la zona horaria del servidor del bot: EMBOS_TZ si está
 * definida, si no la zona local del proceso (nunca UTC a propósito, para
 * que la hora del nombre coincida con la que vio el oficial al lanzarlo).
 */
function formatearSufijoFecha(fecha) {
  const timeZone = process.env.EMBOS_TZ || undefined;
  const partes = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(fecha);

  const valor = (tipo) => partes.find((p) => p.type === tipo)?.value ?? '00';
  return `${valor('day')}${valor('month')}-${valor('hour')}${valor('minute')}`;
}

/**
 * Genera "<nombreCta>_<ddMM-HHmm>", recortando el nombre libre si el total
 * pasa de 100 caracteres SIN tocar nunca el sufijo, y añadiendo "-N" si ya
 * existe un rol con ese nombre exacto en el servidor (dos CTAs en el mismo
 * minuto, o en canales distintos: ya no es hipotético con varias CTAs a la
 * vez).
 * @param {{ roles: { cache: { some: (fn: (r: {name: string}) => boolean) => boolean } } }} guild
 * @param {string} nombreCta
 * @param {Date} fecha
 * @returns {string}
 */
export function generarNombreDeRolUnico(guild, nombreCta, fecha) {
  const sufijoFecha = `_${formatearSufijoFecha(fecha)}`;

  for (let intento = 0; ; intento++) {
    const sufijoExtra = intento === 0 ? '' : `-${intento + 1}`;
    const sufijoTotal = `${sufijoFecha}${sufijoExtra}`;
    const maxBase = Math.max(0, ROLE_NAME_MAX_LENGTH - sufijoTotal.length);
    const base = nombreCta.length > maxBase ? nombreCta.slice(0, maxBase) : nombreCta;
    const candidato = `${base}${sufijoTotal}`;

    if (!guild.roles.cache.some((r) => r.name === candidato)) {
      return candidato;
    }
  }
}

/**
 * Comprobaciones previas a crear CUALQUIER rol de CTA: el bot necesita
 * "Gestionar roles", su rol tiene que estar por encima de la posición 1
 * (justo encima de @everyone), y el servidor no puede estar ya en el tope
 * de 250 roles de Discord. No muta nada.
 * @param {import('discord.js').Guild} guild
 * @returns {{ avisoCapacidad: string | null }}
 * @throws {CtaRoleError}
 */
export function verificarPrerequisitosDeRol(guild) {
  const me = guild.members.me;
  if (!me?.permissions?.has?.('ManageRoles')) {
    throw new CtaRoleError('El bot no tiene el permiso "Gestionar roles" en este servidor. Actívaselo antes de abrir una CTA.');
  }

  const posicionBot = me.roles.highest.position;
  if (posicionBot <= 1) {
    throw new CtaRoleError(
      'El rol del bot está demasiado abajo en la jerarquía (tiene que estar por encima de la posición 1, justo ' +
        'encima de @everyone). Sube el rol del bot en Ajustes del servidor -> Roles antes de abrir una CTA.',
    );
  }

  const totalRoles = guild.roles.cache.size;
  if (totalRoles >= ROLE_LIMIT_MAX) {
    throw new CtaRoleError(
      `El servidor ya tiene ${totalRoles} roles (el máximo de Discord es ${ROLE_LIMIT_MAX}). No se puede crear el rol de la CTA.`,
    );
  }

  return {
    avisoCapacidad:
      totalRoles >= ROLE_LIMIT_WARNING
        ? `El servidor tiene ${totalRoles} roles, cerca del máximo de ${ROLE_LIMIT_MAX}.`
        : null,
  };
}

/**
 * Verifica prerequisitos y crea el rol de una CTA: mentionable (es el único
 * motivo por el que existe: poder mencionar de golpe a todos los
 * apuntados), sin hoist (no se lista aparte en la lista de miembros).
 * @param {import('discord.js').Guild} guild
 * @param {{ nombreCta: string, fecha?: Date }} params
 * @returns {Promise<{ role: import('discord.js').Role, avisoCapacidad: string | null }>}
 * @throws {CtaRoleError}
 */
export async function crearRolDeCta(guild, { nombreCta, fecha = new Date() }) {
  if (contieneMencionMasiva(nombreCta)) {
    throw new CtaRoleError('El nombre de la CTA no puede contener "@everyone" ni "@here".');
  }

  const { avisoCapacidad } = verificarPrerequisitosDeRol(guild);
  const nombreRol = generarNombreDeRolUnico(guild, nombreCta, fecha);

  const role = await guild.roles.create({
    name: nombreRol,
    mentionable: true,
    hoist: false,
    reason: `CTA "${nombreCta}"`,
  });

  return { role, avisoCapacidad };
}

/**
 * Reconcilia el rol de Discord de una CTA ABIERTA contra quién está
 * inscrito AHORA MISMO en cta.json: se lo da a quien lo perdió (o nunca lo
 * recibió — p.ej. si roles.add() falló al apuntarse y nadie hizo /cta ping)
 * y se lo quita a quien ya no está apuntado (salió y roles.remove() falló
 * en su momento). Pensado para /cta sync bajo demanda; nunca se llama
 * automáticamente ni por temporizador — es una reconciliación puntual, no
 * un polling.
 *
 * Requiere el intent PRIVILEGIADO GuildMembers (`guild.members.fetch()` sin
 * argumentos, para saber con certeza quién tiene el rol ahora, no solo lo
 * que el caché ya conociera). Actívalo en el Developer Portal del bot
 * ("Server Members Intent") si no lo está ya — sin él, esta llamada falla.
 * @param {import('discord.js').Guild} guild
 * @param {object} cta - la CTA activa (con roleId e inscritos)
 * @returns {Promise<{ otorgados: string[], quitados: string[], fallos: Array<{ userId: string, accion: 'otorgar' | 'quitar', error: unknown }> }>}
 */
export async function reconciliarRolDeCta(guild, cta) {
  if (!cta.roleId) {
    return { otorgados: [], quitados: [], fallos: [] };
  }

  await guild.members.fetch();

  const role = guild.roles.cache.get(cta.roleId);
  if (!role) {
    return { otorgados: [], quitados: [], fallos: [] };
  }

  const deberianTenerlo = new Set(cta.inscritos.map((i) => i.userId));
  const tienenAhora = new Set(role.members.keys());

  const otorgados = [];
  const quitados = [];
  const fallos = [];

  async function resolverMiembro(userId) {
    return guild.members.cache.get(userId) ?? guild.members.fetch(userId);
  }

  for (const userId of deberianTenerlo) {
    if (tienenAhora.has(userId)) continue;
    try {
      const member = await resolverMiembro(userId);
      await member.roles.add(cta.roleId, `Reconciliación /cta sync de "${cta.nombre}"`);
      otorgados.push(userId);
    } catch (error) {
      fallos.push({ userId, accion: 'otorgar', error });
    }
  }

  for (const userId of tienenAhora) {
    if (deberianTenerlo.has(userId)) continue;
    try {
      const member = await resolverMiembro(userId);
      await member.roles.remove(cta.roleId, `Reconciliación /cta sync de "${cta.nombre}"`);
      quitados.push(userId);
    } catch (error) {
      fallos.push({ userId, accion: 'quitar', error });
    }
  }

  return { otorgados, quitados, fallos };
}
