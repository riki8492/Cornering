import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ALL_PRESETS, PRESET_GROUPS, findPreset, presetToVehicle } from '../js/presets.js';
import { deriveVehicle, solveCorner, DRIVETRAINS, TIRES, DEFAULT_ENV } from '../js/physics.js';

const dry = { ...DEFAULT_ENV, surface: 'dry' };

test('プリセット：ID が重複せず、国産・輸入の各グループに車種がある', () => {
  const ids = ALL_PRESETS.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(PRESET_GROUPS.length >= 3);
  for (const g of PRESET_GROUPS) assert.ok(g.items.length > 0, g.label);
});

test('プリセット：諸元が妥当な範囲にあり、計算に使えるキーを持つ', () => {
  for (const p of ALL_PRESETS) {
    const s = p.specs;
    const name = `${p.maker} ${p.model}`;
    assert.ok(s.massKg >= 500 && s.massKg <= 2500, `${name} 重量`);
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
    assert.ok(s.aLatG > 0.7 && s.aLatG < 1.4, `${p.model}: ${s.aLatG.toFixed(2)} G`);
  }
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
