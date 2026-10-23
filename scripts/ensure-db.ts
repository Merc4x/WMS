/** Se ejecuta antes de `npm run dev`: sincroniza desde Turso Cloud (si existe) o corre el seed automáticamente. */
import fs from 'node:fs';
import { execSync } from 'node:child_process';
import { config } from '../api/src/shared/config';
import { closeDb, isTursoEnabled, syncFromTurso } from '../api/src/shared/db';

async function main() {
  if (isTursoEnabled()) {
    console.log(`☁️  Conectando con Turso Cloud (${config.tursoUrl})…`);
    const hasRemoteData = await syncFromTurso();
    closeDb();
    if (hasRemoteData) {
      console.log(`✅ Base de datos sincronizada desde Turso Cloud (${config.dbPath}).`);
      return;
    }
    console.log('ℹ️  Turso Cloud está vacía: ejecutando el seed inicial y subiendo datos a Turso…');
    execSync('npx tsx scripts/seed.ts', { stdio: 'inherit' });
    return;
  }

  if (config.dbPath !== ':memory:' && !fs.existsSync(config.dbPath)) {
    console.log('ℹ️  No hay base de datos local: ejecutando el seed de datos demo por primera vez…');
    execSync('npx tsx scripts/seed.ts', { stdio: 'inherit' });
  } else {
    console.log(
      `ℹ️  Usando la base de datos existente (${config.dbPath}). Para reiniciar la demo: npm run seed`,
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
