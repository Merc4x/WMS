import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync, StatementSync } from 'node:sqlite';
import { config } from './config';
import { MIGRATIONS } from './migrations';

/**
 * Capa de acceso a datos sobre SQLite (node:sqlite en Node / sql.js en navegador) con sincronización
 * hacia Turso Cloud (libSQL HTTP /v2/pipeline).
 * Los repositorios sólo usan las funciones síncronas (all/get/run/tx) sin ningún cambio.
 */
type Param = string | number | bigint | null | Uint8Array | boolean | undefined;
export type Params = Record<string, Param> | Param[];

let db: DatabaseSync | null = null;
const cache = new Map<string, StatementSync>();
const paramNames = new Map<string, string[]>();

/* ---------- Cliente HTTP ligero para Turso Cloud (/v2/pipeline, compatible con Node y Navegador) ---------- */
interface HranaValue {
  type: 'null' | 'integer' | 'float' | 'text' | 'blob';
  value?: string | number;
  base64?: string;
}

interface HranaStmt {
  sql: string;
  args?: HranaValue[];
  named_args?: { name: string; value: HranaValue }[];
}

let tursoSchemaReady: Promise<void> | null = null;
let pendingWrites: HranaStmt[] = [];
let txWrites: HranaStmt[] | null = null;
let flushPromise: Promise<void> = Promise.resolve();
let flushScheduled = false;
let suppressTursoEcho = false;

export function setTursoSuppress(v: boolean) {
  suppressTursoEcho = v;
}
export function isTursoSuppressed(): boolean {
  return suppressTursoEcho;
}

export function isTursoEnabled(): boolean {
  return Boolean(
    config.tursoUrl &&
      config.tursoAuthToken &&
      !process.env.VITEST,
  );
}

function tursoPipelineUrl(): string {
  return config.tursoUrl.replace(/^libsql:\/\//, 'https://').replace(/\/$/, '') + '/v2/pipeline';
}

function toBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function fromBase64(b64: string): Uint8Array {
  if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(b64, 'base64'));
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function toHranaValue(v: unknown): HranaValue {
  if (v === null || v === undefined) return { type: 'null' };
  if (typeof v === 'boolean') return { type: 'integer', value: v ? '1' : '0' };
  if (typeof v === 'bigint') return { type: 'integer', value: String(v) };
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return { type: 'null' };
    return Number.isInteger(v) ? { type: 'integer', value: String(v) } : { type: 'float', value: v };
  }
  if (v instanceof Uint8Array) return { type: 'blob', base64: toBase64(v) };
  return { type: 'text', value: String(v) };
}

function toHranaStmt(sql: string, bound: unknown): HranaStmt {
  if (bound === undefined) return { sql };
  if (Array.isArray(bound)) return { sql, args: bound.map(toHranaValue) };
  const named_args = Object.entries(bound as Record<string, unknown>).map(([name, val]) => ({
    name: name.replace(/^@/, ''),
    value: toHranaValue(val),
  }));
  return { sql, named_args };
}

function fromHranaCell(cell: HranaValue): unknown {
  if (!cell || cell.type === 'null') return null;
  if (cell.type === 'integer' || cell.type === 'float') return Number(cell.value);
  if (cell.type === 'blob') return fromBase64(cell.base64 ?? '');
  return cell.value ?? null;
}

async function tursoPipeline(stmts: HranaStmt[]): Promise<{ cols: string[]; rows: Record<string, unknown>[] }[]> {
  if (!isTursoEnabled() || !stmts.length) return [];
  const res = await fetch(tursoPipelineUrl(), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.tursoAuthToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      requests: [
        ...stmts.map((stmt) => ({ type: 'execute', stmt })),
        { type: 'close' },
      ],
    }),
  });
  if (!res.ok) {
    throw new Error(`Turso HTTP ${res.status}: ${await res.text()}`);
  }
  const data = (await res.json()) as {
    results: {
      type: 'ok' | 'error';
      error?: { message: string };
      response?: {
        type: string;
        result?: { cols: { name: string }[]; rows: HranaValue[][] };
      };
    }[];
  };
  const out: { cols: string[]; rows: Record<string, unknown>[] }[] = [];
  for (const r of data.results) {
    if (r.type === 'error') throw new Error(`Turso SQL error: ${r.error?.message ?? 'unknown'}`);
    if (r.response?.type === 'execute' && r.response.result) {
      const cols = r.response.result.cols.map((c) => c.name);
      const rows = r.response.result.rows.map((row) => {
        const obj: Record<string, unknown> = {};
        for (let i = 0; i < cols.length; i++) obj[cols[i]] = fromHranaCell(row[i]);
        return obj;
      });
      out.push({ cols, rows });
    }
  }
  return out;
}

