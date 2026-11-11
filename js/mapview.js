// 走行中の現在地を地図に表示する
// 地図ライブラリ（Leaflet、vendor/leaflet に同梱）は地図を初めて開いたときに読み込む

let leafletPromise = null;

/** Leaflet を読み込んで L を返す */
export function loadLeaflet(base = 'vendor/leaflet/') {
  if (globalThis.L) return Promise.resolve(globalThis.L);
  if (!leafletPromise) {
    leafletPromise = new Promise((resolve, reject) => {
      const css = document.createElement('link');
      css.rel = 'stylesheet';
      css.href = `${base}leaflet.css`;
      document.head.append(css);
      const s = document.createElement('script');
      s.src = `${base}leaflet.js`;
      s.onload = () => resolve(globalThis.L);
      s.onerror = () => {
        leafletPromise = null;
        s.remove();
        reject(new Error('地図ライブラリを読み込めません'));
      };
      document.head.append(s);
    });
  }
  return leafletPromise;
}

const GSI_ATTR = '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank" rel="noopener">地理院タイル</a>';

// dark: 暗い画面に合わせて色を反転する（航空写真はそのまま）
export const BASE_LAYERS = {
  gsi: {
    label: '地理院地図',
    url: 'https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png',
    maxNativeZoom: 18,
    attribution: GSI_ATTR,
    dark: true,
  },
  photo: {
    label: '航空写真（地理院）',
    url: 'https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg',
    maxNativeZoom: 18,
    attribution: GSI_ATTR,
    dark: false,
  },
  osm: {
    label: 'OpenStreetMap',
    url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    maxNativeZoom: 19,
    attribution: '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap contributors</a>',
    dark: true,
  },
};

const CAR_SVG =
  '<svg viewBox="0 0 24 24" width="28" height="28" aria-hidden="true"><path d="M12 2.5 L19.5 20.5 L12 16.5 L4.5 20.5 Z"/></svg>';

export class DriveMap {
  /**
   * @param {any} L Leaflet
   * @param {HTMLElement} el 地図を描く要素
   * @param {object} [o]
   * @param {string} [o.baseLayer] 'gsi' | 'photo' | 'osm'
   * @param {(key:string)=>void} [o.onBaseLayerChange]
   */
  constructor(L, el, { baseLayer = 'gsi', onBaseLayerChange } = {}) {
    this.L = L;
    const map = L.map(el, { zoomControl: true, preferCanvas: true }).setView([36.2, 138.25], 5);
    this.map = map;

    this.layers = {};
    const control = {};
    for (const [key, def] of Object.entries(BASE_LAYERS)) {
      const layer = L.tileLayer(def.url, {
        maxZoom: 19,
        maxNativeZoom: def.maxNativeZoom,
        attribution: def.attribution,
        className: def.dark ? 'tiles-dark' : '',
      });
      layer.key = key;
      this.layers[key] = layer;
      control[def.label] = layer;
    }
    (this.layers[baseLayer] || this.layers.gsi).addTo(map);
    L.control.layers(control, null, { position: 'topright' }).addTo(map);
    map.on('baselayerchange', (e) => onBaseLayerChange?.(e.layer.key));

    // 現在地への追従。地図を指で動かしたら追従をやめ、「現在地」ボタンで再開
    this.follow = true;
    map.on('dragstart', () => this.setFollow(false));
    const self = this;
    const Recenter = L.Control.extend({
      options: { position: 'bottomright' },
      onAdd() {
        const b = L.DomUtil.create('button', 'map-recenter active');
        b.type = 'button';
        b.textContent = '現在地';
        L.DomEvent.disableClickPropagation(b);
        L.DomEvent.on(b, 'click', () => {
          self.setFollow(true);
          if (self.pos) map.setView(self.pos, Math.max(map.getZoom(), 15));
        });
        self.recenterBtn = b;
        return b;
      },
    });
    new Recenter().addTo(map);

    this.track = L.polyline([], { color: '#8b9aab', weight: 3, opacity: 0.6, interactive: false }).addTo(map);
    this.trackLen = 0;
    this.ahead = L.layerGroup().addTo(map);
    this.curves = L.layerGroup().addTo(map);
    this.accuracy = null;
    this.marker = null;
    this.pos = null;
    this.centered = false;
  }

  setFollow(on) {
    this.follow = on;
    this.recenterBtn?.classList.toggle('active', on);
  }

  /** 非表示から表示に切り替えたあとに呼ぶ（サイズの再計算） */
  invalidate() {
    this.map.invalidateSize();
  }

  /** 走行の開始時：軌跡を消して現在地に追従し直す */
  reset() {
    this.track.setLatLngs([]);
    this.trackLen = 0;
    this.ahead.clearLayers();
    this.curves.clearLayers();
    this.centered = false;
    this.setFollow(true);
  }

  /**
   * @param {object} s
   * @param {number} s.lat
   * @param {number} s.lon
   * @param {number|null} s.accuracy [m]
   * @param {number|null} s.heading 北=0 の方位 [deg]
   * @param {Array<[number,number]>} s.track これまでの軌跡
   * @param {Array<{latlngs:Array<[number,number]>, color:string}>} s.ahead この先の道路（色分け済み）
   * @param {Array<{lat:number,lon:number,label:string}>} s.curves カーブの頂点
   */
  update({ lat, lon, accuracy, heading, track, ahead = [], curves = [] }) {
    const L = this.L;
    const ll = [lat, lon];
    this.pos = ll;

    if (track && track.length !== this.trackLen) {
      this.track.setLatLngs(track);
      this.trackLen = track.length;
    }

    this.ahead.clearLayers();
    for (const run of ahead) {
      L.polyline(run.latlngs, { color: run.color, weight: 7, opacity: 0.9, interactive: false }).addTo(this.ahead);
    }
    this.curves.clearLayers();
    for (const c of curves) {
      L.marker([c.lat, c.lon], {
        icon: L.divIcon({ className: 'curve-label', html: `<span>${c.label}</span>`, iconSize: null }),
        interactive: false,
        keyboard: false,
      }).addTo(this.curves);
    }

    if (Number.isFinite(accuracy) && accuracy > 0) {
      if (!this.accuracy) {
        this.accuracy = L.circle(ll, {
          radius: accuracy,
          color: '#2dd4bf',
          weight: 1,
          opacity: 0.6,
          fillOpacity: 0.12,
          interactive: false,
        }).addTo(this.map);
      } else {
        this.accuracy.setLatLng(ll);
        this.accuracy.setRadius(accuracy);
      }
    }

    if (!this.marker) {
      this.marker = L.marker(ll, {
        icon: L.divIcon({ className: 'car-icon', html: `<div class="car-arrow">${CAR_SVG}</div>`, iconSize: [28, 28], iconAnchor: [14, 14] }),
        interactive: false,
        keyboard: false,
        zIndexOffset: 1000,
      }).addTo(this.map);
    } else {
      this.marker.setLatLng(ll);
    }
    const arrow = this.marker.getElement()?.querySelector('.car-arrow');
    if (arrow) {
      arrow.classList.toggle('no-heading', heading == null);
      arrow.style.transform = heading == null ? '' : `rotate(${heading}deg)`;
    }

    if (!this.centered) {
      this.map.setView(ll, 16);
      this.centered = true;
    } else if (this.follow) {
      this.map.panTo(ll, { animate: true, duration: 0.5 });
    }
  }
}
