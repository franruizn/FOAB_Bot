// Comprobaciones previas a crear un rol desde el bot: permisos, jerarquía y
// cupo ANTES de tocar nada. Sin dependencia directa de discord.js más allá
// del objeto `guild` que ya trae el propio cliente (duck-typed, testeable
// sin un client real).

const ROLE_LIMIT_WARNING = 200;
const ROLE_LIMIT_MAX = 250;

import { LocalizedError } from '../i18n.js';

/** El bot no puede crear el rol. El texto sale de src/i18n.js (rolePrereq.*). */
export class RolePrerequisiteError extends LocalizedError {
  /**
   * @param {string} key
   * @param {Record<string, string | number>} [values]
   */
  constructor(key, values) {
    super(key, values);
    this.name = 'RolePrerequisiteError';
  }
}

/**
 * El bot necesita "Gestionar roles", su rol tiene que estar por encima de la
 * posición 1 (justo encima de @everyone), y el servidor no puede estar ya en
 * el tope de 250 roles de Discord. No muta nada.
 * @param {import('discord.js').Guild} guild
 * @returns {{ avisoCapacidad: { key: string, values: object } | null }} aviso de cupo, como clave de i18n
 * @throws {RolePrerequisiteError}
 */
export function verificarPrerequisitosDeRol(guild) {
  const me = guild.members.me;
  if (!me?.permissions?.has?.('ManageRoles')) {
    throw new RolePrerequisiteError('rolePrereq.noPermission');
  }

  const posicionBot = me.roles.highest.position;
  if (posicionBot <= 1) {
    throw new RolePrerequisiteError('rolePrereq.tooLow');
  }

  const totalRoles = guild.roles.cache.size;
  if (totalRoles >= ROLE_LIMIT_MAX) {
    throw new RolePrerequisiteError('rolePrereq.limit', { count: totalRoles, max: ROLE_LIMIT_MAX });
  }

  return {
    avisoCapacidad:
      totalRoles >= ROLE_LIMIT_WARNING
        ? { key: 'rolePrereq.nearLimit', values: { count: totalRoles, max: ROLE_LIMIT_MAX } }
        : null,
  };
}
