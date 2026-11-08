// 車両の定常円旋回モデル
// 道路の半径 R・車両諸元・タイヤ・路面から、定常旋回できる上限速度を求める。
//
// 考慮している要素
//   - タイヤ種類 × 路面状態 × 摩耗 によるピーク摩擦係数
//   - タイヤの荷重感度（重いほど μ が下がる）… 車重・タイヤ幅で補正
//   - 横方向荷重移動（重心高 / トレッド）と前後ロール剛性配分
//   - 前後軸重：各軸が自分の軸重ぶんの横力を受け持つ（定常旋回のモーメント釣り合い）
//   - 駆動方式：速度維持に必要な駆動力（空気抵抗・転がり抵抗・コーナリング抵抗）が
//     駆動輪の摩擦円を食う。オープンデフでは内輪の空転も判定
//   - 片勾配（カント）
//   - 転覆限界（静的安定係数 SSF = トレッド / (2 × 重心高)）
// 全て国際単位系（m, kg, s, N）。速度は m/s。

export const G = 9.80665;
export const RHO_AIR = 1.225;

/** 転覆判定に使う SSF の低減係数（サスペンションのロールによる重心の横移動ぶん） */
export const ROLLOVER_FACTOR = 0.88;

export const SURFACES = {
  dry: { label: '乾燥舗装', crr: 0.012 },
  wet: { label: '濡れた舗装', crr: 0.013 },
  rain: { label: '大雨・水たまり', crr: 0.016 },
  snow: { label: '圧雪', crr: 0.03 },
  ice: { label: '凍結（アイスバーン）', crr: 0.012 },
  gravel: { label: '砂利・未舗装', crr: 0.025 },
};

// mu: 基準荷重でのピーク横方向摩擦係数（路面別）
// alphaPeakDeg: 横力がピークになるスリップ角（コーナリング抵抗の計算に使う）
// loadSens: 荷重感度指数 k （Fy_max = μ0·Fz·(Fz/Fz0)^-k）
export const TIRES = {
  eco: {
    label: 'エコタイヤ（低燃費）',
    mu: { dry: 0.85, wet: 0.6, rain: 0.45, snow: 0.12, ice: 0.06, gravel: 0.55 },
    alphaPeakDeg: 7.0,
    loadSens: 0.18,
  },
  standard: {
    label: 'スタンダード／コンフォート',
    mu: { dry: 0.9, wet: 0.65, rain: 0.5, snow: 0.13, ice: 0.06, gravel: 0.56 },
    alphaPeakDeg: 6.5,
    loadSens: 0.17,
  },
  sport: {
    label: 'スポーツ',
    mu: { dry: 1.0, wet: 0.72, rain: 0.52, snow: 0.12, ice: 0.05, gravel: 0.58 },
    alphaPeakDeg: 5.5,
    loadSens: 0.15,
  },
  highgrip: {
    label: 'ハイグリップ',
    mu: { dry: 1.1, wet: 0.72, rain: 0.48, snow: 0.1, ice: 0.05, gravel: 0.58 },
    alphaPeakDeg: 5.0,
    loadSens: 0.14,
  },
  semislick: {
    label: 'Sタイヤ／セミスリック',
    mu: { dry: 1.25, wet: 0.65, rain: 0.35, snow: 0.08, ice: 0.04, gravel: 0.5 },
    alphaPeakDeg: 4.5,
    loadSens: 0.12,
  },
  allseason: {
    label: 'オールシーズン',
    mu: { dry: 0.85, wet: 0.62, rain: 0.48, snow: 0.25, ice: 0.09, gravel: 0.56 },
    alphaPeakDeg: 7.0,
    loadSens: 0.18,
  },
  studless: {
    label: 'スタッドレス',
    mu: { dry: 0.75, wet: 0.55, rain: 0.45, snow: 0.35, ice: 0.15, gravel: 0.52 },
    alphaPeakDeg: 8.0,
    loadSens: 0.2,
  },
  offroad: {
    label: 'オフロード（A/T・M/T）',
    mu: { dry: 0.75, wet: 0.55, rain: 0.42, snow: 0.2, ice: 0.07, gravel: 0.65 },
    alphaPeakDeg: 8.0,
    loadSens: 0.2,
  },
};

