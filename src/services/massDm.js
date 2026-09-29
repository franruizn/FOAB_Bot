import { escapeMarkdown } from 'discord.js';
import { createMutex, readJsonFile, atomicWriteJson } from './fileStore.js';

// Lógica de /dm separada del comando: construir el mensaje exacto, el envío
// secuencial y el estado persistido (cooldown + envío en curso).
//
// Los DMs masivos son el principal vector de spam en Discord: un par de
// reportes pueden desactivar la aplicación ENTERA. Todo lo de aquí (pausa
// entre envíos, cabecera de atribución no editable, cooldown, sin
// reanudación) existe para no parecerse a ese patrón.

export const DM_MAX_RECIPIENTS = 200;
export const DM_BODY_MAX_LENGTH = 1900;
export const DM_COOLDOWN_MS = 10 * 60_000;
export const DM_SEND_DELAY_MS = 1000;
export const DM_PROGRESS_EVERY = 25;

const DISCORD_MESSAGE_MAX_LENGTH = 2000;
const DM_CLOSED_ERROR_CODE = 50007; // "Cannot send messages to this user"

/**
 * DM_OWNER_ID recortado, o null si falta/está vacío. null = comando
 * DESACTIVADO: falla cerrado, una variable mal puesta nunca abre /dm a nadie.
 * @returns {string | null}
 */
export function getDmOwnerId() {
  const ownerId = (process.env.DM_OWNER_ID ?? '').trim();
  return ownerId.length > 0 ? ownerId : null;
}

/** @returns {string | null} */
export function getDmOptOutRoleId() {
  const roleId = (process.env.DM_OPTOUT_ROLE_ID ?? '').trim();
  return roleId.length > 0 ? roleId : null;
}

function buildHeader(senderName, guildName) {
  return `📨 ${escapeMarkdown(senderName)} te envía este mensaje desde **${escapeMarkdown(guildName)}**:`;
}

function shorten(text, length) {
  return text.length <= length ? text : `${text.slice(0, Math.max(0, length - 1))}…`;
}

/**
 * El mensaje EXACTO que recibe cada destinatario: la cabecera de atribución
 * (que el remitente no controla: sale de su nombre en el servidor y del
 * nombre del servidor) + una línea en blanco + el cuerpo tal cual.
 *
 * Nunca pasa de 2000 caracteres: con un cuerpo de 1900 y un nombre de
 * servidor largo (hasta 100) la cabecera completa no cabe, así que se
 * recortan los NOMBRES (primero el del servidor, luego el del remitente),
 * nunca el cuerpo ni la cabecera en sí.
 * @param {{ senderName: string, guildName: string, body: string }} params
 * @returns {string}
 */
export function buildDmContent({ senderName, guildName, body }) {
  let sender = String(senderName);
  let guild = String(guildName);
  const compose = () => `${buildHeader(sender, guild)}\n\n${body}`;

  while (compose().length > DISCORD_MESSAGE_MAX_LENGTH && guild.length > 1) {
    guild = shorten(guild, guild.length - 1);
  }
  while (compose().length > DISCORD_MESSAGE_MAX_LENGTH && sender.length > 1) {
    sender = shorten(sender, sender.length - 1);
  }
  return compose();
}

/**
 * Manda `content` por DM a cada destinatario, UNO A UNO y con una pausa de
 * `delayMs` entre envíos: abrir 150 canales de DM en ráfaga es justo el
 * patrón que dispara los límites anti-spam de Discord.
 *
 * - Bots: se saltan (no cuentan como envío, sin pausa).
 * - Rol de exclusión (DM_OPTOUT_ROLE_ID): se salta y se reporta.
 * - DMs cerrados (código 50007) u otro fallo: se reporta y se sigue con el
 *   resto, nunca detiene el envío.
 *
 * `onProgress(processed, total)` se llama cada `progressEvery` destinatarios
 * procesados (no en cada uno: editar un mensaje 150 veces es otro rate limit)
 * y nunca en el último — ahí el llamador publica el resultado final.
 * `onSent(member)` se llama tras cada envío correcto (para persistir el
 * avance por si el bot se reinicia a mitad).
 * @param {{
 *   recipients: Array<{ id: string, user: { bot: boolean }, roles?: { cache?: { has: (id: string) => boolean } }, send: (payload: object) => Promise<unknown> }>,
 *   content: string,
 *   optOutRoleId?: string | null,
 *   delayMs?: number,
 *   progressEvery?: number,
 *   sleep?: (ms: number) => Promise<void>,
 *   onProgress?: (processed: number, total: number) => Promise<void> | void,
 *   onSent?: (member: object) => Promise<void> | void,
 * }} params
 * @returns {Promise<{ sent: string[], dmClosed: string[], failed: string[], optedOut: string[], bots: string[] }>} ids de usuario
 */
