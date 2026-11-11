// 車種の諸元プリセット（代表グレードの目安値）
//
// 値は公称値・一般的に知られている値をもとにした目安で、年式・グレード・オプション・
// 仕向け地で変わる。正確な値は車検証で確認する前提。
// - 前後軸重：公称の前後重量配分から計算。配分が公表されていない車は駆動方式と
//   レイアウトから推定（ratioEstimated）し、画面に「推定」と出す
// - tireWidthMm：前後でサイズが違う車は前後の平均
// - drivetrain：4WD は前後駆動配分が近いものに割り当て。パートタイム 4WD は舗装路で
//   使う 2WD（2H）として扱う
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
 * @property {number} [frontAxleKg] 前軸重が分かっていればその値（後軸重 = 車両重量 − 前軸重）
 * @property {boolean} [axleFromInspection] 前後軸重が実車の車検証の値
 */

/** ボディタイプ（1台が複数に属してよい。例：GRヤリスはコンパクトかつスポーツ） */
export const BODY_TYPES = {
  kei: '軽自動車',
  compact: 'コンパクト・ハッチバック',
  sedan: 'セダン',
  wagon: 'ステーションワゴン',
  suv: 'SUV',
  minivan: 'ミニバン',
  sports: 'スポーツ',
};

/** メーカーの表示順 */
export const MAKER_GROUPS = [
  { label: '国産メーカー', makers: ['トヨタ', 'レクサス', 'ホンダ', '日産', 'マツダ', 'スバル', 'スズキ', 'ダイハツ', '三菱'] },
  {
    label: '輸入車メーカー',
    makers: ['フォルクスワーゲン', 'MINI', 'BMW', 'メルセデス・ベンツ', 'ポルシェ', 'フォード', 'シボレー', 'ロータス', 'アルピーヌ'],
  },
];
export const MAKERS = MAKER_GROUPS.flatMap((g) => g.makers);

const car = (id, maker, body, model, grade, tires, specs) => ({ id, maker, body, model, grade, tires, specs });
/** 前後配分を推定した車 */
const est = (specs) => ({ ...specs, ratioEstimated: true });

const GR86_SPECS = {
  massKg: 1270, frontRatio: 0.53, widthMm: 1775, heightMm: 1310, lengthMm: 4265,
  drivetrain: 'FR', lsd: true, tire: 'sport', tireWidthMm: 215, wheelbaseMm: 2575, trackMm: 1535,
};

