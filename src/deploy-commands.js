import 'dotenv/config';
import { REST, Routes } from 'discord.js';
import { data as getkillsCommand } from './commands/getkills.js';
import { data as squadsCommand } from './commands/squads.js';
import { data as attendanceCommand } from './commands/attendance.js';
import { data as healthCommand } from './commands/health.js';
import { data as sorteoCommand } from './commands/sorteo.js';
import { data as crearRolCommand } from './commands/crearRol.js';
import { data as dmCommand } from './commands/dm.js';
import { data as configCommand } from './commands/config.js';
import { planDeploy } from './deployPlan.js';

// Acepta el modo como argumento CLI (para que los scripts de package.json
// sean portables entre shells: "VAR=x node ..." no funciona en cmd.exe de
// Windows) o como env var DEPLOY_SCOPE, en ese orden. Por defecto "guild".
// Qué se registra dónde en cada modo: ver deployPlan.js.
const DEPLOY_SCOPE = process.argv[2] || process.env.DEPLOY_SCOPE || 'guild';

const { DISCORD_TOKEN, CLIENT_ID } = process.env;

if (!DISCORD_TOKEN || !CLIENT_ID) {
  throw new Error('Faltan variables de entorno: DISCORD_TOKEN y CLIENT_ID son requeridas');
}

const { steps, warnings } = planDeploy({
  scope: DEPLOY_SCOPE,
  commands: [getkillsCommand, squadsCommand, attendanceCommand, healthCommand, sorteoCommand, crearRolCommand, configCommand],
  dmCommand,
  env: process.env,
});
for (const warning of warnings) console.warn(`⚠️ ${warning}`);

const rest = new REST().setToken(DISCORD_TOKEN);

try {
  for (const { target, body, label } of steps) {
    console.log(`${label}...`);
    const route = target === 'global' ? Routes.applicationCommands(CLIENT_ID) : Routes.applicationGuildCommands(CLIENT_ID, target);
    await rest.put(route, { body });
  }
  console.log('Hecho.');
  if (DEPLOY_SCOPE === 'global') {
    console.log(
      'Si el servidor de desarrollo (GUILD_ID) tenía comandos de guild y no es DM_GUILD_ID, corre "npm run deploy:clean" o saldrán duplicados.',
    );
  } else if (DEPLOY_SCOPE === 'guild') {
    console.log('Si también hay comandos globales registrados, en este servidor saldrán duplicados: "npm run deploy:clean" al terminar.');
  }
} catch (error) {
  console.error('Error registrando comandos:', error);
  process.exitCode = 1;
}
