/**
 * API de WMS dentro del navegador (demo de GitHub Pages).
 *
 * Pages solo sirve archivos estáticos, así que este módulo empaqueta las MISMAS funciones del backend
 * (registry de defineHttp/defineTimer) sobre SQLite en WebAssembly (sql.js), corre el simulador GPS y el
 * watchdog y guarda la base en IndexedDB. El frontend le entrega las peticiones /api/* a `handle`.
 *
 * Corre en un Web Worker (hilo aparte): así SQLite, el simulador y el guardado no congelan la interfaz.
 * index.html crea el Worker apenas se abre la página (ver build-pages.mjs) y la app le habla con mensajes
 * (core/demo-backend.ts). Si el navegador no soporta Workers de módulo, la app importa este archivo en la
 * página y llama a `boot` directamente, como antes.
 * Lo construye scripts/build-pages.mjs; en local y en Azure se usa el backend real.
 */
import initSqlJs from 'sql.js';

const g = globalThis as any;
const DB_KEY = 'wms-demo-db';
const SCHEMA_TAG = 'v2';
const MAX_AGE_MS = 24 * 3600_000; // los datos demo se regeneran a diario para que el historial sea "de esta semana"

export interface DemoResponse {
  status: number;
  headers: Record<string, string>;
  json?: unknown;
  body?: Uint8Array | string;
}

export interface DemoApi {
  handle(method: string, url: string, headers: Record<string, string>, body: unknown): Promise<DemoResponse>;
  reset(): Promise<void>;
  persist(): void;
  seededAt: number;
}

