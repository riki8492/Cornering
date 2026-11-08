import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  deriveVehicle,
  solveCorner,
  evaluateCorner,
  makeSpeedLookup,
  gradeFromElevations,
  DEFAULT_ENV,
} from '../js/physics.js';
import {
  decodeGsiDemPng,
  decodeTerrariumPng,
  tileCoord,
  DemElevation,
  elevationProfile,
  gradeBetween,
} from '../js/elevation.js';
import { makeProjector } from '../js/geo.js';
import { RoadTracker } from '../js/roadmap.js';
import { buildDemoCourse, demoWays, demoElevation } from '../js/sim.js';

const dry = { ...DEFAULT_ENV, surface: 'dry' };
const snow = { ...DEFAULT_ENV, surface: 'snow' };

// ---------- 物理 ----------

test('入口・出口の標高とカーブ長から勾配を求める', () => {
  assert.equal(gradeFromElevations(500, 494, 100), -6);
  assert.equal(gradeFromElevations(null, 494, 100), null);
  assert.equal(gradeFromElevations(500, 494, 0), null);
});

test('上り勾配では FF のフロントが抜けて限界が下がる', () => {
  const ff = deriveVehicle({ massKg: 1100, frontAxleKg: 680, rearAxleKg: 420, drivetrain: 'FF' });
  const flat = solveCorner(50, ff, dry);
  const up = solveCorner(50, ff, { ...dry, gradePct: 12 });
  assert.ok(up.vLimit < flat.vLimit - 1 / 3.6, `${up.vLimit * 3.6} vs ${flat.vLimit * 3.6}`);
  assert.equal(up.limitedBy, 'front');
});

test('上りでは駆動を前後で分担する 4WD の方が FF より落ち込みが小さい', () => {
  const base = { massKg: 1400, frontAxleKg: 840, rearAxleKg: 560 };
  const loss = (dt) => {
    const v = deriveVehicle({ ...base, drivetrain: dt });
    return solveCorner(50, v, dry).vLimit - solveCorner(50, v, { ...dry, gradePct: 12 }).vLimit;
  };
  assert.ok(loss('AWD') < loss('FF'));
});

test('上りは後ろ、下りは前に荷重が移る', () => {
  const veh = deriveVehicle({});
  const v = 15;
  const flat = evaluateCorner(v, 80, veh, dry);
  const up = evaluateCorner(v, 80, veh, { ...dry, gradePct: 10 });
  const down = evaluateCorner(v, 80, veh, { ...dry, gradePct: -10 });
  assert.ok(up.frontLoad < flat.frontLoad && up.rearLoad > flat.rearLoad);
  assert.ok(down.frontLoad > flat.frontLoad && down.rearLoad < flat.rearLoad);
  assert.ok(down.fx < 0, '急な下りでは速度を保つのにブレーキが要る');
});

test('FR の急な下りコーナーではリアが先に限界を迎える', () => {
  const fr = deriveVehicle({ massKg: 1260, frontAxleKg: 660, rearAxleKg: 600, drivetrain: 'FR', tire: 'sport', lsd: true });
  assert.equal(solveCorner(50, fr, { ...dry, gradePct: -12 }).limitedBy, 'rear');
});

test('雪道＋夏タイヤ：急な下りは止まれず、上りは登れない', () => {
  const veh = deriveVehicle({ tire: 'standard' });
  const down = solveCorner(50, veh, { ...snow, gradePct: -15 });
  assert.equal(down.vLimit, 0);
  assert.equal(down.limitedBy, 'braking');
  const up = solveCorner(50, veh, { ...snow, gradePct: 10 });
  assert.equal(up.vLimit, 0);
  assert.equal(up.limitedBy, 'traction');
  // スタッドレスなら 6% の上りは登れる
  const sl = solveCorner(50, deriveVehicle({ tire: 'studless' }), { ...snow, gradePct: 6 });
  assert.ok(sl.vLimit > 5);
});

test('勾配つき速度表の補間は直接計算とほぼ一致', () => {
  const veh = deriveVehicle({});
  const lookup = makeSpeedLookup(veh, dry);
  for (const [R, g] of [
    [40, -5.5],
    [120, 3.2],
    [60, 0],
  ]) {
    const d = solveCorner(R, veh, { ...dry, gradePct: g });
    const t = lookup(R, g);
    assert.ok(Math.abs(t.vLimit - d.vLimit) / d.vLimit < 0.01, `R=${R} g=${g}`);
  }
});

// ---------- 標高タイル ----------

