// 標高タイルから地点の標高を引き、道路に沿った標高プロファイル・勾配を求める
//
// 国内：国土地理院 標高タイル（DEM10B、PNG 形式）
//   https://maps.gsi.go.jp/development/demtile.html
//   標高 = (R·2^16 + G·2^8 + B) × 0.01 m（2^23 以上は負値、(128,0,0) は無効値）
// 国外・海上など地理院タイルが無い所：AWS Terrain Tiles（Terrarium 形式）
//   標高 = (R·256 + G + B/256) − 32768 m

const TILE = 256;

export const DEM_SOURCES = [
  {
    id: 'gsi',
    label: '国土地理院',
    url: (z, x, y) => `https://cyberjapandata.gsi.go.jp/xyz/dem_png/${z}/${x}/${y}.png`,
    decode: decodeGsiDemPng,
  },
  {
    id: 'terrarium',
    label: 'Terrarium',
    url: (z, x, y) => `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`,
    decode: decodeTerrariumPng,
  },
];

/** 地理院 DEM PNG の RGBA → 標高配列 [m]（無効値は NaN） */
export function decodeGsiDemPng(rgba) {
  const n = rgba.length / 4;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const r = rgba[i * 4];
    const g = rgba[i * 4 + 1];
    const b = rgba[i * 4 + 2];
    const a = rgba[i * 4 + 3];
    if (a === 0 || (r === 128 && g === 0 && b === 0)) {
      out[i] = NaN;
      continue;
    }
    let v = r * 65536 + g * 256 + b;
    if (v >= 8388608) v -= 16777216;
    out[i] = v * 0.01;
  }
  return out;
}

/** Terrarium PNG の RGBA → 標高配列 [m] */
export function decodeTerrariumPng(rgba) {
  const n = rgba.length / 4;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = rgba[i * 4 + 3];
    out[i] = a === 0 ? NaN : rgba[i * 4] * 256 + rgba[i * 4 + 1] + rgba[i * 4 + 2] / 256 - 32768;
  }
  return out;
}

/** 緯度経度 → タイル座標（小数） */
export function tileCoord(lat, lon, z) {
  const n = 2 ** z;
  const x = ((lon + 180) / 360) * n;
  const r = (lat * Math.PI) / 180;
  const y = ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n;
  return { x, y };
}

/** ブラウザで PNG タイルを取得して RGBA を返す（色空間変換なし） */
async function fetchTileRgba(url) {
  const res = await fetch(url, { mode: 'cors' });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const blob = await res.blob();
  const bmp = await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  const canvas =
    typeof OffscreenCanvas !== 'undefined'
      ? new OffscreenCanvas(TILE, TILE)
      : Object.assign(document.createElement('canvas'), { width: TILE, height: TILE });
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0);
  bmp.close?.();
  return ctx.getImageData(0, 0, TILE, TILE).data;
}

/**
 * 地点の標高を返すプロバイダ。タイルは非同期に読み込み、読み込み済みなら即座に値を返す
 */
export class DemElevation {
  /**
   * @param {object} [o]
   * @param {(z:number,x:number,y:number)=>Promise<Float32Array|null>} [o.loadTile]
   *   タイルを読み込む関数（テスト用に差し替え可）。null を返すとデータ無し
   */
  constructor({ zoom = 14, loadTile, maxTiles = 64 } = {}) {
    this.zoom = zoom;
    this.maxTiles = maxTiles;
    this.tiles = new Map(); // key -> Float32Array | null（データ無し）
    this.pending = new Set();
    this.retryAt = new Map();
    this.loadTile = loadTile || ((z, x, y) => this.#loadFromSources(z, x, y));
    this.source = null;
    this.error = '';
  }

  async #loadFromSources(z, x, y) {
    let lastErr = null;
    for (const src of DEM_SOURCES) {
      try {
        const rgba = await fetchTileRgba(src.url(z, x, y));
        if (!rgba) continue; // このソースには無い → 次へ
        const data = src.decode(rgba);
        // 全部無効値（海など）なら次のソースを試す
        if (data.every((v) => Number.isNaN(v))) continue;
        this.source = src.label;
        return data;
      } catch (e) {
        lastErr = e;
      }
    }
    if (lastErr) throw lastErr;
    return null;
  }

  get status() {
    if (this.pending.size) return 'loading';
    if (this.error && !this.tiles.size) return 'error';
    if (this.tiles.size) return 'ready';
    return 'idle';
  }

