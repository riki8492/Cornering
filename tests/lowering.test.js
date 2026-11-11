import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveVehicle, solveCorner, SPRUNG_FRACTION, DEFAULT_ENV } from '../js/physics.js';
import { findPreset, presetToVehicle } from '../js/presets.js';

const dry = { ...DEFAULT_ENV, surface: 'dry' };
const cw2 = () => ({ ...presetToVehicle(findPreset('accord-tourer-cw2')), payloadKg: 60 });

test('ローダウン：前後の下げ量を軸重比で内分し、ばね上の割合ぶん重心が下がる', () => {
  const stock = deriveVehicle(cw2());
  const low = deriveVehicle({ ...cw2(), lowerFrontMm: 20, lowerRearMm: 25 });
  const fr = stock.frontRatio;
  const body = (20 * fr + 25 * (1 - fr)) / 1000;
  assert.ok(Math.abs(low.bodyDropAtCg - body) < 1e-9);
  assert.ok(Math.abs(low.cgDrop - body * SPRUNG_FRACTION) < 1e-9);
  assert.ok(Math.abs(stock.cgHeight - low.cgHeight - body * SPRUNG_FRACTION) < 1e-9);
  // CW2（前 20mm・後 25mm）では重心が約 19mm 下がる
  assert.ok(Math.abs(low.cgDrop * 1000 - 19.3) < 0.5, `${low.cgDrop * 1000}`);
  assert.ok(low.ssf > stock.ssf);
});

test('ローダウンで限界がわずかに上がり、車高アップでは下がる', () => {
  const v = (o) => solveCorner(50, deriveVehicle({ ...cw2(), ...o }), dry).vLimit;
  const stock = v({});
  assert.ok(v({ lowerFrontMm: 20, lowerRearMm: 25 }) > stock);
  assert.ok(v({ lowerFrontMm: -40, lowerRearMm: -40 }) < stock);
});

test('重心高（純正状態）を入力した場合もローダウン量を差し引く', () => {
  const v = deriveVehicle({ ...cw2(), cgHeightMm: 550, lowerFrontMm: 30, lowerRearMm: 30 });
  assert.equal(v.cgHeightBase, 0.55);
  assert.ok(Math.abs(v.cgHeight - (0.55 - 0.03 * SPRUNG_FRACTION)) < 1e-9);
});

test('下げ量は ±150mm で打ち切り、未入力なら補正しない', () => {
  const base = deriveVehicle(cw2());
  assert.equal(base.cgDrop, 0);
  const extreme = deriveVehicle({ ...cw2(), lowerFrontMm: 999, lowerRearMm: 999 });
  assert.ok(Math.abs(extreme.cgDrop - 0.15 * SPRUNG_FRACTION) < 1e-9);
});

test('プリセットを選び直すと車高は純正に戻る', () => {
  const v = presetToVehicle(findPreset('gr86'));
  assert.equal(v.lowerFrontMm, null);
  assert.equal(v.lowerRearMm, null);
});
