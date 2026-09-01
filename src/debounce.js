/**
 * Agrupador genérico por clave: tras trigger(key, task), espera `delayMs`
 * antes de ejecutar `task`. Si trigger() se vuelve a llamar con la MISMA
 * key antes de que pase ese tiempo, la espera se REINICIA (debounce
 * clásico, no throttle) y se queda con el `task` más reciente — así nunca
 * se ejecuta con un estado intermedio, solo con el último.
 *
 * Se usa tanto para agrupar la reedición del embed de /cta (ctaEmbedSync.js)
 * como para agrupar la escritura del bloque en la hoja (ctaSheetSync.js):
 * mismo mecanismo, dos usos distintos.
 * @param {number} delayMs
 */
export function createDebouncer(delayMs) {
  const pending = new Map(); // key -> { timer, run }

  function trigger(key, task) {
    const existing = pending.get(key);
    if (existing) clearTimeout(existing.timer);

    const entry = { run: task };
    entry.timer = setTimeout(() => {
      pending.delete(key);
      Promise.resolve()
        .then(entry.run)
        .catch((error) => {
          console.error(`[debounce] Error ejecutando tarea agrupada (key="${key}"):`, error?.stack ?? error);
        });
    }, delayMs);

    pending.set(key, entry);
  }

  function has(key) {
    return pending.has(key);
  }

  function cancel(key) {
    const existing = pending.get(key);
    if (!existing) return;
    clearTimeout(existing.timer);
    pending.delete(key);
  }

  /**
   * Ejecuta YA la tarea pendiente de `key` (si hay una esperando) y espera
   * a que termine. No-op si no hay nada pendiente.
   */
  async function flush(key) {
    const existing = pending.get(key);
    if (!existing) return;
    clearTimeout(existing.timer);
    pending.delete(key);
    await existing.run();
  }

  async function flushAll() {
    await Promise.all([...pending.keys()].map((key) => flush(key)));
  }

  return { trigger, has, cancel, flush, flushAll };
}
