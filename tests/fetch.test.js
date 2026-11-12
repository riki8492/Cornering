// 地図データの取得：応答がないときの打ち切り・保存済みデータの利用
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchRoadsOverpass, RoadTracker } from '../js/roadmap.js';
import { RoadCache, MemoryBackend, cachedFetcher, compactWays, expandWays } from '../js/roadcache.js';
import { makeProjector } from '../js/geo.js';

const origin = { lat: 35.36, lon: 138.73 };
const proj = makeProjector(origin.lat, origin.lon);
const WAYS = (() => {
  const g = [];
  for (let y = 0; y <= 1000; y += 50) g.push(proj.toLatLon(0, y));
  return [{ id: 7, nodes: g.map((_, i) => 500 + i), geometry: g, tags: { highway: 'secondary', name: 'ダム湖畔道路', surface: 'asphalt' } }];
})();

/** 中断されるまで返事をしない fetch（電波の弱い所や、接続を握ったままのサーバーの再現） */
const hangingFetch = (url, { signal }) =>
  new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))));

const okFetch = () =>
  Promise.resolve({
    ok: true,
    json: async () => ({ elements: WAYS.map((w) => ({ type: 'way', id: w.id, nodes: w.nodes, geometry: w.geometry, tags: w.tags })) }),
  });

test('応答のないサーバーは打ち切って、次のサーバーから取る', async () => {
  const t0 = Date.now();
  const ways = await fetchRoadsOverpass(35.36, 138.73, 1000, {
    endpoints: ['https://hang.example/api', 'https://ok.example/api'],
    timeoutMs: 80,
    fetchImpl: (url, o) => (url.includes('hang') ? hangingFetch(url, o) : okFetch()),
  });
  assert.equal(ways.length, 1);
  assert.equal(ways[0].tags.name, 'ダム湖畔道路');
  assert.ok(Date.now() - t0 < 1000);
});

test('どのサーバーも応答しなければ、待ち続けずにエラーにする', async () => {
  await assert.rejects(
    fetchRoadsOverpass(35.36, 138.73, 1000, {
      endpoints: ['https://a.example', 'https://b.example'],
      timeoutMs: 50,
      fetchImpl: hangingFetch,
    }),
    /応答がありません/,
  );
});

test('取得が固まったら、45 秒であきらめて取り直す（遅れて届いた結果は捨てる）', async () => {
  const pending = [];
  const fetcher = () => new Promise((resolve) => pending.push(resolve));
  const tracker = new RoadTracker({ fetcher });
  const tick = () => new Promise((r) => setTimeout(r, 0));
  const fix = { ...proj.toLatLon(0, 100), accuracy: 5 };
  const mv = { speed: 15, heading: 0, headingSource: 'course' };
  tracker.update(fix, mv, 0);
  await tick();
  assert.equal(tracker.status, 'loading');
  assert.equal(pending.length, 1);
  tracker.update(fix, mv, 20000);
  assert.equal(Math.round(tracker.loadingElapsed() / 1000), 20, '経過秒数が分かる');
  tracker.update(fix, mv, 46000);
  assert.equal(tracker.status, 'error', '固まった取得をあきらめた');
  assert.ok(tracker.retryIn() > 0);
  // あきらめた後に最初の取得が返ってきても使わない
  pending[0](WAYS);
  await tick();
  assert.equal(tracker.net, null);
  // 少し待つと取り直す
  tracker.update(fix, mv, 52000);
  await tick();
  assert.equal(pending.length, 2);
  pending[1](WAYS);
  await tick();
  assert.equal(tracker.status, 'ready');
  assert.ok(tracker.update(fix, mv, 53000), '取り直したデータで道路が特定できる');
});

test('保存形式：座標は 1e-6 度（約 0.1m）の精度で元に戻る', () => {
  const back = expandWays(compactWays(WAYS));
  assert.equal(back[0].id, 7);
  assert.deepEqual(back[0].nodes, WAYS[0].nodes);
  assert.equal(back[0].tags.name, 'ダム湖畔道路');
  assert.equal(back[0].tags.surface, undefined, '使わないタグは保存しない');
  for (let i = 0; i < WAYS[0].geometry.length; i++) {
    assert.ok(Math.abs(back[0].geometry[i].lat - WAYS[0].geometry[i].lat) < 1e-6);
    assert.ok(Math.abs(back[0].geometry[i].lon - WAYS[0].geometry[i].lon) < 1e-6);
  }
});

