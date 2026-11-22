// Cuándo toca el informe semanal de strikes. Puro (sin discord.js ni disco).
//
// En config.json va como texto: "strikeReport": "monday 12". La hora se
// interpreta en la zona horaria del proceso (TZ).
//
// Las citas se calculan siempre por CALENDARIO (mismo día de la semana, misma
// hora), nunca sumando 604.800.000 ms: las semanas del cambio de hora duran
// una hora más o menos, y sumar ms movería el informe a las 11 o a las 13.

// En el orden de Date#getDay().
export const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

const SCHEDULE_PATTERN = new RegExp(`^(${WEEKDAYS.join('|')}) (\\d{1,2})$`);

/**
 * @param {unknown} value - "monday 12"
 * @returns {{ day: number, hour: number, dayName: string } | null} null si está apagado o no es válido
 */
export function parseSchedule(value) {
  if (typeof value !== 'string') return null;
  const match = value.match(SCHEDULE_PATTERN);
  if (!match) return null;
  const hour = Number(match[2]);
  if (hour > 23) return null;
  return { day: WEEKDAYS.indexOf(match[1]), hour, dayName: match[1] };
}

/**
 * La última cita que ya ha llegado (<= nowMs) y la siguiente (> nowMs).
 * @param {number} nowMs
 * @param {{ day: number, hour: number }} schedule
 * @returns {{ previous: number, next: number }}
 */
export function slotsAround(nowMs, { day, hour }) {
  const now = new Date(nowMs);
  const year = now.getFullYear();
  const month = now.getMonth();
  // new Date() normaliza los días fuera de rango (día 0, día 35...).
  const slotAt = (date) => new Date(year, month, date, hour, 0, 0, 0).getTime();

  let date = now.getDate() + (day - now.getDay());
  if (slotAt(date) > nowMs) date -= 7;
  return { previous: slotAt(date), next: slotAt(date + 7) };
}

/**
 * ¿Hay una cita pasada sin informe? Las citas anteriores a `enabledAt` (cuando
 * se fijó este horario) no cuentan: activar el informe un martes para "los
 * lunes" no debe mandar uno atrasado en el siguiente reinicio.
 * @param {number} nowMs
 * @param {{ day: number, hour: number }} schedule
 * @param {string | null | undefined} lastReportAt
 * @param {string | null | undefined} enabledAt
 * @returns {number | null} la cita pendiente, o null si no hay ninguna
 */
export function overdueSlot(nowMs, schedule, lastReportAt, enabledAt) {
  const { previous } = slotsAround(nowMs, schedule);
  const covered = Math.max(Date.parse(lastReportAt ?? '') || 0, Date.parse(enabledAt ?? '') || 0);
  return previous > covered ? previous : null;
}
