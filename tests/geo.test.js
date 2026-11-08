import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  makeProjector,
  haversine,
  fitCircle,
  resample,
  curvatureProfile,
  findCurves,
  signedCurvature3,
  polylineLength,
} from '../js/geo.js';
import { RoadNetwork, RoadTracker } from '../js/roadmap.js';
import { MotionTracker } from '../js/sensors.js';
import { buildDemoCourse, demoWays } from '../js/sim.js';

const arc = (R, from, to, n, cx = 0, cy = 0) =>
  Array.from({ length: n }, (_, i) => {
    const a = from + ((to - from) * i) / (n - 1);
    return { x: cx + R * Math.cos(a), y: cy + R * Math.sin(a) };
  });

test('投影と逆投影が往復で一致し、距離が haversine と合う', () => {
  const p = makeProjector(35.68, 139.76);
  const q = p.toXY(35.69, 139.77);
  const back = p.toLatLon(q.x, q.y);
  assert.ok(Math.abs(back.lat - 35.69) < 1e-9 && Math.abs(back.lon - 139.77) < 1e-9);
  const d = Math.hypot(q.x, q.y);
  const h = haversine(35.68, 139.76, 35.69, 139.77);
  assert.ok(Math.abs(d - h) / h < 0.002);
});

test('3点曲率：左カーブが正', () => {
  const k = signedCurvature3({ x: 0, y: 0 }, { x: 10, y: 1 }, { x: 20, y: 4 });
  assert.ok(k > 0);
  const pts = arc(50, 0, 1, 3);
  assert.ok(Math.abs(signedCurvature3(...pts) - 1 / 50) < 1e-9);
});

test('円フィッティングで半径を復元できる（ノイズあり）', () => {
  const pts = arc(80, 0, 1.2, 12).map((p, i) => ({ x: p.x + (i % 2 ? 0.8 : -0.8), y: p.y }));
  const c = fitCircle(pts);
  assert.ok(Math.abs(c.r - 80) < 4, `r=${c.r}`);
});

test('再サンプリングは等間隔で全長を保つ', () => {
  const pts = [
    { x: 0, y: 0 },
    { x: 13, y: 0 },
    { x: 13, y: 7 },
  ];
  const r = resample(pts, 5);
  assert.equal(r.length, 5); // 0,5,10,15,20
  for (let i = 1; i < r.length; i++) {
    assert.ok(Math.abs(polylineLength([r[i - 1], r[i]]) - 5) < 1.5);
  }
});

test('曲率プロファイルとカーブ抽出：直線→R=40右→直線', () => {
  const pts = [];
  for (let i = 0; i <= 100; i += 2) pts.push({ x: 0, y: i });
  // 右カーブ（中心は x=+40）
  for (const p of arc(40, Math.PI, Math.PI / 2, 40, 40, 100).slice(1)) pts.push(p);
  const end = pts[pts.length - 1];
  for (let i = 2; i <= 100; i += 2) pts.push({ x: end.x + i, y: end.y });
  const r = resample(pts, 5);
  const k = curvatureProfile(r, 5, 15);
  const curves = findCurves(k, 5);
  assert.equal(curves.length, 1);
  assert.equal(curves[0].dir, 'right');
  assert.ok(Math.abs(curves[0].R - 40) < 6, `R=${curves[0].R}`);
});

test('道路網：マッチングと接続先への道なり追跡', () => {
  const origin = { lat: 35, lon: 139 };
  const proj = makeProjector(origin.lat, origin.lon);
  const ll = (x, y) => proj.toLatLon(x, y);
  // way1: 南→北に 200m、終点 node 3 で way2（東へ）と way3（西へ急角度）に接続
  const ways = [
    { id: 1, nodes: [1, 2, 3], geometry: [ll(0, 0), ll(0, 100), ll(0, 200)], tags: { highway: 'primary', name: 'A' } },
    { id: 2, nodes: [3, 4, 5], geometry: [ll(0, 200), ll(30, 290), ll(60, 380)], tags: { highway: 'primary', name: 'A' } },
    { id: 3, nodes: [3, 6], geometry: [ll(0, 200), ll(-100, 210)], tags: { highway: 'residential' } },
  ];
  const net = new RoadNetwork(ways, origin);
  const m = net.match({ x: 3, y: 50 }, 2, null);
  assert.equal(net.ways[m.w].id, 1);
  assert.equal(m.dir, 1);
  const w = net.walk(m, m.dir, 250);
  assert.ok(Math.abs(w.length - 250) < 1e-6);
  assert.deepEqual(
    w.ways.map((i) => net.ways[i].id),
    [1, 2],
  );
  // 逆向きに走っていれば dir = -1
  const m2 = net.match({ x: -2, y: 120 }, 181, null);
  assert.equal(m2.dir, -1);
});

