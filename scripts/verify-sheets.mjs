#!/usr/bin/env node
// Verifica que GOOGLE_CREDENTIALS_PATH sirvió para hacer login en Google
// Sheets y que CTA_SHEET_ID es una hoja a la que esa cuenta de servicio
// tiene acceso — SIN escribir nada (services/sheets.js#validarCredenciales,
// la misma comprobación que corre una vez al arrancar el bot, ver
// index.js). No sustituye a abrir/cerrar una CTA de verdad, pero contesta
// "¿el login funciona?" en segundos y sin pasar por Discord.
//
// Uso: npm run verify:sheets

import 'dotenv/config';
import { validarCredenciales } from '../src/services/sheets.js';

async function main() {
  console.log('FOAB Bot — verificación de credenciales de Google Sheets\n');

  const resultado = await validarCredenciales();

  if (resultado.result === 'sin-configurar') {
    console.log('ℹ GOOGLE_CREDENTIALS_PATH y/o CTA_SHEET_ID no están definidas. Ver .env.example.');
    process.exitCode = 1;
    return;
  }

  if (resultado.result === 'ok') {
    console.log(`✔ login OK — cuenta de servicio: ${resultado.email}`);
    console.log(`✔ acceso a la hoja OK — título: "${resultado.titulo}"`);
    console.log('\n✔ TODO OK — el login funciona y la hoja es accesible.');
    process.exitCode = 0;
    return;
  }

  // resultado.result === 'error'
  if (resultado.etapa === 'login') {
    console.error(`✖ login — ${resultado.mensaje}`);
    console.log(
      '\n✖ No se pudo ni leer el JSON de credenciales. Revisa que GOOGLE_CREDENTIALS_PATH apunte a un fichero ' +
        'que existe y es el JSON de una cuenta de servicio (no un OAuth client).',
    );
  } else {
    console.log(`✔ login OK — cuenta de servicio: ${resultado.email}`);
    console.error(`✖ acceso a la hoja (CTA_SHEET_ID) — ${resultado.mensaje}`);
    if (resultado.status === 403 || resultado.status === 404) {
      console.log(
        `\n✖ El login funcionó (${resultado.email}), pero no se pudo acceder a la hoja. La causa más probable: ` +
          `la hoja no está compartida con ese email como editor. Compártela con "${resultado.email}" y vuelve a intentarlo.`,
      );
    } else {
      console.log(`\n✖ El login funcionó (${resultado.email}), pero falló el acceso a la hoja por otro motivo (ver arriba).`);
    }
  }
  process.exitCode = 1;
}

main();
