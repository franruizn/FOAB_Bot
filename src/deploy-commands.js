import 'dotenv/config';
import { REST, Routes } from 'discord.js';
import { data as getkillsCommand } from './commands/getkills.js';
import { data as squadsCommand } from './commands/squads.js';
import { data as attendanceCommand } from './commands/attendance.js';
import { data as healthCommand } from './commands/health.js';
import { data as sorteoCommand } from './commands/sorteo.js';
import { data as ctaCommand } from './commands/cta.js';

const VALID_SCOPES = new Set(['guild', 'global', 'clean']);
// Acepta el modo como argumento CLI (para que los scripts de package.json
// sean portables entre shells: "VAR=x node ..." no funciona en cmd.exe de
// Windows) o como env var DEPLOY_SCOPE, en ese orden. Por defecto "guild".
const DEPLOY_SCOPE = process.argv[2] || process.env.DEPLOY_SCOPE || 'guild';

if (!VALID_SCOPES.has(DEPLOY_SCOPE)) {
  throw new Error(`DEPLOY_SCOPE inválido: "${DEPLOY_SCOPE}". Usa: guild | global | clean`);
}

const { DISCORD_TOKEN, CLIENT_ID, GUILD_ID } = process.env;

if (!DISCORD_TOKEN || !CLIENT_ID) {
  throw new Error('Faltan variables de entorno: DISCORD_TOKEN y CLIENT_ID son requeridas');
}

if (DEPLOY_SCOPE !== 'global' && !GUILD_ID) {
  throw new Error(`DEPLOY_SCOPE=${DEPLOY_SCOPE} requiere también GUILD_ID`);
}

const rest = new REST().setToken(DISCORD_TOKEN);

try {
  if (DEPLOY_SCOPE === 'clean') {
    // Borra los comandos de guild. Necesario al pasar de dev (guild) a prod
    // (global): si dejas ambos registrados a la vez, Discord los muestra
    // duplicados en ese servidor.
    console.log(`Borrando los slash commands de guild en el servidor ${GUILD_ID}...`);
    await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: [] });
    console.log('Comandos de guild eliminados.');
  } else {
    const commands = [
      getkillsCommand,
      squadsCommand,
      attendanceCommand,
      healthCommand,
      sorteoCommand,
      ctaCommand,
    ].map((command) => command.toJSON());

    if (DEPLOY_SCOPE === 'guild') {
      console.log(`[dev] Registrando ${commands.length} slash commands en el servidor ${GUILD_ID} (cambios instantáneos)...`);
      await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
      console.log('Comandos registrados en el servidor. Si antes usaste DEPLOY_SCOPE=global aquí, corre "npm run deploy:clean" para no duplicarlos.');
    } else {
      console.log(`[prod] Registrando ${commands.length} slash commands GLOBALES (pueden tardar hasta 1 hora en propagarse)...`);
      await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
      console.log('Comandos globales registrados. Si tenías comandos de guild de desarrollo, corre "npm run deploy:clean" para evitar duplicados.');
    }
  }
} catch (error) {
  console.error('Error registrando comandos:', error);
  process.exitCode = 1;
}
