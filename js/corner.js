// 次のコーナーの見せ方：きつさの分類・到達までの時間・音声案内の文言

// 半径によるきつさの分類（上から順に判定）
export const CORNER_CLASSES = [
  { maxR: 30, label: 'ヘアピン', level: 5 },
  { maxR: 60, label: 'きつい', level: 4 },
  { maxR: 120, label: 'ややきつい', level: 3 },
  { maxR: 250, label: 'ゆるい', level: 2 },
  { maxR: Infinity, label: 'ごくゆるい', level: 1 },
];

/** @returns {{label:string, level:number}} */
export function classifyCorner(R) {
  const c = CORNER_CLASSES.find((x) => R < x.maxR) || CORNER_CLASSES[CORNER_CLASSES.length - 1];
  return { label: c.label, level: c.level };
}

export const dirLabel = (dir) => (dir === 'left' ? '左' : '右');

/** 今の速度で入口まであと何秒か（止まっているときは null） */
export function secondsTo(dist, v) {
  if (!(v > 2) || !(dist > 0)) return null;
  return dist / v;
}

/** 音声で知らせ始める距離 [m]：約 7 秒前、近すぎず遠すぎず */
export function announceDistance(v) {
  return Math.max(80, Math.min(300, (v || 0) * 7));
}

const roundR = (R) => (R < 100 ? Math.round(R / 5) * 5 : Math.round(R / 10) * 10);
const roundDist = (d) => (d < 100 ? Math.round(d / 10) * 10 : Math.round(d / 50) * 50);

/**
 * 音声案内の文言。例：「左、きつい、アール60、120メートル先、50キロまで減速」
 * @param {{dir:'left'|'right', R:number, distStart:number}} c
 * @param {number} vRec 安全上限 [m/s]
 * @param {number} v 今の速度 [m/s]
 */
export function cornerSpeech(c, vRec, v) {
  const parts = [dirLabel(c.dir), classifyCorner(c.R).label, `アール${roundR(c.R)}`];
  if (c.distStart > 0) parts.push(`${Math.max(10, roundDist(c.distStart))}メートル先`);
  if (Number.isFinite(vRec) && v > vRec) parts.push(`${Math.max(5, Math.floor((vRec * 3.6) / 5) * 5)}キロまで減速`);
  return parts.join('、');
}

/**
 * 読み上げに使う日本語の声を選ぶ。拡張（Enhanced / Premium）の声があれば聞き取りやすいので優先する
 * @param {Array<{name:string, lang:string, localService?:boolean}>} voices speechSynthesis.getVoices() の結果
 */
export function pickJapaneseVoice(voices) {
  const ja = (voices || []).filter((v) => /^ja([-_]|$)/i.test(v.lang || ''));
  if (!ja.length) return null;
  const score = (v) =>
    (/(enhanced|premium|拡張|高品質)/i.test(v.name) ? 4 : 0) + (v.localService ? 1 : 0) + (/^ja[-_]JP$/i.test(v.lang) ? 1 : 0);
  return ja.reduce((best, v) => (score(v) > score(best) ? v : best), ja[0]);
}

/** 警告の読み上げ文言（音楽を聞いているとビープ音は埋もれやすいので、言葉でも伝える） */
export const ALERT_SPEECH = { brake: '減速', danger: '危険、急減速' };

/**
 * 警告を読み上げるかどうか。警告が強くなったときに一度だけ読み上げ、同じ強さでは繰り返さない。
 * 警告が消えて 3 秒たったら、次の警告をまた読み上げられるようにする
 * @param {{rank:number, clearSince:number|null}} st 前回までの状態（呼ぶたびに更新する）
 * @param {'caution'|'brake'|'danger'|null} level 今の警告
 * @param {number} now [ms]
 * @returns {string|null} 読み上げる文言
 */
export function alertToSpeak(st, level, now) {
  const rank = { brake: 1, danger: 2 }[level] || 0;
  // 警告が消えてから 3 秒以上たっていれば、次の警告は新しいものとして読む
  if (st.clearSince != null && now - st.clearSince >= 3000) st.rank = 0;
  if (rank === 0) {
    if (st.clearSince == null) st.clearSince = now;
    return null;
  }
  st.clearSince = null;
  if (rank <= st.rank) return null;
  st.rank = rank;
  return ALERT_SPEECH[level];
}

/**
 * 同じコーナーを二度読み上げないための判定。
 * 頂点（いちばんきつい点）は更新のたびに揺れ、長くゆるいカーブでは区間内のどこへでも動く。
 * そこで読み上げ済みのカーブは区間全体の点列で覚えておき、
 * 「新しい頂点が、同じ向きの読み上げ済み区間から radius 以内か」で判定する。
 * 地図データを取り直して座標系が変わっても使えるよう緯度経度で比べる
 * @param {Array<{dir:string, pts:Array<[number,number]>}>} list 読み上げ済みのカーブ区間
 */
export function isAnnounced(list, lat, lon, dir, radius = 40) {
  const k = Math.cos((lat * Math.PI) / 180);
  const r2 = radius * radius;
  return list.some(
    (a) =>
      a.dir === dir &&
      a.pts.some(([la, lo]) => {
        const dy = (la - lat) * 111195;
        const dx = (lo - lon) * 111195 * k;
        return dx * dx + dy * dy <= r2;
      }),
  );
}

/**
 * 次のコーナーに対する今の状況
 * - ok：安全上限以下
 * - slow：安全上限を超えているが、入口までに無理なく減速できる
 * - danger：入口までに強いブレーキ（0.3G 超）が必要、またはカーブの中で限界を超えている
 * 入口までまだ距離があれば、限界を少し超えていても軽いブレーキで間に合うので danger にはしない
 * @param {number} v 今の速度 [m/s]
 * @param {{vRec:number, vLimit:number}} s
 * @param {number} dist 入口までの距離 [m]（カーブ中なら 0 以下）
 * @param {number} [slope] 入口までの平均勾配（-0.05 = 5% の下り）
 */
export function approachState(v, s, dist, slope = 0) {
  if (!(v > s.vRec)) return 'ok';
  if (dist <= 0 && v > s.vLimit) return 'danger';
  const d = Math.max(dist, 1);
  const aReq = (v * v - s.vRec * s.vRec) / (2 * d) - 9.80665 * slope;
  return aReq > 0.3 * 9.80665 ? 'danger' : 'slow';
}
