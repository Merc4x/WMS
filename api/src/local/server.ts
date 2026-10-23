/**
 * Adaptador local ligero: carga las MISMAS funciones definidas para Azure Functions y las expone con Express
 * en http://localhost:7071/api — para levantar el proyecto sin instalar Azure Functions Core Tools.
 */
process.env.WMS_LOCAL_ADAPTER = '1';
import cors from 'cors';
import express, { Request, Response } from 'express';
import { config } from '../shared/config';
import { isTursoEnabled, syncFromTurso } from '../shared/db';
import { toErrorBody } from '../shared/errors';
import { execute, HttpDef, registry, Req, resolveCtx, StreamDef } from '../shared/http';
import '../index';

const toExpressPath = (route: string) => '/api/' + route.replace(/\{(\w+)\}/g, ':$1');

/** Rutas literales antes que las paramétricas (mismo criterio que el enrutador de Azure Functions). */
const sortKey = (route: string) => route.replace(/\{\w+\}/g, '');

function toReq(r: Request): Req {
  const url = new URL(r.originalUrl, 'http://localhost');
  return {
    method: r.method,
    path: url.pathname,
    params: Object.fromEntries(Object.entries(r.params ?? {}).map(([k, v]) => [k, String(v)])),
    query: url.searchParams,
    headers: { get: (n: string) => (r.headers[n.toLowerCase()] as string | undefined) ?? null },
    body: r.body ?? {},
    ip: r.ip ?? 'local',
  };
}

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback');
  app.use(cors({ origin: config.corsOrigin, credentials: true }));
  app.use(express.json({ limit: '2mb' }));
  app.use((err: any, _req: Request, res: Response, next: (e?: any) => void) => {
    if (err?.type === 'entity.parse.failed')
      return res.status(400).json({ code: 'BAD_JSON', message: 'JSON inválido.' });
    next(err);
  });

  app.get('/api/health', (_req, res) =>
    res.json({ status: 'ok', runtime: 'express-adapter', time: new Date().toISOString() }),
  );

  const http = [...registry.http].sort((a, b) => (sortKey(a.route) < sortKey(b.route) ? -1 : 1));
  for (const def of http) mountHttp(app, def);
  for (const def of registry.stream) mountStream(app, def);

  app.use('/api', (_req, res) => res.status(404).json({ code: 'NOT_FOUND', message: 'Ruta no encontrada.' }));
  return app;
}

function mountHttp(app: express.Express, def: HttpDef) {
  for (const m of def.methods) {
    const method = m.toLowerCase() as 'get' | 'post' | 'put' | 'patch' | 'delete';
    app[method](toExpressPath(def.route), async (r: Request, res: Response) => {
      const out = await execute(def, toReq(r));
      res.status(out.status).set(out.headers);
      if (out.json !== undefined) res.json(out.json);
      else if (out.body !== undefined) res.send(Buffer.from(out.body as any));
      else res.end();
    });
  }
}

function mountStream(app: express.Express, def: StreamDef) {
  app.get(toExpressPath(def.route), (r: Request, res: Response) => {
    const req = toReq(r);
    let ctx;
    try {
      ctx = resolveCtx(def.guard, req);
    } catch (e) {
      const { status, body } = toErrorBody(e);
      return res.status(status).json(body);
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 3000\n\n');
    const cleanup = def.handler(req, ctx, (event, data) =>
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
    );
    r.on('close', cleanup);
  });
}

export function startTimers() {
  return registry.timer.map((t) =>
    setInterval(async () => {
      try {
        await t.handler();
      } catch (e) {
        console.error(`[timer ${t.name}]`, e);
      }
    }, t.intervalMs),
  );
}

if (require.main === module) {
  (async () => {
    if (isTursoEnabled()) {
      await syncFromTurso().catch((err) => console.error('[Turso Init Sync]', err?.message ?? err));
    }
    const app = createApp();
    app.listen(config.port, () => {
      startTimers();
      console.log(`\n🚚 WMS API (adaptador local de Azure Functions) en http://localhost:${config.port}/api`);
      console.log(
        `   ${registry.http.length} funciones HTTP · ${registry.stream.length} stream SSE · ${registry.timer.length} timer`,
      );
      console.log(
        `   Base de datos: ${isTursoEnabled() ? `Turso Cloud (${config.tursoUrl}) + réplica ${config.dbPath}` : config.dbPath}\n`,
      );
    });
  })();
}