export async function sendMassDm({
  recipients,
  content,
  optOutRoleId = null,
  delayMs = DM_SEND_DELAY_MS,
  progressEvery = DM_PROGRESS_EVERY,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  onProgress = () => {},
  onSent = () => {},
}) {
  const result = { sent: [], dmClosed: [], failed: [], optedOut: [], bots: [] };
  let attempts = 0;

  for (let i = 0; i < recipients.length; i++) {
    const member = recipients[i];

    if (member.user.bot) {
      result.bots.push(member.id);
    } else if (optOutRoleId && member.roles?.cache?.has(optOutRoleId)) {
      result.optedOut.push(member.id);
    } else {
      if (attempts > 0) await sleep(delayMs);
      attempts++;
      try {
        await member.send({ content, allowedMentions: { parse: [] } });
        result.sent.push(member.id);
        await onSent(member);
      } catch (error) {
        if (error?.code === DM_CLOSED_ERROR_CODE) {
          result.dmClosed.push(member.id);
        } else {
          console.error(`[dm] No se pudo mandar el DM a ${member.id}:`, error?.message ?? error);
          result.failed.push(member.id);
        }
      }
    }

    const processed = i + 1;
    if (processed % progressEvery === 0 && processed < recipients.length) {
      try {
        await onProgress(processed, recipients.length);
      } catch (error) {
        // Un fallo al editar el progreso nunca debe cortar el envío.
        console.error('[dm] No se pudo actualizar el progreso:', error?.message ?? error);
      }
    }
  }

  return result;
}

// --- Estado persistido (DATA_DIR/dm.json) ---
//
// { lastStartedAt: number | null, inProgress: null | { startedAt, actorId,
//   actorTag, total, sentIds: string[] } }
//
// lastStartedAt alimenta el cooldown (y sobrevive a un reinicio: reiniciar
// el bot no es una forma de saltárselo). inProgress existe mientras dura un
// envío; si al arrancar sigue ahí, el envío se cortó a mitad — se avisa en
// el canal de logs con cuántos se mandaron y se BORRA, nunca se reanuda:
// reenviar duplicados a quien ya lo recibió es peor que no enviar.

const DEFAULT_STATE = { lastStartedAt: null, inProgress: null };
const { withWriteLock, waitForPendingWrites } = createMutex();

export const waitForPendingDmWrites = waitForPendingWrites;

export async function loadDmState(filePath) {
  return { ...DEFAULT_STATE, ...(await readJsonFile(filePath, DEFAULT_STATE)) };
}

function mutateDmState(filePath, mutateFn) {
  return withWriteLock(async () => {
    const current = await loadDmState(filePath);
    const { next, result } = mutateFn(current);
    if (next) await atomicWriteJson(filePath, next);
    return result;
  });
}

/**
 * Motivo por el que ahora mismo NO se puede empezar un /dm, o null si se
 * puede. Solo lectura: la comprobación que cuenta es la de tryStartDmSend().
 * @returns {{ reason: 'in-progress' } | { reason: 'cooldown', remainingMs: number } | null}
 */
export function dmBlockReason(state, now = Date.now()) {
  if (state.inProgress) return { reason: 'in-progress' };
  if (state.lastStartedAt && now - state.lastStartedAt < DM_COOLDOWN_MS) {
    return { reason: 'cooldown', remainingMs: DM_COOLDOWN_MS - (now - state.lastStartedAt) };
  }
  return null;
}

/**
 * Comprueba y reserva el envío en una sola operación bajo el mutex: dos
 * confirmaciones casi simultáneas (dos /dm abiertos a la vez, doble clic)
 * no pueden pasar las dos.
 * @returns {Promise<ReturnType<typeof dmBlockReason>>} null si se reservó
 */
export function tryStartDmSend(filePath, { actorId, actorTag, total }, now = Date.now()) {
  return mutateDmState(filePath, (state) => {
    const blocked = dmBlockReason(state, now);
    if (blocked) return { next: null, result: blocked };
    return {
      next: { ...state, lastStartedAt: now, inProgress: { startedAt: now, actorId, actorTag, total, sentIds: [] } },
      result: null,
    };
  });
}

export function recordDmSent(filePath, userId) {
  return mutateDmState(filePath, (state) => {
    if (!state.inProgress) return { next: null, result: undefined };
    return {
      next: { ...state, inProgress: { ...state.inProgress, sentIds: [...state.inProgress.sentIds, userId] } },
      result: undefined,
    };
  });
}

export function finishDmSend(filePath) {
  return mutateDmState(filePath, (state) => ({ next: { ...state, inProgress: null }, result: undefined }));
}

/**
 * Al arrancar: si quedó un envío a medias, lo devuelve y lo borra del estado
 * (el cooldown se conserva). NO lo reanuda.
 * @returns {Promise<null | { startedAt: number, actorId: string, actorTag: string, total: number, sentIds: string[] }>}
 */
export function takeInterruptedDmSend(filePath) {
  return mutateDmState(filePath, (state) => {
    if (!state.inProgress) return { next: null, result: null };
    return { next: { ...state, inProgress: null }, result: state.inProgress };
  });
}