// 摩耗による μ の倍率（路面別）。溝が効くのは水・雪の路面
export const WEAR = {
  new: { label: '新品〜8分山', f: { dry: 1, wet: 1, rain: 1, snow: 1, ice: 1, gravel: 1 } },
  half: { label: '5分山', f: { dry: 1, wet: 0.9, rain: 0.8, snow: 0.8, ice: 0.85, gravel: 0.95 } },
  worn: {
    label: '摩耗（スリップサイン付近）',
    f: { dry: 1, wet: 0.7, rain: 0.5, snow: 0.5, ice: 0.7, gravel: 0.9 },
  },
};

// driveFront: 駆動力の前輪配分 / defaultFrontRatio: 軸重が不明なときの前軸重量比の目安
export const DRIVETRAINS = {
  FF: { label: 'FF（前輪駆動）', driveFront: 1.0, defaultFrontRatio: 0.62 },
  FR: { label: 'FR（後輪駆動）', driveFront: 0.0, defaultFrontRatio: 0.53 },
  MR: { label: 'MR（ミッドシップ）', driveFront: 0.0, defaultFrontRatio: 0.43 },
  RR: { label: 'RR（リアエンジン）', driveFront: 0.0, defaultFrontRatio: 0.39 },
  AWD_F: { label: '4WD（FFベース・オンデマンド）', driveFront: 0.8, defaultFrontRatio: 0.6 },
  AWD: { label: '4WD（フルタイム・前後均等）', driveFront: 0.5, defaultFrontRatio: 0.56 },
  AWD_R: { label: '4WD（FR/MRベース）', driveFront: 0.35, defaultFrontRatio: 0.52 },
};

/** タイヤ幅 195mm のときの基準荷重 [N]（1輪あたり）。幅に比例させる */
const FZ0_BASE = 3500;
const TIRE_WIDTH_BASE = 195;

export const DEFAULT_VEHICLE = {
  massKg: 1300,
  frontAxleKg: 790,
  rearAxleKg: 510,
  payloadKg: 60,
  widthMm: 1695,
  heightMm: 1480,
  lengthMm: 4400,
  drivetrain: 'FF',
  lsd: false,
  tire: 'standard',
  tireWidthMm: 195,
  wear: 'new',
  // 推定値の上書き（未指定なら車幅・車高・車長から推定）
  trackMm: null,
  cgHeightMm: null,
  wheelbaseMm: null,
  cd: null,
  frontalAreaM2: null,
  rollStiffFrontPct: null,
  minTurnRadiusM: null,
};

export const DEFAULT_ENV = {
  surface: 'dry',
  bankPct: 0,
  safety: 0.5,
};

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const pos = (x) => Number.isFinite(x) && x > 0;

function lerpTable(table, x) {
  if (x <= table[0][0]) return table[0][1];
  for (let i = 1; i < table.length; i++) {
    if (x <= table[i][0]) {
      const [x0, y0] = table[i - 1];
      const [x1, y1] = table[i];
      return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
    }
  }
  return table[table.length - 1][1];
}

/** 車高から空気抵抗係数 Cd を推定（低いスポーツカー〜背の高いワンボックス） */
export function estimateCd(heightM) {
  return lerpTable(
    [
      [1.2, 0.29],
      [1.45, 0.3],
      [1.7, 0.35],
      [1.9, 0.38],
      [2.2, 0.45],
    ],
    heightM,
  );
}

/** 車高から重心高を推定 [m] */
export function estimateCgHeight(heightM) {
  return clamp(0.42 * heightM - 0.06, 0.3, 1.3);
}

/** 車幅からトレッドを推定 [m] */
export function estimateTrack(widthM) {
  return widthM * 0.86;
}

/** 車長からホイールベースを推定 [m] */
export function estimateWheelbase(lengthM) {
  return clamp(0.39 * lengthM + 0.9, 1.8, 4.5);
}

/** 前面投影面積の推定 [m²] */
export function estimateFrontalArea(widthM, heightM) {
  return 0.84 * widthM * heightM;
}

