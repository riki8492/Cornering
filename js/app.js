// 画面の制御

import * as P from './physics.js';
import { MotionTracker, startGps, startGyro, requestMotionPermission } from './sensors.js';
import { RoadTracker } from './roadmap.js';
import { DemElevation, gradeBetween } from './elevation.js';
import { makeProjector } from './geo.js';
import { startDemo } from './sim.js';
import {
  BODY_TYPES,
  MAKER_GROUPS,
  filterPresets,
  groupByMaker,
  findPreset,
  presetName,
  presetToVehicle,
} from './presets.js';
import { loadLeaflet, DriveMap } from './mapview.js';
import { classifyCorner, dirLabel, secondsTo, announceDistance, cornerSpeech, isAnnounced, approachState } from './corner.js';

const STORE_KEY = 'cornering.v1';
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

const state = {
  vehicle: { ...P.DEFAULT_VEHICLE },
  env: { ...P.DEFAULT_ENV },
  // panel: 走行画面の下段（'shape' 道路形状 / 'map' 地図）、mapLayer: 地図の種類
  prefs: { sound: false, gyro: true, map: true, elevation: true, panel: 'shape', mapLayer: 'gsi' },
  calcR: 50,
  calc: { entryElev: null, exitElev: null, angleDeg: 90 },
  axleAuto: 'rearAxleKg', // 自動補完した側の軸重（手入力された値は上書きしない）
  presetId: null, // 選んだ車種プリセット
  presetEdited: false, // プリセットを選んだあとに手で変えたか
  presetFilter: { maker: '', body: '' }, // 車種選びの絞り込み（起動時に選択中の車種から決め直す）
};

function load() {
  try {
    const s = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
    if (!s) return;
    Object.assign(state.vehicle, s.vehicle);
    Object.assign(state.env, s.env);
    Object.assign(state.prefs, s.prefs);
    if (Number(s.calcR) > 0) state.calcR = Number(s.calcR);
    if (s.calc) Object.assign(state.calc, s.calc);
    if ('axleAuto' in s) state.axleAuto = s.axleAuto;
    if (findPreset(s.presetId)) {
      state.presetId = s.presetId;
      state.presetEdited = !!s.presetEdited;
    }
  } catch {
    /* 保存領域が使えなくても既定値で動く */
  }
}

function save() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(state));
  } catch {
    /* 無視 */
  }
}

// ---------- 表示用の整形 ----------
const fmtKmh = (v) => {
  if (!Number.isFinite(v)) return '—';
  const k = v * 3.6;
  return k >= 300 ? '300+' : String(Math.round(k));
};
const fmtR = (R) => {
  if (!Number.isFinite(R) || R >= 1500) return '直線';
  if (R >= 1000) return `${(R / 1000).toFixed(1)} km`;
  return `${Math.round(R)} m`;
};
const fmtNum = (x, d = 0) => (Number.isFinite(x) ? x.toFixed(d) : '—');
const fmtGrade = (g) => {
  if (!Number.isFinite(g)) return '—';
  if (Math.abs(g) < 1) return '平坦';
  return g > 0 ? `上り ${g.toFixed(1)}%` : `下り ${(-g).toFixed(1)}%`;
};
/** 下りがきついときに目立たせる */
const gradeHtml = (g) => {
  const t = fmtGrade(g);
  return g <= -4 ? `<span class="down">${t}</span>` : t;
};

const SOURCE_LABEL = {
  gyro: 'ジャイロ',
  'gps-course': 'GPS方位',
  'gps-track': 'GPS軌跡',
};

const MAP_STATUS = {
  idle: '未取得',
  loading: '読込中…',
  ready: 'OK',
  error: '取得失敗',
  'no-road': '道路外',
};

// ---------- 車両の計算 ----------
let veh = P.deriveVehicle(state.vehicle);
/** (R, 縦断勾配%) → {vLimit, vRec} */
let speedAt = P.makeSpeedLookup(veh, state.env);

function recompute() {
  veh = P.deriveVehicle(state.vehicle);
  speedAt = P.makeSpeedLookup(veh, state.env);
  renderDerived();
  renderAxleHint();
  renderLowerHint();
  renderCalc();
  renderSurfaceChips();
  scheduleRender();
}

// ---------- フォーム ----------
function fillSelect(sel, entries, value) {
  sel.innerHTML = '';
  for (const [key, obj] of Object.entries(entries)) {
    const o = document.createElement('option');
    o.value = key;
    o.textContent = obj.label;
    sel.append(o);
  }
  sel.value = value;
}

function readInput(el) {
  if (el.type === 'checkbox') return el.checked;
  if (el.tagName === 'SELECT') return el.value;
  if (el.value === '') return null;
  const n = Number(el.value);
  return Number.isFinite(n) ? n : null;
}

function writeInput(el, v) {
  if (el.type === 'checkbox') el.checked = !!v;
  else el.value = v == null ? '' : v;
}

const vehInput = (key) => $(`[data-veh="${key}"]`);

function syncAxles(changed) {
  const v = state.vehicle;
  const m = v.massKg;
  const other = { frontAxleKg: 'rearAxleKg', rearAxleKg: 'frontAxleKg' };
  if (changed in other) {
    // 手で触った側は手入力扱い。もう一方が空欄か自動補完なら埋める
    const o = other[changed];
    if (state.axleAuto === changed) state.axleAuto = null;
    if (m > 0 && v[changed] > 0 && v[changed] < m && (v[o] == null || state.axleAuto === o)) {
      v[o] = Math.round(m - v[changed]);
      state.axleAuto = o;
      writeInput(vehInput(o), v[o]);
    }
  } else if (changed === 'massKg' && state.axleAuto && m > 0) {
    const o = state.axleAuto;
    const fixed = o === 'rearAxleKg' ? v.frontAxleKg : v.rearAxleKg;
    if (fixed > 0 && fixed < m) {
      v[o] = Math.round(m - fixed);
      writeInput(vehInput(o), v[o]);
    }
  }
}

function estimateAxles() {
  const v = state.vehicle;
  const m = v.massKg > 0 ? v.massKg : P.DEFAULT_VEHICLE.massKg;
  const ratio = (P.DRIVETRAINS[v.drivetrain] || P.DRIVETRAINS.FF).defaultFrontRatio;
  v.frontAxleKg = Math.round((m * ratio) / 10) * 10;
  v.rearAxleKg = m - v.frontAxleKg;
  state.axleAuto = 'rearAxleKg';
  markPresetEdited();
  writeInput(vehInput('frontAxleKg'), v.frontAxleKg);
  writeInput(vehInput('rearAxleKg'), v.rearAxleKg);
  save();
  recompute();
}

