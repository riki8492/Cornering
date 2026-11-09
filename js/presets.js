// 走り好きに人気の車種の諸元プリセット（代表グレードの目安値）
//
// 値は公称値・一般的に知られている値をもとにした目安で、年式・グレード・オプション・
// 仕向け地で変わる。前後軸重は公称の前後重量配分から計算している。
// - tireWidthMm：前後でサイズが違う車は前後の平均
// - drivetrain：4WD は前後駆動配分が近いものに割り当て
// - trackMm（前後平均）・wheelbaseMm：分かっている車のみ。無ければ外寸から推定

/**
 * @typedef {object} PresetSpecs
 * @property {number} massKg 車両重量
 * @property {number} frontRatio 前軸重量比（0〜1）
 * @property {number} widthMm
 * @property {number} heightMm
 * @property {number} lengthMm
 * @property {string} drivetrain
 * @property {boolean} lsd
 * @property {string} tire
 * @property {number} tireWidthMm
 * @property {number} [wheelbaseMm]
 * @property {number} [trackMm]
 * @property {number} [minTurnRadiusM] カタログの最小回転半径
 * @property {boolean} [ratioEstimated] 前後配分が公称値ではなく推定値
 */

const p = (id, maker, model, grade, tires, specs) => ({ id, maker, model, grade, tires, specs });