test('地理院 DEM PNG のデコード（正・負・無効値）', () => {
  const px = (v) => {
    const n = Math.round(v * 100);
    const u = n < 0 ? n + 16777216 : n;
    return [(u >> 16) & 255, (u >> 8) & 255, u & 255, 255];
  };
  const rgba = new Uint8ClampedArray([...px(723.45), ...px(-3.5), 128, 0, 0, 255, 0, 0, 0, 0]);
  const e = decodeGsiDemPng(rgba);
  assert.ok(Math.abs(e[0] - 723.45) < 1e-3);
  assert.ok(Math.abs(e[1] + 3.5) < 1e-3);
  assert.ok(Number.isNaN(e[2]) && Number.isNaN(e[3]));
});

test('Terrarium PNG のデコード', () => {
  const v = 1234.5 + 32768;
  const rgba = new Uint8ClampedArray([Math.floor(v / 256), Math.floor(v) % 256, Math.round((v % 1) * 256), 255]);
  assert.ok(Math.abs(decodeTerrariumPng(rgba)[0] - 1234.5) < 0.01);
});

/** 緯度経度の関数から作った合成タイルを返すローダー */
function syntheticLoader(fn) {
  return async (z, x, y) => {
    const n = 2 ** z;
    const data = new Float32Array(256 * 256);
    for (let py = 0; py < 256; py++) {
      for (let px = 0; px < 256; px++) {
        const lon = ((x + (px + 0.5) / 256) / n) * 360 - 180;
        const yy = y + (py + 0.5) / 256;
        const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * yy) / n))) * 180) / Math.PI;
        data[py * 256 + px] = fn(lat, lon);
      }
    }
    return data;
  };
}

test('DemElevation：初回は読み込みを始めて null、読み込み後は補間した標高を返す', async () => {
  const origin = { lat: 35.36, lon: 138.73 };
  const proj = makeProjector(origin.lat, origin.lon);
  const plane = (lat, lon) => {
    const p = proj.toXY(lat, lon);
    return 500 + 0.08 * p.y; // 北へ 8% の上り
  };
  const dem = new DemElevation({ loadTile: syntheticLoader(plane) });
  assert.equal(dem.get(origin.lat, origin.lon), null);
  assert.equal(dem.status, 'loading');
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(dem.status, 'ready');
  const a = proj.toLatLon(0, -50);
  const b = proj.toLatLon(0, 50);
  const ea = dem.get(a.lat, a.lon);
  const eb = dem.get(b.lat, b.lon);
  assert.ok(Math.abs(ea - 496) < 0.5 && Math.abs(eb - 504) < 0.5, `${ea} ${eb}`);
  const t = tileCoord(origin.lat, origin.lon, 14);
  assert.ok(t.x > 0 && t.y > 0);
});

test('標高プロファイル：橋・トンネル区間は前後から直線補間する', () => {
  const pts = Array.from({ length: 21 }, (_, i) => ({ x: 0, y: i * 5, st: i >= 8 && i <= 12 }));
  // 地表は 100m だが、トンネル区間の真上は山（200m）
  const elev = (lat, lon) => lat; // toLatLon で y をそのまま渡す
  const ground = (x, y) => ({ lat: y >= 40 && y <= 60 ? 200 : 100, lon: 0 });
  const e = elevationProfile(pts, ground, elev, 5, 0.1);
  assert.ok(e.every((v) => Math.abs(v - 100) < 1e-9), '山の標高を拾わない');
  assert.equal(gradeBetween(e, 0, 20, 5), 0);
});

test('RoadTracker：デモ峠道でカーブの入口・出口標高と勾配を求める', () => {
  const origin = { lat: 35.36, lon: 138.73 };
  const course = buildDemoCourse();
  const elevation = demoElevation(course, origin);
  const tracker = new RoadTracker({ elevation });
  tracker.setStaticNetwork(demoWays(course, origin), origin);
  const proj = makeProjector(origin.lat, origin.lon);
  const p = proj.toLatLon(0, 100);
  const r = tracker.update({ lat: p.lat, lon: p.lon, accuracy: 5 }, { speed: 40, heading: 0 });
  assert.ok(r.hasElevation);
  const c = r.curves[0];
  assert.ok(c.entryElev != null && c.exitElev > c.entryElev, '前半は上り');
  // 期待値：コース上の距離から求めた真の標高差 / カーブ長
  const s0 = 100 + c.distStart;
  const s1 = 100 + c.distEnd;
  const expected = ((elevation.elevAtS(s1) - elevation.elevAtS(s0)) / (s1 - s0)) * 100;
  assert.ok(Math.abs(c.gradePct - expected) < 1, `${c.gradePct} vs ${expected}`);
  assert.ok(r.gradeHere > 3, `gradeHere=${r.gradeHere}`);
});
