// 国土地理院の「道路中心線」ベクトルタイル（GeoJSON）から道路データを作る。
// Overpass API（OpenStreetMap）が混雑・停止しているときの予備（日本国内のみ）。
//
// - タイルはズーム 16 のみ（1 枚 約 0.5km 四方）。道路はタイルの境目と交差点で切れている
// - 境目・交差点の端点を同じ点として結び、分岐のない区間は 1 本につなげて
//   OpenStreetMap と同じ形（id・nodes・geometry・tags）にする
// - 一方通行の情報は無い

const Z = 16;
const TILE_URL = (x, y) => `https://cyberjapandata.gsi.go.jp/xyz/experimental_rdcl/${Z}/${x}/${y}.geojson`;

/** 車で走らない種別（徒歩道・石段・公園や施設の中の道） */
const SKIP_TYPES = new Set(['徒歩道', '石段', '階段', '庭園路', '庭園路等']);
const SKIP_STATES = new Set(['建設中']);

/** 日本とその周辺（これより外は国土地理院のデータが無い） */
export function inJapan(lat, lon) {
  return lat > 20 && lat < 46.5 && lon > 122 && lon < 154.5;
}

// ---------- タイル番号 ----------
function lon2x(lon) {
  return Math.floor(((lon + 180) / 360) * 2 ** Z);
}
function lat2y(lat) {
  const r = (lat * Math.PI) / 180;
  return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** Z);
}

/** 四角い範囲にかかるタイルの一覧 */
export function tilesForBbox(bbox) {
  const x0 = lon2x(bbox.w);
  const x1 = lon2x(bbox.e);
  const y0 = lat2y(bbox.n);
  const y1 = lat2y(bbox.s);
  const out = [];
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) out.push({ x, y });
  return out;
}

/** 点 (lat, lon) のまわり radius [m] を含む四角い範囲 */
export function bboxAround(lat, lon, radius) {
  const dLat = radius / 111195;
  const dLon = radius / (111195 * Math.cos((lat * Math.PI) / 180));
  return { s: lat - dLat, n: lat + dLat, w: lon - dLon, e: lon + dLon };
}

// ---------- 属性 → OpenStreetMap 風のタグ ----------
function toTags(p) {
  const tags = {};
  const ctg = p.rdCtg || '';
  const wide = /5\.5m-13m|13m-19\.5m|19\.5m以上/.test(p.rnkWidth || '');
  // 高速道路は 'motorway' にすると暗黙の一方通行になるので、使わない（上下線が 1 本の線のことがある）
  tags.highway = /高速/.test(ctg) ? 'trunk' : ctg === '国道' ? 'primary' : ctg === '都道府県道' ? 'secondary' : wide ? 'tertiary' : 'unclassified';
  const name = p.name || p.comName;
  if (name) tags.name = name;
  if (p.rtCode) tags.ref = String(p.rtCode);
  const st = p.state || '';
  if (/橋|高架/.test(st)) tags.bridge = 'yes';
  if (/トンネル|地下/.test(st)) tags.tunnel = 'yes';
  if (/雪覆い|覆道/.test(st)) tags.covered = 'yes';
  return tags;
}

function usable(f) {
  const p = f.properties || {};
  if (SKIP_TYPES.has(p.type) || SKIP_STATES.has(p.state)) return false;
  const g = f.geometry;
  return g && (g.type === 'LineString' || g.type === 'MultiLineString');
}

function lines(f) {
  const g = f.geometry;
  return g.type === 'LineString' ? [g.coordinates] : g.coordinates;
}