export const PRESET_GROUPS = [
  {
    label: '国産車（現行・近年）',
    items: [
      p('gr86', 'トヨタ', 'GR86 / スバル BRZ', 'RZ・S 6MT（ZN8/ZD8）', '215/40R18', {
        massKg: 1270, frontRatio: 0.53, widthMm: 1775, heightMm: 1310, lengthMm: 4265,
        drivetrain: 'FR', lsd: true, tire: 'sport', tireWidthMm: 215, wheelbaseMm: 2575, trackMm: 1535,
      }),
      p('roadster-nd', 'マツダ', 'ロードスター / MX-5', 'S Special Package 6MT（ND）', '195/50R16', {
        massKg: 1010, frontRatio: 0.5, widthMm: 1735, heightMm: 1235, lengthMm: 3915,
        drivetrain: 'FR', lsd: true, tire: 'sport', tireWidthMm: 195, wheelbaseMm: 2310, trackMm: 1500,
      }),
      p('gr-yaris', 'トヨタ', 'GRヤリス', 'RZ High performance（2020）', '225/40ZR18', {
        massKg: 1280, frontRatio: 0.61, widthMm: 1805, heightMm: 1455, lengthMm: 3995,
        drivetrain: 'AWD', lsd: true, tire: 'highgrip', tireWidthMm: 225, wheelbaseMm: 2560,
      }),
      p('gr-corolla', 'トヨタ', 'GRカローラ', 'RZ（2022）', '235/40ZR18', {
        massKg: 1470, frontRatio: 0.61, widthMm: 1850, heightMm: 1480, lengthMm: 4410,
        drivetrain: 'AWD', lsd: true, tire: 'sport', tireWidthMm: 235, wheelbaseMm: 2640,
      }),
      p('civic-fl5', 'ホンダ', 'シビック タイプR', 'FL5（2022）', '265/30ZR19', {
        massKg: 1430, frontRatio: 0.62, widthMm: 1890, heightMm: 1405, lengthMm: 4595,
        drivetrain: 'FF', lsd: true, tire: 'highgrip', tireWidthMm: 265, wheelbaseMm: 2735, trackMm: 1620,
      }),
      p('supra', 'トヨタ', 'GRスープラ', 'RZ（DB42）', '255/35ZR19 / 275/35ZR19', {
        massKg: 1520, frontRatio: 0.5, widthMm: 1865, heightMm: 1295, lengthMm: 4380,
        drivetrain: 'FR', lsd: true, tire: 'highgrip', tireWidthMm: 265, wheelbaseMm: 2470, trackMm: 1592,
      }),
      p('z-rz34', '日産', 'フェアレディZ', 'Version ST 6MT（RZ34）', '255/40R19 / 275/35R19', {
        massKg: 1620, frontRatio: 0.55, widthMm: 1845, heightMm: 1315, lengthMm: 4380,
        drivetrain: 'FR', lsd: true, tire: 'highgrip', tireWidthMm: 265, wheelbaseMm: 2550,
      }),
      p('gtr-r35', '日産', 'GT-R', 'Premium edition（R35・2017〜）', '255/40ZRF20 / 285/35ZRF20', {
        massKg: 1760, frontRatio: 0.54, widthMm: 1895, heightMm: 1370, lengthMm: 4710,
        drivetrain: 'AWD_R', lsd: true, tire: 'highgrip', tireWidthMm: 270, wheelbaseMm: 2780, trackMm: 1595,
      }),
      p('wrx-s4', 'スバル', 'WRX S4', 'STI Sport R（VBH）', '245/40R18', {
        massKg: 1600, frontRatio: 0.6, widthMm: 1825, heightMm: 1465, lengthMm: 4670,
        drivetrain: 'AWD', lsd: false, tire: 'sport', tireWidthMm: 245, wheelbaseMm: 2675,
      }),
      p('swift-sport', 'スズキ', 'スイフトスポーツ', '6MT（ZC33S）', '195/45R17', {
        massKg: 970, frontRatio: 0.61, widthMm: 1735, heightMm: 1500, lengthMm: 3890,
        drivetrain: 'FF', lsd: false, tire: 'sport', tireWidthMm: 195, wheelbaseMm: 2450, trackMm: 1512,
      }),
      p('s660', 'ホンダ', 'S660', 'α 6MT（JW5）', '165/55R15 / 195/45R16', {
        massKg: 830, frontRatio: 0.45, widthMm: 1475, heightMm: 1180, lengthMm: 3395,
        drivetrain: 'MR', lsd: false, tire: 'highgrip', tireWidthMm: 180, wheelbaseMm: 2285, trackMm: 1288,
      }),
      p('alto-works', 'スズキ', 'アルトワークス', '5MT・2WD（HA36S）', '165/55R15', {
        massKg: 670, frontRatio: 0.62, widthMm: 1475, heightMm: 1500, lengthMm: 3395,
        drivetrain: 'FF', lsd: false, tire: 'sport', tireWidthMm: 165, wheelbaseMm: 2460,
      }),
    ],
  },
  {
    label: '国産車（旧型・名車）',
    items: [
      p('accord-tourer-cw2', 'ホンダ', 'アコードツアラー', 'タイプS 5AT（CW2・2012）', '235/45R18', {
        massKg: 1610, frontRatio: 0.61, ratioEstimated: true, widthMm: 1850, heightMm: 1470, lengthMm: 4750,
        drivetrain: 'FF', lsd: false, tire: 'standard', tireWidthMm: 235, wheelbaseMm: 2705, trackMm: 1580,
        minTurnRadiusM: 5.7,
      }),
      p('legacy-br9-25gt', 'スバル', 'レガシィツーリングワゴン', '2.5GT 5AT（BR9・2009）', '225/50R17', {
        massKg: 1510, frontRatio: 0.59, ratioEstimated: true, widthMm: 1780, heightMm: 1535, lengthMm: 4775,
        drivetrain: 'AWD', lsd: false, tire: 'standard', tireWidthMm: 225, wheelbaseMm: 2750,
        minTurnRadiusM: 5.5,
      }),
      p('wrx-sti-vab', 'スバル', 'WRX STI', 'Type S（VAB）', '245/35R19', {
        massKg: 1490, frontRatio: 0.59, widthMm: 1795, heightMm: 1475, lengthMm: 4595,
        drivetrain: 'AWD_R', lsd: true, tire: 'sport', tireWidthMm: 245, wheelbaseMm: 2650,
      }),
      p('evo-x', '三菱', 'ランサーエボリューションX', 'GSR 5MT（CZ4A）', '245/40R18', {
        massKg: 1520, frontRatio: 0.6, widthMm: 1810, heightMm: 1480, lengthMm: 4495,
        drivetrain: 'AWD', lsd: true, tire: 'sport', tireWidthMm: 245, wheelbaseMm: 2650,
      }),
      p('bnr34', '日産', 'スカイラインGT-R', 'V-spec（BNR34）', '245/40ZR18', {
        massKg: 1560, frontRatio: 0.55, widthMm: 1785, heightMm: 1360, lengthMm: 4600,
        drivetrain: 'AWD_R', lsd: true, tire: 'sport', tireWidthMm: 245, wheelbaseMm: 2665, trackMm: 1485,
      }),
      p('fd3s', 'マツダ', 'RX-7', 'Type RS（FD3S・6型）', '235/45ZR17', {
        massKg: 1280, frontRatio: 0.5, widthMm: 1760, heightMm: 1230, lengthMm: 4285,
        drivetrain: 'FR', lsd: true, tire: 'sport', tireWidthMm: 235, wheelbaseMm: 2425, trackMm: 1460,
      }),
      p('s2000', 'ホンダ', 'S2000', 'AP2（2005〜）', '215/45R17 / 245/40R17', {
        massKg: 1250, frontRatio: 0.5, widthMm: 1750, heightMm: 1285, lengthMm: 4135,
        drivetrain: 'FR', lsd: true, tire: 'sport', tireWidthMm: 230, wheelbaseMm: 2400, trackMm: 1490,
      }),
      p('ek9', 'ホンダ', 'シビック タイプR', 'EK9', '195/55R15', {
        massKg: 1050, frontRatio: 0.62, widthMm: 1695, heightMm: 1360, lengthMm: 4180,
        drivetrain: 'FF', lsd: true, tire: 'sport', tireWidthMm: 195, wheelbaseMm: 2620,
      }),
      p('ae86', 'トヨタ', 'スプリンタートレノ', 'GT-APEX 3ドア（AE86）', '185/70R13', {
        massKg: 940, frontRatio: 0.53, widthMm: 1625, heightMm: 1335, lengthMm: 4205,
        drivetrain: 'FR', lsd: false, tire: 'standard', tireWidthMm: 185, wheelbaseMm: 2400, trackMm: 1350,
      }),
    ],
  },
  {
    label: '輸入車',
    items: [
      p('911-gt3', 'ポルシェ', '911 GT3', 'PDK（992）', '255/35ZR20 / 315/30ZR21', {
        massKg: 1435, frontRatio: 0.39, widthMm: 1852, heightMm: 1279, lengthMm: 4573,
        drivetrain: 'RR', lsd: true, tire: 'semislick', tireWidthMm: 285, wheelbaseMm: 2457,
      }),
      p('911-carrera', 'ポルシェ', '911 カレラ', 'PDK（992）', '235/40ZR20 / 295/35ZR21', {
        massKg: 1505, frontRatio: 0.38, widthMm: 1852, heightMm: 1300, lengthMm: 4519,
        drivetrain: 'RR', lsd: false, tire: 'highgrip', tireWidthMm: 265, wheelbaseMm: 2450,
      }),
      p('cayman-gts', 'ポルシェ', '718 ケイマン GTS 4.0', '6MT', '235/35ZR20 / 265/35ZR20', {
        massKg: 1405, frontRatio: 0.46, widthMm: 1801, heightMm: 1285, lengthMm: 4405,
        drivetrain: 'MR', lsd: true, tire: 'highgrip', tireWidthMm: 250, wheelbaseMm: 2475,
      }),
      p('m2', 'BMW', 'M2', '6MT（G87）', '275/35ZR19 / 285/30ZR20', {
        massKg: 1730, frontRatio: 0.52, widthMm: 1887, heightMm: 1403, lengthMm: 4580,
        drivetrain: 'FR', lsd: true, tire: 'highgrip', tireWidthMm: 280, wheelbaseMm: 2747,
      }),
      p('golf-gti', 'フォルクスワーゲン', 'ゴルフ GTI', '（Mk8）', '225/40R18', {
        massKg: 1430, frontRatio: 0.62, widthMm: 1790, heightMm: 1465, lengthMm: 4295,
        drivetrain: 'FF', lsd: true, tire: 'sport', tireWidthMm: 225, wheelbaseMm: 2625,
      }),
      p('mustang-gt', 'フォード', 'マスタング GT', 'Performance Pack 6MT（S650）', '255/40ZR19 / 275/40ZR19', {
        massKg: 1760, frontRatio: 0.53, widthMm: 1916, heightMm: 1400, lengthMm: 4811,
        drivetrain: 'FR', lsd: true, tire: 'highgrip', tireWidthMm: 265, wheelbaseMm: 2720,
      }),
      p('corvette-c8', 'シボレー', 'コルベット スティングレイ', 'Z51（C8）', '245/35ZR19 / 305/30ZR20', {
        massKg: 1655, frontRatio: 0.4, widthMm: 1934, heightMm: 1234, lengthMm: 4630,
        drivetrain: 'MR', lsd: true, tire: 'highgrip', tireWidthMm: 275, wheelbaseMm: 2723,
      }),
      p('elise', 'ロータス', 'エリーゼ', 'Sport 220 II', '195/50R16 / 225/45R17', {
        massKg: 925, frontRatio: 0.39, widthMm: 1719, heightMm: 1117, lengthMm: 3824,
        drivetrain: 'MR', lsd: false, tire: 'highgrip', tireWidthMm: 210, wheelbaseMm: 2300,
      }),
      p('a110', 'アルピーヌ', 'A110', 'Pure（2018〜）', '205/40R18 / 235/40R18', {
        massKg: 1110, frontRatio: 0.44, widthMm: 1800, heightMm: 1250, lengthMm: 4180,
        drivetrain: 'MR', lsd: false, tire: 'sport', tireWidthMm: 220, wheelbaseMm: 2420,
      }),
    ],
  },
];

export const ALL_PRESETS = PRESET_GROUPS.flatMap((g) => g.items);

export function findPreset(id) {
  return ALL_PRESETS.find((x) => x.id === id) || null;
}

export function presetName(preset) {
  return `${preset.maker} ${preset.model} ${preset.grade}`;
}

/**
 * プリセットを車両入力値に変換する。
 * 前の車の上書き値が残らないよう、推定値の上書き欄は（分かっているもの以外）空にする
 */
export function presetToVehicle(preset) {
  const s = preset.specs;
  const front = Math.round(s.massKg * s.frontRatio);
  return {
    massKg: s.massKg,
    frontAxleKg: front,
    rearAxleKg: s.massKg - front,
    widthMm: s.widthMm,
    heightMm: s.heightMm,
    lengthMm: s.lengthMm,
    drivetrain: s.drivetrain,
    lsd: s.lsd,
    tire: s.tire,
    tireWidthMm: s.tireWidthMm,
    trackMm: s.trackMm ?? null,
    wheelbaseMm: s.wheelbaseMm ?? null,
    cgHeightMm: null,
    cd: null,
    frontalAreaM2: null,
    rollStiffFrontPct: null,
    minTurnRadiusM: s.minTurnRadiusM ?? null,
  };
}