/* ---------- IndexedDB ---------- */
function idb(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const r = indexedDB.open('wms-demo', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function idbGet<T>(key: string): Promise<T | undefined> {
  try {
    const db = await idb();
    return await new Promise((res) => {
      const q = db.transaction('kv').objectStore('kv').get(key);
      q.onsuccess = () => res(q.result as T);
      q.onerror = () => res(undefined);
    });
  } catch {
    return undefined;
  }
}
async function idbSet(key: string, value: unknown) {
  try {
    const db = await idb();
    await new Promise<void>((res) => {
      const t = db.transaction('kv', 'readwrite');
      t.objectStore('kv').put(value, key);
      t.oncomplete = () => res();
      t.onerror = () => res();
    });
  } catch {}
}

interface BootOptions {
  wasmUrl: string;
  routeUrl: string;
  /** Si la página ya los descargó (precarga de index.html), se usan en vez de volver a pedirlos. */
  wasm?: ArrayBuffer;
  route?: string;
  onStep?: (msg: string) => void;
}

export async function boot(opts: BootOptions): Promise<DemoApi> {
  const step = opts.onStep ?? (() => {});
  step('Cargando la base de datos…');
  g.process ??= { env: {}, cwd: () => '/', pid: 1, on() {} };
  Object.assign(g.process.env, { DB_PATH: ':memory:', DEMO_MODE: 'true', WMS_LOCAL_ADAPTER: '1' });

  const [SQL, route, saved] = await Promise.all([
    initSqlJs(opts.wasm ? { wasmBinary: opts.wasm } : { locateFile: () => opts.wasmUrl }),
    opts.route ?? fetch(opts.routeUrl).then((r) => r.text()),
    idbGet<{ tag: string; at: number; seededAt?: number; bytes: Uint8Array }>(DB_KEY),
  ]);
  g.__WMS_SQL = SQL;
  g.__WMS_ROUTE = route;
  const fresh = !!saved && saved.tag === SCHEMA_TAG && Date.now() - (saved.seededAt ?? saved.at) < MAX_AGE_MS;
  if (fresh) g.__WMS_DB_BYTES = saved!.bytes;

  // Importar la API registra todas las funciones y abre la base (aplica migraciones si hace falta).
  const { setTursoSuppress, syncFromTurso, flushTurso, LIVE_SYNC_TABLES } = await import('../shared/db');
  setTursoSuppress(true);
  const { registry, execute } = await import('../shared/http');
  await import('../index');
  let seededAt = fresh ? (saved!.seededAt ?? saved!.at) : Date.now();
  let sampleReports: (() => Promise<void>) | null = null;
  if (!fresh) {
    step('Creando los datos de la demo…');
    const { seed } = await import('../../../scripts/seed');
    sampleReports = await seed({ quiet: true, deferReports: true });
    seededAt = Date.now();
  }

  /* ---------- Enrutador: mismas rutas que Azure Functions ---------- */
  const routes = [...registry.http]
    .sort((a, b) => (a.route.replace(/\{\w+\}/g, '￿') < b.route.replace(/\{\w+\}/g, '￿') ? -1 : 1))
    .map((def) => {
      const names: string[] = [];
      const re = new RegExp(
        '^/api/' +
          def.route.replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace(/\{(\w+)\}/g, (_m, name: string) => {
            names.push(name);
            return '([^/]+)';
          }) +
          '$',
      );
      return { def, re, names };
    });

  let persistTimer: ReturnType<typeof setTimeout> | undefined;
  /** Las acciones del usuario (crear, editar, ubicación del conductor…) se guardan casi de inmediato. */
  const schedulePersist = () => {
    clearTimeout(persistTimer);
    persistTimer = setTimeout(() => persist(), 600);
  };

  async function handle(method: string, url: string, headers: Record<string, string>, body: unknown): Promise<DemoResponse> {
    const u = new URL(url, 'http://demo.local');
    const m = method.toUpperCase();
    const isUserMutation = m !== 'GET' && !/\/(tracking\/ingest|simulator\/heartbeat)$/.test(u.pathname);
    if (isUserMutation) schedulePersist();
    for (const r of routes) {
      if (!r.def.methods.includes(m)) continue;
      const hit = r.re.exec(u.pathname);
      if (!hit) continue;
      const params: Record<string, string> = {};
      r.names.forEach((n, i) => (params[n] = decodeURIComponent(hit[i + 1])));
      const h = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
      if (isUserMutation) setTursoSuppress(false);
      try {
        const out = await execute(r.def, {
        method: m,
        path: u.pathname,
        params,
        query: u.searchParams,
        headers: { get: (n: string) => h[n.toLowerCase()] ?? null },
        body: body ?? {},
        ip: 'navegador',
      });
        if (isUserMutation) void flushTurso();
        return { status: out.status, headers: out.headers, json: out.json, body: out.body };
      } finally {
        if (isUserMutation) setTursoSuppress(true);
      }
    }
    if (u.pathname === '/api/health') return { status: 200, headers: {}, json: { status: 'ok', runtime: 'browser-demo' } };
    return { status: 404, headers: {}, json: { code: 'NOT_FOUND', message: 'Ruta no encontrada.' } };
  }

  /* ---------- Simulador GPS y watchdog en la página ---------- */
  const { createSimulator } = await import('../functions/gps-simulator/loop');
  const call = async (path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) => {
    const r = await handle(init.method ?? 'GET', `/api${path}`, init.headers ?? {}, init.body ? JSON.parse(init.body) : {});
    if (r.status >= 400 && r.status !== 202) {
      throw Object.assign(new Error(`${r.status} ${(r.json as any)?.message ?? ''}`), { status: r.status });
    }
    return r.json ?? null;
  };
  const quiet = () => {};
  const sim = createSimulator({ call, target: 'el navegador', log: quiet, warn: quiet });
  let ticking = false;
  setInterval(async () => {
    if (ticking) return;
    ticking = true;
    try {
      await sim.tick();
    } finally {
      ticking = false;
    }
  }, 1000);
  for (const t of registry.timer) setInterval(() => Promise.resolve(t.handler()).catch(() => {}), t.intervalMs);

  /* ---------- Persistencia en IndexedDB ---------- */
  let resetting = false; // tras «reiniciar», no se vuelve a guardar la base vieja al cerrar la página
  function persist() {
    if (resetting) return;
    const db = g.__WMS_DB;
    if (db) idbSet(DB_KEY, { tag: SCHEMA_TAG, at: Date.now(), seededAt, bytes: db.export() });
  }
  if (!fresh) persist();
  syncFromTurso(LIVE_SYNC_TABLES).then((ok) => ok && persist()).catch(() => {});
  setInterval(() => syncFromTurso(LIVE_SYNC_TABLES).catch(() => {}), 6000);
  // Los reportes de ejemplo (PDF y Excel) se generan unos segundos después del arranque: así la primera
  // visita no descarga ni ejecuta ExcelJS y PDFKit antes de poder iniciar sesión.
  if (sampleReports) {
    const make = sampleReports;
    setTimeout(() => make().then(persist, () => {}), 4000);
  }
  setInterval(persist, 30_000);
  // En el Worker no hay document: ahí la página avisa con un mensaje «persist» al ocultarse.
  if (typeof document !== 'undefined') {
    addEventListener('pagehide', persist);
    document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && persist());
  }

  return {
    handle,
    seededAt,
    persist,
    async reset() {
      resetting = true;
      clearTimeout(persistTimer);
      await idbSet(DB_KEY, null);
      if (typeof document !== 'undefined') location.reload();
    },
  };
}

/* ---------- Modo Worker: la página habla con la API por mensajes ---------- */
type InMsg =
  | { type: 'assets'; wasmUrl: string; routeUrl: string; wasm?: ArrayBuffer; route?: string }
  | { type: 'status' }
  | { type: 'persist' }
  | { type: 'reset'; id: number }
  | { type: 'req'; id: number; method: string; url: string; headers: Record<string, string>; body: unknown };

function startWorker() {
  const post = (m: unknown, transfer: Transferable[] = []) => (self as any).postMessage(m, transfer);
  let state = { step: '', ready: false, error: '', seededAt: 0 };
  const report = () => post({ type: 'status', ...state });
  let api: Promise<DemoApi> | null = null;

  self.addEventListener('message', async (e: MessageEvent<InMsg>) => {
    const m = e.data;
    if (m.type === 'assets') {
      if (api) return;
      api = boot({
        ...m,
        onStep: (step) => {
          state = { ...state, step };
          report();
        },
      });
      api.then(
        (a) => {
          state = { step: '', ready: true, error: '', seededAt: a.seededAt };
          report();
        },
        (err) => {
          state = { ...state, error: String(err?.message ?? err) };
          report();
        },
      );
    } else if (m.type === 'status') {
      report();
    } else if (m.type === 'persist') {
      (await api)?.persist();
    } else if (m.type === 'reset') {
      await (await api)?.reset();
      post({ type: 'res', id: m.id, res: { status: 200, headers: {} } });
    } else if (m.type === 'req') {
      try {
        if (!api) throw new Error('La demo aún no ha arrancado.');
        const a = await api;
        const res = await a.handle(m.method, m.url, m.headers, m.body);
        // Los archivos (PDF / Excel) viajan sin copiarse (salvo que sean una vista de un buffer más grande).
        const transfer: Transferable[] = [];
        if (res.body instanceof Uint8Array) {
          const b = res.body;
          res.body = b.byteOffset === 0 && b.byteLength === b.buffer.byteLength ? new Uint8Array(b.buffer) : new Uint8Array(b);
          transfer.push(res.body.buffer as ArrayBuffer);
        }
        try {
          post({ type: 'res', id: m.id, res }, transfer);
        } catch {
          // Algún valor no clonable en la respuesta: se envía como JSON plano.
          post({ type: 'res', id: m.id, res: { ...res, json: JSON.parse(JSON.stringify(res.json ?? null)) } });
        }
      } catch (err: any) {
        post({ type: 'res', id: m.id, res: { status: 500, headers: {}, json: { code: 'INTERNAL', message: String(err?.message ?? err) } } });
      }
    }
  });
}

const WGS = (globalThis as any).WorkerGlobalScope;
if (typeof WGS !== 'undefined' && self instanceof WGS) startWorker();
