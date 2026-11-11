import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyCorner,
  secondsTo,
  announceDistance,
  cornerSpeech,
  isAnnounced,
  approachState,
} from '../js/corner.js';

test('きつさの分類：R が小さいほどきつい', () => {
  assert.equal(classifyCorner(25).label, 'ヘアピン');
  assert.equal(classifyCorner(45).label, 'きつい');
  assert.equal(classifyCorner(80).label, 'ややきつい');
  assert.equal(classifyCorner(200).label, 'ゆるい');
  assert.equal(classifyCorner(500).label, 'ごくゆるい');
  assert.ok(classifyCorner(25).level > classifyCorner(500).level);
});

test('到達までの秒数と、音声で知らせ始める距離', () => {
  assert.equal(secondsTo(100, 20), 5);
  assert.equal(secondsTo(100, 0), null);
  assert.equal(secondsTo(-5, 20), null);
  assert.equal(announceDistance(5), 80); // 低速でも 80m 手前
  assert.equal(announceDistance(20), 140); // 約 7 秒前
  assert.equal(announceDistance(60), 300); // 高速でも 300m まで
});

test('音声案内の文言：減速が必要なときだけ目標速度を言う', () => {
  const c = { dir: 'left', R: 58, distStart: 118 };
  assert.equal(cornerSpeech(c, 15, 22), '左、きつい、アール60、100メートル先、50キロまで減速');
  assert.equal(cornerSpeech(c, 25, 22), '左、きつい、アール60、100メートル先');
  assert.equal(cornerSpeech({ dir: 'right', R: 24, distStart: 64 }, 30, 10), '右、ヘアピン、アール25、60メートル先');
  assert.equal(cornerSpeech({ dir: 'right', R: 143, distStart: 230 }, 40, 20), '右、ゆるい、アール140、250メートル先');
});

test('読み上げ済みの判定：頂点が区間内のどこへ動いても同じコーナーとみなす', () => {
  // 北へ 180m 続く長くゆるい右カーブ（10m おきの点列）
  const lat0 = 35.36;
  const lon0 = 138.72;
  const pts = Array.from({ length: 19 }, (_, i) => [lat0 + (i * 10) / 111195, lon0]);
  const list = [{ dir: 'right', pts }];
  // 最初は 30m 地点が頂点だったが、次の更新で 150m 地点に移った → 同じコーナー
  assert.ok(isAnnounced(list, lat0 + 150 / 111195, lon0, 'right'));
  assert.ok(isAnnounced(list, lat0 + 205 / 111195, lon0, 'right'), '区間の端から 25m');
  assert.ok(!isAnnounced(list, lat0 + 150 / 111195, lon0, 'left'), '向きが違えば別のコーナー');
  assert.ok(!isAnnounced(list, lat0 + 300 / 111195, lon0, 'right'), '区間から 120m 離れれば別のコーナー');
  assert.ok(!isAnnounced([], lat0, lon0, 'right'));
});

test('接近の状況：余裕あり → 減速 → 急ブレーキ', () => {
  const s = { vRec: 15, vLimit: 21 };
  assert.equal(approachState(14, s, 100), 'ok');
  assert.equal(approachState(18, s, 100), 'slow'); // 0.05G 程度で減速できる
  assert.equal(approachState(20, s, 15), 'danger'); // 15m で 20→15m/s は約 0.6G
  assert.equal(approachState(22, s, 200), 'danger'); // 限界超え
  // 同じ速度・距離でも、下りだと必要な制動力が増える
  assert.equal(approachState(20, s, 40, 0), 'slow');
  assert.equal(approachState(20, s, 40, -0.15), 'danger');
});
