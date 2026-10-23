/**
 * Seed de datos demo: 2 empresas (aislamiento multi-tenant), planes, usuarios de cada rol, flota con GPS,
 * geocercas, reglas de alerta, 7 días de recorridos/alertas históricas, reportes, facturas y tickets.
 * Uso: npm run seed   (BORRA y recrea la base de datos local; detén la API antes en Windows).
 */
import fs from 'node:fs';
import { config } from '../api/src/shared/config';
import { closeDb, flushTurso, get, getDb, id, isTursoEnabled, resetTurso, run, tx } from '../api/src/shared/db';
import { hashPassword } from '../api/src/shared/auth';
import { destination, haversine, LatLng } from '../api/src/shared/geo';
import { companiesRepo, plansRepo } from '../api/src/shared/repositories/companies';
import { devicesRepo } from '../api/src/shared/repositories/fleet';
import { geofencesRepo } from '../api/src/shared/repositories/geofences';
import { alertsRepo, AlertType, Priority } from '../api/src/shared/repositories/alerts';
import { bogotaDayStart } from '../api/src/shared/repositories/tracking';
import { SIM_FLEET } from '../api/src/functions/gps-simulator/fleet';
import { loadRoute, SimVehicle } from '../api/src/functions/gps-simulator/engine';
import { LA72 } from '../api/src/functions/gps-simulator/waypoints';
import { buildReport } from '../api/src/functions/reports/builder';
import { driversRepo } from '../api/src/shared/repositories/users';

export const DEMO_PASSWORD = 'Demo1234!';

/** PRNG determinista para que el seed sea reproducible. */
let seedState = 72;
const rand = () => {
  seedState = (seedState * 1103515245 + 12345) & 0x7fffffff;
  return seedState / 0x7fffffff;
};
const pick = <T>(arr: T[]) => arr[Math.floor(rand() * arr.length)];

async function resetDb() {
  closeDb();
  if (isTursoEnabled()) await resetTurso();
  const file = config.dbPath;
  for (const f of [file, `${file}-wal`, `${file}-shm`]) {
    try {
      if (fs.existsSync(f)) fs.rmSync(f);
    } catch (e) {
      console.error(
        `\n❌ No se pudo borrar ${f}. ¿La API está corriendo? Detén "npm run dev" y vuelve a ejecutar "npm run seed".\n`,
      );
      throw e;
    }
  }
  getDb();
}

function seedPlans() {
  const plans = [
    {
      code: 'basico',
      name: 'Básico',
      description: 'Para negocios que empiezan a rastrear su primer vehículo.',
      price: 89_000,
      vehicles: 3,
      users: 4,
      features: [
        'Hasta 3 vehículos',
        'Mapa en tiempo real',
        'Geocercas y alertas en plataforma',
        'Reportes PDF',
        'Soporte por correo',
      ],
    },
    {
      code: 'pro',
      name: 'Pro',
      description: 'La opción ideal para pymes con domicilios y flota mixta.',
      price: 249_000,
      vehicles: 15,
      users: 15,
      features: [
        'Hasta 15 vehículos',
        'Alertas por correo y push',
        'Reportes PDF y Excel',
        'Compartir reportes',
        'Permisos granulares',
        'Soporte prioritario',
      ],
    },
    {
      code: 'flota',
      name: 'Flota',
      description: 'Para operaciones logísticas con decenas de vehículos.',
      price: 690_000,
      vehicles: 100,
      users: 60,
      features: [
        'Hasta 100 vehículos',
        'Todo lo del plan Pro',
        'Historial extendido',
        'Acompañamiento de implementación',
        'Soporte 24/7',
      ],
    },
  ];
  plans.forEach((p, i) =>
    run(
      `INSERT INTO plans (id, code, name, description, price_cop, max_vehicles, max_users, features, sort)
       VALUES (@id,@code,@name,@description,@price,@vehicles,@users,@features,@sort)`,
      { id: id(), ...p, features: JSON.stringify(p.features), sort: i },
    ),
  );
}

/** Todas las cuentas demo comparten contraseña: se hashea una vez. bcrypt (costo 10) por cada usuario tardaba
 *  ~3 s del primer arranque de la demo de GitHub Pages en un celular (corre en el navegador). */