// ---------- 車種プリセット ----------
function renderPresetHint() {
  const el = $('#preset-hint');
  const pr = findPreset(state.presetId);
  el.textContent = '';
  if (!pr) {
    el.textContent =
      '選ぶと下の項目に代表値が入ります（あとから自由に変更できます）。年式・グレード・オプションで変わるので、正確な値は車検証で確認してください';
    return;
  }
  const add = (text, tag = 'span', cls = '') => {
    const n = document.createElement(tag);
    n.textContent = text;
    if (cls) n.className = cls;
    el.append(n);
  };
  const pct = Math.round(pr.specs.frontRatio * 100);
  add(presetName(pr), 'b');
  const s = pr.specs;
  const axle = s.axleFromInspection
    ? `前後軸重 ${s.frontAxleKg}/${s.massKg - s.frontAxleKg}kg（車検証の値）`
    : `前後配分 ${pct}:${100 - pct}${s.ratioEstimated ? '（推定）' : ''}`;
  add(`：純正タイヤ ${pr.tires}・${axle}`);
  // 「前 / 後」の区切りは前後に空白あり（215/40R18 の扁平率のスラッシュと区別）
  if (pr.tires.includes(' / ')) add('（前後異径のためタイヤ幅は平均値）');
  if (state.presetEdited) add('・一部変更あり', 'span', 'edited');
}

/** プリセットを選んだあとに手で値を変えたら印を付ける */
function markPresetEdited() {
  if (state.presetId && !state.presetEdited) {
    state.presetEdited = true;
    renderPresetHint();
  }
}

function applyPreset(id) {
  const pr = findPreset(id);
  state.presetId = pr ? pr.id : null;
  state.presetEdited = false;
  if (pr) {
    Object.assign(state.vehicle, presetToVehicle(pr));
    state.axleAuto = 'rearAxleKg';
    for (const el of $$('[data-veh]')) writeInput(el, state.vehicle[el.dataset.veh]);
  }
  save();
  recompute();
  renderPresetHint();
}

const option = (value, text) => {
  const o = document.createElement('option');
  o.value = value;
  o.textContent = text;
  return o;
};

/** メーカー・ボディタイプの絞り込みに合わせて車種の選択肢を作り直す */
function renderPresetOptions() {
  const f = state.presetFilter;
  const list = filterPresets(f);
  const sel = $('#preset-select');
  sel.innerHTML = '';
  sel.append(option('', list.length ? '選択しない（手入力）' : '該当する車種がありません'));
  if (f.maker) {
    for (const pr of list) sel.append(option(pr.id, `${pr.model}　${pr.grade}`));
  } else {
    // メーカーを絞っていないときはメーカーごとにまとめる
    for (const g of groupByMaker(list)) {
      const og = document.createElement('optgroup');
      og.label = g.maker;
      for (const pr of g.items) og.append(option(pr.id, `${pr.model}　${pr.grade}`));
      sel.append(og);
    }
  }
  sel.value = list.some((x) => x.id === state.presetId) ? state.presetId : '';
  $('#preset-count').textContent = `${list.length} 車種`;
}

function bindPresets() {
  // 選んである車種があれば、そのメーカーで絞った状態から始める
  const current = findPreset(state.presetId);
  state.presetFilter = { maker: current ? current.maker : '', body: '' };

  const makerSel = $('#preset-maker');
  makerSel.append(option('', 'すべてのメーカー'));
  for (const g of MAKER_GROUPS) {
    const og = document.createElement('optgroup');
    og.label = g.label;
    for (const m of g.makers) {
      const n = filterPresets({ maker: m }).length;
      if (n) og.append(option(m, `${m}（${n}）`));
    }
    makerSel.append(og);
  }
  makerSel.value = state.presetFilter.maker;

  const bodySel = $('#preset-body');
  bodySel.append(option('', 'すべてのタイプ'));
  for (const [key, label] of Object.entries(BODY_TYPES)) bodySel.append(option(key, label));
  bodySel.value = state.presetFilter.body;

  makerSel.addEventListener('change', () => {
    state.presetFilter.maker = makerSel.value;
    renderPresetOptions();
  });
  bodySel.addEventListener('change', () => {
    state.presetFilter.body = bodySel.value;
    renderPresetOptions();
  });
  const sel = $('#preset-select');
  sel.addEventListener('change', () => {
    // 「選択しない」に戻したときは入力値を変えない（手入力に切り替えるだけ）
    if (!sel.value) {
      state.presetId = null;
      state.presetEdited = false;
      save();
      renderPresetHint();
      return;
    }
    applyPreset(sel.value);
  });
  renderPresetOptions();
  renderPresetHint();
}

function bindForms() {
  fillSelect(vehInput('drivetrain'), P.DRIVETRAINS, state.vehicle.drivetrain);
  fillSelect(vehInput('tire'), P.TIRES, state.vehicle.tire);
  fillSelect(vehInput('wear'), P.WEAR, state.vehicle.wear);
  fillSelect($('[data-env="surface"]'), P.SURFACES, state.env.surface);

  for (const el of $$('[data-veh]')) {
    const key = el.dataset.veh;
    writeInput(el, state.vehicle[key]);
    el.addEventListener(el.type === 'checkbox' || el.tagName === 'SELECT' ? 'change' : 'input', () => {
      state.vehicle[key] = readInput(el);
      syncAxles(key);
      markPresetEdited();
      save();
      recompute();
    });
  }
  for (const el of $$('[data-env]')) {
    const key = el.dataset.env;
    writeInput(el, state.env[key]);
    el.addEventListener(el.tagName === 'SELECT' ? 'change' : 'input', () => {
      const v = readInput(el);
      state.env[key] = key === 'bankPct' ? v ?? 0 : v;
      save();
      recompute();
    });
  }
  for (const el of $$('[data-pref]')) {
    const key = el.dataset.pref;
    writeInput(el, state.prefs[key]);
    el.addEventListener('change', () => {
      state.prefs[key] = el.checked;
      if (key === 'sound' && el.checked) ensureAudio();
      // iOS は操作の中で一度しゃべらせないと、その後の読み上げが鳴らない
      if (key === 'voice' && el.checked) speak('音声案内をオンにしました');
      save();
    });
  }

  $('#btn-axle-estimate').addEventListener('click', estimateAxles);

  const rInput = $('#calc-r');
  rInput.value = state.calcR;
  rInput.addEventListener('input', () => {
    const v = Number(rInput.value);
    if (v > 0) {
      state.calcR = v;
      save();
      renderCalc();
    }
  });
  for (const [id, key] of [
    ['#calc-entry', 'entryElev'],
    ['#calc-exit', 'exitElev'],
    ['#calc-angle', 'angleDeg'],
  ]) {
    const el = $(id);
    writeInput(el, state.calc[key]);
    el.addEventListener('input', () => {
      state.calc[key] = readInput(el);
      save();
      renderCalc();
    });
  }
  const quick = $('#calc-quick');
  for (const R of [15, 30, 50, 80, 100, 150, 200, 300, 500]) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = `R${R}`;
    b.addEventListener('click', () => {
      state.calcR = R;
      rInput.value = R;
      save();
      renderCalc();
    });
    quick.append(b);
  }
}