test('保存済みの範囲：近くなら通信せずに使い、通信できないときは代用する', async () => {
  const cache = new RoadCache({ backend: new MemoryBackend() });
  let calls = 0;
  let online = true;
  const net = async () => {
    calls++;
    if (!online) throw new Error('オフライン');
    return WAYS;
  };
  const f = cachedFetcher(net, cache);
  const c = proj.toLatLon(0, 500);
  // 1 回目：通信して保存
  const r1 = await f(c.lat, c.lon, 1000);
  assert.equal(r1.source, 'network');
  assert.equal(calls, 1);
  // 100m ずれた所：保存済みの範囲に収まるので通信しない
  const c2 = proj.toLatLon(0, 600);
  const r2 = await f(c2.lat, c2.lon, 1000);
  assert.equal(r2.source, 'cache');
  assert.equal(calls, 1);
  assert.equal(r2.ways[0].tags.name, 'ダム湖畔道路');
  // 800m 先：余裕が足りないので通信を試みる → オフラインなら保存済みで代用
  online = false;
  const c3 = proj.toLatLon(0, 1300);
  const r3 = await f(c3.lat, c3.lon, 1000, { here: proj.toLatLon(0, 900) });
  assert.equal(r3.source, 'cache-fallback');
  assert.equal(calls, 2);
  // 保存済みの範囲の外でオフライン → エラー
  const far = proj.toLatLon(5000, 5000);
  await assert.rejects(f(far.lat, far.lon, 1000, { here: far }), /オフライン/);
});

test('古い保存データは使わずに取り直し、通信できなければ古くても使う', async () => {
  const cache = new RoadCache({ backend: new MemoryBackend() });
  let clock = 0;
  let online = true;
  let calls = 0;
  const f = cachedFetcher(
    async () => {
      calls++;
      if (!online) throw new Error('オフライン');
      return WAYS;
    },
    cache,
    { maxAgeDays: 30, now: () => clock },
  );
  await f(origin.lat, origin.lon, 1000);
  clock = 31 * 24 * 3600 * 1000; // 31 日後
  const r = await f(origin.lat, origin.lon, 1000);
  assert.equal(r.source, 'network', '古いので取り直した');
  assert.equal(calls, 2);
  clock = 62 * 24 * 3600 * 1000;
  online = false;
  const r2 = await f(origin.lat, origin.lon, 1000);
  assert.equal(r2.source, 'cache-fallback', '通信できなければ古くても使う');
});

test('保存する範囲の数には上限があり、古いものから消す', async () => {
  const cache = new RoadCache({ backend: new MemoryBackend(), maxAreas: 3 });
  for (let i = 0; i < 5; i++) await cache.save(35 + i * 0.1, 139, 1000, WAYS, i);
  assert.equal(await cache.count(), 3);
  assert.equal(await cache.findCovering(35, 139, 0), null, '最初のものは消えた');
  assert.ok(await cache.findCovering(35.4, 139, 0));
});

test('RoadTracker は保存済みデータを使ったことを状態として持つ', async () => {
  const cache = new RoadCache({ backend: new MemoryBackend() });
  const c = proj.toLatLon(0, 500);
  await cache.save(c.lat, c.lon, 2000, WAYS, Date.now());
  const tracker = new RoadTracker({
    fetcher: cachedFetcher(async () => {
      throw new Error('通信しないはず');
    }, cache),
  });
  const fix = { ...proj.toLatLon(0, 100), accuracy: 5 };
  tracker.update(fix, { speed: 15, heading: 0, headingSource: 'course' }, 0);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(tracker.source, 'cache');
  assert.ok(tracker.update(fix, { speed: 15, heading: 0, headingSource: 'course' }, 1000));
});
