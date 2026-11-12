// GPS とジャイロから、現在の速度・進行方位・旋回半径を推定する

import { makeProjector, dist, bearingDeg, angleDiffDeg, fitCircle, polylineLength } from './geo.js';

const DEG = Math.PI / 180;

/** 線形回帰の傾き */
function slope(xs, ys) {
  const n = xs.length;
  let mx = 0;
  let my = 0;
  for (let i = 0; i < n; i++) {
    mx += xs[i];
    my += ys[i];
  }
  mx /= n;
  my /= n;
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sxx += (xs[i] - mx) ** 2;
  }
  return sxx > 0 ? sxy / sxx : 0;
}

export class MotionTracker {
  constructor() {
    this.reset();
  }

  reset() {
    this.proj = null;
    this.fixes = [];
    this.speed = 0;
    this.heading = null; // 最後に分かった進行方位（止まっている間も保つ）
    this.headingSource = null; // 'course'（GPS のコース）| 'track'（軌跡から）
    this.accuracy = null;
    this.kappa = 0; // 平滑化した曲率（符号付き、正=左）
    this.kappaSource = null;
    this.lastKappaT = null;
    this.gyro = null; // {omega, t}
    this.lastFix = null;
  }

  /**
   * ジャイロから重力軸まわりの角速度 [rad/s]（符号は端末の向き次第なので大きさのみ使う）
   * @param {number} tSec GPS の fix と同じ基準（epoch 秒）
   */
  setYawRate(omegaAbs, tSec) {
    this.gyro = { omega: Math.abs(omegaAbs), t: tSec };
  }

  /**
   * @param {{t:number, lat:number, lon:number, speed?:number|null, heading?:number|null, accuracy?:number}} f
   *   t は秒
   */
  addFix(f) {
    if (!this.proj) this.proj = makeProjector(f.lat, f.lon);
    let p = this.proj.toXY(f.lat, f.lon);
    if (Math.hypot(p.x, p.y) > 20000) {
      // 原点から遠くなったら座標系を張り直す
      this.proj = makeProjector(f.lat, f.lon);
      this.fixes = this.fixes.map((q) => ({ ...q, ...this.proj.toXY(q.lat, q.lon) }));
      p = this.proj.toXY(f.lat, f.lon);
    }
    const prev = this.fixes[this.fixes.length - 1];
    if (prev && f.t <= prev.t) return; // 時刻が戻ったものは捨てる

    // 速度：GPS の値が無ければ位置の変化から。1 秒ぶんだと止まっていても位置の揺れで
    // 「動いている」ことになるので、3 秒以上前の位置との差で求める
    let speed = Number.isFinite(f.speed) && f.speed >= 0 ? f.speed : null;
    if (speed == null && prev) {
      let q = prev;
      for (let i = this.fixes.length - 1; i >= 0; i--) {
        q = this.fixes[i];
        if (f.t - q.t >= 3) break;
      }
      const dt = f.t - q.t;
      if (dt > 0) speed = dist(q, p) / dt;
    }
    if (speed == null) speed = 0;

    // 方位：GPS のコース（ドップラー由来で滑らか）を優先。
    // 無い端末（Android に多い）では軌跡から求めるが、直前 1 秒の移動だと低速では GPS の誤差に
    // 負けて向きが暴れる（止まっていても位置が揺れて向きが付いてしまう）。そこで、ある程度
    // 走っているときだけ、12m 以上離れた 8 秒以内の過去の位置からの向きを使う。
    // 止まっている間は最後の向きをそのまま保つ
    let heading = Number.isFinite(f.heading) && f.heading >= 0 && speed > 1.5 ? (f.heading + 360) % 360 : null;
    let headingSource = heading != null ? 'course' : null;
    if (heading == null && speed > 2) {
      for (let i = this.fixes.length - 1; i >= 0; i--) {
        const q = this.fixes[i];
        if (f.t - q.t > 8) break;
        if (dist(q, p) >= 12) {
          heading = bearingDeg(q, p);
          headingSource = 'track';
          break;
        }
      }
    }

    const rec = { t: f.t, lat: f.lat, lon: f.lon, x: p.x, y: p.y, speed, heading, accuracy: f.accuracy };
    this.fixes.push(rec);
    while (this.fixes.length && f.t - this.fixes[0].t > 15) this.fixes.shift();

    this.speed = speed;
    if (heading != null) {
      this.heading = heading;
      this.headingSource = headingSource;
    }
    this.accuracy = Number.isFinite(f.accuracy) ? f.accuracy : null;
    this.lastFix = rec;
    this.#updateCurvature(f.t);
  }

