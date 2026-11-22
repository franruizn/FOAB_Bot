// Proceso hijo del test de "matar durante una escritura": escribe strikes sin
// parar hasta que lo maten. Avisa cuando ya ha hecho unas cuantas escrituras,
// para que exista un backup que comprobar.
const { addStrike } = await import('../services/strikesStore.js');

const guildId = process.argv[2];
const reason = 'x'.repeat(200);
for (let written = 1; ; written++) {
  await addStrike(guildId, { userId: '100000000000000002', userName: 'n', reason, addedBy: '100000000000000001' });
  if (written === 3) process.send('ready');
}
