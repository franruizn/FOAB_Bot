// Comprobaciones previas a crear un rol desde el bot: permisos, jerarquía y
// cupo ANTES de tocar nada. Sin dependencia directa de discord.js más allá
// del objeto `guild` que ya trae el propio cliente (duck-typed, testeable
// sin un client real).

const ROLE_LIMIT_WARNING = 200;
const ROLE_LIMIT_MAX = 250;

export class RolePrerequisiteError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RolePrerequisiteError';
  }
}

/**
 * El bot necesita "Gestionar roles", su rol tiene que estar por encima de la
 * posición 1 (justo encima de @everyone), y el servidor no puede estar ya en
 * el tope de 250 roles de Discord. No muta nada.
 * @param {import('discord.js').Guild} guild
 * @returns {{ avisoCapacidad: string | null }}
 * @throws {RolePrerequisiteError}
 */
export function verificarPrerequisitosDeRol(guild) {
  const me = guild.members.me;
  if (!me?.permissions?.has?.('ManageRoles')) {
    throw new RolePrerequisiteError('El bot no tiene el permiso "Gestionar roles" en este servidor. Actívaselo antes de crear un rol.');
  }

  const posicionBot = me.roles.highest.position;
  if (posicionBot <= 1) {
    throw new RolePrerequisiteError(
      'El rol del bot está demasiado abajo en la jerarquía (tiene que estar por encima de la posición 1, justo ' +
        'encima de @everyone). Sube el rol del bot en Ajustes del servidor -> Roles antes de crear un rol.',
    );
  }

  const totalRoles = guild.roles.cache.size;
  if (totalRoles >= ROLE_LIMIT_MAX) {
    throw new RolePrerequisiteError(
      `El servidor ya tiene ${totalRoles} roles (el máximo de Discord es ${ROLE_LIMIT_MAX}). No se puede crear el rol.`,
    );
  }

  return {
    avisoCapacidad:
      totalRoles >= ROLE_LIMIT_WARNING
        ? `El servidor tiene ${totalRoles} roles, cerca del máximo de ${ROLE_LIMIT_MAX}.`
        : null,
  };
}
