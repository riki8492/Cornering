// デモ走行：架空の峠道を走らせて、GPS・ジャイロ・地図データを模擬する

import { makeProjector, dist } from './geo.js';

const G = 9.80665;

// 架空コース（angle の正 = 右カーブ）
const DEMO_SEGMENTS = [
  { type: 'straight', len: 250 },
  { type: 'arc', R: 150, angle: 40 },
  { type: 'straight', len: 120 },
  { type: 'arc', R: 60, angle: -75 },
  { type: 'straight', len: 90 },
  { type: 'arc', R: 25, angle: 150 },
  { type: 'straight', len: 160 },
  { type: 'arc', R: 80, angle: -60 },
  { type: 'arc', R: 80, angle: 60 },
  { type: 'straight', len: 200 },
  { type: 'arc', R: 40, angle: -110 },
  { type: 'straight', len: 140 },
  { type: 'arc', R: 300, angle: 35 },
  { type: 'straight', len: 300 },
];

/** コースを局所座標の折れ線（2m 間隔）と各点の真の曲率にする */
export function buildDemoCourse(segments = DEMO_SEGMENTS, step = 2) {
  const pts = [{ x: 0, y: 0, k: 0 }];
  let x = 0;
  let y = 0;
  let h = 0; // 北=0, 時計回り [rad]
  for (const seg of segments) {
    if (seg.type === 'straight') {
      const n = Math.max(1, Math.round(seg.len / step));
      const d = seg.len / n;
      for (let i = 0; i < n; i++) {
        x += Math.sin(h) * d;
        y += Math.cos(h) * d;
        pts.push({ x, y, k: 0 });
      }
    } else {
      const total = (Math.abs(seg.angle) * Math.PI) / 180;
      const len = total * seg.R;
      const n = Math.max(2, Math.round(len / step));
      const dh = (Math.sign(seg.angle) * total) / n;
      const d = len / n;
      const k = -Math.sign(seg.angle) / seg.R; // 左を正
      for (let i = 0; i < n; i++) {
        h += dh / 2;
        x += Math.sin(h) * d;
        y += Math.cos(h) * d;
        h += dh / 2;
        pts.push({ x, y, k });
      }
    }
  }
  let s = 0;
  pts[0].s = 0;
  for (let i = 1; i < pts.length; i++) {
    s += dist(pts[i - 1], pts[i]);
    pts[i].s = s;
  }
  return { pts, length: s };
}

/** デモコースを OSM 形式の道路データにする */
export function demoWays(course, origin) {
  const proj = makeProjector(origin.lat, origin.lon);
  // 地図らしさを出すため、頂点を間引く（直線は粗く、カーブは細かく）
  const keep = [];
  let lastKept = -Infinity;
  course.pts.forEach((p, i) => {
    const spacing = Math.abs(p.k) > 0 ? 8 : 40;
    if (i === 0 || i === course.pts.length - 1 || p.s - lastKept >= spacing) {
      keep.push(p);
      lastKept = p.s;
    }
  });
  return [
    {
      id: 1,
      nodes: keep.map((_, i) => 1000 + i),
      geometry: keep.map((p) => proj.toLatLon(p.x, p.y)),
      tags: { highway: 'secondary', name: 'デモ峠道' },
    },
  ];
}

function gauss() {
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * デモ走行を開始する
 * @param {object} o
 * @param {(fix:object)=>void} o.onFix  1秒ごとの GPS
 * @param {(omega:number,t:number)=>void} o.onYaw  ジャイロ
 * @param {()=>void} [o.onLoop] コースを一周してスタートに戻ったとき
 * @param {number} [o.lateralG] デモのドライバーが攻める横G
 * @returns {{stop:()=>void, origin:object, ways:object[]}}
 */
export function startDemo({ onFix, onYaw, onLoop, lateralG = 0.5, cruiseKmh = 80 }) {
  const origin = { lat: 35.3606, lon: 138.7274 };
  const course = buildDemoCourse();
  const proj = makeProjector(origin.lat, origin.lon);
  const ways = demoWays(course, origin);
  const pts = course.pts;

  // 速度プロファイル：横G上限 → 後ろ向きに減速 0.35G → 前向きに加速 0.15G
  const vmax = pts.map((p) => Math.min(cruiseKmh / 3.6, p.k ? Math.sqrt((lateralG * G) / Math.abs(p.k)) : Infinity));
  for (let i = pts.length - 2; i >= 0; i--) {
    const ds = pts[i + 1].s - pts[i].s;
    vmax[i] = Math.min(vmax[i], Math.sqrt(vmax[i + 1] ** 2 + 2 * 0.35 * G * ds));
  }
  const prof = [...vmax];
  prof[0] = Math.min(prof[0], 8);
  for (let i = 1; i < pts.length; i++) {
    const ds = pts[i].s - pts[i - 1].s;
    prof[i] = Math.min(prof[i], Math.sqrt(prof[i - 1] ** 2 + 2 * 0.15 * G * ds));
  }

  let s = 0;
  let idx = 0;
  let simT = Date.now() / 1000;
  let nextFix = 0;
  const dt = 0.1;

  const stateAt = (sPos) => {
    while (idx < pts.length - 2 && pts[idx + 1].s < sPos) idx++;
    while (idx > 0 && pts[idx].s > sPos) idx--;
    const a = pts[idx];
    const b = pts[idx + 1];
    const t = (sPos - a.s) / Math.max(1e-6, b.s - a.s);
    const x = a.x + (b.x - a.x) * t;
    const y = a.y + (b.y - a.y) * t;
    const heading = ((Math.atan2(b.x - a.x, b.y - a.y) * 180) / Math.PI + 360) % 360;
    const v = prof[idx] + (prof[idx + 1] - prof[idx]) * t;
    return { x, y, heading, v, k: b.k };
  };

  const timer = setInterval(() => {
    const st = stateAt(s);
    s += st.v * dt;
    simT += dt;
    onYaw?.(Math.abs(st.v * st.k) + Math.abs(gauss() * 0.004), simT);
    nextFix -= dt;
    if (nextFix <= 0) {
      nextFix += 1;
      const ll = proj.toLatLon(st.x + gauss() * 1.5, st.y + gauss() * 1.5);
      onFix({
        t: simT,
        lat: ll.lat,
        lon: ll.lon,
        speed: Math.max(0, st.v + gauss() * 0.2),
        heading: (st.heading + gauss() * 1.0 + 360) % 360,
        accuracy: 4,
      });
    }
    if (s >= course.length - 1) {
      s = 0;
      idx = 0;
      onLoop?.();
    }
  }, dt * 1000);

  return { stop: () => clearInterval(timer), origin, ways, course };
}
