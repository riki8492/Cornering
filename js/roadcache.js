// 取得した道路データを端末に保存し、電波の弱い山道や、同じ道の帰り道で使う
//
// 保存の単位は「取得した範囲」（中心と半径）。走行中に必要になった範囲が保存済みの範囲に
// 十分おさまっていれば、通信せずにそれを使う。通信に失敗したときも、現在地を含む保存済みの
// 範囲があればそれで代用する。

const DAY = 24 * 60 * 60 * 1000;

// ---------- 保存形式（容量を減らすため、座標は整数にし、使うタグだけ残す） ----------
const KEEP_TAGS = ['highway', 'oneway', 'junction', 'name', 'ref', 'bridge', 'tunnel', 'covered'];

export function compactWays(ways) {
  return ways.map((w) => {
    const g = [];
    for (const p of w.geometry) {
      if (p) g.push(Math.round(p.lat * 1e6), Math.round(p.lon * 1e6));
      else g.push(null, null);
    }
    const t = {};
    for (const k of KEEP_TAGS) if (w.tags?.[k] != null) t[k] = w.tags[k];
    return { i: w.id, n: w.nodes, g, t };
  });
}

export function expandWays(compact) {
  return compact.map((c) => {
    const geometry = [];
    for (let k = 0; k < c.g.length; k += 2) {
      geometry.push(c.g[k] == null ? null : { lat: c.g[k] / 1e6, lon: c.g[k + 1] / 1e6 });
    }
    return { id: c.i, nodes: c.n, geometry, tags: c.t };
  });
}

function distM(lat1, lon1, lat2, lon2) {
  const k = Math.cos((((lat1 + lat2) / 2) * Math.PI) / 180);
  const dy = (lat2 - lat1) * 111195;
  const dx = (lon2 - lon1) * 111195 * k;
  return Math.hypot(dx, dy);
}

// ---------- 保存先 ----------

/** メモリに保存（テスト用。IndexedDB が使えない環境の代わりにも使う） */
export class MemoryBackend {
  constructor() {
    this.meta = new Map();
    this.data = new Map();
  }
  async allMeta() {
    return [...this.meta.values()];
  }
  async getWays(id) {
    return this.data.get(id) || null;
  }
  async put(meta, ways) {
    this.meta.set(meta.id, meta);
    this.data.set(meta.id, ways);
  }
  async remove(id) {
    this.meta.delete(id);
    this.data.delete(id);
  }
}

/** ブラウザの IndexedDB に保存（アプリを閉じても残る） */
export class IdbBackend {
  constructor(name = 'cornering-roads') {
    this.name = name;
    this.db = null;
  }
  #open() {
    if (this.db) return Promise.resolve(this.db);
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(this.name, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('ways')) db.createObjectStore('ways');
      };
      req.onsuccess = () => resolve((this.db = req.result));
      req.onerror = () => reject(req.error);
    });
  }
  async #tx(stores, mode, fn) {
    const db = await this.#open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(stores, mode);
      const out = fn(tx);
      tx.oncomplete = () => resolve(out.result ?? out.value);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }
  allMeta() {
    return this.#tx(['meta'], 'readonly', (tx) => tx.objectStore('meta').getAll());
  }
  getWays(id) {
    return this.#tx(['ways'], 'readonly', (tx) => tx.objectStore('ways').get(id));
  }
  put(meta, ways) {
    return this.#tx(['meta', 'ways'], 'readwrite', (tx) => {
      tx.objectStore('meta').put(meta);
      tx.objectStore('ways').put(ways, meta.id);
      return { value: undefined };
    });
  }
  remove(id) {
    return this.#tx(['meta', 'ways'], 'readwrite', (tx) => {
      tx.objectStore('meta').delete(id);
      tx.objectStore('ways').delete(id);
      return { value: undefined };
    });
  }
}

export class RoadCache {
  /**
   * @param {object} [o]
   * @param {MemoryBackend|IdbBackend} [o.backend]
   * @param {number} [o.maxAreas] 走行中に自動で保存する範囲の数（古いものから消す）
   * @param {number} [o.maxManual] 事前ダウンロードで保存する区画の数
   */
  constructor({ backend = new MemoryBackend(), maxAreas = 150, maxManual = 400 } = {}) {
    this.backend = backend;
    this.maxAreas = maxAreas;
    this.maxManual = maxManual;
    this.metaCache = null;
  }

