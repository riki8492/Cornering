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
   * @param {number} [o.maxAreas] 保存しておく範囲の数（古いものから消す）
   */
  constructor({ backend = new MemoryBackend(), maxAreas = 150 } = {}) {
    this.backend = backend;
    this.maxAreas = maxAreas;
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
   * (lat, lon) のまわり need [m] を含む保存済みの範囲のうち、いちばん余裕のあるもの
   * @returns {Promise<object|null>} meta
   */
  async findCovering(lat, lon, need) {
    let best = null;
    for (const m of await this.#metas()) {
      const margin = m.radius - distM(lat, lon, m.lat, m.lon) - need;
      if (margin >= 0 && (!best || margin > best.margin)) best = { ...m, margin };
    }
    return best;
  }

  async load(meta) {
    try {
      const c = await this.backend.getWays(meta.id);
      return c ? expandWays(c) : null;
    } catch {
      return null;
    }
  }

  async save(lat, lon, radius, ways, now = Date.now()) {
    const meta = { id: `${lat.toFixed(5)},${lon.toFixed(5)},${Math.round(radius)}`, lat, lon, radius, ts: now, count: ways.length };
    try {
      await this.backend.put(meta, compactWays(ways));
      const metas = await this.#metas();
      const i = metas.findIndex((m) => m.id === meta.id);
      if (i >= 0) metas.splice(i, 1);
      metas.push(meta);
      // 古い範囲から消す
      metas.sort((a, b) => a.ts - b.ts);
      while (metas.length > this.maxAreas) {
        const old = metas.shift();
        await this.backend.remove(old.id);
      }
    } catch {
      /* 保存できなくても走行には影響しない */
    }
  }

  async count() {
    return (await this.#metas()).length;
  }
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
      if (ways) return { ways, source: 'cache' };
    }
    try {
      const ways = await fetcher(lat, lon, radius, opts);
      await cache.save(lat, lon, radius, ways, now());
      return { ways, source: 'network' };
    } catch (e) {
      // 通信できないとき：古くても、狭くても、現在地のまわりが入っていれば使う
      const near = fresh || (await cache.findCovering(lat, lon, 0)) || (opts.here && (await cache.findCovering(opts.here.lat, opts.here.lon, 150)));
      if (near) {
        const ways = await cache.load(near);
        if (ways) return { ways, source: 'cache-fallback' };
      }
      throw e;
    }
  };
}
