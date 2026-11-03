import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildRaffleAnnouncementContent,
  buildRaffleResultsEmbed,
  buildNoParticipantsEmbed,
  buildRaffleWinnersContent,
  buildRaffleMessageEmbed,
} from './raffleEmbed.js';

// Los textos esperados son los de un servidor en español (lang: 'es'); los
// mensajes del sorteo son públicos y siguen el idioma del servidor.

// ============================================================
// buildRaffleAnnouncementContent()
// ============================================================

test('buildRaffleAnnouncementContent(): sin rol y sin RAFFLE_ROLE_ID, comportamiento idéntico al actual', () => {
  const content = buildRaffleAnnouncementContent({ lang: 'es', creatorId: 'creator-1', endsAtUnixSeconds: 123, roleId: null, requiredRoleId: null });
  assert.equal(content, '<@creator-1> ha comenzado un sorteo que terminará <t:123:R>.\n\nReacciona con 🎉 para participar.');
});

test('buildRaffleAnnouncementContent(): sin rol pero con RAFFLE_ROLE_ID, mantiene el ping delante (comportamiento actual)', () => {
  const content = buildRaffleAnnouncementContent({ lang: 'es', creatorId: 'creator-1', endsAtUnixSeconds: 123, roleId: 'raffle-role', requiredRoleId: null });
  assert.equal(content, '<@&raffle-role> <@creator-1> ha comenzado un sorteo que terminará <t:123:R>.\n\nReacciona con 🎉 para participar.');
});

test('buildRaffleAnnouncementContent(): con rol restrictivo, menciona solo ESE rol (nunca RAFFLE_ROLE_ID) y explica el requisito', () => {
  const content = buildRaffleAnnouncementContent({
    lang: 'es',
    creatorId: 'creator-1',
    endsAtUnixSeconds: 123,
    roleId: 'raffle-role',
    requiredRoleId: 'party-role',
  });
  assert.equal(
    content,
    '<@&party-role> <@creator-1> ha comenzado un sorteo que terminará <t:123:R>.\n\n' +
      'Reacciona con 🎉 para participar (solo miembros de <@&party-role>).',
  );
  assert.doesNotMatch(content, /raffle-role/, 'no debe pingear el rol de RAFFLE_ROLE_ID cuando hay un rol restrictivo');
});

// ============================================================
// buildRaffleResultsEmbed(): footer con el conteo de reaccionados vs válidos
// ============================================================

test('buildRaffleResultsEmbed(): sin descartes (o sin rol), el footer se comporta como antes', () => {
  const results = [
    { user: { id: 'p1' }, roll: 90 },
    { user: { id: 'p2' }, roll: 50 },
  ];
  const embed = buildRaffleResultsEmbed({ lang: 'es', results, totalReactors: 2 }).toJSON();
  assert.equal(embed.footer.text, 'Tiradas 1–100', 'con <=5 participantes y sin descartes, no añade conteo');
});

test('buildRaffleResultsEmbed(): con más de 5 participantes y sin descartes, muestra el conteo simple (comportamiento actual)', () => {
  const results = Array.from({ length: 7 }, (_, i) => ({ user: { id: `p${i}` }, roll: 100 - i }));
  const embed = buildRaffleResultsEmbed({ lang: 'es', results, totalReactors: 7 }).toJSON();
  assert.equal(embed.footer.text, 'Tiradas 1–100 · 7 participantes');
});

test('buildRaffleResultsEmbed(): con descartes por rol, el footer dice "X de Y participantes válidos"', () => {
  const results = [
    { user: { id: 'p1' }, roll: 90 },
    { user: { id: 'p2' }, roll: 50 },
  ];
  const embed = buildRaffleResultsEmbed({ lang: 'es', results, totalReactors: 5 }).toJSON();
  assert.equal(embed.footer.text, 'Tiradas 1–100 · 2 de 5 participantes válidos');
});

// ============================================================
// buildNoParticipantsEmbed()
// ============================================================

test('buildNoParticipantsEmbed(): sin argumentos, "Nadie participó." (comportamiento actual)', () => {
  const embed = buildNoParticipantsEmbed({ lang: 'es' }).toJSON();
  assert.equal(embed.description, 'Nadie participó.');
});

