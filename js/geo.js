// 幾何ユーティリティ：座標変換・円フィッティング・曲率プロファイル

export const EARTH_RADIUS = 6371008.8;
const DEG = Math.PI / 180;

/**
 * 原点まわりの局所平面座標（x: 東, y: 北 [m]）への投影。
 * 数km 程度の範囲なら正距円筒近似で十分な精度になる。
 */
export function makeProjector(lat0, lon0) {
  const k = Math.cos(lat0 * DEG);
  return {
    lat0,
    lon0,
    toXY(lat, lon) {
      return {
        x: (lon - lon0) * DEG * EARTH_RADIUS * k,
        y: (lat - lat0) * DEG * EARTH_RADIUS,
      };
    },
    toLatLon(x, y) {
      return {
        lat: lat0 + y / (EARTH_RADIUS * DEG),
        lon: lon0 + x / (EARTH_RADIUS * DEG * k),
      };
    },
  };
}

export function haversine(lat1, lon1, lat2, lon2) {
  const dLat = (lat2 - lat1) * DEG;
  const dLon = (lon2 - lon1) * DEG;
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * DEG) * Math.cos(lat2 * DEG) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS * Math.asin(Math.min(1, Math.sqrt(a)));
}

export const dist = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);

/** 方位角（北=0°, 時計回り）[deg] */
export function bearingDeg(a, b) {
  const d = Math.atan2(b.x - a.x, b.y - a.y) / DEG;
  return (d + 360) % 360;
}

/** 方位の差 b − a を −180〜180° に正規化 */
export function angleDiffDeg(a, b) {
  let d = (b - a) % 360;
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  return d;
}

/**
 * 3点を通る円の符号付き曲率 [1/m]。正 = 左カーブ（反時計回り）
 */
export function signedCurvature3(a, b, c) {
  const ab = dist(a, b);
  const bc = dist(b, c);
  const ca = dist(c, a);
  const cross = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  const den = ab * bc * ca;
  if (den < 1e-9) return 0;
  return (2 * cross) / den;
}

/**
 * 代数的最小二乗による円フィッティング（Kåsa 法）
 * @returns {{cx:number, cy:number, r:number, rms:number} | null}
 */
export function fitCircle(points) {
  const n = points.length;
  if (n < 3) return null;
  let mx = 0;
  let my = 0;
  for (const p of points) {
    mx += p.x;
    my += p.y;
  }
  mx /= n;
  my /= n;
  let suu = 0;
  let svv = 0;
  let suv = 0;
  let suuu = 0;
  let svvv = 0;
  let suvv = 0;
  let svuu = 0;
  for (const p of points) {
    const u = p.x - mx;
    const v = p.y - my;
    suu += u * u;
    svv += v * v;
    suv += u * v;
    suuu += u * u * u;
    svvv += v * v * v;
    suvv += u * v * v;
    svuu += v * u * u;
  }
  const det = suu * svv - suv * suv;
  if (Math.abs(det) < 1e-9) return null;
  const b1 = 0.5 * (suuu + suvv);
  const b2 = 0.5 * (svvv + svuu);
  const uc = (b1 * svv - b2 * suv) / det;
  const vc = (b2 * suu - b1 * suv) / det;
  const r = Math.sqrt(uc * uc + vc * vc + (suu + svv) / n);
  const cx = uc + mx;
  const cy = vc + my;
  let se = 0;
  for (const p of points) {
    const e = Math.hypot(p.x - cx, p.y - cy) - r;
    se += e * e;
  }
  return { cx, cy, r, rms: Math.sqrt(se / n) };
}

export function polylineLength(pts) {
  let s = 0;
  for (let i = 1; i < pts.length; i++) s += dist(pts[i - 1], pts[i]);
  return s;
}