function hash32(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * 道路中心線の地物を、つながりを持った道路の一覧にする
 * @param {object[]} features GeoJSON の Feature（複数タイル分をまとめて渡す）
 * @returns {Array<{id:number,nodes:number[],geometry:{lat:number,lon:number}[],tags:object}>}
 */
export function gsiFeaturesToWays(features, { snapM = 0.6 } = {}) {
  // 1. 線分ごとに分け、端点を近いもの同士で同じ点にまとめる
  const segs = [];
  const seen = new Set();
  for (const f of features) {
    if (!usable(f)) continue;
    const p = f.properties || {};
    const rid = String(p.rID ?? '');
    lines(f).forEach((coords, k) => {
      const pts = coords.filter((c) => Array.isArray(c) && Number.isFinite(c[0]) && Number.isFinite(c[1]));
      if (pts.length < 2) return;
      // 同じ線が 2 回入っていたら（タイルの重複など）1 本にする
      const key = `${rid}#${k}#${pts[0][0]},${pts[0][1]}`;
      if (seen.has(key)) return;
      seen.add(key);
      segs.push({ rid, tags: toTags(p), pts });
    });
  }
  if (!segs.length) return [];

  const lat0 = segs[0].pts[0][1];
  const kx = 111195 * Math.cos((lat0 * Math.PI) / 180);
  const ky = 111195;
  const cell = Math.max(snapM, 0.1);
  const grid = new Map();
  const nodeXY = [];
  const nodeOf = (c) => {
    const x = c[0] * kx;
    const y = c[1] * ky;
    const gx = Math.floor(x / cell);
    const gy = Math.floor(y / cell);
    for (let i = -1; i <= 1; i++) {
      for (let j = -1; j <= 1; j++) {
        for (const id of grid.get(`${gx + i},${gy + j}`) || []) {
          const q = nodeXY[id];
          if (Math.hypot(q.x - x, q.y - y) <= snapM) return id;
        }
      }
    }
    const id = nodeXY.length;
    nodeXY.push({ x, y });
    const k = `${gx},${gy}`;
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(id);
    return id;
  };
  for (const s of segs) {
    s.a = nodeOf(s.pts[0]);
    s.b = nodeOf(s.pts[s.pts.length - 1]);
  }

  // 2. 端点ごとにつながる線分を数え、分岐のない所（2 本だけ）で同じ属性の線をつなぐ
  const at = new Map();
  segs.forEach((s, i) => {
    for (const n of [s.a, s.b]) {
      if (!at.has(n)) at.set(n, []);
      at.get(n).push(i);
    }
  });
  const sameTags = (t, u) => t.highway === u.highway && t.name === u.name && t.ref === u.ref && t.bridge === u.bridge && t.tunnel === u.tunnel && t.covered === u.covered;
  const used = new Array(segs.length).fill(false);
  const nextAt = (node, from) => {
    const list = at.get(node);
    if (!list || list.length !== 2) return -1;
    const j = list[0] === from ? list[1] : list[0];
    if (j === from || used[j] || !sameTags(segs[j].tags, segs[from].tags)) return -1;
    return j;
  };

  const ways = [];
  let interior = -1; // 端点以外の点の番号（負の数で、端点と重ならないようにする）
  for (let i = 0; i < segs.length; i++) {
    if (used[i]) continue;
    used[i] = true;
    // 列：{seg, forward}。最初の線を基準に、終点側・始点側へ伸ばす
    const chain = [{ i, fwd: true }];
    let end = segs[i].b;
    let cur = i;
    for (;;) {
      const j = nextAt(end, cur);
      if (j < 0 || segs[j].a === segs[j].b) break;
      used[j] = true;
      const fwd = segs[j].a === end;
      chain.push({ i: j, fwd });
      end = fwd ? segs[j].b : segs[j].a;
      cur = j;
    }
    let start = segs[i].a;
    cur = i;
    for (;;) {
      const j = nextAt(start, cur);
      if (j < 0 || segs[j].a === segs[j].b) break;
      used[j] = true;
      const fwd = segs[j].b === start;
      chain.unshift({ i: j, fwd });
      start = fwd ? segs[j].a : segs[j].b;
      cur = j;
    }

    const geometry = [];
    const nodes = [];
    let minRid = null;
    chain.forEach(({ i: k, fwd }, ci) => {
      const s = segs[k];
      if (minRid == null || s.rid < minRid) minRid = s.rid;
      const pts = fwd ? s.pts : [...s.pts].reverse();
      const first = fwd ? s.a : s.b;
      const last = fwd ? s.b : s.a;
      pts.forEach((c, pi) => {
        if (ci > 0 && pi === 0) return; // つなぎ目の点は前の線の終点と同じ
        geometry.push({ lat: c[1], lon: c[0] });
        nodes.push(pi === 0 ? first : pi === pts.length - 1 ? last : interior--);
      });
    });
    if (geometry.length < 2) continue;
    // 取り直しても同じ道は同じ id になるように、含まれる線の番号から作る（OSM の id と重ならないよう負の数）
    ways.push({ id: -(hash32(minRid || `${geometry[0].lat},${geometry[0].lon}`) + 1), nodes, geometry, tags: segs[i].tags });
  }
  // id の重複（ハッシュの衝突）を避ける
  const ids = new Set();
  for (const w of ways) {
    while (ids.has(w.id)) w.id -= 0x100000000;
    ids.add(w.id);
  }
  return ways;
}

// ---------- 取得 ----------

/** 取得したタイルの使い回し（取り直しのたびに同じタイルを取らない） */
const tileMemo = new Map();
const MEMO_MAX = 600;

function memoGet(k) {
  const v = tileMemo.get(k);
  if (v) {
    tileMemo.delete(k);
    tileMemo.set(k, v);
  }
  return v;
}
function memoSet(k, v) {
  tileMemo.set(k, v);
  while (tileMemo.size > MEMO_MAX) tileMemo.delete(tileMemo.keys().next().value);
}

/** テスト用 */
export function clearGsiMemo() {
  tileMemo.clear();
}

async function fetchTile(x, y, { signal, fetchImpl, timeoutMs }) {
  const key = `${x}/${y}`;
  const hit = memoGet(key);
  if (hit) return hit;
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    const onAbort = () => ctl.abort();
    signal?.addEventListener?.('abort', onAbort);
    try {
      const res = await fetchImpl(TILE_URL(x, y), { signal: ctl.signal });
      // 道路の無いタイルは 404
      if (res.status === 404) {
        memoSet(key, []);
        return [];
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const feats = (json.features || []).filter(usable);
      memoSet(key, feats);
      return feats;
    } catch (e) {
      if (signal?.aborted) throw e;
      lastErr = ctl.signal.aborted ? new Error('応答がありません') : e instanceof TypeError ? new Error('通信できません') : e;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
    }
  }
  throw lastErr;
}

/**
 * 四角い範囲の道路を国土地理院の道路中心線から取得する
 * @param {{s:number,w:number,n:number,e:number}} bbox
 */
export async function fetchRoadsGsiBbox(bbox, { signal, fetchImpl = globalThis.fetch, concurrency = 6, timeoutMs = 10000, maxTiles = 600 } = {}) {
  if (!inJapan((bbox.s + bbox.n) / 2, (bbox.w + bbox.e) / 2)) throw new Error('日本国外');
  const tiles = tilesForBbox(bbox);
  if (tiles.length > maxTiles) throw new Error('範囲が広すぎます');
  const features = [];
  let next = 0;
  let failed = null;
  const worker = async () => {
    while (next < tiles.length && !failed) {
      const t = tiles[next++];
      try {
        features.push(...(await fetchTile(t.x, t.y, { signal, fetchImpl, timeoutMs })));
      } catch (e) {
        failed = failed || e;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, tiles.length) }, worker));
  if (signal?.aborted) throw new DOMException('中止しました', 'AbortError');
  // 一部のタイルが欠けると道が途切れて危ないので、欠けたら失敗にする（保存済みデータでの代用に回す）
  if (failed) throw failed;
  return gsiFeaturesToWays(features);
}

/** 点のまわりの道路（Overpass の fetchRoadsOverpass と同じ呼び方） */
export function fetchRoadsGsi(lat, lon, radius, opts = {}) {
  return fetchRoadsGsiBbox(bboxAround(lat, lon, radius), opts);
}
