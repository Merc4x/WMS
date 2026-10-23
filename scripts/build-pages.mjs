/**
 * Build para GitHub Pages (demo sin servidor).
 *   1. Angular en modo demo (configuración «pages»: WMS_DEMO=true, base href /WMS/).
 *   2. La API empaquetada para el navegador con esbuild (api/src/demo/browser.ts): los módulos de Node
 *      (node:sqlite, fs, crypto, jsonwebtoken…) se reemplazan por los shims de api/src/demo/shims.
 *   3. Copia sql-wasm.wasm y la ruta fija de Medellín, y crea 404.html para el enrutamiento SPA.
 * Uso: npm run build:pages  (opcional: BASE_HREF=/otro/)
 */
import { build } from 'esbuild';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'apps/web/dist/web/browser');
const demoDir = path.join(out, 'demo');
const shims = path.join(root, 'api/src/demo/shims');
const base = process.env.BASE_HREF ?? '/WMS/';

if (!process.env.SKIP_NG) {
  console.log('▶ Angular (configuración pages)…');
  execSync(`npx ng build --configuration pages --base-href ${base}`, { cwd: path.join(root, 'apps/web'), stdio: 'inherit' });
}

console.log('▶ API para el navegador (esbuild)…');
const alias = {
  'node:sqlite': path.join(shims, 'sqlite.ts'),
  'node:fs': path.join(shims, 'node.ts'),
  fs: path.join(shims, 'node.ts'),
  'node:path': path.join(shims, 'node.ts'),
  path: path.join(shims, 'node.ts'),
  'node:events': path.join(shims, 'node.ts'),
  events: path.join(shims, 'node.ts'),
  'node:crypto': path.join(shims, 'crypto.ts'),
  crypto: path.join(shims, 'crypto.ts'),
  jsonwebtoken: path.join(shims, 'jsonwebtoken.ts'),
  'node:child_process': path.join(shims, 'node.ts'),
};
const shimPlugin = {
  name: 'wms-shims',
  setup(b) {
    // ExcelJS y PDFKit (lo más pesado de la API) quedan en archivos aparte que el builder de reportes carga
    // con import() solo al generar uno: la primera visita no los descarga.
    b.onResolve({ filter: /^(exceljs|pdfkit)$/ }, (args) =>
      /reports[\\/]builder\.ts$/.test(args.importer)
        ? { path: args.path === 'exceljs' ? './wms-demo-xlsx.js' : './wms-demo-pdf.js', external: true }
        : undefined,
    );
    b.onResolve({ filter: /.*/ }, (args) => (alias[args.path] ? { path: alias[args.path] } : undefined));
    // El runtime de Azure Functions y el cliente de Turso solo se usan en Node, no en la demo del navegador.
    b.onResolve({ filter: /^(@azure\/functions|@libsql\/client)$/ }, () => ({ path: 'empty-mod', namespace: 'empty' }));
    b.onLoad({ filter: /.*/, namespace: 'empty' }, () => ({ contents: 'export default {};', loader: 'js' }));
  },
};
fs.mkdirSync(demoDir, { recursive: true });
const result = await build({
  entryPoints: {
    'wms-demo-api': path.join(root, 'api/src/demo/browser.ts'),
    'wms-demo-xlsx': path.join(root, 'api/src/demo/reports-xlsx.ts'),
    'wms-demo-pdf': path.join(root, 'api/src/demo/reports-pdf.ts'),
  },
  outdir: demoDir,
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  minify: true,
  sourcemap: false,
  legalComments: 'none',
  plugins: [shimPlugin],
  define: { __dirname: '"/"', 'process.env.NODE_ENV': '"production"' },
  inject: [path.join(shims, 'globals.ts')],
  logLevel: 'warning',
  metafile: true,
});
for (const [file, o] of Object.entries(result.metafile.outputs)) console.log(`  ${path.basename(file)} · ${(o.bytes / 1024).toFixed(0)} KB`);

fs.copyFileSync(path.join(root, 'node_modules/sql.js/dist/sql-wasm.wasm'), path.join(demoDir, 'sql-wasm.wasm'));
fs.copyFileSync(
  path.join(root, 'api/src/functions/gps-simulator/route-medellin.geojson'),
  path.join(demoDir, 'route-medellin.geojson'),
);
// Arranque de la API de la demo en un Web Worker desde el propio index.html: el Worker, el motor SQLite y la
// ruta se descargan en paralelo con la app (sin esperar a main.js) y la API nunca ocupa el hilo de la interfaz.
// El wasm y la ruta los descarga la página (con la precarga) y se los pasa al Worker sin copiarlos.
// core/demo-backend.ts toma window.__wmsDemoWorker; si no existe o falla, carga la API en la página.
const workerBoot = `(function () {
  try {
    var u = function (p) { return new URL(p, document.baseURI).href; };
    var w = new Worker(u('demo/wms-demo-api.js'), { type: 'module' });
    var base = { type: 'assets', wasmUrl: u('demo/sql-wasm.wasm'), routeUrl: u('demo/route-medellin.geojson') };
    window.__wmsDemoWorker = w;
    Promise.all([
      fetch(base.wasmUrl).then(function (r) { if (!r.ok) throw r; return r.arrayBuffer(); }),
      fetch(base.routeUrl).then(function (r) { if (!r.ok) throw r; return r.text(); })
    ]).then(function (a) {
      w.postMessage(Object.assign({ wasm: a[0], route: a[1] }, base), [a[0]]);
    }, function () {
      w.postMessage(base);
    });
  } catch (e) {}
})();`;
const indexHtml = path.join(out, 'index.html');
fs.writeFileSync(
  indexHtml,
  fs.readFileSync(indexHtml, 'utf8').replace(
    '</head>',
    '  <link rel="preload" href="demo/sql-wasm.wasm" as="fetch" type="application/wasm" crossorigin />\n' +
      '  <link rel="preload" href="demo/route-medellin.geojson" as="fetch" crossorigin />\n' +
      `  <script>${workerBoot}</script>\n` +
      '</head>',
  ),
);
// GitHub Pages: /WMS/mapa se sirve desde mapa.html si existe (código 200). Se crea una copia de index.html por
// cada ruta de la app (leídas de app.routes.ts, así la lista no se desactualiza); el resto pasa por 404.html.
const routesTs = fs.readFileSync(path.join(root, 'apps/web/src/app/app.routes.ts'), 'utf8');
const pages = [...new Set([...routesTs.matchAll(/path: '([a-z-]+)'/g)].map((m) => m[1]))];
for (const p of pages) fs.copyFileSync(indexHtml, path.join(out, `${p}.html`));
console.log(`  ${pages.length} páginas por ruta (${pages.join(', ')})`);
// GitHub Pages: rutas profundas (/WMS/mapa) se sirven con 404.html → la SPA las resuelve.
fs.copyFileSync(indexHtml, path.join(out, '404.html'));
fs.writeFileSync(path.join(out, '.nojekyll'), '');
console.log(`✅ Sitio listo en ${path.relative(root, out)} (base ${base})`);
