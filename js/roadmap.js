// OpenStreetMap の道路データから「いま走っている道」とその先のカーブを求める

import {
  makeProjector,
  dist,
  bearingDeg,
  angleDiffDeg,
  projectOnSegment,
  resample,
  curvatureProfile,
  findCurves,
  haversine,
} from './geo.js';

const HIGHWAY_TYPES = [
  'motorway',
  'trunk',
  'primary',
  'secondary',
  'tertiary',
  'unclassified',
  'residential',
  'living_street',
  'road',
  'motorway_link',
  'trunk_link',
  'primary_link',
  'secondary_link',
  'tertiary_link',
];

export const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

function parseOneway(tags = {}) {
  const v = tags.oneway;
  if (v === 'yes' || v === 'true' || v === '1') return 1;
  if (v === '-1' || v === 'reverse') return -1;
  if (v === 'no') return 0;
  // 高速道路本線・ランプ・ロータリーは暗黙の一方通行
  if (tags.highway === 'motorway' || tags.junction === 'roundabout') return 1;
  return 0;
}

const CELL = 60; // 空間インデックスのセルサイズ [m]

export class RoadNetwork {
  /**
   * @param {Array<{id:number,nodes:number[],geometry:{lat:number,lon:number}[],tags:object}>} ways
   * @param {{lat:number,lon:number}} origin 投影原点
   */
  constructor(ways, origin) {
    this.origin = origin;
    this.proj = makeProjector(origin.lat, origin.lon);
    this.ways = [];
    this.nodeIndex = new Map();
    this.grid = new Map();
    for (const w of ways) {
      if (!w.geometry || !w.nodes || w.geometry.length < 2) continue;
      const pts = [];
      const nodes = [];
      for (let i = 0; i < w.geometry.length; i++) {
        const g = w.geometry[i];
        if (!g) continue;
        pts.push(this.proj.toXY(g.lat, g.lon));
        nodes.push(w.nodes[i]);
      }
      if (pts.length < 2) continue;
      const wi = this.ways.length;
      this.ways.push({ id: w.id, tags: w.tags || {}, oneway: parseOneway(w.tags), pts, nodes });
      nodes.forEach((nid, i) => {
        let list = this.nodeIndex.get(nid);
        if (!list) this.nodeIndex.set(nid, (list = []));
        list.push({ w: wi, i });
      });
      for (let i = 0; i < pts.length - 1; i++) this.#indexSegment(wi, i, pts[i], pts[i + 1]);
    }
  }