let demoHash: Promise<string> | null = null;

async function user(
  companyId: string,
  name: string,
  email: string,
  role: string,
  phone = '',
  permissions: Record<string, string> = {},
) {
  const uid = id();
  const ts = new Date(Date.now() - 100 * 86400_000).toISOString();
  run(
    `INSERT INTO users (id, company_id, name, email, password_hash, role, permissions, phone, created_at, updated_at, last_login_at)
     VALUES (@id,@cid,@name,@email,@hash,@role,@perms,@phone,@ts,@ts,@login)`,
    {
      id: uid,
      cid: companyId,
      name,
      email,
      hash: await (demoHash ??= hashPassword(DEMO_PASSWORD)),
      role,
      perms: JSON.stringify(permissions),
      phone,
      ts,
      login: new Date(Date.now() - rand() * 3 * 86400_000).toISOString(),
    },
  );
  return uid;
}

function driverProfile(
  userId: string,
  companyId: string,
  document: string,
  license: string,
  category: string,
) {
  run(
    `INSERT INTO driver_profiles (user_id, company_id, document, license_number, license_category, license_expires_at, status)
     VALUES (@u,@c,@d,@l,@cat,@exp,'disponible')`,
    {
      u: userId,
      c: companyId,
      d: document,
      l: license,
      cat: category,
      exp: new Date(Date.now() + 400 * 86400_000).toISOString().slice(0, 10),
    },
  );
}

function vehicle(
  companyId: string,
  v: {
    plate: string;
    type: string;
    brand: string;
    model: string;
    year: number;
    color: string;
    deviceId?: string | null;
    driverId?: string | null;
    status?: string;
  },
) {
  const vid = id();
  const ts = new Date(Date.now() - 90 * 86400_000).toISOString();
  run(
    `INSERT INTO vehicles (id, company_id, plate, type, brand, model, year, color, status, device_id, driver_id, created_at, updated_at)
     VALUES (@id,@cid,@plate,@type,@brand,@model,@year,@color,@status,@device,@driver,@ts,@ts)`,
    {
      id: vid,
      cid: companyId,
      ...v,
      status: v.status ?? 'active',
      device: v.deviceId ?? null,
      driver: v.driverId ?? null,
      ts,
    },
  );
  return vid;
}