  async #metas() {
    if (!this.metaCache) {
      try {
        this.metaCache = await this.backend.allMeta();
      } catch {
        this.metaCache = [];
      }
    }
    return this.metaCache;
  }

  /**
   * (lat, lon) のまわり need [m] を含む保存済みの範囲のうち、いちばん余裕のあるもの。
   * 範囲は円（走行中の自動保存）か四角（事前ダウンロード）
   * @returns {Promise<object|null>} meta
   */
  async findCovering(lat, lon, need) {
    let best = null;
    for (const m of await this.#metas()) {
      const margin = coverMargin(m, lat, lon) - need;
      if (margin >= 0 && (!best || margin > best.margin)) best = { ...m, margin };
    }
    return best;
  }

  /**
   * 四角い範囲 bbox を（marginM [m] の余白込みで）すっぽり含む保存済みの範囲があるか
   * @param {number} [maxAgeMs] これより古いものは数えない
   */
  async coversBbox(bbox, marginM = 0, maxAgeMs = Infinity, now = Date.now()) {
    const corners = [
      [bbox.s, bbox.w],
      [bbox.s, bbox.e],
      [bbox.n, bbox.w],
      [bbox.n, bbox.e],
    ];
    return (await this.#metas()).some(
      (m) => now - m.ts < maxAgeMs && corners.every(([la, lo]) => coverMargin(m, la, lo) >= marginM),
    );
  }

  async load(meta) {
    try {
      const c = await this.backend.getWays(meta.id);
      return c ? expandWays(c) : null;
    } catch {
      return null;
    }
  }

  /** 走行中に取得した円い範囲を保存 */
  save(lat, lon, radius, ways, now = Date.now(), provider) {
    const id = `${lat.toFixed(5)},${lon.toFixed(5)},${Math.round(radius)}`;
    return this.#put({ id, kind: 'circle', lat, lon, radius, ts: now, count: ways.length, manual: false, provider }, ways);
  }

  /** 事前ダウンロードした四角い範囲を保存 */
  saveBbox(bbox, ways, now = Date.now(), provider) {
    const f = (x) => x.toFixed(5);
    const id = `bbox:${f(bbox.s)},${f(bbox.w)},${f(bbox.n)},${f(bbox.e)}`;
    const lat = (bbox.s + bbox.n) / 2;
    const lon = (bbox.w + bbox.e) / 2;
    return this.#put({ id, kind: 'bbox', bbox, lat, lon, ts: now, count: ways.length, manual: true, provider }, ways);
  }

  async #put(meta, ways) {
    try {
      const compact = compactWays(ways);
      meta.bytes = JSON.stringify(compact).length;
      await this.backend.put(meta, compact);
      const metas = await this.#metas();
      const i = metas.findIndex((m) => m.id === meta.id);
      if (i >= 0) metas.splice(i, 1);
      metas.push(meta);
      // 自動保存と事前ダウンロードは別々に数え、それぞれ古いものから消す
      for (const [manual, max] of [
        [false, this.maxAreas],
        [true, this.maxManual],
      ]) {
        const group = metas.filter((m) => !!m.manual === manual).sort((a, b) => a.ts - b.ts);
        while (group.length > max) {
          const old = group.shift();
          metas.splice(metas.indexOf(old), 1);
          await this.backend.remove(old.id);
        }
      }
      return true;
    } catch {
      return false; // 保存できなくても走行には影響しない
    }
  }

  async count() {
    return (await this.#metas()).length;
  }

  /** 保存済みの範囲の一覧（地図に描く用） */
  async list() {
    return [...(await this.#metas())];
  }

  /** 保存量のまとめ */
  async stats() {
    const metas = await this.#metas();
    const auto = metas.filter((m) => !m.manual);
    const manual = metas.filter((m) => m.manual);
    return { auto: auto.length, manual: manual.length, bytes: metas.reduce((s, m) => s + (m.bytes || 0), 0) };
  }

  /** 保存した道路データをすべて消す */
  async clear() {
    for (const m of await this.#metas()) {
      try {
        await this.backend.remove(m.id);
      } catch {
        /* 無視 */
      }
    }
    this.metaCache = [];
  }
}

/** 地点 (lat, lon) が保存済みの範囲 m の内側にどれだけ入っているか [m]（外なら負） */
function coverMargin(m, lat, lon) {
  if (m.kind === 'bbox' && m.bbox) {
    const k = Math.cos((lat * Math.PI) / 180);
    const b = m.bbox;
    return Math.min((b.n - lat) * 111195, (lat - b.s) * 111195, (b.e - lon) * 111195 * k, (lon - b.w) * 111195 * k);
  }
  return m.radius - distM(lat, lon, m.lat, m.lon);
}

/**
 * 事前ダウンロードの範囲を区画に分ける。区画どうしは marginKm だけ重ねて取得するので、
 * 区画の境目でも先読みが途切れない
 * @param {{s:number, w:number, n:number, e:number}} bbox
 * @returns {Array<{inner:object, query:object}>} inner：受け持つ区画、query：取得する範囲（余白込み）
 */
export function planTiles(bbox, { tileKm = 5, marginKm = 1 } = {}) {
  const lat0 = (bbox.s + bbox.n) / 2;
  const dLat = (tileKm * 1000) / 111195;
  const dLon = (tileKm * 1000) / (111195 * Math.cos((lat0 * Math.PI) / 180));
  const mLat = (marginKm * 1000) / 111195;
  const mLon = (marginKm * 1000) / (111195 * Math.cos((lat0 * Math.PI) / 180));
  const rows = Math.max(1, Math.ceil((bbox.n - bbox.s) / dLat));
  const cols = Math.max(1, Math.ceil((bbox.e - bbox.w) / dLon));
  const hLat = (bbox.n - bbox.s) / rows;
  const hLon = (bbox.e - bbox.w) / cols;
  const tiles = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const inner = { s: bbox.s + r * hLat, n: bbox.s + (r + 1) * hLat, w: bbox.w + c * hLon, e: bbox.w + (c + 1) * hLon };
      const query = { s: inner.s - mLat, n: inner.n + mLat, w: inner.w - mLon, e: inner.e + mLon };
      tiles.push({ inner, query });
    }
  }
  return tiles;
}