  #request(key, x, y) {
    if (this.pending.has(key) || Date.now() < (this.retryAt.get(key) || 0)) return;
    this.pending.add(key);
    this.loadTile(this.zoom, x, y)
      .then((data) => {
        this.tiles.set(key, data || null);
        this.error = '';
        if (this.tiles.size > this.maxTiles) this.tiles.delete(this.tiles.keys().next().value);
      })
      .catch((e) => {
        this.error = String(e?.message || e);
        this.retryAt.set(key, Date.now() + 15000);
      })
      .finally(() => this.pending.delete(key));
  }

  /**
   * 地点の標高 [m]。未読み込みなら読み込みを始めて null を返す
   */
  get(lat, lon) {
    const { x, y } = tileCoord(lat, lon, this.zoom);
    const tx = Math.floor(x);
    const ty = Math.floor(y);
    const key = `${tx}/${ty}`;
    if (!this.tiles.has(key)) {
      this.#request(key, tx, ty);
      return null;
    }
    const data = this.tiles.get(key);
    if (!data) return null;
    // タイル内でバイリニア補間（端は最近傍）
    const fx = Math.min(TILE - 1, Math.max(0, (x - tx) * TILE - 0.5));
    const fy = Math.min(TILE - 1, Math.max(0, (y - ty) * TILE - 0.5));
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const x1 = Math.min(TILE - 1, x0 + 1);
    const y1 = Math.min(TILE - 1, y0 + 1);
    const ax = fx - x0;
    const ay = fy - y0;
    const v00 = data[y0 * TILE + x0];
    const v10 = data[y0 * TILE + x1];
    const v01 = data[y1 * TILE + x0];
    const v11 = data[y1 * TILE + x1];
    const vals = [v00, v10, v01, v11];
    if (vals.some((v) => Number.isNaN(v))) {
      const ok = vals.filter((v) => !Number.isNaN(v));
      return ok.length ? ok.reduce((a, b) => a + b, 0) / ok.length : null;
    }
    return (v00 * (1 - ax) + v10 * ax) * (1 - ay) + (v01 * (1 - ax) + v11 * ax) * ay;
  }
}

/**
 * 道路に沿った標高プロファイルを作る
 * 橋・トンネル区間は地表の標高が使えないので、前後の値から直線補間する
 * @param {{x:number,y:number,st?:boolean}[]} pts 等間隔点列（st = 橋・トンネル）
 * @param {(x:number,y:number)=>{lat:number,lon:number}} toLatLon
 * @param {(lat:number,lon:number)=>number|null} elevAt
 * @param {number} ds 点の間隔 [m]
 * @returns {number[]|null} 平滑化した標高 [m]。値が足りなければ null
 */
export function elevationProfile(pts, toLatLon, elevAt, ds, smoothM = 15) {
  const n = pts.length;
  if (n < 2) return null;
  const raw = new Array(n);
  let valid = 0;
  for (let i = 0; i < n; i++) {
    if (pts[i].st) {
      raw[i] = NaN;
      continue;
    }
    const ll = toLatLon(pts[i].x, pts[i].y);
    const e = elevAt(ll.lat, ll.lon);
    raw[i] = Number.isFinite(e) ? e : NaN;
    if (Number.isFinite(e)) valid++;
  }
  if (valid < Math.max(2, n * 0.5)) return null;
  // 欠損を直線補間（端は最寄りの値）
  let prev = -1;
  for (let i = 0; i < n; i++) {
    if (Number.isNaN(raw[i])) continue;
    if (prev < 0) for (let j = 0; j < i; j++) raw[j] = raw[i];
    else for (let j = prev + 1; j < i; j++) raw[j] = raw[prev] + ((raw[i] - raw[prev]) * (j - prev)) / (i - prev);
    prev = i;
  }
  for (let j = prev + 1; j < n; j++) raw[j] = raw[prev];
  // 移動平均（DEM のメッシュ境界によるガタつきを抑える）
  const k = Math.max(1, Math.round(smoothM / ds));
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    let c = 0;
    for (let j = Math.max(0, i - k); j <= Math.min(n - 1, i + k); j++) {
      s += raw[j];
      c++;
    }
    out[i] = s / c;
  }
  return out;
}

/** 標高プロファイルの区間 [i0, i1] の平均勾配 [%] */
export function gradeBetween(elev, i0, i1, ds) {
  if (!elev || i1 <= i0) return 0;
  const a = Math.max(0, i0);
  const b = Math.min(elev.length - 1, i1);
  if (b <= a) return 0;
  return ((elev[b] - elev[a]) / ((b - a) * ds)) * 100;
}
