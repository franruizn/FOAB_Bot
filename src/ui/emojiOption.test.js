import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emojiParaOpcion, esEmojiPersonalizado } from './emojiOption.js';

test('emojiParaOpcion: custom emoji resuelto -> {id,name,animated:false}', () => {
  assert.deepEqual(emojiParaOpcion('<:T8_MAIN_ROCKMACE_KEEPER:1514416132817000000>'), {
    id: '1514416132817000000',
    name: 'T8_MAIN_ROCKMACE_KEEPER',
    animated: false,
  });
});

test('emojiParaOpcion: custom emoji animado -> animated:true', () => {
  assert.deepEqual(emojiParaOpcion('<a:fuego:123456789012345678>'), {
    id: '123456789012345678',
    name: 'fuego',
    animated: true,
  });
});

test('emojiParaOpcion: unicode se devuelve tal cual', () => {
  assert.equal(emojiParaOpcion('🟢'), '🟢');
  assert.equal(emojiParaOpcion('⚠️'), '⚠️');
});

test('esEmojiPersonalizado: true solo para la forma custom resuelta', () => {
  assert.equal(esEmojiPersonalizado('<:maza:123456789012345678>'), true);
  assert.equal(esEmojiPersonalizado('<a:maza:123456789012345678>'), true);
  assert.equal(esEmojiPersonalizado('🟢'), false);
  assert.equal(esEmojiPersonalizado(':maza:'), false); // código corto sin resolver, no la forma completa
});