function renderSurfaceChips() {
  const box = $('#surface-chips');
  if (!box.childElementCount) {
    for (const [key, s] of Object.entries(P.SURFACES)) {
      const b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('role', 'radio');
      b.dataset.surface = key;
      b.textContent = s.label;
      b.addEventListener('click', () => {
        state.env.surface = key;
        $('[data-env="surface"]').value = key;
        save();
        recompute();
      });
      box.append(b);
    }
  }
  for (const b of box.children) b.setAttribute('aria-checked', String(b.dataset.surface === state.env.surface));
}

function renderAxleHint() {
  const v = state.vehicle;
  const el = $('#axle-hint');
  const pct = Math.round(veh.frontRatio * 100);
  let msg = `前後配分（乗員込み） ${pct} : ${100 - pct}`;
  if (veh.axleSource === 'drivetrain') msg += '（駆動方式からの推定値）';
  if (v.frontAxleKg > 0 && v.rearAxleKg > 0 && v.massKg > 0) {
    const diff = v.frontAxleKg + v.rearAxleKg - v.massKg;
    if (Math.abs(diff) > 30) msg += ` ／ 軸重の合計が車両重量と ${diff > 0 ? '+' : ''}${diff} kg 違います（配分比だけ使います）`;
  }
  el.textContent = msg;
}

function kvRows(dl, rows) {
  dl.innerHTML = '';
  for (const [k, v, cls] of rows) {
    const dt = document.createElement('dt');
    dt.textContent = k;
    const dd = document.createElement('dd');
    dd.textContent = v;
    if (cls) dd.className = cls;
    dl.append(dt, dd);
  }
}

function renderLowerHint() {
  const el = $('#lower-hint');
  if (Math.abs(veh.bodyDropAtCg) < 0.0005) {
    el.textContent = '下げた量を入れると重心高を自動で補正します（上げた場合はマイナス）';
    return;
  }
  const up = veh.bodyDropAtCg < 0;
  const body = Math.round(Math.abs(veh.bodyDropAtCg) * 1000);
  const cg = Math.round(Math.abs(veh.cgDrop) * 1000);
  el.textContent =
    `重心の位置でボディが約 ${body} mm ${up ? '上がり' : '下がり'}、重心高は約 ${cg} mm ${up ? '高く' : '低く'}なります` +
    `（タイヤ・ブレーキなどのばね下は動かないので、約 ${Math.round(P.SPRUNG_FRACTION * 100)}% ぶん）。` +
    `重心高 ${Math.round(veh.cgHeightBase * 1000)} → ${Math.round(veh.cgHeight * 1000)} mm`;
}

function renderDerived() {
  const est = (key) => (Number(state.vehicle[key]) > 0 ? '' : '（推定）');
  const pct = Math.round(veh.frontRatio * 100);
  kvRows($('#derived'), [
    ['総重量（乗員・積載込み）', `${Math.round(veh.m)} kg`],
    ['前後重量配分', `${pct} : ${100 - pct}`],
    ['トレッド' + est('trackMm'), `${fmtNum(veh.track, 2)} m`],
    [
      '重心高' + est('cgHeightMm'),
      Math.abs(veh.cgDrop) >= 0.0005
        ? `${fmtNum(veh.cgHeight, 3)} m（純正 ${fmtNum(veh.cgHeightBase, 3)} m ${veh.cgDrop > 0 ? '−' : '＋'} ${Math.round(Math.abs(veh.cgDrop) * 1000)} mm）`
        : `${fmtNum(veh.cgHeight, 2)} m`,
    ],
    ['静的安定係数 SSF', fmtNum(veh.ssf, 2)],
    ['ホイールベース' + est('wheelbaseMm'), `${fmtNum(veh.wheelbase, 2)} m`],
    ['最小回転半径' + est('minTurnRadiusM'), `${fmtNum(veh.minTurnRadius, 1)} m`],
    ['前面投影面積' + est('frontalAreaM2'), `${fmtNum(veh.frontalArea, 2)} m²`],
    ['Cd' + est('cd'), fmtNum(veh.cd, 2)],
    ['前輪ロール剛性配分' + est('rollStiffFrontPct'), `${Math.round(veh.lltdFront * 100)} %`],
    ['タイヤ基準 μ（乾燥 / 現在の路面）', `${fmtNum(P.baseMu(veh, 'dry'), 2)} / ${fmtNum(P.baseMu(veh, state.env.surface), 2)}`],
    ['タイヤ基準荷重（1輪）', `${Math.round(veh.fz0 / P.G)} kg`],
  ]);
}

/** 計算タブの入口・出口標高と角度から勾配を求める */
function calcGrade(R) {
  const c = state.calc;
  const angle = c.angleDeg > 0 ? c.angleDeg : 90;
  const length = (R * angle * Math.PI) / 180;
  const g = P.gradeFromElevations(c.entryElev, c.exitElev, length);
  return { length, gradePct: g == null ? 0 : Math.max(-30, Math.min(30, g)), given: g != null };
}

