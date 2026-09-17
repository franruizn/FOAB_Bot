// Agrupa disparos repetidos bajo la misma clave en UNA sola ejecución,
// transcurrida `windowMs` desde el ÚLTIMO disparo de esa clave (debounce
// clásico, no throttle). Pensado para reeditar el embed de una CTA tras una
// ráfaga de altas/bajas sin gastar una edición de Discord por cada una.

/**
 * @param {number} windowMs
 */
export function createDebouncer(windowMs) {
  const timers = new Map(); // key -> Timeout
  const pending = new Map(); // key -> fn (la última función registrada para esa key gana)

  async function runNow(key) {
    const timer = timers.get(key);
    if (timer) clearTimeout(timer);
    timers.delete(key);

    const fn = pending.get(key);
    pending.delete(key);
    if (!fn) return;

    try {
      await fn();
    } catch (error) {
      console.error(`[debounce] Error ejecutando tarea agrupada (key="${key}"):`, error?.stack ?? error);
    }
  }

  /**
   * Registra `fn` para `key`. Si ya había una tarea pendiente para esa
   * misma key, la reemplaza (la más reciente gana) y reinicia la ventana.
   */
  function trigger(key, fn) {
    pending.set(key, fn);
    const existing = timers.get(key);
    if (existing) clearTimeout(existing);
    timers.set(
      key,
      setTimeout(() => runNow(key), windowMs),
    );
  }

  /**
   * Ejecuta YA la tarea pendiente de `key` (si hay alguna) y cancela su
   * temporizador, sin esperar a que venza la ventana.
   */
  function flush(key) {
    return runNow(key);
  }

  /**
   * Igual que flush(), para todas las keys con algo pendiente. Pensado para
   * el shutdown: no dejar una reedición a medias al cerrar el proceso.
   */
  function flushAll() {
    return Promise.all([...timers.keys()].map((key) => runNow(key)));
  }

  /**
   * Descarta la tarea pendiente de `key` sin ejecutarla. Para cuando otra
   * edición más autoritativa (p.ej. el cierre de una CTA) va a escribir
   * el mismo recurso ya mismo: sin esto, la reedición agrupada podría
   * dispararse justo después y pisar ese resultado final.
   */
  function cancel(key) {
    const timer = timers.get(key);
    if (timer) clearTimeout(timer);
    timers.delete(key);
    pending.delete(key);
  }

  return { trigger, flush, flushAll, cancel };
}