/**
 * 入力（車両諸元）から計算用のパラメータを導出する。
 * 車種・年式・グレードは不要で、重量と外寸だけから推定する。
 */
export function deriveVehicle(input = {}) {
  const p = { ...DEFAULT_VEHICLE, ...input };
  const drive = DRIVETRAINS[p.drivetrain] || DRIVETRAINS.FF;
  const tire = TIRES[p.tire] || TIRES.standard;
  const wear = WEAR[p.wear] || WEAR.new;

  const fA = Number(p.frontAxleKg);
  const rA = Number(p.rearAxleKg);
  let mass = Number(p.massKg);
  if (!pos(mass)) mass = pos(fA) && pos(rA) ? fA + rA : DEFAULT_VEHICLE.massKg;

  let frontRatio;
  let axleSource;
  if (pos(fA) && pos(rA)) {
    frontRatio = fA / (fA + rA);
    axleSource = 'input';
  } else if (pos(fA) && fA < mass) {
    frontRatio = fA / mass;
    axleSource = 'input';
  } else if (pos(rA) && rA < mass) {
    frontRatio = 1 - rA / mass;
    axleSource = 'input';
  } else {
    frontRatio = drive.defaultFrontRatio;
    axleSource = 'drivetrain';
  }
  frontRatio = clamp(frontRatio, 0.2, 0.8);

  const payload = Math.max(0, Number(p.payloadKg) || 0);
  const m = mass + payload;
  // 乗員・荷物は前後均等に載ると仮定
  const frontMass = mass * frontRatio + payload * 0.5;
  const fr = frontMass / m;

  const width = (pos(+p.widthMm) ? +p.widthMm : DEFAULT_VEHICLE.widthMm) / 1000;
  const height = (pos(+p.heightMm) ? +p.heightMm : DEFAULT_VEHICLE.heightMm) / 1000;
  const length = (pos(+p.lengthMm) ? +p.lengthMm : DEFAULT_VEHICLE.lengthMm) / 1000;

  const track = pos(+p.trackMm) ? +p.trackMm / 1000 : estimateTrack(width);
  const cgHeight = pos(+p.cgHeightMm) ? +p.cgHeightMm / 1000 : estimateCgHeight(height);
  const wheelbase = pos(+p.wheelbaseMm) ? +p.wheelbaseMm / 1000 : estimateWheelbase(length);
  const cd = pos(+p.cd) ? +p.cd : estimateCd(height);
  const frontalArea = pos(+p.frontalAreaM2) ? +p.frontalAreaM2 : estimateFrontalArea(width, height);
  const lltdFront = pos(+p.rollStiffFrontPct)
    ? clamp(+p.rollStiffFrontPct / 100, 0.2, 0.85)
    : clamp(fr + 0.05, 0.3, 0.75);

  const tireWidth = pos(+p.tireWidthMm) ? +p.tireWidthMm : TIRE_WIDTH_BASE;
  const minTurnRadius = pos(+p.minTurnRadiusM)
    ? +p.minTurnRadiusM
    : wheelbase / Math.sin((32 * Math.PI) / 180);

  return {
    m,
    massKg: mass,
    payloadKg: payload,
    frontRatio: fr,
    axleSource,
    width,
    height,
    length,
    track,
    cgHeight,
    wheelbase,
    minTurnRadius,
    cd,
    frontalArea,
    lltdFront,
    ssf: track / (2 * cgHeight),
    drivetrain: p.drivetrain in DRIVETRAINS ? p.drivetrain : 'FF',
    driveFront: drive.driveFront,
    lsd: !!p.lsd,
    tireKey: p.tire in TIRES ? p.tire : 'standard',
    tire,
    wear,
    tireWidth,
    fz0: FZ0_BASE * (tireWidth / TIRE_WIDTH_BASE),
  };
}

/** 路面・摩耗を反映した基準荷重でのピーク μ */
export function baseMu(veh, surface) {
  const s = surface in SURFACES ? surface : 'dry';
  return veh.tire.mu[s] * veh.wear.f[s];
}