function renderCalc() {
  const R = state.calcR;
  const cg = calcGrade(R);
  const env = { ...state.env, gradePct: cg.gradePct };
  $('#safety-label').textContent = `${Math.round((env.safety || 0) * 100)}%`;
  $('#calc-grade').innerHTML = cg.given
    ? `カーブ長 約 ${Math.round(cg.length)} m ／ 勾配 ${gradeHtml(cg.gradePct)}${Math.abs(cg.gradePct) >= 30 ? '（±30% で打ち切り）' : ''}`
    : '入口と出口の標高を入れると上り・下りを考慮します';
  const s = P.solveCorner(R, veh, env);
  $('#res-rec').textContent = fmtKmh(s.vRec);
  $('#res-lim').textContent = fmtKmh(s.vLimit);
  const geo = P.lowSpeedGeometry(R, veh);
  const design = P.roadDesignSpeedKmh(R, env.bankPct);
  const rows = [
    ['限界横G', `${fmtNum(s.aLatG, 2)} G`],
    ['限界を決める要因', P.LIMIT_LABELS[s.limitedBy] || '—'],
  ];
  if (cg.given) {
    const flat = P.solveCorner(R, veh, { ...state.env, gradePct: 0 });
    const diff = Math.round((s.vLimit - flat.vLimit) * 3.6);
    rows.push(['縦断勾配', fmtGrade(cg.gradePct)]);
    rows.push(['平坦路との差（理論限界）', `${diff > 0 ? '+' : ''}${diff} km/h（平坦なら ${fmtKmh(flat.vLimit)}）`]);
  }
  if (s.vRec > 0 && Number.isFinite(s.vRec)) {
    // 安全上限で一定速を保つのに必要な前後力（下りでは制動）
    const e = P.evaluateCorner(s.vRec, R, veh, env);
    const gx = e.fx / (veh.m * P.G);
    rows.push([
      '安全上限で速度を保つのに必要な力',
      gx >= 0 ? `駆動 ${gx.toFixed(2)} G` : `ブレーキ ${(-gx).toFixed(2)} G`,
      gx < -0.03 ? 'bad' : '',
    ]);
  }
  kvRows($('#res-detail'), [
    ...rows,
    ['転覆限界速度', `${fmtKmh(s.vRollover)} km/h`],
    [
      `道路の設計速度の目安${env.bankPct > 0 ? '' : '（片勾配6%想定）'}`,
      `約 ${Math.round(design)} km/h`,
    ],
    ['必要な前輪舵角（低速時）', Number.isFinite(geo.steerDeg) ? `${fmtNum(geo.steerDeg, 1)}°` : '—'],
    ['内輪差（低速時）', Number.isFinite(geo.offTracking) ? `${fmtNum(geo.offTracking, 2)} m` : '—'],
    [
      '外側前輪の旋回半径',
      Number.isFinite(geo.outerFrontRadius)
        ? `${fmtNum(geo.outerFrontRadius, 1)} m${geo.feasible ? '' : '（最小回転半径未満・切り返しが必要）'}`
        : '曲がれません',
      geo.feasible ? '' : 'bad',
    ],
  ]);

  $('#table-cond').textContent =
    `${P.SURFACES[env.surface]?.label || ''}・片勾配 ${env.bankPct || 0}%` +
    (cg.given ? `・${fmtGrade(cg.gradePct)}` : '');
  const tbody = $('#speed-table');
  tbody.innerHTML = '';
  const Rs = [10, 15, 20, 30, 40, 50, 60, 80, 100, 120, 150, 200, 300, 400, 600, 1000];
  let nearest = Rs[0];
  for (const r of Rs) if (Math.abs(Math.log(r / R)) < Math.abs(Math.log(nearest / R))) nearest = r;
  const shortLabel = { front: 'フロント', rear: 'リア', traction: '空転', braking: '制動', rollover: '転覆', cap: '—' };
  for (const r of Rs) {
    const x = P.solveCorner(r, veh, env);
    const tr = document.createElement('tr');
    if (r === nearest) tr.className = 'hl';
    for (const t of [
      r,
      fmtKmh(x.vRec),
      fmtKmh(x.vLimit),
      Math.round(P.roadDesignSpeedKmh(r, env.bankPct)),
      shortLabel[x.limitedBy] || '',
    ]) {
      const td = document.createElement('td');
      td.textContent = t;
      tr.append(td);
    }
    tbody.append(tr);
  }
}

// ---------- 走行 ----------
const motion = new MotionTracker();
let road = new RoadTracker();
let dem = null;
let gradeFallback = null; // 地図が無いときの、進行方向の前後から見た勾配 [%]

/** 地図が使えないときの代わり：進行方向の前後 25m の標高差から勾配を推定 */
function demGradeAlongHeading(fix, heading) {
  if (!dem || heading == null) return null;
  const p = makeProjector(fix.lat, fix.lon);
  const h = (heading * Math.PI) / 180;
  const a = p.toLatLon(-25 * Math.sin(h), -25 * Math.cos(h));
  const b = p.toLatLon(25 * Math.sin(h), 25 * Math.cos(h));
  const ea = dem.get(a.lat, a.lon);
  const eb = dem.get(b.lat, b.lon);
  return Number.isFinite(ea) && Number.isFinite(eb) ? ((eb - ea) / 50) * 100 : null;
}
let mode = 'off'; // 'off' | 'gps' | 'demo'
let stopGps = null;
let stopGyro = null;
let demo = null;
let wakeLock = null;
let gpsError = '';
let lastFixAt = 0;

// ---------- 地図（現在地） ----------
const track = []; // 走った軌跡 [lat, lon]
let driveMap = null;
let mapError = '';

function addTrackPoint(lat, lon) {
  const last = track[track.length - 1];
  if (last) {
    const dy = (lat - last[0]) * 111195;
    const dx = (lon - last[1]) * 111195 * Math.cos((lat * Math.PI) / 180);
    if (dx * dx + dy * dy < 9) return; // 3m 未満は間引く
  }
  track.push([lat, lon]);
  if (track.length > 5000) track.splice(0, track.length - 5000);
}

async function ensureMap() {
  if (driveMap) return driveMap;
  try {
    const L = await loadLeaflet();
    if (!driveMap) {
      driveMap = new DriveMap(L, $('#map'), {
        baseLayer: state.prefs.mapLayer,
        onBaseLayerChange: (key) => {
          state.prefs.mapLayer = key;
          save();
        },
      });
    }
    mapError = '';
  } catch (e) {
    mapError = `${e.message}（オフライン？）`;
  }
  scheduleRender();
  return driveMap;
}

/** 走行画面の下段の表示を切り替える */
function showPanel(name) {
  const panel = name === 'map' ? 'map' : 'shape';
  state.prefs.panel = panel;
  save();
  for (const b of $$('.panel-switch button')) b.setAttribute('aria-selected', String(b.dataset.panel === panel));
  $('#preview').hidden = panel !== 'shape';
  $('#map').hidden = panel !== 'map';
  if (panel === 'map') {
    ensureMap().then((m) => {
      m?.invalidate();
      scheduleRender();
    });
  }
  scheduleRender();
}

function bindPanels() {
  for (const b of $$('.panel-switch button')) b.addEventListener('click', () => showPanel(b.dataset.panel));
  showPanel(state.prefs.panel);
}

/** この先の道路を、色ごとのひと続きの線に分けて緯度経度にする */
function aheadRuns(rr, v) {
  if (!rr || !road.net) return [];
  const { pts, kappa, idx0, ds, elev } = rr.profile;
  const toLL = (p) => {
    const ll = road.net.proj.toLatLon(p.x, p.y);
    return [ll.lat, ll.lon];
  };
  const runs = [];
  let cur = null;
  for (let i = Math.max(1, idx0 + 1); i < pts.length; i++) {
    const color = speedColor(kappa[i], elev ? gradeBetween(elev, i - 3, i + 3, ds) : 0, v);
    if (!cur || cur.color !== color) {
      cur = { color, latlngs: [toLL(pts[i - 1])] };
      runs.push(cur);
    }
    cur.latlngs.push(toLL(pts[i]));
  }
  return runs;
}

