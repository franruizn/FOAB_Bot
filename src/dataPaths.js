import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { access, mkdir, copyFile } from 'node:fs/promises';

// Fichero semilla horneado en la imagen: solo se usa para poblar un DATA_DIR
// nuevo (primer arranque / volumen vacío). Nunca se lee ni escribe en runtime
// más allá de esa copia inicial.
const SEED_SQUADS_PATH = fileURLToPath(new URL('./config/squads.seed.json', import.meta.url));

// DATA_DIR es el directorio persistente (montado como volumen en Docker).
// Por defecto "./data" relativo al cwd del proceso, para desarrollo local.
export const DATA_DIR = path.resolve(process.env.DATA_DIR || './data');
export const SQUADS_CONFIG_PATH = path.join(DATA_DIR, 'squads.json');
export const RAFFLES_PATH = path.join(DATA_DIR, 'raffles.json');
export const CTA_PATH = path.join(DATA_DIR, 'cta.json');
export const CTA_SHEET_CONFIG_PATH = path.join(DATA_DIR, 'cta-sheet-config.json');

/**
 * Garantiza que DATA_DIR y squads.json existan antes de que el bot atienda
 * ninguna interacción. Si squads.json no existe (volumen recién creado, o
 * DATA_DIR nuevo), lo copia desde el fichero semilla de la imagen y avisa por
 * log — así un redeploy sin volumen montado se nota de inmediato en vez de
 * arrancar en silencio con datos de ejemplo.
 */
export async function ensureSquadsConfig() {
  await mkdir(DATA_DIR, { recursive: true });

  try {
    await access(SQUADS_CONFIG_PATH);
  } catch {
    await copyFile(SEED_SQUADS_PATH, SQUADS_CONFIG_PATH);
    console.warn(
      `[dataPaths] "${SQUADS_CONFIG_PATH}" no existía. Copiado el fichero semilla de la imagen ` +
        `(${SEED_SQUADS_PATH}). Si esperabas los datos reales del gremio, revisa que el volumen ` +
        `de DATA_DIR esté montado correctamente antes de seguir.`,
    );
  }
}
