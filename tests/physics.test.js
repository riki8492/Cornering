import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  G,
  deriveVehicle,
  solveCorner,
  evaluateCorner,
  rolloverSpeed,
  speedForRatio,
  buildSpeedTable,
  roadDesignSpeedKmh,
  lowSpeedGeometry,
  DEFAULT_ENV,
} from '../js/physics.js';

const dry = { ...DEFAULT_ENV, surface: 'dry', bankPct: 0 };
const kmh = (v) => v * 3.6;

test('荷重感度・荷重移動・抵抗を消すと v = √(μgR) に一致する', () => {
  const veh = deriveVehicle({ massKg: 1300, tire: 'standard', cgHeightMm: 1 });
  // 理想化：荷重感度ゼロ、抵抗ゼロ
  veh.tire = { ...veh.tire, loadSens: 0, alphaPeakDeg: 0 };
  veh.cd = 0;
  const env = { ...dry, surface: 'ice' }; // crr を使わない代わりに μ の小さい路面で比較
  const R = 50;
  const mu = veh.tire.mu.ice;
  const s = solveCorner(R, veh, env);
  // 転がり抵抗ぶんだけわずかに低いはず
  const ideal = Math.sqrt(mu * G * R);
  assert.ok(s.vLimit <= ideal + 1e-6);
  assert.ok(s.vLimit > ideal * 0.97, `${s.vLimit} vs ${ideal}`);
});

test('一般的な乗用車：乾燥路 R=100m で 100〜115 km/h 程度', () => {
  const veh = deriveVehicle({});
  const s = solveCorner(100, veh, dry);
  const v = kmh(s.vLimit);
  assert.ok(v > 95 && v < 118, `vLimit=${v}`);
  assert.ok(s.aLatG > 0.75 && s.aLatG < 0.95, `aLatG=${s.aLatG}`);
  assert.ok(s.vRec < s.vLimit);
});

test('R が大きいほど速く、濡れた路面・凍結は遅い', () => {
  const veh = deriveVehicle({});
  const v30 = solveCorner(30, veh, dry).vLimit;
  const v100 = solveCorner(100, veh, dry).vLimit;
  assert.ok(v100 > v30);
  const wet = solveCorner(100, veh, { ...dry, surface: 'wet' }).vLimit;
  const ice = solveCorner(100, veh, { ...dry, surface: 'ice' }).vLimit;
  assert.ok(wet < v100 && ice < wet);
});

test('同じタイヤなら重い車ほど限界が下がる（荷重感度）', () => {
  const light = deriveVehicle({ massKg: 900, frontAxleKg: 560, rearAxleKg: 340 });
  const heavy = deriveVehicle({ massKg: 2000, frontAxleKg: 1150, rearAxleKg: 850 });
  assert.ok(solveCorner(60, light, dry).vLimit > solveCorner(60, heavy, dry).vLimit);
});

test('タイヤ幅を太くすると限界がわずかに上がる', () => {
  const narrow = deriveVehicle({ tireWidthMm: 175 });
  const wide = deriveVehicle({ tireWidthMm: 245 });
  assert.ok(solveCorner(60, wide, dry).vLimit > solveCorner(60, narrow, dry).vLimit);
});

test('ハイグリップタイヤは速く、スタッドレスは乾燥路で遅い', () => {
  const hg = deriveVehicle({ tire: 'highgrip' });
  const st = deriveVehicle({ tire: 'standard' });
  const sl = deriveVehicle({ tire: 'studless' });
  const R = 60;
  assert.ok(solveCorner(R, hg, dry).vLimit > solveCorner(R, st, dry).vLimit);
  assert.ok(solveCorner(R, sl, dry).vLimit < solveCorner(R, st, dry).vLimit);
  // 雪ではスタッドレスが勝つ
  const snow = { ...dry, surface: 'snow' };
  assert.ok(solveCorner(R, sl, snow).vLimit > solveCorner(R, st, snow).vLimit);
});

test('背が高い車ほど（重心が高いほど）限界が下がる', () => {
  const low = deriveVehicle({ heightMm: 1300 });
  const tall = deriveVehicle({ heightMm: 1900 });
  assert.ok(solveCorner(60, low, dry).vLimit > solveCorner(60, tall, dry).vLimit);
  assert.ok(tall.ssf < low.ssf);
});

test('背が高く幅の狭い車 + 高グリップでは転覆限界が支配する', () => {
  // オープンデフだと先に内輪が浮いて空転するので LSD 付きで比較
  const veh = deriveVehicle({ widthMm: 1475, heightMm: 2000, tire: 'semislick', lsd: true });
  const s = solveCorner(40, veh, dry);
  assert.equal(s.limitedBy, 'rollover');
  assert.ok(Math.abs(s.vLimit - rolloverSpeed(40, veh, dry)) < 0.05);
});

test('片勾配（バンク）があると上限速度が上がる', () => {
  const veh = deriveVehicle({});
  const flat = solveCorner(80, veh, dry).vLimit;
  const banked = solveCorner(80, veh, { ...dry, bankPct: 8 }).vLimit;
  const adverse = solveCorner(80, veh, { ...dry, bankPct: -4 }).vLimit;
  assert.ok(banked > flat && adverse < flat);
});