function updateMap(rr, ms, next = null) {
  const hint = $('#map-hint');
  const fix = motion.lastFix;
  const msg = mapError || (!driveMap ? '地図を読み込み中…' : !fix ? '計測開始で現在地を表示します' : '');
  hint.hidden = !msg;
  hint.textContent = msg;
  if (!driveMap || !fix) return;
  const toLL = (p) => {
    const ll = road.net.proj.toLatLon(p.x, p.y);
    return [ll.lat, ll.lon];
  };
  const nc = next?.curve;
  const curves = rr
    ? rr.curves
        .filter((c) => c.distApex >= 0 && c !== nc)
        .map((c) => {
          const [lat, lon] = toLL(rr.profile.pts[c.apexIdx]);
          const g = c.gradePct || 0;
          const gl = Math.abs(g) >= 2 ? ` ${g > 0 ? '↗' : '↘'}${Math.abs(g).toFixed(0)}%` : '';
          return { lat, lon, label: `R${Math.round(c.R)}${gl}` };
        })
    : [];
  let nextMark = null;
  if (rr && nc) {
    const { pts, idx0 } = rr.profile;
    const section = [];
    for (let i = Math.max(idx0, nc.startIdx); i <= nc.endIdx; i++) section.push(toLL(pts[i]));
    nextMark = {
      section,
      entry: nc.distStart > 0 ? toLL(pts[nc.startIdx]) : null,
      apex: toLL(pts[nc.apexIdx]),
      label: `${dirLabel(nc.dir)} ${next.cls.label} R${Math.round(nc.R)}`,
      sub: nc.distStart > 0 ? `${Math.round(nc.distStart)}m 先・安全 ${fmtKmh(next.speeds.vRec)}km/h` : `安全 ${fmtKmh(next.speeds.vRec)}km/h`,
      color: stateColor(next.state),
      state: next.state,
    };
  }
  driveMap.update({
    lat: fix.lat,
    lon: fix.lon,
    accuracy: ms.accuracy,
    heading: ms.speed > 1.5 ? ms.heading : null,
    track,
    ahead: aheadRuns(rr, ms.speed),
    curves,
    next: nextMark,
  });
}

function onFix(fix) {
  motion.addFix(fix);
  addTrackPoint(fix.lat, fix.lon);
  lastFixAt = Date.now();
  gpsError = '';
  road.update(fix, motion.state);
  const g = road.result?.hasElevation || motion.speed < 2 ? null : demGradeAlongHeading(fix, motion.heading);
  // DEM のメッシュ由来のガタつきを時間方向にならす
  gradeFallback = g == null ? null : gradeFallback == null ? g : gradeFallback + (g - gradeFallback) * 0.3;
  scheduleRender();
}

function onGpsError(err) {
  const msg =
    err?.code === 1
      ? '許可されていません'
      : err?.code === 2
        ? '測位できません'
        : err?.code === 3
          ? '受信待ち'
          : String(err?.message || err);
  gpsError = msg;
  scheduleRender();
}

async function requestWakeLock() {
  try {
    wakeLock = await navigator.wakeLock?.request('screen');
  } catch {
    wakeLock = null;
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && mode !== 'off') requestWakeLock();
});

function stop() {
  stopGps?.();
  stopGyro?.();
  demo?.stop();
  stopGps = stopGyro = demo = null;
  wakeLock?.release?.().catch(() => {});
  wakeLock = null;
  mode = 'off';
  updateControls();
  scheduleRender();
}

async function start(kind) {
  stop();
  if (state.prefs.sound) ensureAudio();
  if (state.prefs.voice) speak('案内を開始します');
  motion.reset();
  gpsError = '';
  gradeFallback = null;
  track.length = 0;
  announced.length = 0;
  driveMap?.reset();
  mode = kind;
  if (kind === 'demo') {
    demo = startDemo({
      onFix,
      onYaw: (w, t) => motion.setYawRate(w, t),
      onLoop: () => {
        motion.reset();
        road.reset();
        track.length = 0;
        announced.length = 0;
        driveMap?.reset();
      },
    });
    dem = state.prefs.elevation ? demo.elevation : null;
    road = new RoadTracker({ fetcher: null, elevation: dem });
    road.setStaticNetwork(demo.ways, demo.origin);
  } else {
    if (state.prefs.elevation && !(dem instanceof DemElevation)) dem = new DemElevation();
    if (!state.prefs.elevation) dem = null;
    road = new RoadTracker({ ...(state.prefs.map ? {} : { fetcher: null }), elevation: dem });
    // iOS ではクリック処理の中で許可を求める必要がある
    const motionOk = state.prefs.gyro ? requestMotionPermission() : Promise.resolve(false);
    stopGps = startGps(onFix, onGpsError);
    if (await motionOk) stopGyro = startGyro((w, t) => motion.setYawRate(w, t));
    if (!window.isSecureContext) gpsError = 'https でのみ利用可';
  }
  requestWakeLock();
  updateControls();
  scheduleRender();
}

function updateControls() {
  const startBtn = $('#btn-start');
  const demoBtn = $('#btn-demo');
  startBtn.textContent = mode === 'gps' ? '停止' : '計測開始';
  startBtn.classList.toggle('stop', mode === 'gps');
  startBtn.classList.toggle('primary', mode !== 'gps');
  demoBtn.textContent = mode === 'demo' ? 'デモ停止' : 'デモ走行';
  const pill = $('#hdr-status');
  pill.textContent = mode === 'gps' ? '計測中' : mode === 'demo' ? 'デモ走行中' : '停止中';
  pill.className = `pill ${mode === 'gps' ? 'live' : mode === 'demo' ? 'demo' : ''}`;
}

// ---------- 警告音 ----------
let audioCtx = null;
let lastBeep = 0;

function ensureAudio() {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
  } catch {
    audioCtx = null;
  }
}

function beep(freq, count) {
  if (!audioCtx) return;
  const t0 = audioCtx.currentTime;
  for (let i = 0; i < count; i++) {
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.frequency.value = freq;
    o.type = 'square';
    const t = t0 + i * 0.18;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.25, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
    o.connect(g).connect(audioCtx.destination);
    o.start(t);
    o.stop(t + 0.14);
  }
}

function soundFor(alert) {
  if (!state.prefs.sound || !alert || mode === 'off') return;
  const now = Date.now();
  if (alert.level === 'danger' && now - lastBeep > 1500) {
    beep(1320, 3);
    lastBeep = now;
  } else if (alert.level === 'brake' && now - lastBeep > 3000) {
    beep(880, 2);
    lastBeep = now;
  }
}

// ---------- 音声案内 ----------
const announced = []; // 読み上げ済みのコーナー区間 {dir, pts: [[lat, lon], ...]}
const canSpeak = () => 'speechSynthesis' in window && typeof SpeechSynthesisUtterance === 'function';

function speak(text) {
  if (!canSpeak()) return;
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'ja-JP';
  u.rate = 1.1;
  window.speechSynthesis.speak(u);
}

/** 入口の約 7 秒前（80〜300m 手前）に一度だけ読み上げる */
function maybeAnnounce(rr, nc, s, v) {
  if (!state.prefs.voice || mode === 'off' || !road.net || !canSpeak()) return;
  if (v < 3 || nc.distStart <= 15 || nc.distStart > announceDistance(v)) return;
  const pts = rr.profile.pts;
  const toLL = (p) => {
    const ll = road.net.proj.toLatLon(p.x, p.y);
    return [ll.lat, ll.lon];
  };
  const [lat, lon] = toLL(pts[nc.apexIdx]);
  if (isAnnounced(announced, lat, lon, nc.dir)) return;
  // 区間全体を約 10m おきに覚える（長いカーブで頂点が動いても同じと分かるように）
  const section = [];
  for (let i = nc.startIdx; i <= nc.endIdx; i += 2) section.push(toLL(pts[i]));
  section.push(toLL(pts[nc.endIdx]));
  announced.push({ dir: nc.dir, pts: section });
  if (announced.length > 50) announced.shift();
  speak(cornerSpeech(nc, s.vRec, v));
}

