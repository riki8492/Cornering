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

// ---------- 事前ダウンロード ----------
import { planTiles, bboxSizeKm, predownload } from '../js/roadcache.js';

/** 中心 (lat0, lon0) から東西 wKm・南北 hKm の範囲 */
function areaKm(lat0, lon0, wKm, hKm) {
  const dLat = (hKm * 1000) / 111195 / 2;
  const dLon = (wKm * 1000) / (111195 * Math.cos((lat0 * Math.PI) / 180)) / 2;
  return { s: lat0 - dLat, n: lat0 + dLat, w: lon0 - dLon, e: lon0 + dLon };
}

test('事前ダウンロードの区画：5km ごとに分け、1km 重ねて取得する', () => {
  const bbox = areaKm(35.3, 139.0, 12, 8);
  const tiles = planTiles(bbox);
  assert.equal(tiles.length, 3 * 2);
  // 区画の受け持ちは範囲をすき間なく覆う
  assert.ok(Math.abs(Math.min(...tiles.map((t) => t.inner.s)) - bbox.s) < 1e-9);
  assert.ok(Math.abs(Math.max(...tiles.map((t) => t.inner.e)) - bbox.e) < 1e-9);
  // 取得する範囲は 1km 広い
  const t = tiles[0];
  const ext = bboxSizeKm(t.query);
  const inn = bboxSizeKm(t.inner);
  assert.ok(Math.abs(ext.w - inn.w - 2) < 0.01 && Math.abs(ext.h - inn.h - 2) < 0.01);
});

test('事前ダウンロード：区画ごとに保存し、失敗した区画はもう一度押すと続きから', async () => {
  const cache = new RoadCache({ backend: new MemoryBackend() });
  const bbox = areaKm(35.3, 139.0, 9, 9); // 2×2 区画
  let calls = 0;
  let failOnce = true;
  const fetchBbox = async (q) => {
    calls++;
    if (failOnce && calls === 2) {
      failOnce = false;
      throw new Error('電波なし');
    }
    return WAYS;
  };
  const progress = [];
  const r1 = await predownload(bbox, cache, fetchBbox, { onProgress: (p) => progress.push(`${p.done}/${p.total}`) });
  assert.deepEqual([r1.saved, r1.failed, r1.skipped], [3, 1, 0]);
  assert.deepEqual(progress, ['0/4', '1/4', '2/4', '3/4', '4/4']);
  const r2 = await predownload(bbox, cache, fetchBbox);
  assert.deepEqual([r2.saved, r2.failed, r2.skipped], [1, 0, 3], '保存済みの区画は飛ばす');
  assert.equal(calls, 5);
  const st = await cache.stats();
  assert.equal(st.manual, 4);
  assert.ok(st.bytes > 0);
});

test('事前ダウンロード：広すぎる範囲は断る', async () => {
  const cache = new RoadCache({ backend: new MemoryBackend() });
  await assert.rejects(predownload(areaKm(35.3, 139.0, 40, 10), cache, async () => WAYS), /範囲が広すぎます/);
});

test('事前に保存した範囲の中なら、区画の境目でも通信せずに走れる', async () => {
  const cache = new RoadCache({ backend: new MemoryBackend() });
  const bbox = areaKm(35.3, 139.0, 10, 10); // 2×2 区画、境目は中心を通る
  await predownload(bbox, cache, async () => WAYS);
  let calls = 0;
  const f = cachedFetcher(async () => {
    calls++;
    return WAYS;
  }, cache);
  // 区画の境目（範囲の中心）と、区画の内側の点
  for (const [lat, lon] of [
    [35.3, 139.0],
    [35.28, 138.98],
    [35.32, 139.03],
  ]) {
    const r = await f(lat, lon, 1000);
    assert.equal(r.source, 'cache', `${lat},${lon}`);
  }
  assert.equal(calls, 0);
  // 範囲の外は通信する
  const out = await f(35.5, 139.0, 1000);
  assert.equal(out.source, 'network');
});

test('保存した道路データを消去できる', async () => {
  const cache = new RoadCache({ backend: new MemoryBackend() });
  await cache.save(35, 139, 1000, WAYS);
  await predownload(areaKm(35.3, 139.0, 4, 4), cache, async () => WAYS);
  assert.deepEqual(Object.values(await cache.stats()).slice(0, 2), [1, 1]);
  await cache.clear();
  const st = await cache.stats();
  assert.deepEqual([st.auto, st.manual, st.bytes], [0, 0, 0]);
  assert.equal(await cache.findCovering(35, 139, 0), null);
});