  #indexSegment(w, i, a, b) {
    const x0 = Math.floor(Math.min(a.x, b.x) / CELL);
    const x1 = Math.floor(Math.max(a.x, b.x) / CELL);
    const y0 = Math.floor(Math.min(a.y, b.y) / CELL);
    const y1 = Math.floor(Math.max(a.y, b.y) / CELL);
    for (let gx = x0; gx <= x1; gx++) {
      for (let gy = y0; gy <= y1; gy++) {
        const key = `${gx},${gy}`;
        let list = this.grid.get(key);
        if (!list) this.grid.set(key, (list = []));
        list.push((w << 12) | i); // 1本あたり 4096 セグメントまで
      }
    }
  }

  get size() {
    return this.ways.length;
  }

  toXY(lat, lon) {
    return this.proj.toXY(lat, lon);
  }

  /**
   * 現在位置と進行方位から、走行中の道路と進行方向を推定する
   * @param {{x:number,y:number}} p
   * @param {number|null} headingDeg 北=0 の方位。null なら方位を使わない
   * @param {object|null} prev 前回のマッチ結果（ヒステリシス用）
   */
  match(p, headingDeg, prev = null, maxDist = 40) {
    const gx = Math.floor(p.x / CELL);
    const gy = Math.floor(p.y / CELL);
    const seen = new Set();
    let best = null;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const list = this.grid.get(`${gx + dx},${gy + dy}`);
        if (!list) continue;
        for (const code of list) {
          if (seen.has(code)) continue;
          seen.add(code);
          const w = code >> 12;
          const i = code & 4095;
          const way = this.ways[w];
          const a = way.pts[i];
          const b = way.pts[i + 1];
          const pr = projectOnSegment(p, a, b);
          if (pr.d > maxDist) continue;
          let dir = 1;
          let angErr = 0;
          if (headingDeg != null) {
            const segBearing = bearingDeg(a, b);
            const dFwd = Math.abs(angleDiffDeg(headingDeg, segBearing));
            const dRev = 180 - dFwd;
            dir = dFwd <= dRev ? 1 : -1;
            angErr = Math.min(dFwd, dRev);
            if (angErr > 60) continue;
          } else if (prev && prev.w === w) {
            dir = prev.dir;
          }
          let score = pr.d + 0.35 * angErr;
          // 一方通行の逆走側（中央分離帯の反対車線など）は大きく減点
          if (way.oneway !== 0 && headingDeg != null && dir !== way.oneway) score += 60;
          if (prev && prev.w === w) score -= 6;
          if (!best || score < best.score) {
            best = { w, seg: i, t: pr.t, dir, d: pr.d, x: pr.x, y: pr.y, score };
          }
        }
      }
    }
    return best;
  }

  /**
   * マッチ位置から道なりにたどった折れ線を返す
   * @returns {{pts:{x:number,y:number}[], length:number, ways:number[]}}
   */
  walk(m, dir, maxDist, reverse = false) {
    const pts = [{ x: m.x, y: m.y }];
    const ways = [m.w];
    let total = 0;
    let w = m.w;
    let d = dir;
    let i = d > 0 ? m.seg + 1 : m.seg;
    let prevPt = pts[0];
    let lastBearing = null;
    for (let guard = 0; guard < 5000; guard++) {
      const way = this.ways[w];
      while (i >= 0 && i < way.pts.length) {
        const q = way.pts[i];
        const seg = dist(prevPt, q);
        if (seg > 0) {
          if (total + seg >= maxDist) {
            const t = (maxDist - total) / seg;
            pts.push({ x: prevPt.x + (q.x - prevPt.x) * t, y: prevPt.y + (q.y - prevPt.y) * t });
            return { pts, length: maxDist, ways };
          }
          lastBearing = bearingDeg(prevPt, q);
          pts.push(q);
          total += seg;
          prevPt = q;
        }
        i += d;
      }
      // 道路の端に到達 → 接続する道路のうち最も「道なり」なものへ
      const endIdx = i - d;
      const nodeId = way.nodes[endIdx];
      const cands = this.nodeIndex.get(nodeId) || [];
      let best = null;
      for (const c of cands) {
        const cw = this.ways[c.w];
        for (const d2 of [1, -1]) {
          if (c.w === w && c.i === endIdx && d2 === -d) continue; // 来た道を戻る
          if (c.w === w && c.i === endIdx && d2 === d) continue; // 端の先は無い
          const j = c.i + d2;
          if (j < 0 || j >= cw.pts.length) continue;
          const allowed = reverse ? -cw.oneway : cw.oneway;
          if (allowed !== 0 && d2 !== allowed) continue;
          const outBearing = bearingDeg(cw.pts[c.i], cw.pts[j]);
          const turn = lastBearing == null ? 0 : Math.abs(angleDiffDeg(lastBearing, outBearing));
          if (turn > 110) continue;
          let score = turn;
          if (way.tags.name && cw.tags.name === way.tags.name) score -= 25;
          if (way.tags.ref && cw.tags.ref === way.tags.ref) score -= 25;
          if (cw.tags.highway === way.tags.highway) score -= 8;
          if (!best || score < best.score) best = { w: c.w, i: j, d: d2, score };
        }
      }
      if (!best) return { pts, length: total, ways };
      w = best.w;
      d = best.d;
      i = best.i;
      ways.push(w);
    }
    return { pts, length: total, ways };
  }

  /**
   * 現在位置の前後をたどって曲率プロファイルを作る
   */
  profile(m, ahead = 400, behind = 40, ds = 5) {
    const fwd = this.walk(m, m.dir, ahead, false);
    const back = this.walk(m, -m.dir, behind, true);
    const backPts = back.pts.slice(1).reverse();
    const raw = [...backPts, ...fwd.pts];
    const pts = resample(raw, ds);
    const kappa = curvatureProfile(pts, ds, 15);
    const s0 = back.length; // 現在位置までの距離
    const idx0 = Math.min(pts.length - 1, Math.round(s0 / ds));
    return { pts, kappa, ds, idx0, aheadLength: fwd.length, behindLength: back.length };
  }

  wayInfo(w) {
    const t = this.ways[w]?.tags || {};
    return { name: t.name || '', ref: t.ref || '', highway: t.highway || '' };
  }
}

/** Overpass API から周辺の道路を取得 */
export async function fetchRoadsOverpass(lat, lon, radius, { signal, endpoints = OVERPASS_ENDPOINTS } = {}) {
  const re = `^(${HIGHWAY_TYPES.join('|')})$`;
  const q = `[out:json][timeout:25];way(around:${Math.round(radius)},${lat.toFixed(6)},${lon.toFixed(6)})["highway"~"${re}"];out geom;`;
  let lastErr;
  for (const url of endpoints) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        body: 'data=' + encodeURIComponent(q),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      return (json.elements || [])
        .filter((e) => e.type === 'way' && Array.isArray(e.geometry) && Array.isArray(e.nodes))
        .map((e) => ({ id: e.id, nodes: e.nodes, geometry: e.geometry, tags: e.tags || {} }));
    } catch (e) {
      if (signal?.aborted) throw e;
      lastErr = e;
    }
  }
  throw lastErr || new Error('Overpass に接続できません');
}