// ---------- 判定 ----------
function nextCurve(rr) {
  if (!rr) return null;
  return rr.curves.find((c) => c.distApex > 0) || null;
}

function computeAlert(v, nowSpeeds, rr) {
  if (mode === 'off' || v < 3) return null;
  let alert = null;
  const raise = (level, text) => {
    const rank = { caution: 1, brake: 2, danger: 3 };
    if (!alert || rank[level] > rank[alert.level]) alert = { level, text };
  };
  if (v > nowSpeeds.vLimit) raise('danger', '限界速度を超えています');
  if (rr) {
    const { kappa, ds, idx0, elev } = rr.profile;
    let worst = null;
    for (let j = idx0 + 1; j < kappa.length; j++) {
      const d = (j - idx0) * ds;
      if (d < 20) continue; // 目の前は「現在のカーブ」で判定する
      const k = Math.abs(kappa[j]);
      if (k < 1 / 1500) continue;
      const s = speedAt(1 / k, elev ? gradeBetween(elev, j - 3, j + 3, ds) : 0);
      if (v <= s.vRec) continue;
      // カーブまでが下りなら、同じ減速でも余分に制動力が要る（上りなら少なくて済む）
      const slope = elev ? (elev[j] - elev[idx0]) / d : 0;
      const aRec = (v * v - s.vRec * s.vRec) / (2 * d) - P.G * slope;
      const aLim = (v * v - s.vLimit * s.vLimit) / (2 * d) - P.G * slope;
      if (!worst || aRec > worst.aRec) worst = { aRec, aLim, d, vRec: s.vRec, R: 1 / k, slope };
    }
    if (worst && worst.aRec > 0) {
      if (worst.aLim > 0.55 * P.G) {
        raise('danger', `急減速！ ${Math.round(worst.d)} m 先 ${fmtR(worst.R)}`);
      } else if (worst.aRec > 0.3 * P.G) {
        raise(
          'brake',
          `${worst.slope <= -0.03 ? '下り・' : ''}減速：${Math.round(worst.d)} m で ${fmtKmh(worst.vRec)} km/h へ（${(worst.aRec / P.G).toFixed(2)} G）`,
        );
      }
    }
  }
  if (v > nowSpeeds.vRec) raise('caution', '現在のカーブの安全上限を超えています');
  return alert;
}

// ---------- 矢印 ----------
function arrowSvg(dir, R) {
  const head = (x, y, dx, dy) => {
    const n = Math.hypot(dx, dy);
    const ux = dx / n;
    const uy = dy / n;
    const bx = x - ux * 9;
    const by = y - uy * 9;
    return `M${bx - uy * 7} ${by + ux * 7} L${x} ${y} L${bx + uy * 7} ${by - ux * 7}`;
  };
  let d;
  if (!dir || !Number.isFinite(R) || R >= 1500) {
    d = `M24 42 V8 ${head(24, 8, 0, -1)}`;
  } else if (R < 40) {
    d = `M14 42 V22 A10 10 0 0 1 34 22 V32 ${head(34, 32, 0, 1)}`;
  } else if (R < 120) {
    d = `M16 42 C16 20 22 14 40 14 ${head(40, 14, 1, 0)}`;
  } else {
    d = `M20 42 Q20 14 36 8 ${head(36, 8, 16, -6)}`;
  }
  const flip = dir === 'left' ? ' transform="translate(48 0) scale(-1 1)"' : '';
  return `<path d="${d}"${flip} fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>`;
}

// ---------- 前方プレビュー ----------
const cssCache = new Map();
function cssVar(name) {
  let v = cssCache.get(name);
  if (v == null) {
    v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    cssCache.set(name, v);
  }
  return v;
}

/** 道路の色：直線は灰色、カーブは今の速度が安全上限以下なら緑、超えたら橙、限界超えなら赤 */
function speedColor(kappa, grade, v) {
  if (Math.abs(kappa) < 1 / 600) return '#3b4a5c';
  const s = speedAt(1 / Math.abs(kappa), grade);
  if (v > s.vLimit) return cssVar('--danger');
  if (v > s.vRec) return cssVar('--warn');
  return cssVar('--accent');
}

/** 接近の状況の色 */
function stateColor(st) {
  return st === 'danger' ? cssVar('--danger') : st === 'slow' ? cssVar('--warn') : cssVar('--accent');
}

