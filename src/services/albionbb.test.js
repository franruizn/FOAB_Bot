import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAlbionbbUrl, InvalidLinkError } from './albionbb.js';

test('parsea el servidor europe', () => {
  const result = parseAlbionbbUrl('https://europe.albionbb.com/battles/418186013');
  assert.deepStrictEqual(result, { server: 'europe', battleIds: [418186013] });
});

test('parsea el servidor americas (sin subdominio)', () => {
  const result = parseAlbionbbUrl('https://albionbb.com/battles/123');
  assert.deepStrictEqual(result, { server: 'americas', battleIds: [123] });
});

test('parsea el servidor asia (east)', () => {
  const result = parseAlbionbbUrl('https://east.albionbb.com/battles/123');
  assert.deepStrictEqual(result, { server: 'asia', battleIds: [123] });
});

test('parsea múltiples ids separados por comas', () => {
  const result = parseAlbionbbUrl('https://europe.albionbb.com/battles/123,456,789');
  assert.deepStrictEqual(result, { server: 'europe', battleIds: [123, 456, 789] });
});

test('lanza InvalidLinkError si la URL no es válida', () => {
  assert.throws(() => parseAlbionbbUrl('no-es-una-url'), InvalidLinkError);
});

test('lanza InvalidLinkError si el host no es de albionbb', () => {
  assert.throws(
    () => parseAlbionbbUrl('https://example.com/battles/123'),
    InvalidLinkError,
  );
});

test('lanza InvalidLinkError si el subdominio no está mapeado', () => {
  assert.throws(
    () => parseAlbionbbUrl('https://asia.albionbb.com/battles/123'),
    InvalidLinkError,
  );
});

test('lanza InvalidLinkError si la ruta no es /battles/<id>', () => {
  assert.throws(
    () => parseAlbionbbUrl('https://europe.albionbb.com/kills/123'),
    InvalidLinkError,
  );
});

test('lanza InvalidLinkError si falta el id en la ruta', () => {
  assert.throws(
    () => parseAlbionbbUrl('https://europe.albionbb.com/battles/'),
    InvalidLinkError,
  );
});

test('lanza InvalidLinkError si un id no es numérico', () => {
  assert.throws(
    () => parseAlbionbbUrl('https://europe.albionbb.com/battles/abc'),
    InvalidLinkError,
  );
});

test('lanza InvalidLinkError si alguno de varios ids no es numérico', () => {
  assert.throws(
    () => parseAlbionbbUrl('https://europe.albionbb.com/battles/123,abc'),
    InvalidLinkError,
  );
});

test('parsea /battles/multi?ids=... con varios ids', () => {
  const result = parseAlbionbbUrl('https://europe.albionbb.com/battles/multi?ids=418543901,418551073');
  assert.deepStrictEqual(result, { server: 'europe', battleIds: [418543901, 418551073] });
});

test('parsea /battles/multi?ids=... con un solo id', () => {
  const result = parseAlbionbbUrl('https://albionbb.com/battles/multi?ids=123');
  assert.deepStrictEqual(result, { server: 'americas', battleIds: [123] });
});

test('lanza InvalidLinkError si /battles/multi no tiene el parámetro ids', () => {
  assert.throws(
    () => parseAlbionbbUrl('https://europe.albionbb.com/battles/multi'),
    InvalidLinkError,
  );
});

test('lanza InvalidLinkError si /battles/multi tiene ids vacío', () => {
  assert.throws(
    () => parseAlbionbbUrl('https://europe.albionbb.com/battles/multi?ids='),
    InvalidLinkError,
  );
});

test('lanza InvalidLinkError si algún id de /battles/multi no es numérico', () => {
  assert.throws(
    () => parseAlbionbbUrl('https://europe.albionbb.com/battles/multi?ids=123,abc'),
    InvalidLinkError,
  );
});
