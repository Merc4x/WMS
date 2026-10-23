import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync, StatementSync } from 'node:sqlite';
import type { Client, InArgs, InStatement } from '@libsql/client';
import { config } from './config';
import { MIGRATIONS } from './migrations';

/**
 * Capa de acceso a datos sobre SQLite (node:sqlite) con sincronización en la nube hacia Turso (libSQL).
 * Los repositorios sólo usan estas funciones síncronas (all/get/run/tx), manteniendo lecturas instantáneas
 * desde la réplica local y replicando todas las escrituras hacia Turso Cloud cuando está configurado.
 */
type Param = string | number | bigint | null | Uint8Array | boolean | undefined;
export type Params = Record<string, Param> | Param[];

let db: DatabaseSync | null = null;
const cache = new Map<string, StatementSync>();
const paramNames = new Map<string, string[]>();

/* ---------- Cliente Turso (libSQL en la nube) ---------- */
let tursoClient: Client | null = null;
let tursoSchemaReady: Promise<void> | null = null;
let pendingWrites: InStatement[] = [];
let txWrites: InStatement[] | null = null;
let flushPromise: Promise<void> = Promise.resolve();
let flushScheduled = false;
let suppressTursoEcho = false;

export function isTursoEnabled(): boolean {
  return Boolean(
    config.tursoUrl &&
      config.tursoAuthToken &&
      config.dbPath !== ':memory:' &&
      !process.env.VITEST,
  );
}

function getTurso(): Client | null {
  if (!isTursoEnabled()) return null;
  if (!tursoClient) {
    // Carga perezosa para no incluir @libsql/client cuando corre en el navegador (demo Pages)
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { createClient } = require('@libsql/client') as typeof import('@libsql/client');
    tursoClient = createClient({
      url: config.tursoUrl,
      authToken: config.tursoAuthToken,
    });
  }
  return tursoClient;
}

async function ensureTursoSchema(): Promise<void> {
  const client = getTurso();
  if (!client) return;
  if (!tursoSchemaReady) {
    tursoSchemaReady = (async () => {
      await client.execute('CREATE TABLE IF NOT EXISTS _schema_version (version INTEGER NOT NULL)');
      const r = await client.execute('SELECT COALESCE(MAX(version), 0) AS v FROM _schema_version');
      const current = Number(r.rows[0]?.v ?? 0);
      for (let v = current; v < MIGRATIONS.length; v++) {
        await client.executeMultiple(
          `${MIGRATIONS[v]}\nINSERT INTO _schema_version (version) VALUES (${v + 1});`,
        );
      }
    })();
  }
  return tursoSchemaReady;
}

function scheduleTursoFlush() {
  if (flushScheduled || !pendingWrites.length) return;
  flushScheduled = true;
  queueMicrotask(() => {
    flushScheduled = false;
    void flushTurso();
  });
}

/** Envía todas las escrituras pendientes a Turso Cloud en lotes transaccionales. */
export function flushTurso(): Promise<void> {
  const client = getTurso();
  if (!client || !pendingWrites.length) return flushPromise;
  const batch = pendingWrites.splice(0, pendingWrites.length);
  flushPromise = flushPromise
    .then(async () => {
      await ensureTursoSchema();
      const CHUNK = 120;
      for (let i = 0; i < batch.length; i += CHUNK) {
        await client.batch(batch.slice(i, i + CHUNK), 'write');
      }
    })
    .catch((err) => {
      console.error('[Turso Sync Error]', err?.message ?? err);
    });
  return flushPromise;
}

/** Reinicia las tablas remotas en Turso Cloud (usado por `npm run seed`). */
export async function resetTurso(): Promise<void> {
  const client = getTurso();
  if (!client) return;
  pendingWrites = [];
  txWrites = null;
  tursoSchemaReady = null;
  const tablesRes = await client.execute(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
  );
  const drops = tablesRes.rows.map((r) => `DROP TABLE IF EXISTS "${String(r.name)}";`).join('\n');
  if (drops) {
    await client.executeMultiple(`PRAGMA foreign_keys = OFF;\n${drops}\nPRAGMA foreign_keys = ON;`);
  }
  await ensureTursoSchema();
}

const SYNC_TABLES = [
  'plans',
  'companies',
  'subscriptions',
  'invoices',
  'users',
  'driver_profiles',
  'refresh_tokens',
  'password_resets',
  'devices',
  'vehicles',
  'trips',
  'positions',
  'vehicle_live',
  'geofences',
  'geofence_vehicles',
  'geofence_state',
  'alert_rules',
  'rule_state',
  'alerts',
  'notifications',
  'reports',
  'report_shares',
  'tickets',
  'ticket_comments',
  'simulator_state',
  'driver_locations',
];

/**
 * Descarga el estado actual desde Turso Cloud hacia la réplica SQLite local.
 * Devuelve `true` si Turso Cloud ya tenía datos, o `false` si está vacía.
 */