/** Recorridos históricos generados con el mismo motor del simulador sobre la ruta fija. */
function seedHistory(
  companyId: string,
  vehicleId: string,
  deviceId: string,
  driverId: string | null,
  cfgKey: string,
  plate: string,
) {
  const route = loadRoute();
  const cfg = SIM_FLEET.find((f) => f.key === cfgKey)!;
  const today = bogotaDayStart().getTime();
  const STEP = 15; // segundos entre puntos
  let lastPoint: {
    lat: number;
    lng: number;
    speed: number;
    heading: number;
    ts: string;
    battery: number;
  } | null = null;
  const tripIds: { id: string; points: { lat: number; lng: number; ts: string }[] }[] = [];

  for (let day = 7; day >= 0; day--) {
    const nTrips = day === 0 ? 2 : 3 + Math.floor(rand() * 3);
    const hours = [7, 9.5, 11.5, 14, 16.5, 18]
      .sort(() => rand() - 0.5)
      .slice(0, nTrips)
      .sort((a, b) => a - b);
    for (const h of hours) {
      const start = today - day * 86400_000 + h * 3600_000 + Math.floor(rand() * 40) * 60_000;
      const durationMin = 20 + Math.floor(rand() * 25);
      if (start + durationMin * 60_000 > Date.now() - 20 * 60_000) continue; // nada en el futuro ni pegado al presente
      const sim = new SimVehicle({ ...cfg, startM: rand() * route.length }, route);
      const tripId = id();
      const pts: any[] = [];
      let dist = 0;
      let maxSpeed = 0;
      let moving = 0;
      let stopped = 0;
      for (let s = 0; s <= durationMin * 60; s += STEP) {
        const p = sim.tick(STEP, STEP)!;
        const ts = new Date(start + s * 1000).toISOString();
        if (pts.length) {
          const prev = pts[pts.length - 1];
          dist += haversine([prev.lat, prev.lng], [p.lat, p.lng]);
          if (p.speed >= 2) moving += STEP;
          else stopped += STEP;
        }
        maxSpeed = Math.max(maxSpeed, p.speed);
        pts.push({ ...p, ts });
      }
      run(
        `INSERT INTO trips (id, company_id, vehicle_id, driver_id, started_at, ended_at, distance_m, max_speed, moving_seconds, stopped_seconds, points, status)
         VALUES (@id,@cid,@vid,@did,@s,@e,@dist,@max,@mv,@st,@n,'closed')`,
        {
          id: tripId,
          cid: companyId,
          vid: vehicleId,
          did: driverId,
          s: pts[0].ts,
          e: pts[pts.length - 1].ts,
          dist,
          max: maxSpeed,
          mv: moving,
          st: stopped,
          n: pts.length,
        },
      );
      // Por lotes de 80 puntos (una sentencia por punto eran ~12 000 en total: en la demo de GitHub Pages cada una
      // se compila de nuevo en el navegador y era la mayor parte del primer arranque en un celular).
      for (let i = 0; i < pts.length; i += 80) {
        const chunk = pts.slice(i, i + 80);
        run(
          `INSERT INTO positions (company_id, vehicle_id, device_id, trip_id, lat, lng, speed, heading, accuracy, battery, ignition, ts)
           VALUES ${chunk.map(() => '(?,?,?,?,?,?,?,?,?,?,1,?)').join(',')}`,
          chunk.flatMap((p) => [companyId, vehicleId, deviceId, tripId, p.lat, p.lng, p.speed, p.heading, p.accuracy, p.battery, p.ts]),
        );
      }
      lastPoint = pts[pts.length - 1];
      tripIds.push({ id: tripId, points: pts });
    }
  }

  // Alertas históricas sobre los recorridos (la mayoría atendidas)
  const kinds: { type: AlertType; priority: Priority; title: (p: string) => string; desc: string }[] = [
    {
      type: 'geofence_enter',
      priority: 'low',
      title: (p) => `${p} entró a «Supermercados la 72»`,
      desc: 'Ingreso a la geocerca de la sede.',
    },
    {
      type: 'geofence_exit',
      priority: 'medium',
      title: (p) => `${p} salió de «Zona autorizada de domicilios»`,
      desc: 'El vehículo abandonó la zona autorizada.',
    },
    {
      type: 'prolonged_stop',
      priority: 'high',
      title: (p) => `${p} lleva 12 min detenido`,
      desc: 'Parada prolongada detectada (umbral 10 min).',
    },
    {
      type: 'speeding',
      priority: 'medium',
      title: (p) => `${p} a 58 km/h`,
      desc: 'Exceso de velocidad: 58 km/h (límite 50 km/h).',
    },
    {
      type: 'signal_loss',
      priority: 'high',
      title: (p) => `Sin señal del GPS de ${p}`,
      desc: 'El dispositivo dejó de reportar durante 3 min.',
    },
    {
      type: 'route_deviation',
      priority: 'high',
      title: (p) => `${p} se desvió de la ruta autorizada`,
      desc: 'Salida del corredor «Ruta autorizada de domicilios».',
    },
  ];
  tripIds.forEach((t, i) => {
    const n = Math.floor(rand() * 3);
    for (let k = 0; k < n; k++) {
      const kind = pick(kinds);
      const p = pick(t.points);
      const recent = i >= tripIds.length - 2;
      alertsRepo.insert(companyId, {
        vehicleId,
        deviceId,
        tripId: t.id,
        type: kind.type,
        priority: kind.priority,
        title: kind.title(plate),
        description: kind.desc,
        lat: p.lat,
        lng: p.lng,
        ts: p.ts,
        attended: !(recent && rand() < 0.6),
      });
    }
  });

  if (lastPoint) {
    run(
      `INSERT INTO vehicle_live (vehicle_id, company_id, lat, lng, speed, heading, accuracy, battery, ignition, ts, stopped_since)
       VALUES (@v,@c,@lat,@lng,0,@h,5,@b,0,@ts,@ts)`,
      {
        v: vehicleId,
        c: companyId,
        lat: lastPoint.lat,
        lng: lastPoint.lng,
        h: lastPoint.heading,
        b: lastPoint.battery,
        ts: lastPoint.ts,
      },
    );
    run(`UPDATE devices SET last_seen_at=@ts, connection='offline', battery=@b WHERE id=@d`, {
      ts: lastPoint.ts,
      b: lastPoint.battery,
      d: deviceId,
    });
  }
}

