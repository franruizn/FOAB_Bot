import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRaffleAnnouncementContent, buildRaffleResultsEmbed, buildNoParticipantsEmbed } from './raffleEmbed.js';

// ============================================================
// buildRaffleAnnouncementContent()
// ============================================================

test('buildRaffleAnnouncementContent(): sin rol y sin RAFFLE_ROLE_ID, comportamiento idéntico al actual', () => {
  const content = buildRaffleAnnouncementContent({ creatorId: 'creator-1', endsAtUnixSeconds: 123, roleId: null, requiredRoleId: null });
  assert.equal(content, '<@creator-1> ha comenzado un sorteo que terminará <t:123:R>.\n\nReacciona con 🎉 para participar.');
});

test('buildRaffleAnnouncementContent(): sin rol pero con RAFFLE_ROLE_ID, mantiene el ping delante (comportamiento actual)', () => {
  const content = buildRaffleAnnouncementContent({ creatorId: 'creator-1', endsAtUnixSeconds: 123, roleId: 'raffle-role', requiredRoleId: null });
  assert.equal(content, '<@&raffle-role> <@creator-1> ha comenzado un sorteo que terminará <t:123:R>.\n\nReacciona con 🎉 para participar.');
});

test('buildRaffleAnnouncementContent(): con rol restrictivo, menciona solo ESE rol (nunca RAFFLE_ROLE_ID) y explica el requisito', () => {
  const content = buildRaffleAnnouncementContent({
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
  const embed = buildRaffleResultsEmbed({ results, totalReactors: 2 }).toJSON();
  assert.equal(embed.footer.text, 'Tiradas 1–100', 'con <=5 participantes y sin descartes, no añade conteo');
});

test('buildRaffleResultsEmbed(): con más de 5 participantes y sin descartes, muestra el conteo simple (comportamiento actual)', () => {
  const results = Array.from({ length: 7 }, (_, i) => ({ user: { id: `p${i}` }, roll: 100 - i }));
  const embed = buildRaffleResultsEmbed({ results, totalReactors: 7 }).toJSON();
  assert.equal(embed.footer.text, 'Tiradas 1–100 · 7 participantes');
});

test('buildRaffleResultsEmbed(): con descartes por rol, el footer dice "X de Y participantes válidos"', () => {
  const results = [
    { user: { id: 'p1' }, roll: 90 },
    { user: { id: 'p2' }, roll: 50 },
  ];
  const embed = buildRaffleResultsEmbed({ results, totalReactors: 5 }).toJSON();
  assert.equal(embed.footer.text, 'Tiradas 1–100 · 2 de 5 participantes válidos');
});

// ============================================================
// buildNoParticipantsEmbed()
// ============================================================

test('buildNoParticipantsEmbed(): sin argumentos, "Nadie participó." (comportamiento actual)', () => {
  const embed = buildNoParticipantsEmbed().toJSON();
  assert.equal(embed.description, 'Nadie participó.');
});

test('buildNoParticipantsEmbed(): hubo reacciones pero ninguna cumplía el rol, lo distingue de un sorteo vacío', () => {
  const embed = buildNoParticipantsEmbed({ totalReactors: 3 }).toJSON();
  assert.match(embed.description, /3 persona\(s\) reaccionaron, pero ninguna cumplía el rol requerido/);
  assert.doesNotMatch(embed.description, /^Nadie participó\.$/);
});

test('buildNoParticipantsEmbed(): rol borrado antes de resolver, lo explica sin importar cuántos reaccionaron', () => {
  const embed = buildNoParticipantsEmbed({ totalReactors: 4, roleMissing: true }).toJSON();
  assert.match(embed.description, /el rol requerido para este sorteo ya no existe/i);
});

test('buildNoParticipantsEmbed(): delayed añade la nota de retraso además del motivo', () => {
  const embed = buildNoParticipantsEmbed({ delayed: true, totalReactors: 2 }).toJSON();
  assert.match(embed.description, /ninguna cumplía el rol requerido/);
  assert.match(embed.description, /se resolvió con retraso/);
});