/** 1輪の最大グリップ力 [N]（荷重感度込み） */
export function wheelCapacity(fz, mu0, fz0, k) {
  if (!(fz > 0)) return 0;
  return mu0 * fz * Math.pow(fz / fz0, -k);
}

/**
 * 1軸ぶんの横力の余裕を計算する
 * @returns {{capacity:number, tractionOk:boolean}}
 */
function axleLateralCapacity(nAxle, dW, fx, mu0, veh, lsd) {
  const k = veh.tire.loadSens;
  const fzOut = nAxle / 2 + dW;
  const fzIn = nAxle / 2 - dW;
  const capOut = wheelCapacity(fzOut, mu0, veh.fz0, k);
  const capIn = wheelCapacity(fzIn, mu0, veh.fz0, k);
  let fxOut;
  let fxIn;
  if (fx <= 0) {
    fxOut = 0;
    fxIn = 0;
  } else if (lsd) {
    // LSD：グリップに応じて駆動力を配分（理想的な差動制限として扱う）
    const sum = capOut + capIn;
    if (sum <= 0 || fx >= sum) return { capacity: 0, tractionOk: false };
    fxOut = (fx * capOut) / sum;
    fxIn = (fx * capIn) / sum;
  } else {
    // オープンデフ：左右同トルク。内輪のグリップを超えると空転して速度を維持できない
    fxOut = fx / 2;
    fxIn = fx / 2;
    if (fxIn > capIn || fxOut > capOut) return { capacity: 0, tractionOk: false };
  }
  const latOut = Math.sqrt(Math.max(0, capOut * capOut - fxOut * fxOut));
  const latIn = Math.sqrt(Math.max(0, capIn * capIn - fxIn * fxIn));
  return { capacity: latOut + latIn, tractionOk: true };
}

/**
 * 速度 v で半径 R を定常旋回したときの状態を評価する
 * @returns 各種余裕と、成立するかどうか
 */
export function evaluateCorner(v, R, veh, env = DEFAULT_ENV, opts = {}) {
  const theta = Math.atan((Number(env.bankPct) || 0) / 100);
  const ac = (v * v) / R;
  const aLatSigned = ac * Math.cos(theta) - G * Math.sin(theta);
  const aLat = Math.abs(aLatSigned);
  const aN = G * Math.cos(theta) + ac * Math.sin(theta);
  const m = veh.m;
  const fr = veh.frontRatio;
  const mu0 = baseMu(veh, env.surface);

  const ratio = aLat / aN;
  const rollover = opts.ignoreRollover ? false : ratio >= veh.ssf * ROLLOVER_FACTOR;

  const N = m * aN;
  const nF = N * fr;
  const nR = N * (1 - fr);
  const fy = m * aLat;
  const fyF = fy * fr;
  const fyR = fy * (1 - fr);

  // 横方向荷重移動
  const dW = (fy * veh.cgHeight) / veh.track;
  let dWf = dW * veh.lltdFront;
  let dWr = dW * (1 - veh.lltdFront);
  // 片輪が浮いたら、それ以上の荷重移動はもう一方の軸が負担する
  if (dWf > nF / 2) {
    dWr += dWf - nF / 2;
    dWf = nF / 2;
  }
  if (dWr > nR / 2) {
    dWf = Math.min(nF / 2, dWf + (dWr - nR / 2));
    dWr = nR / 2;
  }

  // 一定速度を保つのに必要な駆動力
  const surface = SURFACES[env.surface] || SURFACES.dry;
  const fAero = 0.5 * RHO_AIR * veh.cd * veh.frontalArea * v * v;
  const fRoll = surface.crr * N;
  const fCorner = fy * Math.sin((veh.tire.alphaPeakDeg * Math.PI) / 180);
  const fx = fAero + fRoll + fCorner;
  const fxF = fx * veh.driveFront;
  const fxR = fx * (1 - veh.driveFront);

  const front = axleLateralCapacity(nF, dWf, fxF, mu0, veh, veh.lsd);
  const rear = axleLateralCapacity(nR, dWr, fxR, mu0, veh, veh.lsd);

  const frontMargin = front.capacity - fyF;
  const rearMargin = rear.capacity - fyR;
  const tractionOk = front.tractionOk && rear.tractionOk;

  let limitedBy = null;
  if (rollover) limitedBy = 'rollover';
  else if (!tractionOk) limitedBy = 'traction';
  else if (frontMargin < 0 || rearMargin < 0) {
    limitedBy = frontMargin / Math.max(fyF, 1) <= rearMargin / Math.max(fyR, 1) ? 'front' : 'rear';
  }

  return {
    ok: limitedBy === null,
    limitedBy,
    aLat,
    aN,
    ratio,
    frontMargin,
    rearMargin,
    fx,
    fAero,
    fCorner,
    innerFrontLoad: nF / 2 - dWf,
    innerRearLoad: nR / 2 - dWr,
  };
}