function drawPreview(rr, ms, next = null) {
  const cv = $('#preview');
  const w = cv.clientWidth;
  const h = cv.clientHeight;
  if (!w || !h) return;
  const dpr = window.devicePixelRatio || 1;
  if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(h * dpr);
  }
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const cx = w / 2;
  const cy = h * 0.86;
  const range = Math.max(150, Math.min(400, ms.speed * 10));
  const scale = (cy - 14) / range;
  const muted = cssVar('--muted');
  const line = cssVar('--line');

  // 距離の目盛り
  ctx.strokeStyle = line;
  ctx.fillStyle = muted;
  ctx.font = '11px system-ui, sans-serif';
  ctx.lineWidth = 1;
  for (let d = 100; d < range; d += 100) {
    const r = d * scale;
    ctx.beginPath();
    ctx.arc(cx, cy, r, Math.PI * 1.08, Math.PI * 1.92);
    ctx.stroke();
    // 道路（中央付近）や入口の距離表示と重ならないよう、目盛りの文字は弧の右端に置く
    const label = `${d}m`;
    const lw = ctx.measureText(label).width;
    const ex = cx + r * Math.cos(Math.PI * 1.92);
    const ey = cy + r * Math.sin(Math.PI * 1.92);
    ctx.fillText(label, Math.min(w - lw - 4, ex - lw / 2), ey - 6);
  }

  const v = ms.speed;
  const colorFor = (k, grade = 0) => speedColor(k, grade, v);

  if (rr) {
    const { pts, kappa, idx0, ds, elev } = rr.profile;
    const o = pts[idx0];
    const a = pts[Math.max(0, idx0 - 1)];
    const b = pts[Math.min(pts.length - 1, idx0 + 2)];
    const hd = Math.atan2(b.x - a.x, b.y - a.y);
    const c = Math.cos(hd);
    const s = Math.sin(hd);
    const tx = (p) => {
      const dx = p.x - o.x;
      const dy = p.y - o.y;
      return [cx + (dx * c - dy * s) * scale, cy - (dx * s + dy * c) * scale];
    };
    ctx.lineCap = 'round';
    const nc = next?.curve;
    const nColor = next ? stateColor(next.state) : null;

    // 次のコーナーの区間を太い帯で下敷きにする
    if (nc) {
      ctx.save();
      ctx.globalAlpha = 0.35;
      ctx.strokeStyle = nColor;
      ctx.lineWidth = 20;
      ctx.lineJoin = 'round';
      ctx.beginPath();
      const i0 = Math.max(idx0, nc.startIdx);
      ctx.moveTo(...tx(pts[i0]));
      for (let i = i0 + 1; i <= nc.endIdx; i++) ctx.lineTo(...tx(pts[i]));
      ctx.stroke();
      ctx.restore();
    }

    ctx.lineWidth = 7;
    for (let i = 1; i < pts.length; i++) {
      ctx.strokeStyle = i <= idx0 ? '#2a3542' : colorFor(kappa[i], elev ? gradeBetween(elev, i - 3, i + 3, ds) : 0);
      ctx.beginPath();
      ctx.moveTo(...tx(pts[i - 1]));
      ctx.lineTo(...tx(pts[i]));
      ctx.stroke();
    }

    // ほかのカーブは控えめなラベル
    ctx.font = '12px system-ui, sans-serif';
    for (const cv2 of rr.curves) {
      if (cv2.distApex < 0 || cv2 === nc) continue;
      const [x, y] = tx(pts[cv2.apexIdx]);
      if (y < 0 || x < 0 || x > w) continue;
      const g = cv2.gradePct || 0;
      const label = `R${Math.round(cv2.R)}${Math.abs(g) >= 2 ? (g > 0 ? ' ↗' : ' ↘') + Math.abs(g).toFixed(0) + '%' : ''}`;
      const off = cv2.dir === 'left' ? -12 - ctx.measureText(label).width : 12;
      ctx.fillStyle = muted;
      ctx.fillText(label, x + off, y + 4);
    }

    if (nc) {
      // 入口の線（道路に直交）と距離
      if (nc.distStart > 0) {
        const i = Math.min(pts.length - 2, Math.max(1, nc.startIdx));
        const [ex, ey] = tx(pts[i]);
        const [ax, ay] = tx(pts[i - 1]);
        const [bx, by] = tx(pts[i + 1]);
        const len = Math.hypot(bx - ax, by - ay) || 1;
        const nx = -(by - ay) / len;
        const ny = (bx - ax) / len;
        ctx.strokeStyle = cssVar('--text');
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(ex - nx * 14, ey - ny * 14);
        ctx.lineTo(ex + nx * 14, ey + ny * 14);
        ctx.stroke();
        ctx.font = 'bold 12px system-ui, sans-serif';
        ctx.fillStyle = cssVar('--text');
        const t = `${Math.round(nc.distStart)}m`;
        const side = nc.dir === 'left' ? 1 : -1; // カーブと反対側に書く
        const tw = ctx.measureText(t).width;
        ctx.fillText(t, side > 0 ? ex + 20 : ex - 20 - tw, ey + 4);
      }
      // 頂点に大きな吹き出し：「左 きつい R60」＋安全上限
      const [px, py] = tx(pts[nc.apexIdx]);
      const line1 = `${dirLabel(nc.dir)} ${next.cls.label} R${Math.round(nc.R)}`;
      const line2 = `安全 ${fmtKmh(next.speeds.vRec)} km/h`;
      ctx.font = 'bold 15px system-ui, sans-serif';
      const w1 = ctx.measureText(line1).width;
      ctx.font = 'bold 12px system-ui, sans-serif';
      const w2 = ctx.measureText(line2).width;
      const bw = Math.max(w1, w2) + 16;
      const bh = 42;
      let bx = nc.dir === 'left' ? px - 16 - bw : px + 16;
      bx = Math.max(4, Math.min(w - bw - 4, bx));
      const by = Math.max(4, Math.min(h - bh - 4, py - bh / 2));
      ctx.fillStyle = nColor;
      ctx.beginPath();
      ctx.roundRect ? ctx.roundRect(bx, by, bw, bh, 8) : ctx.rect(bx, by, bw, bh);
      ctx.fill();
      ctx.fillStyle = '#071311';
      ctx.font = 'bold 15px system-ui, sans-serif';
      ctx.fillText(line1, bx + 8, by + 18);
      ctx.font = 'bold 12px system-ui, sans-serif';
      ctx.fillText(line2, bx + 8, by + 34);
    }
  } else if (mode !== 'off' && ms.speed > 1.5) {
    // 地図が無いときは、いまの曲率のまま進んだ場合の軌跡を点線で
    const k = motion.kappa;
    ctx.setLineDash([8, 8]);
    ctx.lineWidth = 4;
    ctx.strokeStyle = colorFor(k, road.result?.gradeHere || 0);
    ctx.beginPath();
    for (let sPos = 0; sPos <= range; sPos += 5) {
      const x = Math.abs(k) < 1e-6 ? 0 : -(1 - Math.cos(k * sPos)) / k;
      const y = Math.abs(k) < 1e-6 ? sPos : Math.sin(k * sPos) / k;
      const X = cx + x * scale;
      const Y = cy - y * scale;
      if (sPos === 0) ctx.moveTo(X, Y);
      else ctx.lineTo(X, Y);
    }
    ctx.stroke();
    ctx.setLineDash([]);
  } else {
    ctx.fillStyle = muted;
    ctx.font = '13px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('計測を開始すると前方の道路形状を表示します', cx, h / 2);
    ctx.textAlign = 'start';
  }

  // 自車
  ctx.fillStyle = cssVar('--text');
  ctx.beginPath();
  ctx.moveTo(cx, cy - 12);
  ctx.lineTo(cx - 8, cy + 8);
  ctx.lineTo(cx + 8, cy + 8);
  ctx.closePath();
  ctx.fill();
}

