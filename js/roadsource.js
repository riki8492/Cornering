// 道路データの取得元を切り替える
//
// 1. OpenStreetMap（Overpass API）：一方通行や道路名まであり、いちばん詳しい
// 2. 国土地理院の道路中心線：Overpass が混雑・停止しているときの予備（日本国内のみ。形がやや粗い）
//
// Overpass が全滅したら、しばらくは Overpass を飛ばして国土地理院から直接取る
// （走行中に毎回 Overpass の応答待ちで時間を使わないように）

import { fetchRoadsOverpass, fetchRoadsOverpassBbox } from './roadmap.js';
import { fetchRoadsGsi, fetchRoadsGsiBbox, inJapan } from './gsiroads.js';

const PROVIDER_LABEL = { osm: 'OpenStreetMap', gsi: '国土地理院' };
export const providerLabel = (p) => PROVIDER_LABEL[p] || '';

/**
 * @param {object} [o]
 * @param {Function} [o.osm] (lat, lon, radius, opts) → ways
 * @param {Function} [o.gsi]
 * @param {Function} [o.osmBbox] (bbox, opts) → ways
 * @param {Function} [o.gsiBbox]
 * @param {number} [o.skipMs] Overpass が全滅したあと、Overpass を飛ばす時間
 * @param {() => number} [o.now]
 */
export function makeRoadSource({
  osm = fetchRoadsOverpass,
  gsi = fetchRoadsGsi,
  osmBbox = fetchRoadsOverpassBbox,
  gsiBbox = fetchRoadsGsiBbox,
  skipMs = 10 * 60 * 1000,
  osmDeadlineMs = 10000,
  osmBboxDeadlineMs = 50000,
  now = () => Date.now(),
} = {}) {
  let osmDownUntil = 0;
  let osmError = '';

  async function chain(lat, lon, callOsm, callGsi, signal) {
    const errors = [];
    if (now() >= osmDownUntil) {
      try {
        const ways = await callOsm();
        return { ways, provider: 'osm' };
      } catch (e) {
        if (signal?.aborted) throw e;
        osmDownUntil = now() + skipMs;
        osmError = String(e?.message || e);
        errors.push(`OpenStreetMap：${osmError}`);
      }
    } else {
      errors.push(`OpenStreetMap：${osmError}・休止中`);
    }
    if (inJapan(lat, lon)) {
      try {
        const ways = await callGsi();
        return { ways, provider: 'gsi' };
      } catch (e) {
        if (signal?.aborted) throw e;
        errors.push(`国土地理院：${e?.message || e}`);
      }
    }
    // 国外で Overpass を飛ばしている間は、Overpass をもう一度試す
    if (errors.length === 1 && !inJapan(lat, lon) && errors[0].endsWith('・休止中')) {
      osmDownUntil = 0;
      return chain(lat, lon, callOsm, callGsi, signal);
    }
    throw new Error(errors.join('／'));
  }

  return {
    /** 点のまわりの道路（RoadTracker の fetcher） */
    fetch(lat, lon, radius, opts = {}) {
      return chain(
        lat,
        lon,
        () => osm(lat, lon, radius, { ...opts, deadlineMs: osmDeadlineMs }),
        () => gsi(lat, lon, radius, opts),
        opts.signal,
      );
    },
    /** 四角い範囲の道路（事前ダウンロード） */
    fetchBbox(bbox, opts = {}) {
      const lat = (bbox.s + bbox.n) / 2;
      const lon = (bbox.w + bbox.e) / 2;
      return chain(
        lat,
        lon,
        () => osmBbox(bbox, { ...opts, deadlineMs: osmBboxDeadlineMs }),
        () => gsiBbox(bbox, opts),
        opts.signal,
      );
    },
    /** Overpass を飛ばしているか */
    get osmSkipped() {
      return now() < osmDownUntil;
    },
    /** もう一度 Overpass から試すようにする */
    resetOsm() {
      osmDownUntil = 0;
    },
  };
}