test('buildNoParticipantsEmbed(): hubo reacciones pero ninguna cumplía el rol, lo distingue de un sorteo vacío', () => {
  const embed = buildNoParticipantsEmbed({ lang: 'es', totalReactors: 3 }).toJSON();
  assert.match(embed.description, /3 personas reaccionaron, pero ninguna tenía el rol requerido/);
  assert.doesNotMatch(embed.description, /^Nadie participó\.$/);
});

test('buildNoParticipantsEmbed(): con una sola reacción, el singular es su propia frase (no "persona(s)")', () => {
  assert.equal(
    buildNoParticipantsEmbed({ lang: 'es', totalReactors: 1 }).toJSON().description,
    '1 persona reaccionó, pero no tenía el rol requerido para participar.',
  );
  assert.equal(
    buildNoParticipantsEmbed({ lang: 'en', totalReactors: 1 }).toJSON().description,
    '1 person reacted, but they did not have the role required to take part.',
  );
});

test('buildNoParticipantsEmbed(): rol borrado antes de resolver, lo explica sin importar cuántos reaccionaron', () => {
  const embed = buildNoParticipantsEmbed({ lang: 'es', totalReactors: 4, roleMissing: true }).toJSON();
  assert.match(embed.description, /el rol requerido para este sorteo ya no existe/i);
});

test('buildNoParticipantsEmbed(): delayed añade la nota de retraso además del motivo', () => {
  const embed = buildNoParticipantsEmbed({ lang: 'es', delayed: true, totalReactors: 2 }).toJSON();
  assert.match(embed.description, /ninguna tenía el rol requerido/);
  assert.match(embed.description, /se resolvió con retraso/);
});

// ============================================================
// Mensaje y varios ganadores
// ============================================================

test('buildRaffleAnnouncementContent(): un ganador y sin mensaje, el texto de siempre', () => {
  const base = { lang: 'es', creatorId: 'creator-1', endsAtUnixSeconds: 123, roleId: null, requiredRoleId: null };
  assert.equal(buildRaffleAnnouncementContent({ ...base, winners: 1, message: null }), buildRaffleAnnouncementContent(base));
});

test('buildRaffleMessageEmbed(): el mensaje va solo, en su propio field', () => {
  assert.deepEqual(buildRaffleMessageEmbed({ lang: 'es', message: 'Premio: **T8** [info](https://example.com)' }).toJSON().fields, [
    { name: 'Mensaje', value: 'Premio: **T8** [info](https://example.com)' },
  ]);
});

test('field del mensaje: un número impar de ``` se cierra; uno par se deja como está', () => {
  const field = (message) => buildRaffleMessageEmbed({ lang: 'es', message }).toJSON().fields[0].value;
  assert.equal(field('Premio: ```montura'), 'Premio: ```montura\n```');
  assert.equal(field('```a``` y ```b'), '```a``` y ```b\n```');
  assert.equal(field('```bloque```'), '```bloque```');

  const results = buildRaffleResultsEmbed({ lang: 'es', results: [{ user: { id: 'a' }, roll: 5 }], message: '```roto' }).toJSON();
  assert.equal(results.fields[0].value, '```roto\n```', 'mismo tratamiento en el embed de resultados');
});

test('buildRaffleResultsEmbed(): con un ganador el embed es el de siempre; el mensaje solo añade un field delante', () => {
  const results = [
    { user: { id: 'p1' }, roll: 90 },
    { user: { id: 'p2' }, roll: 50 },
  ];
  const before = buildRaffleResultsEmbed({ lang: 'es', results, totalReactors: 2 }).toJSON();
  assert.equal(before.description, '🥇 **Ganador: <@p1> con una tirada de 90!**');
  assert.deepEqual(before.fields.map((f) => f.name), ['ROLLS']);

  const withMessage = buildRaffleResultsEmbed({ lang: 'es', results, totalReactors: 2, winners: 1, message: 'Premio' }).toJSON();
  assert.deepEqual(withMessage.fields, [{ name: 'Mensaje', value: 'Premio' }, ...before.fields]);
  assert.equal(withMessage.description, before.description);
});

