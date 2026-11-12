// 国土地理院の道路中心線への切り替えのテスト
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gsiFeaturesToWays, tilesForBbox, fetchRoadsGsiBbox, bboxAround, clearGsiMemo, inJapan } from '../js/gsiroads.js';
import { makeRoadSource } from '../js/roadsource.js';
import { RoadNetwork, RoadTracker, fetchRoadsOverpass } from '../js/roadmap.js';
import { RoadCache, cachedFetcher } from '../js/roadcache.js';
import { makeProjector } from '../js/geo.js';

const origin = { lat: 35.23, lon: 139.1 };
const proj = makeProjector(origin.lat, origin.lon);
const c = (x, y) => {
  const ll = proj.toLatLon(x, y);
  return [ll.lon, ll.lat];
};
const feat = (rID, coords, props = {}) => ({
  type: 'Feature',
  geometry: { type: 'LineString', coordinates: coords },
  properties: { rID, type: '通常部', state: '通常部', rdCtg: '国道', rnkWidth: '5.5m-13m未満', ...props },
});

/** 北へ伸びる国道（タイルの境目 y=300 と交差点 y=500 で切れている）＋ 交差点から東への町道 ＋ 歩道 */
function sample() {
  return [
    feat('a-1', [c(0, 0), c(5, 150), c(0, 300)]),
    // 境目の点は、隣のタイルでわずかにずれた値になることがある（0.1m）
    feat('a-2', [c(0.1, 300), c(-5, 400), c(0, 500)]),
    feat('a-3', [c(0, 500), c(0, 700)]),
    feat('b-1', [c(0, 500), c(200, 520)], { rdCtg: '市区町村道等', rnkWidth: '3m-5.5m未満' }),
    feat('f-1', [c(0, 100), c(-80, 100)], { type: '徒歩道' }),
    feat('g-1', [c(0, 600), c(-50, 650)], { type: '庭園路' }),
    feat('br', [c(0, 700), c(0, 760)], { state: '橋・高架' }),
  ];
}

test('道路中心線：境目でつなぎ、分岐のない区間は 1 本にまとめる。歩道・庭園路は除く', () => {
  const ways = gsiFeaturesToWays(sample());
  // 国道（交差点まで）・国道（交差点の先）・町道・橋 の 4 本
  assert.equal(ways.length, 4);
  const main = ways.find((w) => w.geometry.length === 5 + 0);
  assert.ok(main, '交差点までの国道は 2 本がつながって 5 点になる');
  assert.equal(main.tags.highway, 'primary');
  assert.ok(ways.some((w) => w.tags.bridge === 'yes'), '橋は別の道として bridge 付き');
  assert.ok(ways.some((w) => w.tags.highway === 'unclassified'), '町道');
  assert.ok(ways.every((w) => w.id < 0), 'OSM の id と重ならない負の id');
});

test('道路中心線：交差点を通り抜けて道なりにたどれる（境目のずれも越える）', () => {
  const net = new RoadNetwork(gsiFeaturesToWays(sample()), origin);
  const m = net.match({ x: 0, y: 50 }, 0, null, 25);
  assert.ok(m);
  const fwd = net.walk(m, m.dir, 700);
  assert.ok(fwd.length > 690, `北の端まで ${Math.round(fwd.length)}m たどれる`);
  // 交差点では東の町道ではなく、まっすぐ国道の続きへ
  const last = fwd.pts[fwd.pts.length - 1];
  assert.ok(Math.abs(last.x) < 3 && last.y > 740);
});

test('道路中心線：取得範囲が変わっても同じ道は同じ id', () => {
  const all = gsiFeaturesToWays(sample());
  const part = gsiFeaturesToWays(sample().filter((f) => f.properties.rID !== 'b-1'));
  // 町道が無い範囲では交差点が分岐でなくなり、国道は 1 本につながる。それでも id は変わらない
  const start = (ways) => ways.find((w) => w.nodes.length > 2 && w.geometry[0].lat === sample()[0].geometry.coordinates[0][1]);
  assert.notEqual(start(all).geometry.length, start(part).geometry.length);
  assert.equal(start(all).id, start(part).id);
});

test('タイルの一覧と範囲', () => {
  const t = tilesForBbox(bboxAround(35.23, 139.1, 1000));
  assert.ok(t.length >= 16 && t.length <= 30, `2km 四方は 4〜5 枚四方（${t.length} 枚）`);
  assert.ok(inJapan(35.23, 139.1));
  assert.ok(!inJapan(48.85, 2.35));
});

