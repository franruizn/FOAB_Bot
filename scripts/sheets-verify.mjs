#!/usr/bin/env node
// Verifica el acceso de escritura a Google Sheets: escribe 3 filas de prueba
// y las limpia. Tiene que pasar ANTES de tocar cualquier comando de Discord.
//
// Uso: npm run verify:sheets

import 'dotenv/config';
import { escribirBloque, limpiarBloque } from '../src/services/sheets.js';

const TEST_ROWS = [
  ['Jugador de Prueba 1', 'Tank', 'Healer', 'DPS'],
  ['Jugador de Prueba 2', 'Support', '', ''],
  ['Jugador de Prueba 3', 'DPS', 'DPS', ''],
];

async function main() {
  const sheetId = process.env.CTA_SHEET_ID;
  console.log('Verificando acceso de escritura a Google Sheets...\n');
  console.log(`Hoja:     https://docs.google.com/spreadsheets/d/${sheetId}/edit`);
  console.log(`Pestaña:  ${process.env.CTA_SHEET_TAB}`);
  console.log(`Inicio:   ${process.env.CTA_RANGO_INICIO}\n`);

  console.log(`[1] Escribiendo ${TEST_ROWS.length} filas de prueba...`);
  await escribirBloque(TEST_ROWS);
  console.log('    ✔ Escritura OK. Abrí la hoja y confirmá visualmente que las 3 filas están ahí.');

  console.log(`\n[2] Limpiando las ${TEST_ROWS.length} filas de prueba...`);
  await limpiarBloque(TEST_ROWS.length);
  console.log('    ✔ Limpieza OK. Confirmá que el bloque quedó vacío.');

  console.log('\n✔ TODO OK: el acceso de escritura a Google Sheets funciona.');
}

main().catch((error) => {
  console.error('\n✖ FALLÓ:', error.message);
  process.exitCode = 1;
});
