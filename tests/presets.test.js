import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ALL_PRESETS,
  BODY_TYPES,
  MAKERS,
  filterPresets,
  groupByMaker,
  findPreset,
  presetToVehicle,
} from '../js/presets.js';
import { deriveVehicle, solveCorner, DRIVETRAINS, TIRES, DEFAULT_ENV } from '../js/physics.js';

const dry = { ...DEFAULT_ENV, surface: 'dry' };

test('プリセット：ID が重複せず、メーカーとボディタイプが正しく付いている', () => {
  const ids = ALL_PRESETS.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const p of ALL_PRESETS) {
    assert.ok(MAKERS.includes(p.maker), `${p.id} のメーカー ${p.maker}`);
    assert.ok(Array.isArray(p.body) && p.body.length > 0, `${p.id} のボディタイプ`);
    for (const b of p.body) assert.ok(b in BODY_TYPES, `${p.id} のボディタイプ ${b}`);
  }
  // どのボディタイプにも車種がある
  for (const b of Object.keys(BODY_TYPES)) assert.ok(filterPresets({ body: b }).length > 0, b);
  assert.ok(ALL_PRESETS.length >= 60);
});

test('絞り込み：メーカー・ボディタイプ・両方', () => {
  const toyota = filterPresets({ maker: 'トヨタ' });
  assert.ok(toyota.length > 0 && toyota.every((p) => p.maker === 'トヨタ'));
  const suv = filterPresets({ body: 'suv' });
  assert.ok(suv.every((p) => p.body.includes('suv')));
  const mazdaCompact = filterPresets({ maker: 'マツダ', body: 'compact' });
  assert.ok(mazdaCompact.some((p) => p.model.includes('デミオ')));
  // コンパクトかつスポーツの車はどちらでも出てくる
  assert.ok(filterPresets({ body: 'compact' }).some((p) => p.id === 'gr-yaris'));
  assert.ok(filterPresets({ body: 'sports' }).some((p) => p.id === 'gr-yaris'));
  assert.equal(filterPresets().length, ALL_PRESETS.length);
});

test('メーカーごとのまとまりは表示順どおりで、空のメーカーは出さない', () => {
  const groups = groupByMaker(filterPresets({ body: 'kei' }));
  const order = groups.map((g) => MAKERS.indexOf(g.maker));
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
  assert.ok(groups.every((g) => g.items.length > 0));
  assert.ok(!groups.some((g) => g.maker === 'ポルシェ'));
});

test('プリセット：諸元が妥当な範囲にあり、計算に使えるキーを持つ', () => {
  for (const p of ALL_PRESETS) {
    const s = p.specs;
    const name = `${p.maker} ${p.model}`;
    assert.ok(s.massKg >= 500 && s.massKg <= 3000, `${name} 重量`);
    assert.ok(s.frontRatio >= 0.3 && s.frontRatio <= 0.7, `${name} 前後配分`);
    assert.ok(s.widthMm >= 1400 && s.widthMm <= 2000, `${name} 全幅`);
    assert.ok(s.heightMm >= 1000 && s.heightMm <= 2000, `${name} 全高`);
    assert.ok(s.lengthMm >= 3000 && s.lengthMm <= 5200, `${name} 全長`);
    assert.ok(s.drivetrain in DRIVETRAINS, `${name} 駆動方式`);
    assert.ok(s.tire in TIRES, `${name} タイヤ`);
    assert.ok(s.tireWidthMm >= 145 && s.tireWidthMm <= 335, `${name} タイヤ幅`);
    if (s.wheelbaseMm) assert.ok(s.wheelbaseMm > 2000 && s.wheelbaseMm < s.lengthMm * 0.75, `${name} WB`);
    if (s.trackMm) assert.ok(s.trackMm > 1200 && s.trackMm < s.widthMm, `${name} トレッド`);
    // MR / RR は後ろが重い
    if (s.drivetrain === 'MR' || s.drivetrain === 'RR') assert.ok(s.frontRatio < 0.5, `${name} 配分`);
  }
});

test('プリセット：全車種で乾燥路の限界横G が現実的な範囲になる', () => {
  for (const p of ALL_PRESETS) {
    const veh = deriveVehicle({ ...presetToVehicle(p), payloadKg: 60 });
    const s = solveCorner(50, veh, dry);
    // 背の高い軽・ミニバン・ジムニー（オフロードタイヤ）は 0.7G 前後まで下がる
    assert.ok(s.aLatG > 0.6 && s.aLatG < 1.4, `${p.model}: ${s.aLatG.toFixed(2)} G`);
  }
});

test('プリセット：背の高い車・ミニバンは同じ FF のコンパクトより限界が低い', () => {
  const g = (id) => solveCorner(50, deriveVehicle({ ...presetToVehicle(findPreset(id)), payloadKg: 60 }), dry).aLatG;
  assert.ok(g('n-box') < g('yaris'));
  assert.ok(g('noah-90') < g('corolla'));
  assert.ok(g('jimny') < g('swift-sport'));
});

test('プリセット：Sタイヤの 911 GT3 は純正タイヤのアルトワークスより速く曲がれる', () => {
  const v = (id) => solveCorner(50, deriveVehicle(presetToVehicle(findPreset(id))), dry).vLimit;
  assert.ok(v('911-gt3') > v('alto-works'));
});

test('presetToVehicle：軸重の合計が車両重量になり、前の車の上書き値を消す', () => {
  const p = findPreset('civic-fl5');
  const v = presetToVehicle(p);
  assert.equal(v.frontAxleKg + v.rearAxleKg, p.specs.massKg);
  assert.equal(v.cgHeightMm, null);
  assert.equal(v.cd, null);
  assert.equal(v.minTurnRadiusM, null);
  assert.equal(v.wheelbaseMm, 2735);
  assert.equal(findPreset('no-such-car'), null);
});

test('カタログの最小回転半径があるプリセットはその値を入れる', () => {
  const accord = presetToVehicle(findPreset('accord-tourer-cw2'));
  const legacy = presetToVehicle(findPreset('legacy-br9-25gt'));
  assert.equal(accord.minTurnRadiusM, 5.7);
  // 車検証の前後軸重がそのまま入る
  assert.equal(accord.massKg, 1610);
  assert.equal(accord.frontAxleKg, 910);
  assert.equal(accord.rearAxleKg, 700);
  assert.equal(legacy.minTurnRadiusM, 5.5);
  assert.equal(deriveVehicle(legacy).minTurnRadius, 5.5);
  assert.equal(deriveVehicle(legacy).drivetrain, 'AWD');
});