test('buildRaffleResultsEmbed(): con varios, "N ganadores" con medallas en los tres primeros y número desde el cuarto', () => {
  const results = Array.from({ length: 6 }, (_, i) => ({ user: { id: `p${i + 1}` }, roll: 90 - i }));
  const embed = buildRaffleResultsEmbed({ lang: 'es', results, totalReactors: 6, winners: 4 }).toJSON();
  assert.equal(
    embed.description,
    '🏆 **4 ganadores**\n🥇 <@p1> — `90`\n🥈 <@p2> — `89`\n🥉 <@p3> — `88`\n**4.** <@p4> — `87`',
  );
  assert.match(embed.fields[0].value, /\*\*5\.\*\* <@p5> — `86`\n\*\*6\.\*\* <@p6> — `85`$/);
  assert.equal(embed.footer.text, 'Tiradas 1–100 · 6 participantes');
});

test('buildRaffleResultsEmbed(): 20 ganadores y 200 participantes, el field incluye a todos los ganadores y corta por líneas', () => {
  const results = Array.from({ length: 200 }, (_, i) => ({ user: { id: String(1_000_000_000_000_000_000n + BigInt(i)) }, roll: 100 - (i % 100) }));
  const embed = buildRaffleResultsEmbed({ lang: 'es', results, totalReactors: 200, winners: 20 }).toJSON();
  const value = embed.fields.at(-1).value;
  assert.ok(value.length <= 1024, `field de ${value.length} caracteres`);
  for (const winner of results.slice(0, 20)) assert.ok(value.includes(`<@${winner.user.id}>`), `falta el ganador ${winner.user.id}`);
  const lines = value.split('\n');
  assert.match(lines.at(-1), /^… y \d+ participantes más$/);
  for (const line of lines.slice(0, -1)) assert.match(line, /<@\d+> — `\d+`$/, `línea cortada: ${line}`);
  const shown = lines.length - 1;
  assert.equal(Number(lines.at(-1).match(/\d+/)[0]), 200 - shown, 'el "y N más" cuadra con los que no salen');
});

test('buildRaffleResultsEmbed(): menos participantes que puestos lo dice, en singular y plural', () => {
  const two = buildRaffleResultsEmbed({ lang: 'es', results: [{ user: { id: 'a' }, roll: 5 }, { user: { id: 'b' }, roll: 3 }], winners: 3 }).toJSON();
  assert.match(two.description, /3 ganadores de 2 participantes: ganan todos\./);
  const one = buildRaffleResultsEmbed({ lang: 'es', results: [{ user: { id: 'a' }, roll: 5 }], winners: 3 }).toJSON();
  assert.match(one.description, /^🏆 \*\*1 ganador\*\*/);
  assert.match(one.description, /3 ganadores de 1 participante: gana el único\./);
});

test('buildRaffleResultsEmbed(): el desempate dice entre quiénes y por qué puesto', () => {
  const results = [
    { user: { id: 'a' }, roll: 90 },
    { user: { id: 'c' }, roll: 70 },
    { user: { id: 'b' }, roll: 70 },
    { user: { id: 'd' }, roll: 70 },
  ];
  const participants = [results[2], results[1], results[3]];
  const last = buildRaffleResultsEmbed({
    lang: 'es',
    results,
    winners: 2,
    tiebreak: { roll: 70, participants, slots: 1, rounds: 1, random: false },
  }).toJSON();
  assert.match(last.description, /⚖️ Desempate entre <@b>, <@c> y <@d> por el último puesto \(empate a \*\*70\*\*\)\. Resuelto con una nueva tirada entre ellos\./);

  const places = buildRaffleResultsEmbed({
    lang: 'en',
    results,
    winners: 3,
    tiebreak: { roll: 70, participants, slots: 2, rounds: 10, random: true },
  }).toJSON();
  assert.match(places.description, /Tiebreak between <@b>, <@c>, and <@d> for the last 2 places .*picked at random/);
});

test('buildRaffleWinnersContent(): un ganador, la frase de siempre; varios, la lista', () => {
  assert.equal(buildRaffleWinnersContent({ lang: 'es', winnerIds: ['a'], creatorId: 'c' }), '<@a> ha ganado el sorteo de <@c>');
  assert.equal(buildRaffleWinnersContent({ lang: 'es', winnerIds: ['a', 'b', 'd'], creatorId: 'c' }), '<@a>, <@b> y <@d> han ganado el sorteo de <@c>');
});