/** 転覆限界速度（グリップは無限と仮定） */
export function rolloverSpeed(R, veh, env = DEFAULT_ENV) {
  return speedForRatio(R, veh.ssf * ROLLOVER_FACTOR, env.bankPct);
}

/**
 * 片勾配 bankPct の路面で、横加速度/法線加速度 = ratio となる速度
 * v² = gR (r cosθ + sinθ) / (cosθ − r sinθ)
 */
export function speedForRatio(R, ratio, bankPct = 0) {
  const theta = Math.atan((Number(bankPct) || 0) / 100);
  const den = Math.cos(theta) - ratio * Math.sin(theta);
  if (den <= 0) return Infinity;
  const num = G * R * (ratio * Math.cos(theta) + Math.sin(theta));
  return num <= 0 ? 0 : Math.sqrt(num / den);
}

const V_CAP = 120; // 432 km/h

/**
 * 半径 R の上限速度を求める
 * @returns {{
 *   vLimit:number, vRec:number, vRollover:number, limitedBy:string,
 *   aLatG:number, muEff:number, straight:boolean
 * }}
 */
export function solveCorner(R, veh, env = DEFAULT_ENV) {
  const safety = clamp(Number(env.safety) || DEFAULT_ENV.safety, 0.1, 1);
  const vRollover = Number.isFinite(R) && R > 0 ? rolloverSpeed(R, veh, env) : Infinity;
  if (!Number.isFinite(R) || R <= 0) {
    return {
      R,
      straight: true,
      vLimit: Infinity,
      vRec: Infinity,
      vRollover,
      limitedBy: null,
      aLatG: 0,
      muEff: 0,
    };
  }

  const theta = Math.atan((Number(env.bankPct) || 0) / 100);
  const vBal = Math.sqrt(Math.max(0, G * R * Math.tan(theta)));
  const feasible = (v) => evaluateCorner(v, R, veh, env).ok;

  let lo = vBal;
  if (!feasible(lo)) {
    // 旋回以前に速度維持すらできない（極端な条件）
    return {
      R,
      straight: false,
      vLimit: 0,
      vRec: 0,
      vRollover,
      limitedBy: evaluateCorner(lo, R, veh, env).limitedBy || 'traction',
      aLatG: 0,
      muEff: 0,
    };
  }
  let hi = Math.max(lo * 2, 5);
  while (hi < V_CAP && feasible(hi)) {
    lo = hi;
    hi *= 2;
  }
  if (hi >= V_CAP && feasible(V_CAP)) {
    lo = V_CAP;
    hi = V_CAP;
  } else {
    hi = Math.min(hi, V_CAP);
    for (let i = 0; i < 60 && hi - lo > 1e-4; i++) {
      const mid = (lo + hi) / 2;
      if (feasible(mid)) lo = mid;
      else hi = mid;
    }
  }
  const vLimit = lo;
  const atLimit = evaluateCorner(vLimit, R, veh, env);
  const beyond = evaluateCorner(hi + 1e-3, R, veh, env);
  const limitedBy = vLimit >= V_CAP ? 'cap' : beyond.limitedBy || 'front';
  const muEff = atLimit.ratio;
  const vRec = Math.min(vLimit, speedForRatio(R, muEff * safety, env.bankPct));

  return {
    R,
    straight: false,
    vLimit,
    vRec,
    vRollover,
    limitedBy,
    aLatG: atLimit.aLat / G,
    muEff,
  };
}