function fakeGsiFetch({ fail = () => false } = {}) {
  const calls = [];
  const fn = async (url) => {
    calls.push(url);
    const [x, y] = url.match(/\/(\d+)\/(\d+)\.geojson$/).slice(1).map(Number);
    if (fail(x, y)) throw new TypeError('Load failed');
    // 左上のタイルだけ道路あり、他は 404
    const t = tilesForBbox(bboxAround(origin.lat, origin.lon, 300))[0];
    if (x === t.x && y === t.y) {
      return { ok: true, status: 200, json: async () => ({ features: sample() }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  return { fn, calls };
}

test('国土地理院から取得：道路の無いタイル（404）は空として扱い、取ったタイルは使い回す', async () => {
  clearGsiMemo();
  const f = fakeGsiFetch();
  const bbox = bboxAround(origin.lat, origin.lon, 300);
  const ways = await fetchRoadsGsiBbox(bbox, { fetchImpl: f.fn });
  assert.equal(ways.length, 4);
  const n = f.calls.length;
  await fetchRoadsGsiBbox(bbox, { fetchImpl: f.fn });
  assert.equal(f.calls.length, n, '2 回目は通信しない');
});

test('国土地理院から取得：タイルが 1 枚でも欠けたら失敗にする（道が途切れたデータは使わない）', async () => {
  clearGsiMemo();
  let first = true;
  const f = fakeGsiFetch({ fail: () => (first ? ((first = false), true) : false) || false });
  // 1 回目の失敗は取り直しで回復する
  await fetchRoadsGsiBbox(bboxAround(origin.lat, origin.lon, 300), { fetchImpl: f.fn });
  clearGsiMemo();
  const g = fakeGsiFetch({ fail: () => true });
  await assert.rejects(fetchRoadsGsiBbox(bboxAround(origin.lat, origin.lon, 300), { fetchImpl: g.fn }));
});

test('取得元の切り替え：Overpass が全滅したら国土地理院へ。しばらくは Overpass を飛ばす', async () => {
  let t = 0;
  const log = [];
  const src = makeRoadSource({
    osm: async () => {
      log.push('osm');
      throw new Error('混雑（HTTP 503）');
    },
    gsi: async () => {
      log.push('gsi');
      return [{ id: -1 }];
    },
    skipMs: 60000,
    now: () => t,
  });
  const r1 = await src.fetch(35.23, 139.1, 1000);
  assert.equal(r1.provider, 'gsi');
  assert.deepEqual(log, ['osm', 'gsi']);
  t = 30000;
  await src.fetch(35.23, 139.1, 1000);
  assert.deepEqual(log, ['osm', 'gsi', 'gsi'], '1 分以内は Overpass を待たない');
  t = 61000;
  await src.fetch(35.23, 139.1, 1000);
  assert.deepEqual(log, ['osm', 'gsi', 'gsi', 'osm', 'gsi'], '時間がたったら Overpass をもう一度試す');
});

test('取得元の切り替え：Overpass が使えればそちら。両方だめなら理由をまとめて返す', async () => {
  const ok = makeRoadSource({ osm: async () => [{ id: 1 }], gsi: async () => assert.fail('呼ばれない') });
  assert.equal((await ok.fetch(35.23, 139.1, 1000)).provider, 'osm');
  const bad = makeRoadSource({
    osm: async () => {
      throw new Error('混雑（HTTP 503）');
    },
    gsi: async () => {
      throw new Error('通信できません');
    },
  });
  await assert.rejects(bad.fetch(35.23, 139.1, 1000), /OpenStreetMap：混雑（HTTP 503）／国土地理院：通信できません/);
});

test('取得元の切り替え：国外では国土地理院を使わない', async () => {
  const log = [];
  const src = makeRoadSource({
    osm: async () => {
      log.push('osm');
      throw new Error('混雑（HTTP 503）');
    },
    gsi: async () => log.push('gsi'),
  });
  await assert.rejects(src.fetch(48.85, 2.35, 1000), /OpenStreetMap/);
  await assert.rejects(src.fetch(48.85, 2.35, 1000), /OpenStreetMap/);
  assert.deepEqual(log, ['osm', 'osm']);
});

test('保存済みデータにも取得元が残り、走行中の状態に出る', async () => {
  const cache = new RoadCache();
  const ways = gsiFeaturesToWays(sample());
  const src = { fetch: async () => ({ ways, provider: 'gsi' }) };
  const f = cachedFetcher(src.fetch, cache);
  const r1 = await f(origin.lat, origin.lon, 1000);
  assert.equal(r1.provider, 'gsi');
  assert.equal(r1.source, 'network');
  const r2 = await f(origin.lat, origin.lon, 1000);
  assert.equal(r2.source, 'cache');
  assert.equal(r2.provider, 'gsi');

  const tr = new RoadTracker({ fetcher: f });
  const ll = proj.toLatLon(0, 50);
  tr.update({ ...ll, accuracy: 5 }, { speed: 10, heading: 0, headingSource: 'course' }, 0);
  await new Promise((r) => setTimeout(r, 20));
  tr.update({ ...ll, accuracy: 5 }, { speed: 10, heading: 0, headingSource: 'course' }, 1000);
  assert.equal(tr.provider, 'gsi');
  assert.equal(tr.status, 'ready');
});

test('Overpass：全体の持ち時間を過ぎたら次のサーバーを試さない。混雑は理由に出す', async () => {
  const hits = [];
  const hang = (url, o) =>
    new Promise((_, rej) => {
      hits.push(url);
      o.signal.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')));
    });
  const t0 = Date.now();
  await assert.rejects(
    fetchRoadsOverpass(35, 139, 500, { endpoints: ['https://a', 'https://b', 'https://c', 'https://d'], timeoutMs: 1200, deadlineMs: 2500, fetchImpl: hang }),
    /応答がありません/,
  );
  assert.ok(Date.now() - t0 < 3000, '持ち時間で打ち切る');
  assert.equal(hits.length, 2, '2 台目の途中で時間切れ');

  await assert.rejects(
    fetchRoadsOverpass(35, 139, 500, { endpoints: ['https://a'], fetchImpl: async () => ({ ok: false, status: 503 }) }),
    /混雑（HTTP 503）/,
  );
});
