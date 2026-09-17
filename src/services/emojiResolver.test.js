import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolverEmoji, resolverEmojis, EmojiNoEncontradoError } from './emojiResolver.js';

function fakeGuild(emojis) {
  const list = emojis.map((e) => ({ name: e.name, id: e.id, animated: Boolean(e.animated) }));
  return {
    emojis: {
      cache: {
        find: (predicate) => list.find(predicate),
        has: (id) => list.some((e) => e.id === id),
      },
    },
  };
}

test('emoji unicode pegado directamente se acepta tal cual', () => {
  const guild = fakeGuild([]);
  assert.equal(resolverEmoji(guild, '🔨'), '🔨');
});

test('custom emoji ya resuelto (forma completa) se acepta tal cual', () => {
  const guild = fakeGuild([]);
  assert.equal(resolverEmoji(guild, '<:maza:123456789012345678>'), '<:maza:123456789012345678>');
  assert.equal(resolverEmoji(guild, '<a:baile:123456789012345678>'), '<a:baile:123456789012345678>');
});

test(':nombre: que existe en el servidor se resuelve a <:nombre:id>', () => {
  const guild = fakeGuild([{ name: 'maza', id: '111111111111111111' }]);
  assert.equal(resolverEmoji(guild, ':maza:'), '<:maza:111111111111111111>');
});

test(':nombre: de un emoji ANIMADO se resuelve a <a:nombre:id> (nunca <: sin la "a")', () => {
  const guild = fakeGuild([{ name: 'baile', id: '222222222222222222', animated: true }]);
  assert.equal(resolverEmoji(guild, ':baile:'), '<a:baile:222222222222222222>');
});

test('la búsqueda por nombre es sensible a mayúsculas, igual que Discord', () => {
  const guild = fakeGuild([{ name: 'Maza', id: '333333333333333333' }]);
  // ":maza:" (minúscula) no debe encontrar el emoji "Maza" (mayúscula) del servidor,
  // y "maza" tampoco está en la tabla unicode -> no se encuentra.
  assert.throws(() => resolverEmoji(guild, ':maza:'), EmojiNoEncontradoError);
  assert.equal(resolverEmoji(guild, ':Maza:'), '<:Maza:333333333333333333>');
});

test('si no está en el servidor, cae a la tabla de códigos unicode estándar', () => {
  const guild = fakeGuild([]);
  assert.equal(resolverEmoji(guild, ':fire:'), '🔥');
  assert.equal(resolverEmoji(guild, ':purple_circle:'), '🟣');
});

test('un emoji del servidor con el mismo nombre que un código unicode gana sobre la tabla', () => {
  const guild = fakeGuild([{ name: 'fire', id: '444444444444444444' }]);
  assert.equal(resolverEmoji(guild, ':fire:'), '<:fire:444444444444444444>');
});

test('un código que no existe ni en el servidor ni en la tabla unicode se rechaza', () => {
  const guild = fakeGuild([]);
  assert.throws(() => resolverEmoji(guild, ':esto_no_existe:'), EmojiNoEncontradoError);
});

test('vacío se rechaza', () => {
  const guild = fakeGuild([]);
  assert.throws(() => resolverEmoji(guild, ''), EmojiNoEncontradoError);
  assert.throws(() => resolverEmoji(guild, '   '), EmojiNoEncontradoError);
});

test('resolverEmojis: todo o nada, si uno falla no se devuelve ninguno', () => {
  const guild = fakeGuild([{ name: 'maza', id: '555555555555555555' }]);
  assert.throws(() => resolverEmojis(guild, [':maza:', ':no_existe:']), EmojiNoEncontradoError);
});

test('resolverEmojis: con todos válidos, mantiene el orden', () => {
  const guild = fakeGuild([{ name: 'maza', id: '666666666666666666' }]);
  assert.deepEqual(resolverEmojis(guild, [':maza:', '🔥', '<:otro:777777777777777777>']), [
    '<:maza:666666666666666666>',
    '🔥',
    '<:otro:777777777777777777>',
  ]);
});