  /** GPS コースの変化率から曲率を求める */
  #curvatureFromCourse(now) {
    const pts = this.fixes.filter((q) => now - q.t <= 4.5 && q.heading != null && q.speed > 2);
    if (pts.length < 3) return null;
    const ts = [];
    const hs = [];
    let acc = 0;
    for (let i = 0; i < pts.length; i++) {
      if (i > 0) acc += angleDiffDeg(pts[i - 1].heading, pts[i].heading);
      ts.push(pts[i].t);
      hs.push(acc);
    }
    const omega = slope(ts, hs) * DEG; // rad/s、正 = 時計回り = 右カーブ
    const v = pts.reduce((s, q) => s + q.speed, 0) / pts.length;
    if (v < 2) return null;
    return -omega / v; // 左を正にする
  }

  /** 位置の軌跡に円を当てはめて曲率を求める（コースが取れないとき用） */
  #curvatureFromTrack(now) {
    const pts = this.fixes.filter((q) => now - q.t <= 8);
    if (pts.length < 4) return null;
    const len = polylineLength(pts);
    if (len < 25) return null;
    const c = fitCircle(pts);
    if (!c) return null;
    const acc = this.accuracy || 5;
    if (c.rms > Math.max(4, acc)) return null;
    const turnAngle = len / c.r;
    if (c.r > 3000 || turnAngle < 0.05) return 0;
    // 向き：最初→最後の進行に対して中心が左右どちらか
    const a = pts[0];
    const b = pts[pts.length - 1];
    const cross = (b.x - a.x) * (c.cy - a.y) - (b.y - a.y) * (c.cx - a.x);
    return (cross > 0 ? 1 : -1) / c.r;
  }

  #updateCurvature(now) {
    let k = null;
    let src = null;
    const course = this.#curvatureFromCourse(now);
    const fresh = this.gyro && now - this.gyro.t < 1.5;
    if (fresh && this.speed > 3) {
      const mag = this.gyro.omega < 0.6 * DEG ? 0 : this.gyro.omega / this.speed;
      const sign = course != null && course < 0 ? -1 : 1;
      k = sign * mag;
      src = 'gyro';
    } else if (course != null) {
      k = course;
      src = 'gps-course';
    } else {
      const tr = this.#curvatureFromTrack(now);
      if (tr != null) {
        k = tr;
        src = 'gps-track';
      }
    }
    if (this.speed < 1.5) {
      k = 0;
      src = null;
    }
    if (k == null) return;
    // 曲率で平滑化（R で平滑化すると直線で発散するため）
    const dt = this.lastKappaT == null ? 1 : Math.max(0.05, now - this.lastKappaT);
    const alpha = 1 - Math.exp(-dt / 1.2);
    this.kappa += (k - this.kappa) * alpha;
    this.kappaSource = src;
    this.lastKappaT = now;
  }

  get radius() {
    return Math.abs(this.kappa) < 1 / 1500 ? Infinity : 1 / Math.abs(this.kappa);
  }

  get turnDir() {
    return this.kappa > 0 ? 'left' : 'right';
  }

  /** 現在の横加速度 [G] */
  get lateralG() {
    return (this.speed * this.speed * Math.abs(this.kappa)) / 9.80665;
  }

  get state() {
    return {
      speed: this.speed,
      heading: this.heading,
      headingSource: this.headingSource,
      accuracy: this.accuracy,
      radius: this.radius,
      turnDir: this.turnDir,
      lateralG: this.lateralG,
      source: this.kappaSource,
    };
  }
}

/** GPS の監視を開始。停止関数を返す */
export function startGps(onFix, onError) {
  if (!('geolocation' in navigator)) {
    onError?.(new Error('この端末は位置情報に対応していません'));
    return () => {};
  }
  const id = navigator.geolocation.watchPosition(
    (pos) => {
      const c = pos.coords;
      // 端末によって timestamp がおかしいことがあるので、大きくずれていたら受信時刻を使う
      const now = Date.now();
      const ts = Math.abs(pos.timestamp - now) < 10000 ? pos.timestamp : now;
      onFix({
        t: ts / 1000,
        lat: c.latitude,
        lon: c.longitude,
        speed: c.speed,
        heading: c.heading,
        accuracy: c.accuracy,
      });
    },
    (err) => onError?.(err),
    { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 },
  );
  return () => navigator.geolocation.clearWatch(id);
}

/** iOS ではユーザー操作の中で許可を求める必要がある */
export async function requestMotionPermission() {
  const DME = globalThis.DeviceMotionEvent;
  if (DME && typeof DME.requestPermission === 'function') {
    try {
      return (await DME.requestPermission()) === 'granted';
    } catch {
      return false;
    }
  }
  return !!DME;
}

/**
 * ジャイロの監視を開始。端末の向きに関係なく、重力方向まわりの角速度（＝ヨーレート）を返す。
 * 旋回中は遠心力で「重力」の推定が傾くので、加速度の大きさが 1G 付近のときだけ重力推定を更新する。
 */
export function startGyro(onYaw) {
  if (!('DeviceMotionEvent' in globalThis)) return () => {};
  let g = null;
  let ema = 0;
  let lastT = null;
  const handler = (e) => {
    const ag = e.accelerationIncludingGravity;
    const rr = e.rotationRate;
    if (!ag || !rr || ag.x == null || rr.alpha == null) return;
    const mag = Math.hypot(ag.x, ag.y, ag.z);
    if (!g) g = { x: ag.x, y: ag.y, z: ag.z };
    else if (Math.abs(mag - 9.81) < 0.35) {
      const a = 0.02;
      g.x += (ag.x - g.x) * a;
      g.y += (ag.y - g.y) * a;
      g.z += (ag.z - g.z) * a;
    }
    const n = Math.hypot(g.x, g.y, g.z);
    if (n < 5) return;
    // rotationRate: alpha=z軸, beta=x軸, gamma=y軸まわり [deg/s]
    const w = ((rr.beta || 0) * g.x + (rr.gamma || 0) * g.y + (rr.alpha || 0) * g.z) / n;
    const t = performance.now() / 1000;
    const dt = lastT == null ? 0.02 : Math.min(0.5, t - lastT);
    lastT = t;
    ema += (Math.abs(w) - ema) * (1 - Math.exp(-dt / 0.6));
    // GPS の時刻と比較できるよう epoch 秒で渡す
    onYaw(ema * DEG, Date.now() / 1000);
  };
  window.addEventListener('devicemotion', handler);
  return () => window.removeEventListener('devicemotion', handler);
}
