import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMentionListTokens, resolveMentionList } from './mentionList.js';

function makeMember(id, username, { bot = false } = {}) {
  return { id, user: { username, bot } };
}

function makeMembers(members) {
  return new Map(members.map((m) => [m.id, m]));
}

// ============================================================
// parseMentionListTokens(): separar por espacios y comas
// ============================================================

test('parseMentionListTokens(): comas y espacios dobles entre nombres se ignoran', () => {
  const tokens = parseMentionListTokens('@a,  @b ,@c   @d');
  assert.deepEqual(tokens, ['@a', '@b', '@c', '@d']);
});

test('parseMentionListTokens(): lista vacía o solo separadores da un array vacío', () => {
  assert.deepEqual(parseMentionListTokens('  ,  ,  '), []);
  assert.deepEqual(parseMentionListTokens(''), []);
});

// ============================================================
// resolveMentionList(): mezcla de <@id> y @nombre, la lista del enunciado
// ============================================================

test('resolveMentionList(): resuelve tanto <@id> como @nombre, mezclados en la misma lista', () => {
  const members = makeMembers([
    makeMember('111', 'mnu_07'),
    makeMember('222', 'albertgamer25'),
    makeMember('333', 'ivory8'),
    makeMember('1219688258557050983', 'xdaniel_97x'),
  ]);

  const { resolved, unresolved } = resolveMentionList('@mnu_07 @albertgamer25 @ivory8 <@1219688258557050983> @xdaniel_97x', members);

  assert.deepEqual(
    resolved.map((m) => m.id).sort(),
    ['111', '222', '333', '1219688258557050983'].sort(),
  );
  assert.deepEqual(unresolved, []);
});

test('resolveMentionList(): también acepta la forma <@!id>', () => {
  const members = makeMembers([makeMember('111', 'mnu_07')]);
  const { resolved } = resolveMentionList('<@!111>', members);
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0].id, '111');
});

// ============================================================
// Igualdad exacta por username, nunca por inclusión
// ============================================================

test('resolveMentionList(): "@topo" no casa con "_hanstopo" ni con "mistertopo"', () => {
  const members = makeMembers([makeMember('1', '_hanstopo'), makeMember('2', 'mistertopo')]);
  const { resolved, unresolved } = resolveMentionList('@topo', members);
  assert.deepEqual(resolved, []);
  assert.deepEqual(unresolved, ['@topo']);
});

test('resolveMentionList(): compara en minúsculas (username de Discord es siempre minúsculas, pero por si acaso)', () => {
  const members = makeMembers([makeMember('1', 'mnu_07')]);
  const { resolved } = resolveMentionList('@MNU_07', members);
  assert.equal(resolved.length, 1);
});

// ============================================================
// No resueltos: no rompen el resto
// ============================================================

test('resolveMentionList(): un @nombre que no existe aparece en unresolved, tal cual se escribió, sin romper el resto', () => {
  const members = makeMembers([makeMember('1', 'mnu_07')]);
  const { resolved, unresolved } = resolveMentionList('@mnu_07 @noexiste123', members);
  assert.equal(resolved.length, 1);
  assert.deepEqual(unresolved, ['@noexiste123']);
});

test('resolveMentionList(): un id que no está en el guild (miembro que se fue) aparece en unresolved', () => {
  const members = makeMembers([makeMember('1', 'mnu_07')]);
  const { resolved, unresolved } = resolveMentionList('<@999>', members);
  assert.deepEqual(resolved, []);
  assert.deepEqual(unresolved, ['<@999>']);
});

// ============================================================
// Duplicados: se asigna una vez
// ============================================================

test('resolveMentionList(): la misma persona repetida (por nombre y por mención) se resuelve una sola vez', () => {
  const members = makeMembers([makeMember('1', 'mnu_07')]);
  const { resolved } = resolveMentionList('@mnu_07 @mnu_07 <@1>', members);
  assert.equal(resolved.length, 1);
});

// ============================================================
// Bots: descartados en silencio
// ============================================================

test('resolveMentionList(): un bot en la lista se descarta, sin aparecer en resolved ni en unresolved', () => {
  const members = makeMembers([makeMember('1', 'mnu_07'), makeMember('2', 'algun-bot', { bot: true })]);
  const { resolved, unresolved } = resolveMentionList('@mnu_07 @algun-bot', members);
  assert.deepEqual(
    resolved.map((m) => m.id),
    ['1'],
  );
  assert.deepEqual(unresolved, []);
});