export async function syncFromTurso(): Promise<boolean> {
  const client = getTurso();
  if (!client) return false;
  await ensureTursoSchema();
  const countRes = await client.execute('SELECT COUNT(*) AS n FROM companies');
  const remoteCount = Number(countRes.rows[0]?.n ?? 0);
  if (remoteCount === 0) return false;

  const d = getDb();
  const results = await client.batch(
    SYNC_TABLES.map((t) => `SELECT * FROM ${t}`),
    'read',
  );

  suppressTursoEcho = true;
  try {
    d.exec('PRAGMA foreign_keys = OFF; BEGIN;');
    try {
      for (const t of [...SYNC_TABLES].reverse()) {
        d.exec(`DELETE FROM ${t}`);
      }
      for (let idx = 0; idx < SYNC_TABLES.length; idx++) {
        const table = SYNC_TABLES[idx];
        const rs = results[idx];
        if (!rs || !rs.rows.length) continue;
        const cols = rs.columns;
        const placeholders = cols.map(() => '?').join(',');
        const ins = d.prepare(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${placeholders})`);
        for (const row of rs.rows) {
          const vals = cols.map((c) => {
            const v = (row as any)[c];
            if (v instanceof ArrayBuffer) return new Uint8Array(v);
            return v ?? null;
          });
          ins.run(...vals);
        }
      }
      d.exec('COMMIT; PRAGMA foreign_keys = ON;');
    } catch (e) {
      d.exec('ROLLBACK; PRAGMA foreign_keys = ON;');
      throw e;
    }
  } finally {
    suppressTursoEcho = false;
  }
  return true;
}

/** Nombres de parámetros (@x) usados por la sentencia: permite pasar objetos con campos extra. */
function namesOf(sql: string): string[] {
  let n = paramNames.get(sql);
  if (!n) {
    const code = sql.replace(/'(?:[^']|'')*'/g, "''"); // ignora literales ('soporte@wms.co')
    n = [...new Set([...code.matchAll(/@([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]))];
    paramNames.set(sql, n);
  }
  return n;
}

export function getDb(): DatabaseSync {
  if (db) return db;
  const file = config.dbPath;
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  migrate(db);
  return db;
}

export function closeDb() {
  cache.clear();
  db?.close();
  db = null;
}

function migrate(d: DatabaseSync) {
  const current = (d.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
  for (let v = current; v < MIGRATIONS.length; v++) {
    d.exec('BEGIN');
    try {
      d.exec(MIGRATIONS[v]);
      d.exec(`PRAGMA user_version = ${v + 1}`);
      d.exec('COMMIT');
    } catch (e) {
      d.exec('ROLLBACK');
      throw e;
    }
  }
}

function norm(v: Param): string | number | bigint | null | Uint8Array {
  if (v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  return v;
}

function stmt(sql: string): StatementSync {
  let s = cache.get(sql);
  if (!s) {
    s = getDb().prepare(sql);
    cache.set(sql, s);
  }
  return s;
}

function bindArgs(sql: string, params: Params | undefined): any {
  if (params === undefined) return undefined;
  if (Array.isArray(params)) return params.map(norm);
  const o: Record<string, any> = {};
  for (const k of namesOf(sql)) o[k] = norm(params[k]);
  return o;
}

function exec<T>(sql: string, params: Params | undefined, fn: (s: StatementSync, p: any) => T): T {
  const s = stmt(sql);
  const p = bindArgs(sql, params);
  return fn(s, p);
}

export function all<T = any>(sql: string, params?: Params): T[] {
  return exec(sql, params, (s, p) =>
    p === undefined ? s.all() : Array.isArray(p) ? s.all(...p) : s.all(p),
  ) as T[];
}

export function get<T = any>(sql: string, params?: Params): T | undefined {
  return exec(sql, params, (s, p) =>
    p === undefined ? s.get() : Array.isArray(p) ? s.get(...p) : s.get(p),
  ) as T | undefined;
}

export function run(sql: string, params?: Params): { changes: number } {
  const p = bindArgs(sql, params);
  const s = stmt(sql);
  const r = p === undefined ? s.run() : Array.isArray(p) ? s.run(...p) : s.run(p);

  if (isTursoEnabled() && !suppressTursoEcho) {
    const entry: InStatement = p === undefined ? sql : { sql, args: p as InArgs };
    if (txWrites) {
      txWrites.push(entry);
    } else {
      pendingWrites.push(entry);
      scheduleTursoFlush();
    }
  }

  return { changes: Number(r.changes) };
}

let txDepth = 0;
export function tx<T>(fn: () => T): T {
  const d = getDb();
  if (txDepth > 0) return fn();
  d.exec('BEGIN');
  txDepth++;
  const localTxQueue: InStatement[] = [];
  if (isTursoEnabled() && !suppressTursoEcho) txWrites = localTxQueue;
  try {
    const out = fn();
    d.exec('COMMIT');
    if (localTxQueue.length) {
      pendingWrites.push(...localTxQueue);
      scheduleTursoFlush();
    }
    return out;
  } catch (e) {
    d.exec('ROLLBACK');
    throw e;
  } finally {
    txDepth--;
    if (txDepth === 0) txWrites = null;
  }
}

export const id = () => crypto.randomUUID();
export const now = () => new Date().toISOString();

/** Convierte columnas JSON y booleanas (0/1) de SQLite a tipos JS. */
export function parseJson<T>(v: unknown, fallback: T): T {
  if (typeof v !== 'string' || !v) return fallback;
  try {
    return JSON.parse(v) as T;
  } catch {
    return fallback;
  }
}
export const bool = (v: unknown) => v === 1 || v === true || v === '1';
