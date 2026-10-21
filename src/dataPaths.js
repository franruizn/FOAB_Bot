import path from 'node:path';

// DATA_DIR es el directorio persistente (montado como volumen en Docker).
// Por defecto "./data" relativo al cwd del proceso, para desarrollo local.
//
// Aquí solo viven las rutas del BOT (no de un servidor). Todo lo que
// pertenece a un servidor de Discord sale de guildStore.rutaDe(guildId, ...),
// nunca de una ruta construida a mano: es por donde se cuelan las fugas
// entre servidores.
export const DATA_DIR = path.resolve(process.env.DATA_DIR || './data');
// Estado de /dm: cooldown y el envío en curso (ver services/massDm.js). Es
// del bot, no de un servidor: DM_OWNER_ID es una sola persona.
export const DM_STATE_PATH = path.join(DATA_DIR, 'dm.json');