export const ALL_PRESETS = [
  // ===== トヨタ =====
  car('yaris', 'トヨタ', ['compact'], 'ヤリス', 'Z 1.5 CVT・2WD（MXPA10・2020）', '185/55R16', est({
    massKg: 1000, frontRatio: 0.62, widthMm: 1695, heightMm: 1500, lengthMm: 3940,
    drivetrain: 'FF', lsd: false, tire: 'eco', tireWidthMm: 185, wheelbaseMm: 2550,
  })),
  car('aqua', 'トヨタ', ['compact'], 'アクア', 'Z（MXPK11・2021）', '185/65R15', est({
    massKg: 1130, frontRatio: 0.61, widthMm: 1695, heightMm: 1485, lengthMm: 4050,
    drivetrain: 'FF', lsd: false, tire: 'eco', tireWidthMm: 185, wheelbaseMm: 2600,
  })),
  car('corolla-sport', 'トヨタ', ['compact'], 'カローラ スポーツ', 'G "Z" 1.2T 6MT（2018）', '225/40R18', est({
    massKg: 1310, frontRatio: 0.61, widthMm: 1790, heightMm: 1460, lengthMm: 4375,
    drivetrain: 'FF', lsd: false, tire: 'standard', tireWidthMm: 225, wheelbaseMm: 2640,
  })),
  car('corolla', 'トヨタ', ['sedan'], 'カローラ', 'HYBRID W×B（2019）', '215/45R17', est({
    massKg: 1370, frontRatio: 0.6, widthMm: 1745, heightMm: 1435, lengthMm: 4495,
    drivetrain: 'FF', lsd: false, tire: 'standard', tireWidthMm: 215, wheelbaseMm: 2640,
  })),
  car('prius-60', 'トヨタ', ['sedan'], 'プリウス', 'Z 2.0 HEV・2WD（60系・2023）', '195/50R19', est({
    massKg: 1420, frontRatio: 0.6, widthMm: 1780, heightMm: 1430, lengthMm: 4600,
    drivetrain: 'FF', lsd: false, tire: 'eco', tireWidthMm: 195, wheelbaseMm: 2750,
  })),
  car('camry', 'トヨタ', ['sedan'], 'カムリ', 'G（XV70・2017）', '215/55R17', est({
    massKg: 1540, frontRatio: 0.61, widthMm: 1840, heightMm: 1445, lengthMm: 4885,
    drivetrain: 'FF', lsd: false, tire: 'standard', tireWidthMm: 215, wheelbaseMm: 2825,
  })),
  car('crown-crossover', 'トヨタ', ['sedan', 'suv'], 'クラウン クロスオーバー', 'G 2.5 HEV E-Four（2022）', '225/55R19', est({
    massKg: 1750, frontRatio: 0.58, widthMm: 1840, heightMm: 1540, lengthMm: 4930,
    drivetrain: 'AWD_F', lsd: false, tire: 'standard', tireWidthMm: 225, wheelbaseMm: 2850,
  })),
  car('yaris-cross', 'トヨタ', ['suv', 'compact'], 'ヤリス クロス', 'HYBRID Z・2WD（2020）', '215/50R18', est({
    massKg: 1190, frontRatio: 0.61, widthMm: 1765, heightMm: 1590, lengthMm: 4180,
    drivetrain: 'FF', lsd: false, tire: 'eco', tireWidthMm: 215, wheelbaseMm: 2560,
  })),
  car('corolla-cross', 'トヨタ', ['suv'], 'カローラ クロス', 'HYBRID Z・2WD（2021）', '225/50R18', est({
    massKg: 1410, frontRatio: 0.6, widthMm: 1825, heightMm: 1620, lengthMm: 4490,
    drivetrain: 'FF', lsd: false, tire: 'standard', tireWidthMm: 225, wheelbaseMm: 2640,
  })),
  car('rav4', 'トヨタ', ['suv'], 'RAV4', 'Adventure 2.0・4WD（XA50・2019）', '235/55R19', est({
    massKg: 1630, frontRatio: 0.58, widthMm: 1865, heightMm: 1690, lengthMm: 4610,
    drivetrain: 'AWD_F', lsd: false, tire: 'standard', tireWidthMm: 235, wheelbaseMm: 2690,
  })),
  car('harrier', 'トヨタ', ['suv'], 'ハリアー', 'Z 2.0・2WD（80系・2020）', '225/55R19', est({
    massKg: 1620, frontRatio: 0.6, widthMm: 1855, heightMm: 1660, lengthMm: 4740,
    drivetrain: 'FF', lsd: false, tire: 'standard', tireWidthMm: 225, wheelbaseMm: 2690,
  })),
  car('landcruiser-300', 'トヨタ', ['suv'], 'ランドクルーザー', 'ZX ガソリン（300系・2021）', '265/55R20', est({
    massKg: 2550, frontRatio: 0.53, widthMm: 1980, heightMm: 1925, lengthMm: 4985,
    drivetrain: 'AWD_R', lsd: false, tire: 'standard', tireWidthMm: 265, wheelbaseMm: 2850,
  })),
  car('alphard-40', 'トヨタ', ['minivan'], 'アルファード', 'Z HEV E-Four（40系・2023）', '225/60R18', est({
    massKg: 2240, frontRatio: 0.56, widthMm: 1850, heightMm: 1935, lengthMm: 4995,
    drivetrain: 'AWD_F', lsd: false, tire: 'standard', tireWidthMm: 225, wheelbaseMm: 3000,
  })),
  car('noah-90', 'トヨタ', ['minivan'], 'ノア / ヴォクシー', 'HYBRID S-Z・2WD（90系・2022）', '205/60R16', est({
    massKg: 1670, frontRatio: 0.57, widthMm: 1730, heightMm: 1895, lengthMm: 4695,
    drivetrain: 'FF', lsd: false, tire: 'eco', tireWidthMm: 205, wheelbaseMm: 2850,
  })),
  car('sienta', 'トヨタ', ['minivan', 'compact'], 'シエンタ', 'HYBRID Z・2WD（2022）', '185/65R15', est({
    massKg: 1370, frontRatio: 0.59, widthMm: 1695, heightMm: 1695, lengthMm: 4260,
    drivetrain: 'FF', lsd: false, tire: 'eco', tireWidthMm: 185, wheelbaseMm: 2750,
  })),
  car('gr86', 'トヨタ', ['sports'], 'GR86', 'RZ 6MT（ZN8・2021）', '215/40R18', GR86_SPECS),
  car('gr-yaris', 'トヨタ', ['compact', 'sports'], 'GRヤリス', 'RZ High performance（2020）', '225/40ZR18', {
    massKg: 1280, frontRatio: 0.61, widthMm: 1805, heightMm: 1455, lengthMm: 3995,
    drivetrain: 'AWD', lsd: true, tire: 'highgrip', tireWidthMm: 225, wheelbaseMm: 2560,
  }),
  car('gr-corolla', 'トヨタ', ['compact', 'sports'], 'GRカローラ', 'RZ（2022）', '235/40ZR18', {
    massKg: 1470, frontRatio: 0.61, widthMm: 1850, heightMm: 1480, lengthMm: 4410,
    drivetrain: 'AWD', lsd: true, tire: 'sport', tireWidthMm: 235, wheelbaseMm: 2640,
  }),
  car('supra', 'トヨタ', ['sports'], 'GRスープラ', 'RZ（DB42）', '255/35ZR19 / 275/35ZR19', {
    massKg: 1520, frontRatio: 0.5, widthMm: 1865, heightMm: 1295, lengthMm: 4380,
    drivetrain: 'FR', lsd: true, tire: 'highgrip', tireWidthMm: 265, wheelbaseMm: 2470, trackMm: 1592,
  }),
  car('ae86', 'トヨタ', ['sports'], 'スプリンタートレノ', 'GT-APEX 3ドア（AE86）', '185/70R13', {
    massKg: 940, frontRatio: 0.53, widthMm: 1625, heightMm: 1335, lengthMm: 4205,
    drivetrain: 'FR', lsd: false, tire: 'standard', tireWidthMm: 185, wheelbaseMm: 2400, trackMm: 1350,
  }),

  // ===== レクサス =====
  car('lexus-is300', 'レクサス', ['sedan'], 'IS', 'IS300 F SPORT（2020）', '235/40R19 / 265/35R19', est({
    massKg: 1680, frontRatio: 0.53, widthMm: 1840, heightMm: 1435, lengthMm: 4710,
    drivetrain: 'FR', lsd: false, tire: 'sport', tireWidthMm: 250, wheelbaseMm: 2800,
  })),

  // ===== ホンダ =====
  car('fit-rs', 'ホンダ', ['compact'], 'フィット', 'e:HEV RS（GR・2022）', '185/55R16', est({
    massKg: 1210, frontRatio: 0.62, widthMm: 1695, heightMm: 1540, lengthMm: 4080,
    drivetrain: 'FF', lsd: false, tire: 'eco', tireWidthMm: 185, wheelbaseMm: 2530,
  })),
  car('civic-fl1', 'ホンダ', ['compact'], 'シビック', 'EX 6MT（FL1・2021）', '235/40R18', est({
    massKg: 1330, frontRatio: 0.61, widthMm: 1800, heightMm: 1415, lengthMm: 4550,
    drivetrain: 'FF', lsd: false, tire: 'sport', tireWidthMm: 235, wheelbaseMm: 2735,
  })),
  car('accord-cv3', 'ホンダ', ['sedan'], 'アコード', 'EX（CV3・2020）', '235/45R18', est({
    massKg: 1560, frontRatio: 0.6, widthMm: 1860, heightMm: 1450, lengthMm: 4900,
    drivetrain: 'FF', lsd: false, tire: 'standard', tireWidthMm: 235, wheelbaseMm: 2830,
  })),
  car('vezel', 'ホンダ', ['suv'], 'ヴェゼル', 'e:HEV Z・FF（RV・2021）', '225/50R18', est({
    massKg: 1380, frontRatio: 0.61, widthMm: 1790, heightMm: 1590, lengthMm: 4330,
    drivetrain: 'FF', lsd: false, tire: 'standard', tireWidthMm: 225, wheelbaseMm: 2610,
  })),
  car('zr-v', 'ホンダ', ['suv'], 'ZR-V', 'e:HEV Z・FF（2023）', '225/55R18', est({
    massKg: 1460, frontRatio: 0.6, widthMm: 1840, heightMm: 1620, lengthMm: 4570,
    drivetrain: 'FF', lsd: false, tire: 'standard', tireWidthMm: 225, wheelbaseMm: 2655,
  })),
  car('stepwgn', 'ホンダ', ['minivan'], 'ステップワゴン', 'e:HEV SPADA（RP8・2022）', '205/60R16', est({
    massKg: 1810, frontRatio: 0.57, widthMm: 1750, heightMm: 1840, lengthMm: 4830,
    drivetrain: 'FF', lsd: false, tire: 'eco', tireWidthMm: 205, wheelbaseMm: 2890,
  })),
  car('freed-gb5', 'ホンダ', ['minivan', 'compact'], 'フリード', 'G Honda SENSING（GB5・2016）', '185/65R15', est({
    massKg: 1360, frontRatio: 0.59, widthMm: 1695, heightMm: 1710, lengthMm: 4265,
    drivetrain: 'FF', lsd: false, tire: 'eco', tireWidthMm: 185, wheelbaseMm: 2740,
  })),
  car('n-box', 'ホンダ', ['kei'], 'N-BOX', 'G・L Honda SENSING（JF3・2017）', '155/65R14', est({
    massKg: 900, frontRatio: 0.61, widthMm: 1475, heightMm: 1790, lengthMm: 3395,
    drivetrain: 'FF', lsd: false, tire: 'eco', tireWidthMm: 155, wheelbaseMm: 2520,
  })),
  car('n-one-rs', 'ホンダ', ['kei', 'sports'], 'N-ONE', 'RS 6MT（JG3・2020）', '165/55R15', est({
    massKg: 840, frontRatio: 0.62, widthMm: 1475, heightMm: 1545, lengthMm: 3395,
    drivetrain: 'FF', lsd: false, tire: 'sport', tireWidthMm: 165, wheelbaseMm: 2520,
  })),
  car('civic-fl5', 'ホンダ', ['compact', 'sports'], 'シビック タイプR', 'FL5（2022）', '265/30ZR19', {
    massKg: 1430, frontRatio: 0.62, widthMm: 1890, heightMm: 1405, lengthMm: 4595,
    drivetrain: 'FF', lsd: true, tire: 'highgrip', tireWidthMm: 265, wheelbaseMm: 2735, trackMm: 1620,
  }),
  car('ek9', 'ホンダ', ['compact', 'sports'], 'シビック タイプR', 'EK9', '195/55R15', {
    massKg: 1050, frontRatio: 0.62, widthMm: 1695, heightMm: 1360, lengthMm: 4180,
    drivetrain: 'FF', lsd: true, tire: 'sport', tireWidthMm: 195, wheelbaseMm: 2620,
  }),
  car('integra-dc2', 'ホンダ', ['sports'], 'インテグラ タイプR', '98 spec（DC2）', '195/55R15', est({
    massKg: 1080, frontRatio: 0.62, widthMm: 1695, heightMm: 1330, lengthMm: 4380,
    drivetrain: 'FF', lsd: true, tire: 'sport', tireWidthMm: 195, wheelbaseMm: 2570,
  })),
  car('s660', 'ホンダ', ['kei', 'sports'], 'S660', 'α 6MT（JW5）', '165/55R15 / 195/45R16', {
    massKg: 830, frontRatio: 0.45, widthMm: 1475, heightMm: 1180, lengthMm: 3395,
    drivetrain: 'MR', lsd: false, tire: 'highgrip', tireWidthMm: 180, wheelbaseMm: 2285, trackMm: 1288,
  }),
  car('s2000', 'ホンダ', ['sports'], 'S2000', 'AP2（2005〜）', '215/45R17 / 245/40R17', {
    massKg: 1250, frontRatio: 0.5, widthMm: 1750, heightMm: 1285, lengthMm: 4135,
    drivetrain: 'FR', lsd: true, tire: 'sport', tireWidthMm: 230, wheelbaseMm: 2400, trackMm: 1490,
  }),
  car('accord-tourer-cw2', 'ホンダ', ['wagon'], 'アコードツアラー', 'タイプS 5AT（CW2・2012）', '235/45R18', {
    // 前後軸重は実車の車検証の値（前前軸重 910kg・後後軸重 700kg）
    massKg: 1610, frontAxleKg: 910, frontRatio: 910 / 1610, axleFromInspection: true,
    widthMm: 1850, heightMm: 1470, lengthMm: 4750,
    drivetrain: 'FF', lsd: false, tire: 'standard', tireWidthMm: 235, wheelbaseMm: 2705, trackMm: 1580,
    minTurnRadiusM: 5.7,
  }),

  // ===== 日産 =====
  car('note-e13', '日産', ['compact'], 'ノート', 'X（E13・2020）', '185/60R16', est({
    massKg: 1220, frontRatio: 0.62, widthMm: 1695, heightMm: 1520, lengthMm: 4045,
    drivetrain: 'FF', lsd: false, tire: 'eco', tireWidthMm: 185, wheelbaseMm: 2580,
  })),
  car('note-aura-nismo', '日産', ['compact', 'sports'], 'ノート オーラ NISMO', '（FE13・2021）', '205/50R17', est({
    massKg: 1270, frontRatio: 0.62, widthMm: 1735, heightMm: 1505, lengthMm: 4125,
    drivetrain: 'FF', lsd: false, tire: 'sport', tireWidthMm: 205, wheelbaseMm: 2580,
  })),
  car('skyline-400r', '日産', ['sedan', 'sports'], 'スカイライン', '400R（V37・2019）', '245/40RF19', est({
    massKg: 1760, frontRatio: 0.55, widthMm: 1820, heightMm: 1440, lengthMm: 4810,
    drivetrain: 'FR', lsd: false, tire: 'sport', tireWidthMm: 245, wheelbaseMm: 2850,
  })),
  car('kicks', '日産', ['suv'], 'キックス', 'X（P15・2020）', '205/55R17', est({
    massKg: 1350, frontRatio: 0.62, widthMm: 1760, heightMm: 1610, lengthMm: 4290,
    drivetrain: 'FF', lsd: false, tire: 'eco', tireWidthMm: 205, wheelbaseMm: 2620,
  })),
  car('xtrail-t33', '日産', ['suv'], 'エクストレイル', 'G e-4ORCE（T33・2022）', '235/55R19', est({
    massKg: 1880, frontRatio: 0.56, widthMm: 1840, heightMm: 1720, lengthMm: 4660,
    drivetrain: 'AWD', lsd: false, tire: 'standard', tireWidthMm: 235, wheelbaseMm: 2705,
  })),
  car('serena-c28', '日産', ['minivan'], 'セレナ', 'e-POWER ハイウェイスターV（C28・2022）', '205/65R16', est({
    massKg: 1790, frontRatio: 0.58, widthMm: 1715, heightMm: 1885, lengthMm: 4765,
    drivetrain: 'FF', lsd: false, tire: 'eco', tireWidthMm: 205, wheelbaseMm: 2870,
  })),
  car('z-rz34', '日産', ['sports'], 'フェアレディZ', 'Version ST 6MT（RZ34）', '255/40R19 / 275/35R19', {
    massKg: 1620, frontRatio: 0.55, widthMm: 1845, heightMm: 1315, lengthMm: 4380,
    drivetrain: 'FR', lsd: true, tire: 'highgrip', tireWidthMm: 265, wheelbaseMm: 2550,
  }),
  car('gtr-r35', '日産', ['sports'], 'GT-R', 'Premium edition（R35・2017〜）', '255/40ZRF20 / 285/35ZRF20', {
    massKg: 1760, frontRatio: 0.54, widthMm: 1895, heightMm: 1370, lengthMm: 4710,
    drivetrain: 'AWD_R', lsd: true, tire: 'highgrip', tireWidthMm: 270, wheelbaseMm: 2780, trackMm: 1595,
  }),
  car('bnr34', '日産', ['sports'], 'スカイラインGT-R', 'V-spec（BNR34）', '245/40ZR18', {
    massKg: 1560, frontRatio: 0.55, widthMm: 1785, heightMm: 1360, lengthMm: 4600,
    drivetrain: 'AWD_R', lsd: true, tire: 'sport', tireWidthMm: 245, wheelbaseMm: 2665, trackMm: 1485,
  }),
  car('silvia-s15', '日産', ['sports'], 'シルビア', 'spec-R 6MT（S15）', '215/45R17', est({
    massKg: 1250, frontRatio: 0.55, widthMm: 1695, heightMm: 1285, lengthMm: 4445,
    drivetrain: 'FR', lsd: true, tire: 'sport', tireWidthMm: 215, wheelbaseMm: 2525,
  })),

  // ===== マツダ =====
  car('demio-xd', 'マツダ', ['compact'], 'デミオ', 'XD Touring 6MT（DJ5FS・2014）', '185/60R16', est({
    massKg: 1130, frontRatio: 0.63, widthMm: 1695, heightMm: 1525, lengthMm: 4060,
    drivetrain: 'FF', lsd: false, tire: 'standard', tireWidthMm: 185, wheelbaseMm: 2570,
  })),
  car('mazda2-15s', 'マツダ', ['compact'], 'MAZDA2（デミオ）', '15S PROACTIVE（DJLFS・2019）', '185/65R15', est({
    massKg: 1060, frontRatio: 0.62, widthMm: 1695, heightMm: 1525, lengthMm: 4065,
    drivetrain: 'FF', lsd: false, tire: 'eco', tireWidthMm: 185, wheelbaseMm: 2570,
  })),
  car('mazda3-fb', 'マツダ', ['compact'], 'MAZDA3 ファストバック', '20S PROACTIVE Touring Selection（BP・2019）', '215/45R18', est({
    massKg: 1350, frontRatio: 0.61, widthMm: 1795, heightMm: 1440, lengthMm: 4460,
    drivetrain: 'FF', lsd: false, tire: 'standard', tireWidthMm: 215, wheelbaseMm: 2725,
  })),
  car('mazda6-wagon', 'マツダ', ['wagon'], 'MAZDA6 ワゴン（アテンザ）', 'XD L Package（GJ・2019）', '225/45R19', est({
    massKg: 1620, frontRatio: 0.61, widthMm: 1840, heightMm: 1480, lengthMm: 4805,
    drivetrain: 'FF', lsd: false, tire: 'standard', tireWidthMm: 225, wheelbaseMm: 2750,
  })),
  car('cx-3', 'マツダ', ['suv', 'compact'], 'CX-3', 'XD Touring・2WD（DK）', '215/50R18', est({
    massKg: 1270, frontRatio: 0.62, widthMm: 1765, heightMm: 1550, lengthMm: 4275,
    drivetrain: 'FF', lsd: false, tire: 'standard', tireWidthMm: 215, wheelbaseMm: 2570,
  })),
  car('cx-5', 'マツダ', ['suv'], 'CX-5', 'XD L Package・4WD（KF・2017）', '225/55R19', est({
    massKg: 1690, frontRatio: 0.59, widthMm: 1840, heightMm: 1690, lengthMm: 4545,
    drivetrain: 'AWD_F', lsd: false, tire: 'standard', tireWidthMm: 225, wheelbaseMm: 2700,
  })),
  car('cx-60', 'マツダ', ['suv'], 'CX-60', 'XD-HYBRID Premium Sports（2022）', '235/50R20', est({
    massKg: 1940, frontRatio: 0.53, widthMm: 1890, heightMm: 1685, lengthMm: 4740,
    drivetrain: 'AWD_R', lsd: false, tire: 'standard', tireWidthMm: 235, wheelbaseMm: 2870,
  })),
  car('roadster-nd', 'マツダ', ['sports'], 'ロードスター / MX-5', 'S Special Package 6MT（ND）', '195/50R16', {
    massKg: 1010, frontRatio: 0.5, widthMm: 1735, heightMm: 1235, lengthMm: 3915,
    drivetrain: 'FR', lsd: true, tire: 'sport', tireWidthMm: 195, wheelbaseMm: 2310, trackMm: 1500,
  }),
  car('roadster-na', 'マツダ', ['sports'], 'ロードスター（ユーノス）', '1.6 5MT（NA6CE）', '185/60R14', est({
    massKg: 940, frontRatio: 0.52, widthMm: 1675, heightMm: 1235, lengthMm: 3970,
    drivetrain: 'FR', lsd: false, tire: 'standard', tireWidthMm: 185, wheelbaseMm: 2265,
  })),
  car('rx-8', 'マツダ', ['sports'], 'RX-8', 'Type S 6MT（SE3P）', '225/45R18', est({
    massKg: 1310, frontRatio: 0.5, widthMm: 1770, heightMm: 1340, lengthMm: 4470,
    drivetrain: 'FR', lsd: true, tire: 'sport', tireWidthMm: 225, wheelbaseMm: 2700,
  })),
  car('fd3s', 'マツダ', ['sports'], 'RX-7', 'Type RS（FD3S・6型）', '235/45ZR17', {
    massKg: 1280, frontRatio: 0.5, widthMm: 1760, heightMm: 1230, lengthMm: 4285,
    drivetrain: 'FR', lsd: true, tire: 'sport', tireWidthMm: 235, wheelbaseMm: 2425, trackMm: 1460,
  }),

  // ===== スバル =====
  car('impreza-sport', 'スバル', ['compact'], 'インプレッサ スポーツ', '2.0i-S EyeSight・AWD（GT7・2016）', '215/50R17', est({
    massKg: 1400, frontRatio: 0.6, widthMm: 1775, heightMm: 1480, lengthMm: 4460,
    drivetrain: 'AWD', lsd: false, tire: 'standard', tireWidthMm: 215, wheelbaseMm: 2670,
  })),
  car('levorg-vn5', 'スバル', ['wagon'], 'レヴォーグ', 'STI Sport EX（VN5・2020）', '225/45R18', est({
    massKg: 1580, frontRatio: 0.6, widthMm: 1795, heightMm: 1500, lengthMm: 4755,
    drivetrain: 'AWD', lsd: false, tire: 'sport', tireWidthMm: 225, wheelbaseMm: 2670,
  })),
  car('forester-sk', 'スバル', ['suv'], 'フォレスター', 'Advance（SKE・2018）', '225/55R18', est({
    massKg: 1640, frontRatio: 0.58, widthMm: 1815, heightMm: 1730, lengthMm: 4625,
    drivetrain: 'AWD', lsd: false, tire: 'standard', tireWidthMm: 225, wheelbaseMm: 2670,
  })),
  car('xv', 'スバル', ['suv'], 'SUBARU XV', '2.0i-S EyeSight（GT7・2017）', '225/55R18', est({
    massKg: 1440, frontRatio: 0.59, widthMm: 1800, heightMm: 1550, lengthMm: 4465,
    drivetrain: 'AWD', lsd: false, tire: 'standard', tireWidthMm: 225, wheelbaseMm: 2670,
  })),
  car('brz', 'スバル', ['sports'], 'BRZ', 'S 6MT（ZD8・2021）', '215/40R18', GR86_SPECS),
  car('wrx-s4', 'スバル', ['sedan', 'sports'], 'WRX S4', 'STI Sport R（VBH）', '245/40R18', {
    massKg: 1600, frontRatio: 0.6, widthMm: 1825, heightMm: 1465, lengthMm: 4670,
    drivetrain: 'AWD', lsd: false, tire: 'sport', tireWidthMm: 245, wheelbaseMm: 2675,
  }),
  car('wrx-sti-vab', 'スバル', ['sedan', 'sports'], 'WRX STI', 'Type S（VAB）', '245/35R19', {
    massKg: 1490, frontRatio: 0.59, widthMm: 1795, heightMm: 1475, lengthMm: 4595,
    drivetrain: 'AWD_R', lsd: true, tire: 'sport', tireWidthMm: 245, wheelbaseMm: 2650,
  }),
  car('impreza-gdb', 'スバル', ['sedan', 'sports'], 'インプレッサ WRX STI', 'GDB（2002〜）', '225/45R17', est({
    massKg: 1430, frontRatio: 0.6, widthMm: 1740, heightMm: 1425, lengthMm: 4405,
    drivetrain: 'AWD_R', lsd: true, tire: 'sport', tireWidthMm: 225, wheelbaseMm: 2525,
  })),
  car('legacy-br9-25gt', 'スバル', ['wagon'], 'レガシィツーリングワゴン', '2.5GT 5AT（BR9・2009）', '225/50R17', {
    massKg: 1510, frontRatio: 0.59, ratioEstimated: true, widthMm: 1780, heightMm: 1535, lengthMm: 4775,
    drivetrain: 'AWD', lsd: false, tire: 'standard', tireWidthMm: 225, wheelbaseMm: 2750,
    minTurnRadiusM: 5.5,
  }),

  // ===== スズキ =====
  car('swift-rs', 'スズキ', ['compact'], 'スイフト', 'RS（ZC83S・2017）', '185/55R16', est({
    massKg: 880, frontRatio: 0.62, widthMm: 1695, heightMm: 1500, lengthMm: 3855,
    drivetrain: 'FF', lsd: false, tire: 'standard', tireWidthMm: 185, wheelbaseMm: 2450,
  })),
  car('swift-sport', 'スズキ', ['compact', 'sports'], 'スイフトスポーツ', '6MT（ZC33S）', '195/45R17', {
    massKg: 970, frontRatio: 0.61, widthMm: 1735, heightMm: 1500, lengthMm: 3890,
    drivetrain: 'FF', lsd: false, tire: 'sport', tireWidthMm: 195, wheelbaseMm: 2450, trackMm: 1512,
  }),
  car('wagon-r', 'スズキ', ['kei'], 'ワゴンR', 'HYBRID FX（MH55S・2017）', '155/65R14', est({
    massKg: 770, frontRatio: 0.62, widthMm: 1475, heightMm: 1650, lengthMm: 3395,
    drivetrain: 'FF', lsd: false, tire: 'eco', tireWidthMm: 155, wheelbaseMm: 2460,
  })),
  car('hustler', 'スズキ', ['kei', 'suv'], 'ハスラー', 'HYBRID X・2WD（MR52S・2020）', '165/60R15', est({
    massKg: 820, frontRatio: 0.62, widthMm: 1475, heightMm: 1680, lengthMm: 3395,
    drivetrain: 'FF', lsd: false, tire: 'eco', tireWidthMm: 165, wheelbaseMm: 2460,
  })),
  car('jimny', 'スズキ', ['kei', 'suv'], 'ジムニー', 'XC 5MT・2H（JB64・2018）', '175/80R16', est({
    massKg: 1040, frontRatio: 0.56, widthMm: 1475, heightMm: 1725, lengthMm: 3395,
    drivetrain: 'FR', lsd: false, tire: 'offroad', tireWidthMm: 175, wheelbaseMm: 2250,
  })),
  car('jimny-sierra', 'スズキ', ['suv'], 'ジムニーシエラ', 'JC 5MT・2H（JB74・2018）', '195/80R15', est({
    massKg: 1070, frontRatio: 0.56, widthMm: 1645, heightMm: 1730, lengthMm: 3550,
    drivetrain: 'FR', lsd: false, tire: 'offroad', tireWidthMm: 195, wheelbaseMm: 2250,
  })),
  car('alto-works', 'スズキ', ['kei', 'sports'], 'アルトワークス', '5MT・2WD（HA36S）', '165/55R15', {
    massKg: 670, frontRatio: 0.62, widthMm: 1475, heightMm: 1500, lengthMm: 3395,
    drivetrain: 'FF', lsd: false, tire: 'sport', tireWidthMm: 165, wheelbaseMm: 2460,
  }),

  // ===== ダイハツ =====
  car('tanto', 'ダイハツ', ['kei'], 'タント', 'X（LA650S・2019）', '155/65R14', est({
    massKg: 900, frontRatio: 0.62, widthMm: 1475, heightMm: 1755, lengthMm: 3395,
    drivetrain: 'FF', lsd: false, tire: 'eco', tireWidthMm: 155, wheelbaseMm: 2460,
  })),
  car('copen', 'ダイハツ', ['kei', 'sports'], 'コペン', 'Robe 5MT（LA400K）', '165/50R16', est({
    massKg: 850, frontRatio: 0.62, widthMm: 1475, heightMm: 1280, lengthMm: 3395,
    drivetrain: 'FF', lsd: false, tire: 'sport', tireWidthMm: 165, wheelbaseMm: 2230,
  })),
  car('rocky', 'ダイハツ', ['suv', 'compact'], 'ロッキー', 'Premium G 1.0T・2WD（A200S・2019）', '195/60R17', est({
    massKg: 980, frontRatio: 0.63, widthMm: 1695, heightMm: 1620, lengthMm: 3995,
    drivetrain: 'FF', lsd: false, tire: 'eco', tireWidthMm: 195, wheelbaseMm: 2525,
  })),

  // ===== 三菱 =====
  car('delica-d5', '三菱', ['minivan'], 'デリカ D:5', 'P（2019）', '225/55R18', est({
    massKg: 1980, frontRatio: 0.57, widthMm: 1795, heightMm: 1875, lengthMm: 4800,
    drivetrain: 'AWD_F', lsd: false, tire: 'standard', tireWidthMm: 225, wheelbaseMm: 2850,
  })),
  car('outlander-phev', '三菱', ['suv'], 'アウトランダー PHEV', 'P（GN0W・2021）', '255/45R20', est({
    massKg: 2110, frontRatio: 0.53, widthMm: 1860, heightMm: 1745, lengthMm: 4710,
    drivetrain: 'AWD', lsd: false, tire: 'standard', tireWidthMm: 255, wheelbaseMm: 2705,
  })),
  car('evo-ix', '三菱', ['sedan', 'sports'], 'ランサーエボリューションIX', 'GSR（CT9A・2005）', '235/45R17', est({
    massKg: 1400, frontRatio: 0.6, widthMm: 1770, heightMm: 1450, lengthMm: 4490,
    drivetrain: 'AWD', lsd: true, tire: 'sport', tireWidthMm: 235, wheelbaseMm: 2625,
  })),
  car('evo-x', '三菱', ['sedan', 'sports'], 'ランサーエボリューションX', 'GSR 5MT（CZ4A）', '245/40R18', {
    massKg: 1520, frontRatio: 0.6, widthMm: 1810, heightMm: 1480, lengthMm: 4495,
    drivetrain: 'AWD', lsd: true, tire: 'sport', tireWidthMm: 245, wheelbaseMm: 2650,
  }),

  // ===== フォルクスワーゲン =====
  car('polo', 'フォルクスワーゲン', ['compact'], 'ポロ', 'TSI Comfortline（AW・2018）', '185/65R15', est({
    massKg: 1160, frontRatio: 0.62, widthMm: 1750, heightMm: 1450, lengthMm: 4060,
    drivetrain: 'FF', lsd: false, tire: 'eco', tireWidthMm: 185, wheelbaseMm: 2550,
  })),
  car('golf-gti', 'フォルクスワーゲン', ['compact', 'sports'], 'ゴルフ GTI', '（Mk8）', '225/40R18', {
    massKg: 1430, frontRatio: 0.62, widthMm: 1790, heightMm: 1465, lengthMm: 4295,
    drivetrain: 'FF', lsd: true, tire: 'sport', tireWidthMm: 225, wheelbaseMm: 2625,
  }),

  // ===== MINI =====
  car('mini-cooper-s', 'MINI', ['compact', 'sports'], 'クーパーS', '3ドア（F56）', '205/45R17', est({
    massKg: 1270, frontRatio: 0.62, widthMm: 1725, heightMm: 1430, lengthMm: 3875,
    drivetrain: 'FF', lsd: false, tire: 'sport', tireWidthMm: 205, wheelbaseMm: 2495,
  })),

  // ===== BMW =====
  car('bmw-320i', 'BMW', ['sedan'], '3シリーズ', '320i M Sport（G20・2019）', '225/45R18 / 255/40R18', est({
    massKg: 1560, frontRatio: 0.52, widthMm: 1825, heightMm: 1440, lengthMm: 4715,
    drivetrain: 'FR', lsd: false, tire: 'standard', tireWidthMm: 240, wheelbaseMm: 2850,
  })),
  car('m2', 'BMW', ['sports'], 'M2', '6MT（G87）', '275/35ZR19 / 285/30ZR20', {
    massKg: 1730, frontRatio: 0.52, widthMm: 1887, heightMm: 1403, lengthMm: 4580,
    drivetrain: 'FR', lsd: true, tire: 'highgrip', tireWidthMm: 280, wheelbaseMm: 2747,
  }),

  // ===== メルセデス・ベンツ =====
  car('mb-c200', 'メルセデス・ベンツ', ['sedan'], 'Cクラス', 'C200 アバンギャルド AMGライン（W206・2021）', '225/45R18 / 245/40R18', est({
    massKg: 1660, frontRatio: 0.53, widthMm: 1820, heightMm: 1435, lengthMm: 4755,
    drivetrain: 'FR', lsd: false, tire: 'standard', tireWidthMm: 235, wheelbaseMm: 2865,
  })),

  // ===== ポルシェ =====
  car('911-gt3', 'ポルシェ', ['sports'], '911 GT3', 'PDK（992）', '255/35ZR20 / 315/30ZR21', {
    massKg: 1435, frontRatio: 0.39, widthMm: 1852, heightMm: 1279, lengthMm: 4573,
    drivetrain: 'RR', lsd: true, tire: 'semislick', tireWidthMm: 285, wheelbaseMm: 2457,
  }),
  car('911-carrera', 'ポルシェ', ['sports'], '911 カレラ', 'PDK（992）', '235/40ZR20 / 295/35ZR21', {
    massKg: 1505, frontRatio: 0.38, widthMm: 1852, heightMm: 1300, lengthMm: 4519,
    drivetrain: 'RR', lsd: false, tire: 'highgrip', tireWidthMm: 265, wheelbaseMm: 2450,
  }),
  car('cayman-gts', 'ポルシェ', ['sports'], '718 ケイマン GTS 4.0', '6MT', '235/35ZR20 / 265/35ZR20', {
    massKg: 1405, frontRatio: 0.46, widthMm: 1801, heightMm: 1285, lengthMm: 4405,
    drivetrain: 'MR', lsd: true, tire: 'highgrip', tireWidthMm: 250, wheelbaseMm: 2475,
  }),

  // ===== フォード / シボレー / ロータス / アルピーヌ =====
  car('mustang-gt', 'フォード', ['sports'], 'マスタング GT', 'Performance Pack 6MT（S650）', '255/40ZR19 / 275/40ZR19', {
    massKg: 1760, frontRatio: 0.53, widthMm: 1916, heightMm: 1400, lengthMm: 4811,
    drivetrain: 'FR', lsd: true, tire: 'highgrip', tireWidthMm: 265, wheelbaseMm: 2720,
  }),
  car('corvette-c8', 'シボレー', ['sports'], 'コルベット スティングレイ', 'Z51（C8）', '245/35ZR19 / 305/30ZR20', {
    massKg: 1655, frontRatio: 0.4, widthMm: 1934, heightMm: 1234, lengthMm: 4630,
    drivetrain: 'MR', lsd: true, tire: 'highgrip', tireWidthMm: 275, wheelbaseMm: 2723,
  }),
  car('elise', 'ロータス', ['sports'], 'エリーゼ', 'Sport 220 II', '195/50R16 / 225/45R17', {
    massKg: 925, frontRatio: 0.39, widthMm: 1719, heightMm: 1117, lengthMm: 3824,
    drivetrain: 'MR', lsd: false, tire: 'highgrip', tireWidthMm: 210, wheelbaseMm: 2300,
  }),
  car('a110', 'アルピーヌ', ['sports'], 'A110', 'Pure（2018〜）', '205/40R18 / 235/40R18', {
    massKg: 1110, frontRatio: 0.44, widthMm: 1800, heightMm: 1250, lengthMm: 4180,
    drivetrain: 'MR', lsd: false, tire: 'sport', tireWidthMm: 220, wheelbaseMm: 2420,
  }),
];

export function findPreset(id) {
  return ALL_PRESETS.find((x) => x.id === id) || null;
}

export function presetName(preset) {
  return `${preset.maker} ${preset.model} ${preset.grade}`;
}

/**
 * メーカー・ボディタイプで絞り込む（空ならすべて）
 * @param {{maker?:string, body?:string}} [f]
 */
export function filterPresets({ maker = '', body = '' } = {}) {
  return ALL_PRESETS.filter((x) => (!maker || x.maker === maker) && (!body || x.body.includes(body)));
}

/** メーカーの表示順にまとめる */
export function groupByMaker(list) {
  return MAKERS.map((maker) => ({ maker, items: list.filter((x) => x.maker === maker) })).filter((g) => g.items.length);
}

/**
 * プリセットを車両入力値に変換する。
 * 前の車の上書き値が残らないよう、推定値の上書き欄は（分かっているもの以外）空にする
 */
export function presetToVehicle(preset) {
  const s = preset.specs;
  const front = s.frontAxleKg ?? Math.round(s.massKg * s.frontRatio);
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
    // プリセットは純正状態
    lowerFrontMm: null,
    lowerRearMm: null,
  };
}