/** 範囲の大きさ [km] */
export function bboxSizeKm(bbox) {
  const lat0 = (bbox.s + bbox.n) / 2;
  return {
    w: ((bbox.e - bbox.w) * 111195 * Math.cos((lat0 * Math.PI) / 180)) / 1000,
    h: ((bbox.n - bbox.s) * 111195) / 1000,
  };
}

/**
 * 範囲の道路をまとめて取得して保存する（事前ダウンロード）
 * - 区画ごとに順番に取得する（サーバーに負担をかけないよう同時には取らない）
 * - 30 日以内に保存済みの区画は飛ばすので、途中で失敗してももう一度呼べば続きから
 * @param {object} bbox
 * @param {RoadCache} cache
 * @param {(bbox:object, opts?:object)=>Promise<object[]>} fetchBbox
 * @param {object} [o]
 * @param {(p:{done:number,total:number,saved:number,skipped:number,failed:number})=>void} [o.onProgress]
 * @param {AbortSignal} [o.signal]
 * @param {number} [o.maxKm] 1 辺の上限
 */
export async function predownload(bbox, cache, fetchBbox, { onProgress, signal, maxKm = 30, maxAgeDays = 30, now = () => Date.now() } = {}) {
  const size = bboxSizeKm(bbox);
  if (size.w > maxKm || size.h > maxKm) {
    throw new Error(`範囲が広すぎます（${Math.round(size.w)}×${Math.round(size.h)}km）。${maxKm}km 四方までに拡大してください`);
  }
  const tiles = planTiles(bbox);
  const p = { done: 0, total: tiles.length, saved: 0, skipped: 0, failed: 0, ways: 0, gsi: 0, error: '' };
  onProgress?.({ ...p });
  for (const t of tiles) {
    if (signal?.aborted) break;
    // 区画全体を 0.7km の余白込みで含む新しいデータがあれば取らない
    if (await cache.coversBbox(t.inner, 700, maxAgeDays * DAY, now())) {
      p.skipped++;
    } else {
      try {
        const got = await fetchBbox(t.query, { signal });
        const ways = Array.isArray(got) ? got : got.ways;
        const provider = Array.isArray(got) ? undefined : got.provider;
        if (await cache.saveBbox(t.query, ways, now(), provider)) {
          p.saved++;
          p.ways += ways.length;
          if (provider === 'gsi') p.gsi++;
        } else p.failed++;
      } catch (e) {
        if (signal?.aborted) break;
        p.failed++;
        p.error = String(e?.message || e);
      }
    }
    p.done++;
    onProgress?.({ ...p });
  }
  return p;
}

/**
 * 通信で道路データを取る関数に、保存済みデータの利用をかぶせる
 * - 必要な範囲が保存済みの範囲に十分おさまり、30 日以内なら通信しない
 * - 通信に失敗したら、現在地のまわりを含む保存済みの範囲で代用する
 * @param {(lat:number, lon:number, radius:number, opts?:object)=>Promise<object[]>} fetcher
 * @param {RoadCache} cache
 * @returns {(lat:number, lon:number, radius:number, opts?:object)=>Promise<{ways:object[], source:string}>}
 */
export function cachedFetcher(fetcher, cache, { maxAgeDays = 30, now = () => Date.now() } = {}) {
  return async (lat, lon, radius, opts = {}) => {
    // 新しい中心のまわり 7 割の範囲が収まる保存済みデータがあれば、それを使う
    const fresh = await cache.findCovering(lat, lon, radius * 0.7);
    if (fresh && now() - fresh.ts < maxAgeDays * DAY) {
      const ways = await cache.load(fresh);
      if (ways) return { ways, source: 'cache', provider: fresh.provider };
    }
    try {
      // 取得元を切り替える関数（roadsource.js）は {ways, provider} を返す
      const got = await fetcher(lat, lon, radius, opts);
      const ways = Array.isArray(got) ? got : got.ways;
      const provider = Array.isArray(got) ? undefined : got.provider;
      await cache.save(lat, lon, radius, ways, now(), provider);
      return { ways, source: 'network', provider };
    } catch (e) {
      // 通信できないとき：古くても、狭くても、現在地のまわりが入っていれば使う
      const near = fresh || (await cache.findCovering(lat, lon, 0)) || (opts.here && (await cache.findCovering(opts.here.lat, opts.here.lon, 150)));
      if (near) {
        const ways = await cache.load(near);
        if (ways) return { ways, source: 'cache-fallback', provider: near.provider };
      }
      throw e;
    }
  };
}
