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
import { elevationProfile, gradeBetween } from './elevation.js';

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

/** 橋・トンネル（地表の標高が使えない区間） */
function isStructure(tags = {}) {
  const yes = (v) => v != null && v !== 'no';
  return yes(tags.bridge) || (yes(tags.tunnel) && tags.tunnel !== 'culvert') || tags.covered === 'yes';
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
    this.indexById = new Map(); // OSM の way id → this.ways の添字（データを取り直したときの引き継ぎ用）
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
      const tags = w.tags || {};
      this.ways.push({ id: w.id, tags, oneway: parseOneway(tags), st: isStructure(tags), pts, nodes });
      this.indexById.set(w.id, wi);
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

  /** way w と、その両端で接続している way（同じ道の続き・交差点の先）の添字 */
  neighborsOf(w) {
    const way = this.ways[w];
    const out = new Set([w]);
    if (!way) return out;
    for (const nid of [way.nodes[0], way.nodes[way.nodes.length - 1]]) {
      for (const c of this.nodeIndex.get(nid) || []) out.add(c.w);
    }
    return out;
  }

  /** マッチ結果の位置での、進行方向の方位（北=0） */
  bearingAt(m) {
    const way = this.ways[m.w];
    const seg = Math.min(m.seg, way.pts.length - 2);
    const a = way.pts[seg];
    const b = way.pts[seg + 1];
    return m.dir > 0 ? bearingDeg(a, b) : bearingDeg(b, a);
  }

  /**
   * 現在位置と進行方位から、走行中の道路と進行方向を推定する
   * @param {{x:number,y:number}} p
   * @param {number|null} headingDeg 北=0 の方位。null なら方位を使わない（前回の道の向きで代用）
   * @param {object|null} prev 前回のマッチ結果（ヒステリシス用）
   * @param {number} maxDist 道路からこれ以上離れた候補は使わない [m]
   * @param {object} [opt]
   * @param {number} [opt.angleGate] 方位の差がこれを超える道は候補にしない [deg]
   * @param {Set<number>} [opt.onlyWays] この way だけを探す
   */
  match(p, headingDeg, prev = null, maxDist = 40, opt = {}) {
    const angleGate = opt.angleGate ?? 60;
    const hasPrev = prev && this.ways[prev.w];
    // 前回の道とその続きは、方位が多少ずれても候補に残す
    // （粗い地図のカーブでは道の線と実際の向きがずれる。GPS の方位にも誤差がある）
    const near = hasPrev ? this.neighborsOf(prev.w) : null;
    // 方位が無いときは、前回の道の進行方向で代用する
    const hdg = headingDeg ?? (hasPrev ? this.bearingAt(prev) : null);
    const proxy = headingDeg == null;
    const r = Math.max(1, Math.ceil(maxDist / CELL));
    const gx = Math.floor(p.x / CELL);
    const gy = Math.floor(p.y / CELL);
    const seen = new Set();
    let best = null;
    for (let dx = -r; dx <= r; dx++) {
      for (let dy = -r; dy <= r; dy++) {
        const list = this.grid.get(`${gx + dx},${gy + dy}`);
        if (!list) continue;
        for (const code of list) {
          if (seen.has(code)) continue;
          seen.add(code);
          const w = code >> 12;
          if (opt.onlyWays && !opt.onlyWays.has(w)) continue;
          const i = code & 4095;
          const way = this.ways[w];
          const a = way.pts[i];
          const b = way.pts[i + 1];
          const pr = projectOnSegment(p, a, b);
          if (pr.d > maxDist) continue;
          const cont = !!near?.has(w);
          let dir = 1;
          let angErr = 0;
          if (hdg != null) {
            const segBearing = bearingDeg(a, b);
            const dFwd = Math.abs(angleDiffDeg(hdg, segBearing));
            const dRev = 180 - dFwd;
            dir = dFwd <= dRev ? 1 : -1;
            angErr = Math.min(dFwd, dRev);
            const gate = cont || proxy ? Math.max(angleGate, 100) : angleGate;
            if (angErr > gate) continue;
          }
          let score = pr.d + 0.35 * angErr;
          // 一方通行の逆走側（中央分離帯の反対車線など）は大きく減点
          if (way.oneway !== 0 && hdg != null && dir !== way.oneway) score += 60;
          if (hasPrev && prev.w === w) score -= 6;
          else if (cont) score -= 3;
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
    const pts = [{ x: m.x, y: m.y, st: this.ways[m.w].st }];
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
            pts.push({ x: prevPt.x + (q.x - prevPt.x) * t, y: prevPt.y + (q.y - prevPt.y) * t, st: way.st });
            return { pts, length: maxDist, ways };
          }
          lastBearing = bearingDeg(prevPt, q);
          prevPt = { x: q.x, y: q.y, st: way.st };
          pts.push(prevPt);
          total += seg;
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
  /**
   * @param {object} [o.elevation] 標高プロバイダ（get(lat, lon) → m | null）。無ければ勾配は 0 扱い
   */
  constructor({
    fetcher = fetchRoadsOverpass,
    radius = 1000,
    shift = 450,
    refetchAt = 500,
    minFetchInterval = 15000,
    elevation = null,
  } = {}) {
    this.fetcher = fetcher;
    this.elevation = elevation;
    this.radius = radius;
    this.shift = shift;
    this.refetchAt = refetchAt;
    this.minFetchInterval = minFetchInterval;
    this.net = null;
    this.center = null;
    this.status = 'idle';
    this.error = '';
    this.loading = false;
    this.retryAt = 0;
    this.lastFetchAt = -Infinity;
    this.failures = 0;
    this.prevMatch = null;
    this.result = null;
    this.misses = 0; // 道路に当てはめられなかった回数（連続）
    this.lastUpdate = null; // {t, speed}：外れたときの推測航法用
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
    this.misses = 0;
    this.lastUpdate = null;
  }

  #maybeFetch(lat, lon, headingDeg, now) {
    if (!this.fetcher || this.loading || now < this.retryAt) return;
    if (this.center && this.net) {
      const d = haversine(lat, lon, this.center.lat, this.center.lon);
      if (d < this.refetchAt) return;
      // カーブが続くと取り直しの条件を何度も満たすので、間隔をあける（Overpass の負荷・制限対策）
      if (now - this.lastFetchAt < this.minFetchInterval) return;
    }
    this.lastFetchAt = now;
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
        const oldNet = this.net;
        const net = new RoadNetwork(ways, { lat: cLat, lon: cLon });
        // 「いま走っている道」を way の id で新しいデータに引き継ぐ（止まっている間に取り直しても見失わない）
        let carried = null;
        if (this.prevMatch && oldNet) {
          const id = oldNet.ways[this.prevMatch.w]?.id;
          const w = net.indexById.get(id);
          if (w != null) {
            carried = { ...this.prevMatch, w, seg: Math.min(this.prevMatch.seg, net.ways[w].pts.length - 2) };
          }
        }
        this.net = net;
        this.center = { lat: cLat, lon: cLon };
        this.prevMatch = carried;
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
    const moving = motion.speed > 1.5;
    // 最後に分かった進行方位。止まっている間も保たれる（車は止まったまま向きを変えない）
    const heading = motion.heading ?? null;
    this.#maybeFetch(fix.lat, fix.lon, moving ? heading : null, now);
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
    // GPS のコースは正確。軌跡から求めた方位や、止まっているときの方位は誤差が大きいので許容幅を広げる
    const reliable = moving && motion.headingSource === 'course';
    let m = this.net.match(p, heading, this.prevMatch, maxDist, { angleGate: reliable ? 60 : 75 });
    if (!m && this.prevMatch) {
      // 一瞬の GPS の跳びや粗い地図で外れたときは、さっきまでの道とその続きに限って広めに探し直す
      m = this.net.match(p, null, this.prevMatch, Math.min(100, maxDist * 2), {
        onlyWays: this.net.neighborsOf(this.prevMatch.w),
      });
    }
    if (!m) return this.#onMiss(motion, now);

    this.misses = 0;
    this.lastUpdate = { t: now, speed: motion.speed || 0 };
    this.status = 'ready';
    this.prevMatch = m;
    const ahead = Math.max(250, Math.min(700, (motion.speed || 0) * 12));
    const prof = this.net.profile(m, ahead, 40, 5);
    // 標高（入口・出口の高さ → 縦断勾配）
    const net = this.net;
    prof.elev = this.elevation
      ? elevationProfile(prof.pts, (x, y) => net.proj.toLatLon(x, y), (la, lo) => this.elevation.get(la, lo), prof.ds)
      : null;
    this.result = buildResult(m, net.wayInfo(m.w), prof, net.proj);
    return this.result;
  }

  /**
   * 道路に当てはめられなかったとき。数回までは、前回の結果を走った距離だけ先へ進めて表示を保つ
   * （一瞬の GPS の乱れで「道路未特定」と表示が点滅しないように）
   */
  #onMiss(motion, now) {
    this.misses++;
    const last = this.result;
    if (last && this.misses <= 3 && this.lastUpdate) {
      const dt = Math.max(0, (now - this.lastUpdate.t) / 1000);
      const traveled = ((this.lastUpdate.speed + (motion.speed || 0)) / 2) * dt;
      this.lastUpdate = { t: now, speed: motion.speed || 0 };
      const prof = last.profile;
      const idx0 = Math.min(prof.pts.length - 1, prof.idx0 + Math.round(traveled / prof.ds));
      this.status = 'ready';
      this.result = buildResult(last.match, last.road, { ...prof, idx0 }, last.proj, true);
      return this.result;
    }
    this.prevMatch = null;
    this.status = 'no-road';
    this.result = null;
    return null;
  }
}

/**
 * 曲率プロファイルから表示用の結果を作る
 * @param {boolean} [estimated] 道路に当てはめられず、走った距離から推測した結果か
 */
function buildResult(m, road, prof, proj, estimated = false) {
  const elev = prof.elev;
  const curves = findCurves(prof.kappa, prof.ds, { thresholdR: 600 }).map((c) => ({
    ...c,
    // 現在地からの距離（負 = すでに入っている）
    distStart: (c.startIdx - prof.idx0) * prof.ds,
    distApex: (c.apexIdx - prof.idx0) * prof.ds,
    distEnd: (c.endIdx - prof.idx0) * prof.ds,
    entryElev: elev ? elev[c.startIdx] : null,
    exitElev: elev ? elev[c.endIdx] : null,
    gradePct: elev ? gradeBetween(elev, c.startIdx, c.endIdx, prof.ds) : 0,
  }));
  const k0 = prof.kappa[prof.idx0] || 0;
  return {
    match: m,
    road,
    profile: prof,
    // この結果の座標（profile.pts）を緯度経度に戻すための投影。地図データを取り直すと
    // RoadTracker.net の投影は変わるので、表示ではこちらを使う
    proj,
    estimated,
    curves: curves.filter((c) => c.distEnd >= 0),
    radiusHere: Math.abs(k0) > 1 / 1500 ? 1 / Math.abs(k0) : Infinity,
    dirHere: k0 > 0 ? 'left' : 'right',
    hasElevation: !!elev,
    elevHere: elev ? elev[prof.idx0] : null,
    // 現在地の前後 25m で見た勾配
    gradeHere: elev ? gradeBetween(elev, prof.idx0 - 5, prof.idx0 + 5, prof.ds) : 0,
  };
}