/** Envolvente convexa de la ruta ampliada `bufferM` metros hacia afuera (polígono de operación). */
function operationArea(points: LatLng[], bufferM: number): LatLng[] {
  const pts = [...points].sort((a, b) => a[1] - b[1] || a[0] - b[0]);
  const cross = (o: LatLng, a: LatLng, b: LatLng) => (a[1] - o[1]) * (b[0] - o[0]) - (a[0] - o[0]) * (b[1] - o[1]);
  const half = (list: LatLng[]) => {
    const h: LatLng[] = [];
    for (const p of list) {
      while (h.length >= 2 && cross(h[h.length - 2], h[h.length - 1], p) <= 0) h.pop();
      h.push(p);
    }
    h.pop();
    return h;
  };
  const hull = [...half(pts), ...half([...pts].reverse())];
  const c: LatLng = [hull.reduce((s, p) => s + p[0], 0) / hull.length, hull.reduce((s, p) => s + p[1], 0) / hull.length];
  return hull.map((p) => {
    const b = (Math.atan2(p[1] - c[1], p[0] - c[0]) * 180) / Math.PI;
    const q = destination(p, (b + 360) % 360, bufferM);
    return [Number(q[0].toFixed(6)), Number(q[1].toFixed(6))] as LatLng;
  });
}

/** Polígono de la zona autorizada de domicilios (Laureles – Belén). */
const ZONE_LAURELES_BELEN: LatLng[] = [
  [6.2615, -75.6035],
  [6.262, -75.585],
  [6.247, -75.5815],
  [6.233, -75.586],
  [6.228, -75.599],
  [6.24, -75.608],
];

/**
 * Crea la base demo. Con `deferReports` (demo del navegador) no genera los reportes de ejemplo: devuelve la
 * función que los crea, para llamarla después del arranque y no cargar ExcelJS y PDFKit al abrir la página.
 */
