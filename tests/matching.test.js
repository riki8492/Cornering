// 走行中に「道路未特定」と表示が点滅しないことのテスト
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RoadTracker } from '../js/roadmap.js';
import { MotionTracker } from '../js/sensors.js';
import { makeProjector } from '../js/geo.js';

const origin = { lat: 35.36, lon: 138.73 };
const proj = makeProjector(origin.lat, origin.lon);

/** 南北にまっすぐ 1.2km の道と、途中から東へ分かれる道 */
function ways() {
  const ll = (x, y) => proj.toLatLon(x, y);
  const main = [];
  for (let y = 0; y <= 1200; y += 50) main.push(ll(0, y));
  return [
    { id: 1, nodes: main.map((_, i) => 100 + i), geometry: main, tags: { highway: 'secondary', name: '本線' } },
    { id: 2, nodes: [100 + 10, 900], geometry: [ll(0, 500), ll(300, 520)], tags: { highway: 'residential' } },
  ];
}

const fixAt = (x, y, acc = 5) => ({ ...proj.toLatLon(x, y), accuracy: acc });

test('止まっている間に GPS の位置が揺れても、進行方位は最後の向きのまま', () => {
  const mt = new MotionTracker();
  // 北へ走る（GPS のコースあり）
  for (let t = 0; t < 5; t++) {
    const ll = proj.toLatLon(0, t * 10);
    mt.addFix({ t, lat: ll.lat, lon: ll.lon, speed: 10, heading: 0, accuracy: 5 });
  }
  // 信号で停止。位置は ±6m 揺れ、コースは出ない
  const jitter = [[5, -4], [-6, 3], [4, 6], [-5, -6], [6, 2], [-3, 5]];
  jitter.forEach(([dx, dy], i) => {
    const ll = proj.toLatLon(dx, 40 + dy);
    mt.addFix({ t: 5 + i, lat: ll.lat, lon: ll.lon, speed: 0, heading: null, accuracy: 5 });
  });
  assert.equal(mt.heading, 0, '揺れで向きが変わらない');
});

test('GPS がコースを返さない端末でも、低速で向きが暴れない', () => {
  const mt = new MotionTracker();
  // 北へ 3m/s（約 11km/h）、位置に ±3m の誤差
  const noise = [[2, -1], [-3, 2], [1, 3], [3, -2], [-2, -3], [2, 1], [-1, 2], [3, 3], [-3, -1], [1, -3], [2, 2], [-2, 1]];
  const errs = [];
  noise.forEach(([dx, dy], t) => {
    const ll = proj.toLatLon(dx, t * 3 + dy);
    mt.addFix({ t, lat: ll.lat, lon: ll.lon, speed: 3, heading: null, accuracy: 5 });
    if (mt.heading != null) errs.push(Math.min(Math.abs(mt.heading), Math.abs(360 - mt.heading)));
  });
  assert.ok(errs.length > 0);
  assert.ok(Math.max(...errs) < 35, `最大のずれ ${Math.max(...errs).toFixed(0)}°`);
  assert.equal(mt.state.headingSource, 'track');
});

test('止まっている間に地図データを取り直しても、道路を見失わない', async () => {
  const fetcher = () => Promise.resolve(ways());
  const tracker = new RoadTracker({ fetcher, refetchAt: 50, minFetchInterval: 0 });
  const tick = () => new Promise((r) => setTimeout(r, 0));
  // 走り出し：取得 → 当てはめ
  tracker.update(fixAt(1, 0), { speed: 10, heading: 0, headingSource: 'course' }, 0);
  await tick();
  assert.ok(tracker.update(fixAt(1, 20), { speed: 10, heading: 0, headingSource: 'course' }, 1000));
  // 信号で停止したところで取り直しが起きる（速度 0、方位は最後の値）
  tracker.update(fixAt(1, 120), { speed: 0, heading: 0, headingSource: 'course' }, 2000);
  await tick();
  const r = tracker.update(fixAt(2, 121), { speed: 0, heading: 0, headingSource: 'course' }, 3000);
  assert.ok(r, '止まったままでも道路が特定されている');
  assert.equal(r.road.name, '本線');
  assert.equal(tracker.status, 'ready');
});

test('一瞬の GPS の跳びでは表示を保ち、外れ続けたら未特定にする', () => {
  const tracker = new RoadTracker();
  tracker.setStaticNetwork(ways(), origin);
  const m = (speed = 15) => ({ speed, heading: 0, headingSource: 'course' });
  assert.ok(tracker.update(fixAt(1, 100), m(), 0));
  // 40m 横に跳んだ（通常の範囲 25m の外）→ さっきまでの道に限って広めに探し直して当てはまる
  const jump = tracker.update(fixAt(40, 115), m(), 1000);
  assert.ok(jump, '一度の跳びでは見失わない');
  assert.equal(jump.road.name, '本線');
  assert.equal(jump.estimated, false, '推測ではなく、道路に当てはめ直せている');
  // 150m 横に外れ続ける → 3 回までは走った距離だけ進めて表示を保つ
  const before = tracker.result.profile.idx0;
  const r1 = tracker.update(fixAt(150, 130), m(), 2000);
  assert.ok(r1 && r1.estimated, '推測で表示を保つ');
  assert.ok(r1.profile.idx0 > before, '走った分だけ先へ進む');
  assert.ok(tracker.update(fixAt(150, 145), m(), 3000));
  assert.ok(tracker.update(fixAt(150, 160), m(), 4000));
  assert.equal(tracker.update(fixAt(150, 175), m(), 5000), null, '外れ続けたら未特定');
  assert.equal(tracker.status, 'no-road');
});

test('結果には、その座標を緯度経度に戻すための投影が付いている（取り直し後もずれない）', () => {
  const tracker = new RoadTracker();
  tracker.setStaticNetwork(ways(), origin);
  const r = tracker.update(fixAt(1, 300), { speed: 15, heading: 0, headingSource: 'course' }, 0);
  const p = r.profile.pts[r.profile.idx0];
  const ll = r.proj.toLatLon(p.x, p.y);
  const back = proj.toXY(ll.lat, ll.lon);
  assert.ok(Math.abs(back.x) < 1 && Math.abs(back.y - 300) < 3);
});

test('地図データの取り直しは間隔をあける', async () => {
  let calls = 0;
  const fetcher = () => {
    calls++;
    return Promise.resolve(ways());
  };
  const tracker = new RoadTracker({ fetcher, refetchAt: 10, minFetchInterval: 15000 });
  const tick = () => new Promise((r) => setTimeout(r, 0));
  const mv = { speed: 10, heading: 0, headingSource: 'course' };
  tracker.update(fixAt(1, 0), mv, 0);
  await tick();
  for (let i = 1; i <= 10; i++) {
    tracker.update(fixAt(1, i * 30), mv, i * 1000); // 毎回取り直しの条件を満たす
    await tick();
  }
  assert.equal(calls, 1, '15 秒以内は取り直さない');
  tracker.update(fixAt(1, 400), mv, 16000);
  await tick();
  assert.equal(calls, 2);
});