test('高速域の大きな R では 4WD が FF を上回る（駆動力が摩擦円を食うため）', () => {
  const base = { massKg: 1500, frontAxleKg: 900, rearAxleKg: 600 };
  const ff = deriveVehicle({ ...base, drivetrain: 'FF' });
  const awd = deriveVehicle({ ...base, drivetrain: 'AWD' });
  const R = 400;
  assert.ok(solveCorner(R, awd, dry).vLimit > solveCorner(R, ff, dry).vLimit);
});

test('フロントヘビーの FF はフロントが先に限界を迎える', () => {
  const veh = deriveVehicle({ massKg: 1300, frontAxleKg: 850, rearAxleKg: 450, drivetrain: 'FF' });
  assert.equal(solveCorner(50, veh, dry).limitedBy, 'front');
});

test('前後軸重から重量配分を求め、片方だけなら車両重量から補う', () => {
  assert.ok(Math.abs(deriveVehicle({ frontAxleKg: 600, rearAxleKg: 400, payloadKg: 0 }).frontRatio - 0.6) < 1e-9);
  const v = deriveVehicle({ massKg: 1000, frontAxleKg: 550, rearAxleKg: null, payloadKg: 0 });
  assert.ok(Math.abs(v.frontRatio - 0.55) < 1e-9);
  const d = deriveVehicle({ massKg: 1000, frontAxleKg: null, rearAxleKg: null, drivetrain: 'MR', payloadKg: 0 });
  assert.equal(d.axleSource, 'drivetrain');
  assert.ok(d.frontRatio < 0.5);
});

test('推奨速度は安全係数に応じて下がる', () => {
  const veh = deriveVehicle({});
  const a = solveCorner(80, veh, { ...dry, safety: 0.8 });
  const b = solveCorner(80, veh, { ...dry, safety: 0.4 });
  assert.ok(a.vRec > b.vRec);
  // 平坦路では横G比がそのまま速度の2乗比になる
  assert.ok(Math.abs((b.vRec / b.vLimit) ** 2 - 0.4) < 0.01);
});

test('speedForRatio は平坦路で √(rgR)', () => {
  assert.ok(Math.abs(speedForRatio(100, 0.5, 0) - Math.sqrt(0.5 * G * 100)) < 1e-9);
});

test('速度表の補間は直接計算とほぼ一致', () => {
  const veh = deriveVehicle({});
  const tbl = buildSpeedTable(veh, dry);
  for (const R of [12, 37, 85, 240, 900]) {
    const direct = solveCorner(R, veh, dry);
    const t = tbl.lookup(R);
    assert.ok(Math.abs(t.vLimit - direct.vLimit) / direct.vLimit < 0.01, `R=${R}`);
  }
  assert.equal(tbl.lookup(Infinity).vLimit, Infinity);
});

test('道路構造令：R=150m（片勾配6%）は設計速度 60km/h 相当', () => {
  const v = roadDesignSpeedKmh(150, 6);
  assert.ok(Math.abs(v - 60) < 1.5, `${v}`);
  const v2 = roadDesignSpeedKmh(460, 6);
  assert.ok(Math.abs(v2 - 100) < 2, `${v2}`);
});

test('低速の幾何：R が小さいほど舵角・内輪差が大きく、最小回転半径未満は曲がれない', () => {
  const veh = deriveVehicle({});
  const a = lowSpeedGeometry(8, veh);
  const b = lowSpeedGeometry(50, veh);
  assert.ok(a.steerDeg > b.steerDeg && a.offTracking > b.offTracking);
  assert.ok(a.feasible);
  assert.equal(lowSpeedGeometry(3.3, veh).feasible, false);
  // カタログの最小回転半径で上書きできる
  const big = deriveVehicle({ minTurnRadiusM: 6.5 });
  assert.equal(lowSpeedGeometry(5, big).feasible, false);
  assert.ok(Math.abs(veh.minTurnRadius - 4.94) < 0.1);
});

test('オープンデフ＋背の高い車は内輪が浮いて空転、LSD なら転覆まで粘る', () => {
  const base = { widthMm: 1475, heightMm: 2000, tire: 'semislick', drivetrain: 'FF' };
  const open = solveCorner(40, deriveVehicle({ ...base, lsd: false }), dry);
  const lsd = solveCorner(40, deriveVehicle({ ...base, lsd: true }), dry);
  assert.equal(open.limitedBy, 'traction');
  assert.ok(lsd.vLimit > open.vLimit);
});

test('evaluateCorner：限界以下では成立、限界を超えると不成立', () => {
  const veh = deriveVehicle({});
  const s = solveCorner(60, veh, dry);
  assert.ok(evaluateCorner(s.vLimit * 0.98, 60, veh, dry).ok);
  assert.ok(!evaluateCorner(s.vLimit * 1.02, 60, veh, dry).ok);
});
