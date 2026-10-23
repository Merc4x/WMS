import fs from 'node:fs';
import path from 'node:path';

/** Raíz del paquete api (funciona tanto desde src/ con tsx como desde dist/ compilado). */
function findApiRoot(): string {
  let dir = __dirname;
  for (let i = 0; i < 6; i++) {
    const pkg = path.join(dir, 'package.json');
    if (fs.existsSync(pkg)) {
      try {
        if (JSON.parse(fs.readFileSync(pkg, 'utf8')).name === '@wms/api') return dir;
      } catch {}
    }
    dir = path.dirname(dir);
  }
  return process.cwd();
}

export const API_ROOT = findApiRoot();
export const REPO_ROOT = path.resolve(API_ROOT, '..');

/** Carga mínima de .env de la raíz del monorepo (sin dependencias). */
function loadDotEnv() {
  const file = path.join(REPO_ROOT, '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
loadDotEnv();

function resolveDbPath(): string {
  const raw = process.env.DB_PATH;
  if (!raw) return path.join(API_ROOT, 'data', 'wms.db');
  if (raw === ':memory:' || path.isAbsolute(raw)) return raw;
  // Rutas relativas: primero respecto a la raíz del repo (api/data/...), si no respecto a api/
  return raw.startsWith('api/') || raw.startsWith('api\\')
    ? path.join(REPO_ROOT, raw)
    : path.join(API_ROOT, raw);
}

export const config = {
  port: Number(process.env.PORT ?? 7071),
  jwtSecret: process.env.JWT_SECRET ?? 'wms-dev-secret-cambiar',
  jwtRefreshSecret: process.env.JWT_REFRESH_SECRET ?? 'wms-dev-refresh-secret-cambiar',
  /** Clave compartida entre el simulador GPS (loop.ts) y sus funciones de control (/simulator/*). */
  simulatorKey: process.env.SIMULATOR_KEY ?? 'wms-simulator-local-key',
  accessTtl: process.env.ACCESS_TOKEN_TTL ?? '15m',
  refreshTtlDays: Number(process.env.REFRESH_TOKEN_TTL_DAYS ?? 7),
  get dbPath() {
    return resolveDbPath();
  },
  get tursoUrl() {
    return process.env.TURSO_DATABASE_URL ?? '';
  },
  get tursoAuthToken() {
    return process.env.TURSO_AUTH_TOKEN ?? '';
  },
  corsOrigin: (process.env.CORS_ORIGIN ?? 'http://localhost:4200').split(','),
  demoMode: (process.env.DEMO_MODE ?? 'true') !== 'false',
  timezone: 'America/Bogota',
};