/**
 * 走行中に道路データを自動で取得・更新し、前方のカーブを解析する
 */
export class RoadTracker {
  /**
   * @param {object} o
   * @param {(lat:number,lon:number,radius:number,opts:object)=>Promise<any[]>} [o.fetcher]
   */
  constructor({ fetcher = fetchRoadsOverpass, radius = 1000, shift = 450, refetchAt = 500 } = {}) {
    this.fetcher = fetcher;
    this.radius = radius;
    this.shift = shift;
    this.refetchAt = refetchAt;
    this.net = null;
    this.center = null;
    this.status = 'idle';
    this.error = '';
    this.loading = false;
    this.retryAt = 0;
    this.failures = 0;
    this.prevMatch = null;
    this.result = null;
  }

  /** 固定の道路データを使う（デモ走行用） */
  setStaticNetwork(ways, origin) {
    this.fetcher = null;
    this.net = new RoadNetwork(ways, origin);
    this.center = origin;
    this.status = 'ready';
    this.prevMatch = null;
  }

  reset() {
    this.prevMatch = null;
    this.result = null;
  }

  #maybeFetch(lat, lon, headingDeg, now) {
    if (!this.fetcher || this.loading || now < this.retryAt) return;
    if (this.center && this.net) {
      const d = haversine(lat, lon, this.center.lat, this.center.lon);
      if (d < this.refetchAt) return;
    }
    // 進行方向に少しずらした位置を中心に取得すると、先の道まで余裕を持って読める
    let cLat = lat;
    let cLon = lon;
    if (headingDeg != null) {
      const p = makeProjector(lat, lon);
      const h = (headingDeg * Math.PI) / 180;
      const ll = p.toLatLon(Math.sin(h) * this.shift, Math.cos(h) * this.shift);
      cLat = ll.lat;
      cLon = ll.lon;
    }
    this.loading = true;
    if (!this.net) this.status = 'loading';
    this.fetcher(cLat, cLon, this.radius, {})
      .then((ways) => {
        this.net = new RoadNetwork(ways, { lat: cLat, lon: cLon });
        this.center = { lat: cLat, lon: cLon };
        this.prevMatch = null;
        this.status = 'ready';
        this.error = '';
        this.failures = 0;
      })
      .catch((e) => {
        this.failures++;
        this.error = String(e?.message || e);
        if (!this.net) this.status = 'error';
        this.retryAt = Date.now() + Math.min(120000, 10000 * 2 ** (this.failures - 1));
      })
      .finally(() => {
        this.loading = false;
      });
  }

  /**
   * @param {{lat:number,lon:number,accuracy?:number}} fix
   * @param {{speed:number, heading:number|null}} motion
   */
  update(fix, motion, now = Date.now()) {
    const heading = motion.heading != null && motion.speed > 1.5 ? motion.heading : null;
    this.#maybeFetch(fix.lat, fix.lon, heading, now);
    if (!this.net) {
      this.result = null;
      return null;
    }
    const p = this.net.toXY(fix.lat, fix.lon);
    if (heading == null && !this.prevMatch) {
      this.result = null;
      return null;
    }
    const maxDist = Math.max(25, Math.min(60, (fix.accuracy || 10) * 2 + 15));
    const m = this.net.match(p, heading, this.prevMatch, maxDist);
    if (!m) {
      this.prevMatch = null;
      this.status = 'no-road';
      this.result = null;
      return null;
    }
    this.status = 'ready';
    this.prevMatch = m;
    const ahead = Math.max(250, Math.min(700, (motion.speed || 0) * 12));
    const prof = this.net.profile(m, ahead, 40, 5);
    const curves = findCurves(prof.kappa, prof.ds, { thresholdR: 600 }).map((c) => ({
      ...c,
      // 現在地からの距離（負 = すでに入っている）
      distStart: (c.startIdx - prof.idx0) * prof.ds,
      distApex: (c.apexIdx - prof.idx0) * prof.ds,
      distEnd: (c.endIdx - prof.idx0) * prof.ds,
    }));
    const k0 = prof.kappa[prof.idx0] || 0;
    const info = this.net.wayInfo(m.w);
    this.result = {
      match: m,
      road: info,
      profile: prof,
      curves: curves.filter((c) => c.distEnd >= 0),
      radiusHere: Math.abs(k0) > 1 / 1500 ? 1 / Math.abs(k0) : Infinity,
      dirHere: k0 > 0 ? 'left' : 'right',
    };
    return this.result;
  }
}
