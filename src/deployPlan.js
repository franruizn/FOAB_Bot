import { InteractionContextType } from 'discord.js';

// Qué se registra dónde, según el modo. Puro (sin red) para poder testearlo;
// deploy-commands.js solo ejecuta el plan.
//
//   global (deploy:prod, el normal): todos los comandos GLOBALES menos /dm, y
//          /dm como comando de guild solo en DM_GUILD_ID (el servidor del
//          dueño). Global, /dm saldría en la lista de todos los servidores
//          y cualquiera que lo probara recibiría un rechazo: ruido, y además
//          enseña que existe. Su acceso sigue siendo DM_OWNER_ID.
//   guild  (deploy:dev): todos, /dm incluido, en GUILD_ID. Instantáneo.
//   clean  (deploy:clean): borra los comandos de guild de GUILD_ID, menos
//          /dm si GUILD_ID es también DM_GUILD_ID.
//
// Un PUT de comandos de guild REEMPLAZA todos los de ese servidor: en
// DM_GUILD_ID, deploy:prod deja solo /dm (y así también limpia los de
// desarrollo si ese servidor era el de pruebas).

const SNOWFLAKE_PATTERN = /^\d{17,20}$/;
export const VALID_SCOPES = new Set(['guild', 'global', 'clean']);

/**
 * @param {{ scope: string, commands: Array<{ toJSON(): object }>, dmCommand: { toJSON(): object }, env: Record<string, string | undefined> }} params
 *   commands: todos menos /dm
 * @returns {{ steps: Array<{ target: 'global' | string, body: object[], label: string }>, warnings: string[] }}
 *   target: 'global' o el id del servidor
 */
export function planDeploy({ scope, commands, dmCommand, env }) {
  if (!VALID_SCOPES.has(scope)) {
    throw new Error(`DEPLOY_SCOPE inválido: "${scope}". Usa: guild | global | clean`);
  }
  const guildId = env.GUILD_ID?.trim() || null;
  const dmGuildId = env.DM_GUILD_ID?.trim() || null;
  if (scope !== 'global' && !guildId) throw new Error(`DEPLOY_SCOPE=${scope} requiere también GUILD_ID`);
  if (dmGuildId && !SNOWFLAKE_PATTERN.test(dmGuildId)) {
    throw new Error(`DM_GUILD_ID no es un id de servidor válido: "${dmGuildId}"`);
  }

  const dmJson = dmCommand.toJSON();
  const warnings = [];

  if (scope === 'guild') {
    return {
      steps: [
        {
          target: guildId,
          body: [...commands.map((command) => command.toJSON()), dmJson],
          label: `[dev] ${commands.length + 1} comandos en el servidor ${guildId} (instantáneo)`,
        },
      ],
      warnings,
    };
  }

  if (scope === 'clean') {
    const keepDm = guildId === dmGuildId;
    return {
      steps: [
        {
          target: guildId,
          body: keepDm ? [dmJson] : [],
          label: keepDm
            ? `Borrando los comandos de guild de ${guildId} (se conserva /dm: es DM_GUILD_ID)`
            : `Borrando los comandos de guild de ${guildId}`,
        },
      ],
      warnings,
    };
  }

  // Global: solo en servidores. Por mensaje directo no hay servidor del que
  // sacar config, squads ni nada (index.js lo rechaza igualmente).
  const globalBody = commands.map((command) => ({ ...command.toJSON(), contexts: [InteractionContextType.Guild] }));
  const steps = [
    {
      target: 'global',
      body: globalBody,
      label: `[prod] ${globalBody.length} comandos GLOBALES (pueden tardar hasta 1 hora en verse en todos los servidores)`,
    },
  ];
  if (dmGuildId) {
    steps.push({ target: dmGuildId, body: [dmJson], label: `/dm como comando de guild en DM_GUILD_ID (${dmGuildId})` });
  } else {
    warnings.push('Falta DM_GUILD_ID: /dm no se registra en ningún servidor.');
  }
  return { steps, warnings };
}
