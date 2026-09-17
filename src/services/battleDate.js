/**
 * Fecha a mostrar en el embed: la del evento más antiguo (inicio aproximado
 * de la batalla). Si no hay eventos, se usa la hora actual como fallback.
 * @param {object[]} events - eventos de kill devueltos por albionApi.getBattleEvents
 * @returns {Date}
 */
export function resolveBattleDate(events) {
  const earliest = events.reduce((acc, event) => {
    const eventDate = new Date(event.TimeStamp);
    return acc === null || eventDate < acc ? eventDate : acc;
  }, null);
  return earliest ?? new Date();
}