/**
 * 半径→速度を高速に引くための表を作る（走行中、毎秒多数の R を評価するため）
 */
export function buildSpeedTable(veh, env = DEFAULT_ENV) {
  const Rmin = 3;
  const Rmax = 8000;
  const n = 90;
  const logMin = Math.log(Rmin);
  const step = (Math.log(Rmax) - logMin) / (n - 1);
  const rows = [];
  for (let i = 0; i < n; i++) {
    const R = Math.exp(logMin + i * step);
    const s = solveCorner(R, veh, env);
    rows.push({ R, vLimit: s.vLimit, vRec: s.vRec, limitedBy: s.limitedBy });
  }
  const lookup = (R) => {
    if (!Number.isFinite(R) || R <= 0 || R >= Rmax) return { vLimit: Infinity, vRec: Infinity };
    if (R <= Rmin) return solveCorner(R, veh, env);
    const f = (Math.log(R) - logMin) / step;
    const i = Math.min(n - 2, Math.floor(f));
    const t = f - i;
    const a = rows[i];
    const b = rows[i + 1];
    return {
      vLimit: a.vLimit + (b.vLimit - a.vLimit) * t,
      vRec: a.vRec + (b.vRec - a.vRec) * t,
      limitedBy: t < 0.5 ? a.limitedBy : b.limitedBy,
    };
  };
  return { rows, lookup };
}

// 道路構造令の横すべり摩擦係数 f（設計速度別）
const ROAD_DESIGN_F = [
  [20, 0.15],
  [30, 0.15],
  [40, 0.15],
  [50, 0.14],
  [60, 0.13],
  [80, 0.12],
  [100, 0.11],
  [120, 0.1],
];

/**
 * 道路構造令の式 R = V² / (127 (i + f)) を逆算して、
 * このカーブが想定している設計速度の目安 [km/h] を返す
 * @param {number} R 半径 [m]
 * @param {number} bankPct 片勾配 [%]（0 以下なら標準的な 6% と仮定）
 */
export function roadDesignSpeedKmh(R, bankPct = 0) {
  if (!Number.isFinite(R) || R <= 0) return Infinity;
  const i = bankPct > 0 ? bankPct / 100 : 0.06;
  let V = 60;
  for (let k = 0; k < 30; k++) {
    const f = lerpTable(ROAD_DESIGN_F, V);
    V = Math.sqrt(127 * R * (i + f));
  }
  return V;
}

/**
 * 低速時の幾何：必要な前輪舵角・内輪差・曲がり切れるか（重心が半径 R を通るとして）
 * 最小回転半径（外側前輪の軌跡）は入力が無ければ WB / sin(32°) で推定する
 */
export function lowSpeedGeometry(R, veh) {
  const L = veh.wheelbase;
  const b = L * veh.frontRatio; // 重心〜後軸
  const minTurn = veh.minTurnRadius;
  if (!Number.isFinite(R) || R <= b) {
    return { steerDeg: NaN, offTracking: NaN, outerFrontRadius: NaN, minTurn, feasible: false };
  }
  const rRear = Math.sqrt(R * R - b * b);
  const rFront = Math.sqrt(rRear * rRear + L * L);
  const steerDeg = (Math.atan(L / rRear) * 180) / Math.PI;
  const outerFrontRadius = Math.hypot(rRear + veh.track / 2, L);
  return {
    steerDeg,
    offTracking: rFront - rRear,
    outerFrontRadius,
    minTurn,
    feasible: outerFrontRadius >= minTurn,
  };
}

export const LIMIT_LABELS = {
  front: 'フロントのグリップ限界（アンダーステア）',
  rear: 'リアのグリップ限界（オーバーステア）',
  traction: '駆動輪の空転（内輪の荷重抜け・摩擦円の不足）',
  rollover: '転覆（横転）限界',
  cap: '計算上限',
};

export const msToKmh = (v) => v * 3.6;
export const kmhToMs = (v) => v / 3.6;