// ---------- 走行画面の描画 ----------
function renderDrive() {
  const ms = motion.state;
  const running = mode !== 'off';
  const hasFix = !!motion.lastFix;
  const v = ms.speed;
  $('#cur-speed').textContent = hasFix ? Math.round(v * 3.6) : '--';
  $('#cur-latg').textContent = hasFix ? `${ms.lateralG.toFixed(2)} G` : '--';

  const rr = road.result;
  const roadName = rr ? [rr.road.ref, rr.road.name].filter(Boolean).join(' ') : '';
  $('#cur-road').textContent = roadName;

  // 現在のカーブ（計測値）
  const Rnow = hasFix ? ms.radius : NaN;
  const gradeNow = rr?.hasElevation ? rr.gradeHere : (gradeFallback ?? 0);
  const nowS = Number.isFinite(Rnow) ? speedAt(Rnow, gradeNow) : { vLimit: Infinity, vRec: Infinity };
  $('#now-grade').innerHTML =
    rr?.hasElevation || gradeFallback != null ? gradeHtml(gradeNow) : '勾配 --';
  $('#now-r').textContent = hasFix ? fmtR(Rnow) : '--';
  $('#now-map-r').textContent = rr ? fmtR(rr.radiusHere) : '--';
  $('#now-rec').textContent = hasFix ? fmtKmh(nowS.vRec) : '--';
  $('#now-lim').textContent = hasFix ? fmtKmh(nowS.vLimit) : '--';
  $('#now-src').textContent = SOURCE_LABEL[ms.source] || '計測';
  $('#now-arrow').innerHTML = arrowSvg(Number.isFinite(Rnow) ? ms.turnDir : null, Rnow);
  $('#card-now').classList.toggle('over', hasFix && v > nowS.vRec);

  // 次のコーナー（地図）
  const nc = nextCurve(rr);
  const card = $('#card-next');
  let next = null;
  if (nc) {
    const s = speedAt(nc.R, nc.gradePct);
    const prof = rr.profile;
    // 入口までの平均勾配（下りなら同じ減速でも余分に制動力が要る）
    const slope = prof.elev && nc.distStart > 0 ? (prof.elev[nc.startIdx] - prof.elev[prof.idx0]) / nc.distStart : 0;
    const st = hasFix ? approachState(v, s, nc.distStart, slope) : 'ok';
    const cls = classifyCorner(nc.R);
    const then = rr.curves[rr.curves.indexOf(nc) + 1] || null;
    next = { curve: nc, speeds: s, state: st, cls };

    $('#next-dir').textContent = dirLabel(nc.dir);
    const clsEl = $('#next-class');
    clsEl.textContent = cls.label;
    clsEl.dataset.level = String(cls.level);
    $('#next-dist').textContent = nc.distStart > 0 ? `${Math.round(nc.distStart)} m 先` : 'カーブ中';
    const eta = secondsTo(nc.distStart, v);
    $('#next-eta').textContent = eta != null && eta >= 1 && eta < 60 ? `約 ${Math.round(eta)} 秒` : '';
    $('#next-elev').innerHTML =
      nc.entryElev != null
        ? `標高 ${Math.round(nc.entryElev)} → ${Math.round(nc.exitElev)} m・${gradeHtml(nc.gradePct)}`
        : '';
    $('#next-r').textContent = fmtR(nc.R);
    $('#next-rec').textContent = fmtKmh(s.vRec);
    $('#next-lim').textContent = fmtKmh(s.vLimit);
    $('#next-arrow').innerHTML = arrowSvg(nc.dir, nc.R);
    const delta = Math.round((v - s.vRec) * 3.6);
    const dEl = $('#next-delta');
    dEl.className = `speed-delta ${st === 'ok' ? '' : st}`;
    dEl.textContent = !hasFix ? '' : delta > 0 ? `${delta} km/h 減速` : `余裕 ${-delta} km/h`;
    // 入口に近づくほど伸びるバー（表示範囲はプレビューと同じ）
    const range = Math.max(150, Math.min(400, v * 10));
    $('#next-bar').style.width = `${Math.round(Math.max(0, Math.min(1, 1 - nc.distStart / range)) * 100)}%`;
    $('#next-then').textContent = then
      ? `その次：${dirLabel(then.dir)} ${classifyCorner(then.R).label} ${fmtR(then.R)}・${Math.round(then.distStart)} m 先`
      : '';
    card.className = `card next-card state-${st}`;
    maybeAnnounce(rr, nc, s, v);
  } else {
    const why = !running
      ? '--'
      : rr
        ? '直線が続きます'
        : road.status === 'loading'
          ? '地図を読込中'
          : !state.prefs.map && mode === 'gps'
            ? '地図オフ'
            : '道路未特定';
    $('#next-dir').textContent = '';
    $('#next-class').textContent = '';
    $('#next-dist').textContent = why;
    $('#next-eta').textContent = '';
    $('#next-r').textContent = '--';
    $('#next-elev').textContent = '';
    $('#next-rec').textContent = '--';
    $('#next-lim').textContent = '--';
    $('#next-delta').textContent = '';
    $('#next-bar').style.width = '0';
    $('#next-then').textContent = '';
    $('#next-arrow').innerHTML = arrowSvg(null, Infinity);
    card.className = 'card next-card state-none';
  }

  // 警告
  const alert = hasFix ? computeAlert(v, nowS, rr) : null;
  const box = $('#alert');
  if (alert) {
    box.hidden = false;
    box.className = `alert ${alert.level}`;
    box.textContent = alert.text;
  } else {
    box.hidden = true;
  }
  soundFor(alert);

  // ステータス
  const stale = running && lastFixAt && Date.now() - lastFixAt > 5000;
  $('#st-gps').textContent = gpsError
    ? gpsError
    : !running
      ? '--'
      : !hasFix || stale
        ? '受信待ち'
        : ms.accuracy != null
          ? `±${Math.round(ms.accuracy)} m`
          : 'OK';
  const mapState =
    mode === 'gps' && !state.prefs.map
      ? 'オフ'
      : !running
        ? '--'
        : `${MAP_STATUS[road.status] || road.status}${road.loading && road.net ? '（更新中）' : ''}`;
  $('#st-map').textContent = mapState;
  $('#st-src').textContent = SOURCE_LABEL[ms.source] || '--';
  $('#st-elev').textContent = !state.prefs.elevation
    ? 'オフ'
    : !running || !dem
      ? '--'
      : dem.status === 'ready' || rr?.hasElevation || gradeFallback != null
        ? `OK${dem.source ? `（${dem.source}）` : ''}`
        : MAP_STATUS[dem.status] || dem.status;

  if ($('#view-drive').classList.contains('active')) {
    if (state.prefs.panel === 'map') updateMap(rr, ms, next);
    else drawPreview(rr, ms, next);
  }
}

let renderQueued = false;
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    renderDrive();
  });
}

// ---------- タブ ----------
function bindTabs() {
  for (const b of $$('.tabbar button')) {
    b.addEventListener('click', () => {
      for (const x of $$('.tabbar button')) x.classList.toggle('active', x === b);
      for (const v of $$('.view')) v.classList.toggle('active', v.id === `view-${b.dataset.view}`);
      window.scrollTo(0, 0);
      // 非表示の間はサイズが 0 なので、戻ったときに地図の大きさを測り直す
      if (b.dataset.view === 'drive') requestAnimationFrame(() => driveMap?.invalidate());
      scheduleRender();
    });
  }
}

// ---------- 起動 ----------
function init() {
  load();
  bindForms();
  bindPresets();
  bindTabs();
  bindPanels();
  $('#btn-start').addEventListener('click', () => (mode === 'gps' ? stop() : start('gps')));
  $('#btn-demo').addEventListener('click', () => (mode === 'demo' ? stop() : start('demo')));
  window.addEventListener('resize', scheduleRender);
  setInterval(() => mode !== 'off' && scheduleRender(), 1000);
  recompute();
  updateControls();
  if ('serviceWorker' in navigator && window.isSecureContext) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

init();