/** 折れ線を等間隔 ds で再サンプリング（最初の点を含む） */
export function resample(pts, ds) {
  if (pts.length === 0) return [];
  const out = [{ x: pts[0].x, y: pts[0].y }];
  let carry = 0; // 直前の出力点から現在セグメント始点までの距離
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const len = dist(a, b);
    if (len === 0) continue;
    let t = ds - carry;
    while (t <= len + 1e-9) {
      out.push({ x: a.x + ((b.x - a.x) * t) / len, y: a.y + ((b.y - a.y) * t) / len });
      t += ds;
    }
    carry = len - (t - ds);
  }
  return out;
}

/**
 * 等間隔点列の符号付き曲率プロファイル。
 * 前後 halfChord [m] 離れた点との3点円で曲率を求め、移動平均で平滑化する。
 * OSM の折れ線は頂点が粗いので、弦を長めに取ってガタつきを抑える。
 */
export function curvatureProfile(pts, ds, halfChord = 15) {
  const n = pts.length;
  const k = Math.max(1, Math.round(halfChord / ds));
  const raw = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - k);
    const c = Math.min(n - 1, i + k);
    if (c - a < 2 || i === a || i === c) {
      raw[i] = NaN;
      continue;
    }
    raw[i] = signedCurvature3(pts[a], pts[i], pts[c]);
  }
  // 端は隣の有効値で埋める
  let firstValid = raw.findIndex((v) => Number.isFinite(v));
  if (firstValid < 0) return raw.map(() => 0);
  for (let i = 0; i < firstValid; i++) raw[i] = raw[firstValid];
  for (let i = 1; i < n; i++) if (!Number.isFinite(raw[i])) raw[i] = raw[i - 1];
  // 3点移動平均
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    let c = 0;
    for (let j = i - 1; j <= i + 1; j++) {
      if (j >= 0 && j < n) {
        s += raw[j];
        c++;
      }
    }
    out[i] = s / c;
  }
  return out;
}

/**
 * 曲率プロファイルからカーブ区間を抽出する
 * @param {number[]} kappa 符号付き曲率
 * @param {number} ds サンプル間隔 [m]
 * @param {object} [o]
 * @returns {Array<{startIdx:number,endIdx:number,apexIdx:number,R:number,dir:'left'|'right',length:number}>}
 */
export function findCurves(kappa, ds, o = {}) {
  const thresholdR = o.thresholdR ?? 600;
  const mergeGap = o.mergeGap ?? 15;
  const minLength = o.minLength ?? 8;
  const kth = 1 / thresholdR;
  const runs = [];
  let cur = null;
  for (let i = 0; i < kappa.length; i++) {
    const k = kappa[i];
    const sign = k > kth ? 1 : k < -kth ? -1 : 0;
    if (sign !== 0 && cur && cur.sign === sign) {
      cur.endIdx = i;
    } else {
      if (cur) runs.push(cur);
      cur = sign !== 0 ? { sign, startIdx: i, endIdx: i } : null;
    }
  }
  if (cur) runs.push(cur);

  // 同じ向きで間が短いものは結合
  const merged = [];
  for (const r of runs) {
    const last = merged[merged.length - 1];
    if (last && last.sign === r.sign && (r.startIdx - last.endIdx) * ds <= mergeGap) {
      last.endIdx = r.endIdx;
    } else merged.push({ ...r });
  }

  return merged
    .map((r) => {
      let apexIdx = r.startIdx;
      for (let i = r.startIdx; i <= r.endIdx; i++) {
        if (Math.abs(kappa[i]) > Math.abs(kappa[apexIdx])) apexIdx = i;
      }
      return {
        startIdx: r.startIdx,
        endIdx: r.endIdx,
        apexIdx,
        R: 1 / Math.abs(kappa[apexIdx]),
        dir: r.sign > 0 ? 'left' : 'right',
        length: (r.endIdx - r.startIdx + 1) * ds,
      };
    })
    .filter((c) => c.length >= minLength);
}

/** 点 p から線分 ab への射影 */
export function projectOnSegment(p, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const x = a.x + dx * t;
  const y = a.y + dy * t;
  return { t, x, y, d: Math.hypot(p.x - x, p.y - y) };
}