function splitSqlStatements(sqlBlock: string): HranaStmt[] {
  return sqlBlock
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((sql) => ({ sql }));
}

async function ensureTursoSchema(): Promise<void> {
  if (!isTursoEnabled()) return;
  if (!tursoSchemaReady) {
    tursoSchemaReady = (async () => {
      await tursoPipeline([{ sql: 'CREATE TABLE IF NOT EXISTS _schema_version (version INTEGER NOT NULL)' }]);
      const [r] = await tursoPipeline([{ sql: 'SELECT COALESCE(MAX(version), 0) AS v FROM _schema_version' }]);
      const current = Number(r?.rows[0]?.v ?? 0);
      for (let v = current; v < MIGRATIONS.length; v++) {
        const stmts = [
          ...splitSqlStatements(MIGRATIONS[v]),
          { sql: `INSERT INTO _schema_version (version) VALUES (${v + 1})` },
        ];
        await tursoPipeline(stmts);
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

/** Envía todas las escrituras pendientes a Turso Cloud en lotes. */
export function flushTurso(): Promise<void> {
  if (!isTursoEnabled() || !pendingWrites.length) return flushPromise;
  const batch = pendingWrites.splice(0, pendingWrites.length);
  flushPromise = flushPromise
    .then(async () => {
      await ensureTursoSchema();
      const CHUNK = 120;
      for (let i = 0; i < batch.length; i += CHUNK) {
        await tursoPipeline(batch.slice(i, i + CHUNK));
      }
    })
    .catch((err) => {
      console.error('[Turso Sync Error]', err?.message ?? err);
    });
  return flushPromise;
}

/** Reinicia las tablas remotas en Turso Cloud (usado por `npm run seed`). */
export async function resetTurso(): Promise<void> {
  if (!isTursoEnabled()) return;
  pendingWrites = [];
  txWrites = null;
  tursoSchemaReady = null;
  const [tablesRes] = await tursoPipeline([
    { sql: "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'" },
  ]);
  if (tablesRes?.rows.length) {
    const drops: HranaStmt[] = [
      { sql: 'PRAGMA foreign_keys = OFF' },
      ...tablesRes.rows.map((r) => ({ sql: `DROP TABLE IF EXISTS "${String(r.name)}"` })),
      { sql: 'PRAGMA foreign_keys = ON' },
    ];
    await tursoPipeline(drops);
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

/** Tablas ligeras de negocio que la demo del navegador sincroniza periódicamente con Turso Cloud. */
export const LIVE_SYNC_TABLES = [
  'plans',
  'companies',
  'subscriptions',
  'invoices',
  'users',
  'driver_profiles',
  'devices',
  'vehicles',
  'geofences',
  'geofence_vehicles',
  'alert_rules',
  'alerts',
  'tickets',
  'ticket_comments',
  'driver_locations',
];

/**
 * Descarga las tablas indicadas desde Turso Cloud hacia la réplica SQLite local.
 * Devuelve `true` si Turso Cloud ya tenía datos, o `false` si está vacía.
 */
export async function syncFromTurso(tables: string[] = SYNC_TABLES): Promise<boolean> {
  if (!isTursoEnabled()) return false;
  await ensureTursoSchema();
  const [countRes] = await tursoPipeline([{ sql: 'SELECT COUNT(*) AS n FROM companies' }]);
  const remoteCount = Number(countRes?.rows[0]?.n ?? 0);
  if (remoteCount === 0) return false;

  const d = getDb();
  const results = await tursoPipeline(tables.map((t) => ({ sql: `SELECT * FROM ${t}` })));

  const prevSuppress = suppressTursoEcho;
  suppressTursoEcho = true;
  try {
    d.exec('PRAGMA foreign_keys = OFF; BEGIN;');
    try {
      for (const t of [...tables].reverse()) {
        d.exec(`DELETE FROM ${t}`);
      }
      for (let idx = 0; idx < tables.length; idx++) {
        const table = tables[idx];
        const rs = results[idx];
        if (!rs || !rs.rows.length) continue;
        const cols = rs.cols;
        const placeholders = cols.map(() => '?').join(',');
        const ins = d.prepare(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${placeholders})`);
        for (const row of rs.rows) {
          const vals = cols.map((c) => norm(row[c] as Param));
          ins.run(...vals);
        }
      }
      d.exec('COMMIT; PRAGMA foreign_keys = ON;');
    } catch (e) {
      d.exec('ROLLBACK; PRAGMA foreign_keys = ON;');
      throw e;
    }
  } finally {
    suppressTursoEcho = prevSuppress;
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
    const entry = toHranaStmt(sql, p);
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
  const localTxQueue: HranaStmt[] = [];
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