test('一方通行の反対車線にはマッチしない', () => {
  const origin = { lat: 35, lon: 139 };
  const proj = makeProjector(origin.lat, origin.lon);
  const ll = (x, y) => proj.toLatLon(x, y);
  const ways = [
    // 北行き車線（x=+6）と南行き車線（x=-6）
    { id: 10, nodes: [1, 2], geometry: [ll(6, 0), ll(6, 300)], tags: { highway: 'trunk', oneway: 'yes' } },
    { id: 11, nodes: [3, 4], geometry: [ll(-6, 300), ll(-6, 0)], tags: { highway: 'trunk', oneway: 'yes' } },
  ];
  const net = new RoadNetwork(ways, origin);
  // GPS は南行き車線寄りだが、北向きに走っている
  const m = net.match({ x: -4, y: 150 }, 0, null);
  assert.equal(net.ways[m.w].id, 10);
});

test('RoadTracker：デモコースで前方のカーブを検出する', () => {
  const origin = { lat: 35.36, lon: 138.73 };
  const course = buildDemoCourse();
  const ways = demoWays(course, origin);
  const tracker = new RoadTracker();
  tracker.setStaticNetwork(ways, origin);
  const proj = makeProjector(origin.lat, origin.lon);
  // スタートから 100m 地点（直線上）を北向きに走行中
  const p = proj.toLatLon(0, 100);
  // 40 m/s → 先読み 480m（R=150 の右と R=60 の左まで）
  const r = tracker.update({ lat: p.lat, lon: p.lon, accuracy: 5 }, { speed: 40, heading: 0 });
  assert.ok(r, 'マッチすること');
  assert.ok(r.curves.length >= 1);
  const next = r.curves[0];
  assert.equal(next.dir, 'right');
  assert.ok(next.distStart > 100 && next.distStart < 200, `distStart=${next.distStart}`);
  assert.ok(Math.abs(next.R - 150) < 30, `R=${next.R}`);
  const second = r.curves[1];
  assert.equal(second.dir, 'left');
  assert.ok(Math.abs(second.R - 60) < 12, `R2=${second.R}`);
  assert.ok(Math.abs(second.distStart - 375) < 25, `distStart2=${second.distStart}`);
});

test('MotionTracker：一定半径の円を走ると GPS コースから R を推定できる', () => {
  const mt = new MotionTracker();
  const origin = makeProjector(35, 139);
  const R = 60;
  const v = 15;
  const omega = v / R;
  for (let t = 0; t <= 12; t++) {
    const a = omega * t;
    // 時計回り（右カーブ）
    const x = R * Math.sin(a);
    const y = R * Math.cos(a) - R;
    const ll = origin.toLatLon(x, -y);
    const heading = ((a * 180) / Math.PI + 90) % 360;
    mt.addFix({ t, lat: ll.lat, lon: ll.lon, speed: v, heading, accuracy: 3 });
  }
  assert.ok(Math.abs(mt.radius - R) / R < 0.15, `R=${mt.radius}`);
  assert.equal(mt.state.source, 'gps-course');
});

test('MotionTracker：ジャイロがあればヨーレートを優先する', () => {
  const mt = new MotionTracker();
  const origin = makeProjector(35, 139);
  for (let t = 0; t <= 10; t++) {
    mt.setYawRate(20 / 100, t); // v=20, R=100
    const ll = origin.toLatLon(0, t * 20);
    mt.addFix({ t, lat: ll.lat, lon: ll.lon, speed: 20, heading: 0, accuracy: 3 });
  }
  assert.equal(mt.state.source, 'gyro');
  assert.ok(Math.abs(mt.radius - 100) < 10, `R=${mt.radius}`);
});