export async function seed(opts: { quiet?: boolean; deferReports?: boolean } = {}): Promise<() => Promise<void>> {
  const log = (...a: unknown[]) => !opts.quiet && console.log(...a);
  const t0 = Date.now();
  log(`🌱 Creando base de datos demo en ${config.dbPath}`);
  await resetDb();
  const route = loadRoute();

  // --- Planes y empresas
  seedPlans();
  const ago = (days: number) => new Date(Date.now() - days * 86400_000).toISOString();

  const platformId = id();
  run(
    `INSERT INTO companies (id, name, nit, email, city, is_platform, created_at) VALUES (@id,'WMS Soporte','901000000-1','soporte@wms.co','Medellín',1,@ts)`,
    {
      id: platformId,
      ts: ago(200),
    },
  );

  const la72 = companiesRepo.createWithPlan({
    name: 'Supermercados la 72',
    nit: '900726272-1',
    email: 'gerencia@la72.co',
    phone: '604 444 7272',
    city: 'Medellín',
    planCode: 'pro',
    startedAt: ago(120),
  });
  run(`UPDATE companies SET address='Carrera 72 # 45-10, Laureles' WHERE id=@id`, { id: la72 });
  const trigal = companiesRepo.createWithPlan({
    name: 'Panadería El Trigal',
    nit: '901555123-4',
    email: 'admin@eltrigal.co',
    phone: '604 322 1010',
    city: 'Medellín',
    planCode: 'basico',
    startedAt: ago(60),
  });

  // Historial de facturación: periodos anteriores pagados + periodo vigente pendiente
  for (const [cid, plan, months] of [
    [la72, 'pro', 4],
    [trigal, 'basico', 2],
  ] as const) {
    const sub = companiesRepo.subscription(cid);
    run(`DELETE FROM invoices WHERE company_id=@c`, { c: cid });
    const p = plansRepo.byCode(plan)!;
    for (let m = months; m >= 1; m--) {
      const start = new Date();
      start.setUTCMonth(start.getUTCMonth() - m);
      companiesRepo.issueInvoice(cid, sub.id, p, start.toISOString(), 'paid');
    }
    const cur = new Date();
    cur.setUTCDate(Math.max(1, cur.getUTCDate() - 3));
    companiesRepo.issueInvoice(cid, sub.id, p, cur.toISOString(), 'pending');
    run(`UPDATE subscriptions SET current_period_start=@s, current_period_end=@e WHERE id=@id`, {
      s: cur.toISOString(),
      e: new Date(cur.getTime() + 30 * 86400_000).toISOString(),
      id: sub.id,
    });
  }

  // --- Usuarios (contraseña para todos: Demo1234!)
  await user(platformId, 'Andrea Soporte WMS', 'soporte@wms.co', 'support', '300 000 0000');
  await user(la72, 'Gloria Martínez', 'gerencia@la72.co', 'owner', '310 555 7201');
  const la72Admin = await user(la72, 'Duván Restrepo', 'admin@la72.co', 'admin', '310 555 7202');
  await user(la72, 'Sandra Ochoa', 'supervisor@la72.co', 'supervisor', '310 555 7203', { users: 'read' });
  const juan = await user(la72, 'Juan Pérez', 'conductor@la72.co', 'driver', '311 222 3344');
  const laura = await user(la72, 'Laura Gómez', 'laura.gomez@la72.co', 'driver', '311 222 5566');
  const carlos = await user(la72, 'Carlos Restrepo', 'carlos.restrepo@la72.co', 'driver', '311 222 7788');
  const mateo = await user(la72, 'Mateo Arango', 'mateo.arango@la72.co', 'driver', '311 222 9900');
  driverProfile(juan, la72, '1037 654 321', 'LIC-05001-88231', 'A2');
  driverProfile(laura, la72, '1017 123 456', 'LIC-05001-77120', 'B1');
  driverProfile(carlos, la72, '71 789 012', 'LIC-05001-66003', 'C2');
  driverProfile(mateo, la72, '1036 987 654', 'LIC-05001-99410', 'A2');
  const trigalAdmin = await user(trigal, 'Esteban Cárdenas', 'admin@eltrigal.co', 'owner', '320 444 1010');
  const pedro = await user(trigal, 'Pedro Londoño', 'conductor@eltrigal.co', 'driver', '320 444 2020');
  driverProfile(pedro, trigal, '98 765 432', 'LIC-05001-55120', 'B1');

  // --- Dispositivos y vehículos simulados (mismas API keys que usa el simulador)
  const driversByKey: Record<string, string> = { moto: juan, carro: laura, camion: carlos, trigal: pedro };
  const brands: Record<string, [string, string, number, string]> = {
    moto: ['Honda', 'CB 125F', 2023, 'Rojo'],
    carro: ['Renault', 'Logan', 2021, 'Gris'],
    camion: ['Chevrolet', 'NPR Reward', 2019, 'Blanco'],
    trigal: ['Renault', 'Kangoo', 2022, 'Blanco'],
  };
  const simVehicles: Record<string, { vehicleId: string; deviceId: string; companyId: string }> = {};
  for (const f of SIM_FLEET) {
    const cid = f.company === 'la72' ? la72 : trigal;
    const dev = devicesRepo.create(cid, {
      serial: f.serial,
      model: f.model,
      apiKey: f.apiKey,
      notes: `Instalado en ${f.label.toLowerCase()}`,
    });
    const [brand, model, year, color] = brands[f.key];
    const vid = vehicle(cid, {
      plate: f.plate,
      type: f.type,
      brand,
      model,
      year,
      color,
      deviceId: dev.id,
      driverId: driversByKey[f.key],
    });
    simVehicles[f.key] = { vehicleId: vid, deviceId: dev.id, companyId: cid };
  }
  // Inventario extra: moto en mantenimiento, GPS de repuesto y uno dado de baja (robado)
  const bqr = vehicle(la72, {
    plate: 'BQR27F',
    type: 'moto',
    brand: 'Yamaha',
    model: 'XTZ 150',
    year: 2022,
    color: 'Azul',
    status: 'maintenance',
    driverId: mateo,
  });
  devicesRepo.create(la72, {
    serial: '860123450000505',
    model: 'Coban GPS303G',
    status: 'inactive',
    notes: 'Repuesto en bodega',
  });
  const stolen = devicesRepo.create(la72, {
    serial: '860123450000099',
    model: 'Coban TK103',
    notes: 'Equipo de la moto robada (caso original)',
  });
  devicesRepo.retire(la72, stolen.id, 'robado');

  // La moto en mantenimiento queda estacionada en la sede (sin GPS: última posición registrada a mano)
  const parked = destination(LA72, 200, 45);
  run(
    `INSERT INTO vehicle_live (vehicle_id, company_id, lat, lng, speed, heading, accuracy, battery, ignition, ts, stopped_since)
     VALUES (@v,@c,@lat,@lng,0,0,10,NULL,0,@ts,@ts)`,
    { v: bqr, c: la72, lat: parked[0], lng: parked[1], ts: ago(0.2) },
  );

  // Mateo comparte la ubicación de su celular (sin GPS dedicado): aparece en el mapa del administrador.
  const phone = destination(LA72, 70, 190);
  driversRepo.saveLocation(la72, mateo, { lat: phone[0], lng: phone[1], accuracy: 12, speed: 0, heading: null, ts: ago(0.002) });

  // --- Geocercas
  // Área de operación: envuelve toda la ruta, así cada vehículo demo está siempre dentro de una geocerca.
  const area = operationArea(route.points, 600);
  geofencesRepo.create(la72, {
    name: 'Área de operación – Medellín',
    description: 'Zona donde opera la flota de la 72 (Poblado, Centro, U. de A., Laureles).',
    shape: 'polygon',
    coordinates: area,
    color: '#5856D6',
  });
  // El furgón de El Trigal recorre la misma ruta fija del simulador, así que su zona de reparto también la
  // envuelve (si no, quedaría fuera de toda geocerca), pero con polígono propio y un margen más amplio.
  geofencesRepo.create(trigal, {
    name: 'Zona de reparto El Trigal',
    description: 'Cobertura de entregas de la panadería.',
    shape: 'polygon',
    coordinates: operationArea(route.points, 1100),
    color: '#30B0C7',
  });
  const corridor = route.points.filter((_, i) => i % 3 === 0);
  const g72 = geofencesRepo.create(la72, {
    name: 'Supermercados la 72',
    description: 'Sede principal (Carrera 72, Laureles). Punto de cargue de domicilios.',
    shape: 'circle',
    center: LA72,
    radiusM: 220,
    color: '#34C759',
  });
  const gZone = geofencesRepo.create(la72, {
    name: 'Zona autorizada de domicilios (Laureles–Belén)',
    description: 'Área donde la moto puede hacer entregas sin autorización adicional.',
    shape: 'polygon',
    coordinates: ZONE_LAURELES_BELEN,
    color: '#007AFF',
    vehicleIds: [simVehicles.moto.vehicleId],
  });
  const gRoute = geofencesRepo.create(la72, {
    name: 'Ruta autorizada de domicilios',
    description: 'Corredor de 120 m alrededor de la ruta fija Poblado – Centro – Laureles.',
    shape: 'corridor',
    coordinates: [...corridor, route.points[route.points.length - 1]],
    radiusM: 120,
    color: '#AF52DE',
  });
  const gTrigal = geofencesRepo.create(trigal, {
    name: 'Panadería El Trigal – Estadio',
    shape: 'circle',
    center: destination([6.25535, -75.5877], 90, 60),
    radiusM: 200,
    color: '#FF9500',
  });

  // --- Reglas de alerta (umbrales cortos en modo demo)
  const demo = config.demoMode;
  const rule = (cid: string, r: Parameters<typeof alertsRepo.createRule>[1]) => alertsRepo.createRule(cid, r);
  rule(la72, {
    name: 'Llegada a la sede',
    type: 'geofence_enter',
    geofenceId: g72.id,
    channels: ['inapp'],
    priority: 'low',
  });
  rule(la72, {
    name: 'Salida de la sede',
    type: 'geofence_exit',
    geofenceId: g72.id,
    channels: ['inapp', 'push'],
    priority: 'low',
  });
  rule(la72, {
    name: 'Moto fuera de la zona de domicilios',
    type: 'geofence_exit',
    geofenceId: gZone.id,
    vehicleIds: [simVehicles.moto.vehicleId],
    channels: ['inapp', 'email'],
    recipients: ['gerencia@la72.co'],
    priority: 'medium',
  });
  rule(la72, {
    name: 'Parada prolongada',
    type: 'prolonged_stop',
    threshold: demo ? 25 : 600,
    channels: ['inapp', 'email', 'push'],
    recipients: ['supervisor@la72.co'],
    priority: 'high',
  });
  rule(la72, {
    name: 'Falla o pérdida de señal del GPS',
    type: 'signal_loss',
    threshold: demo ? 20 : 180,
    channels: ['inapp', 'email', 'push'],
    recipients: ['admin@la72.co', 'gerencia@la72.co'],
    priority: 'high',
  });
  rule(la72, {
    name: 'Desvío de la ruta autorizada',
    type: 'route_deviation',
    geofenceId: gRoute.id,
    channels: ['inapp', 'email', 'push'],
    recipients: ['supervisor@la72.co'],
    priority: 'high',
  });
  rule(la72, {
    name: 'Exceso de velocidad',
    type: 'speeding',
    threshold: 50,
    channels: ['inapp'],
    priority: 'medium',
  });
  rule(la72, {
    name: 'Movimiento no autorizado (robo)',
    type: 'theft',
    threshold: 5,
    channels: ['inapp', 'email', 'push'],
    recipients: ['gerencia@la72.co', 'admin@la72.co'],
    priority: 'critical',
  });
  rule(la72, {
    name: 'Batería baja del GPS',
    type: 'low_battery',
    threshold: 20,
    channels: ['inapp'],
    priority: 'low',
  });
  rule(trigal, {
    name: 'Llegada a la panadería',
    type: 'geofence_enter',
    geofenceId: gTrigal.id,
    channels: ['inapp'],
    priority: 'low',
  });
  rule(trigal, {
    name: 'Parada prolongada',
    type: 'prolonged_stop',
    threshold: demo ? 25 : 600,
    channels: ['inapp', 'email'],
    recipients: ['admin@eltrigal.co'],
    priority: 'high',
  });
  rule(trigal, {
    name: 'Pérdida de señal del GPS',
    type: 'signal_loss',
    threshold: demo ? 20 : 180,
    channels: ['inapp', 'email'],
    recipients: ['admin@eltrigal.co'],
    priority: 'high',
  });

  // --- Histórico de 7 días
  log('🛣️  Generando 7 días de recorridos y alertas…');
  tx(() => {
    for (const f of SIM_FLEET) {
      const s = simVehicles[f.key];
      seedHistory(s.companyId, s.vehicleId, s.deviceId, driversByKey[f.key], f.key, f.plate);
    }
  });

  // Bandeja de notificaciones con algunos envíos simulados
  alertsRepo.insertNotification(la72, {
    channel: 'email',
    recipient: 'gerencia@la72.co',
    subject: '[WMS] Bienvenida a WMS Pro',
    body: 'Tu suscripción al plan Pro está activa.',
  });

  // --- Reportes de ejemplo
  const sampleReports = async () => {
    log('📄 Generando reportes de ejemplo (PDF y Excel)…');
    const periodEnd = new Date().toISOString();
    const periodStart = new Date(bogotaDayStart().getTime() - 7 * 86400_000).toISOString();
    for (const r of [
      { name: 'Informe semanal de la flota', type: 'full' as const, format: 'pdf' as const, vehicleId: null },
      {
        name: 'Recorridos de la moto de domicilios',
        type: 'trips' as const,
        format: 'xlsx' as const,
        vehicleId: simVehicles.moto.vehicleId,
      },
    ]) {
      const p = { ...r, driverId: null, periodStart, periodEnd };
      const { content, summary } = await buildReport(la72, p);
      run(
        `INSERT INTO reports (id, company_id, created_by, name, type, format, vehicle_id, driver_id, period_start, period_end, summary, content, size_bytes, version, generated_at)
         VALUES (@id,@cid,@uid,@name,@type,@format,@vehicle,NULL,@ps,@pe,@summary,@content,@size,1,@ts)`,
        {
          id: id(),
          cid: la72,
          uid: la72Admin,
          name: p.name,
          type: p.type,
          format: p.format,
          vehicle: p.vehicleId,
          ps: periodStart,
          pe: periodEnd,
          summary: JSON.stringify(summary),
          content,
          size: content.length,
          ts: ago(0.1),
        },
      );
    }
  };
  if (!opts.deferReports) await sampleReports();

  // --- Tickets de soporte
  const ticket = (
    cid: string,
    by: string,
    n: number,
    subject: string,
    description: string,
    category: string,
    priority: string,
    status: string,
    comments: [string, string][] = [],
  ) => {
    const tid = id();
    run(
      `INSERT INTO tickets (id, company_id, number, created_by, subject, description, category, priority, status, created_at, updated_at)
       VALUES (@id,@cid,@n,@by,@subject,@description,@category,@priority,@status,@ts,@ts)`,
      { id: tid, cid, n, by, subject, description, category, priority, status, ts: ago(3 - n / 1000) },
    );
    comments.forEach(([author, body], i) =>
      run(
        `INSERT INTO ticket_comments (id, ticket_id, author_id, body, created_at) VALUES (@id,@t,@a,@b,@ts)`,
        { id: id(), t: tid, a: author, b: body, ts: ago(2.5 - i * 0.2) },
      ),
    );
  };
  const supportUser = get<any>(`SELECT id FROM users WHERE email='soporte@wms.co'`)!.id;
  ticket(
    la72,
    la72Admin,
    1001,
    'El GPS del camión se desconecta en el túnel',
    'Cuando el camión SXK913 pasa por la Av. Regional bajo el puente pierde señal y nos llega la alerta. ¿Es normal?',
    'gps',
    'medium',
    'resolved',
    [
      [
        supportUser,
        'Hola Duván, es normal en pasos a desnivel. Ajustamos el umbral recomendado de pérdida de señal a 3 minutos para producción.',
      ],
      [la72Admin, '¡Gracias! Quedó claro.'],
    ],
  );
  ticket(
    la72,
    la72Admin,
    1002,
    'Quiero agregar 5 motos más',
    '¿Puedo agregarlas en el plan Pro o debo cambiar de plan?',
    'facturacion',
    'low',
    'open',
  );
  ticket(
    trigal,
    trigalAdmin,
    1003,
    'No veo el reporte en Excel',
    'En el plan Básico no encuentro la opción de Excel.',
    'reportes',
    'medium',
    'in_progress',
    [[supportUser, 'Hola Esteban, lo estamos revisando.']],
  );

  run(`INSERT INTO simulator_state (id, state) VALUES (1, @s)`, {
    s: JSON.stringify({ paused: false, speedFactor: 1, scenarios: [] }),
  });

  const counts = get<any>(
    `SELECT (SELECT COUNT(*) FROM positions) p, (SELECT COUNT(*) FROM trips) t, (SELECT COUNT(*) FROM alerts) a`,
  );
  if (isTursoEnabled()) {
    log(`??  Sincronizando datos con Turso Cloud (${config.tursoUrl})?`);
    await flushTurso();
  }
  closeDb();
  log(
    `✅ Seed listo en ${((Date.now() - t0) / 1000).toFixed(1)} s: ${counts.t} recorridos, ${counts.p} posiciones, ${counts.a} alertas.`,
  );
  log(
    `   Credenciales demo (contraseña ${DEMO_PASSWORD}): admin@la72.co · gerencia@la72.co · supervisor@la72.co · conductor@la72.co · admin@eltrigal.co · soporte@wms.co`,
  );
  return sampleReports;
}

// En el navegador (demo de GitHub Pages) no existe `require`: allí el seed lo invoca src/demo.
if (typeof module !== 'undefined' && typeof require !== 'undefined' && require.main === module) {
  seed().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
