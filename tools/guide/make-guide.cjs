// 使い方ガイドの画像を、実際のアプリ画面から作る
//
//   node tools/guide/make-guide.cjs
//
// アプリをヘッドレスブラウザ（Playwright）で操作して画面を撮り、番号付きの印と説明を重ねた
// PNG を docs/guide/ に書き出す。画面を変えたら実行し直せば画像も最新になる。
// 必要なもの：Node.js 18 以上と Playwright（npm i -D playwright && npx playwright install chromium）

const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '../..');
const OUT = path.join(ROOT, 'docs/guide');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

/** リポジトリをそのまま配信する小さな静的サーバー */
function serve() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let p = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
      if (p.endsWith('/')) p += 'index.html';
      const file = path.join(ROOT, p);
      if (!file.startsWith(ROOT)) {
        res.writeHead(403);
        res.end();
        return;
      }
      fs.readFile(file, (err, data) => {
        if (err) {
          res.writeHead(404);
          res.end();
          return;
        }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
        res.end(data);
      });
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 要素の位置（基準要素からの相対、CSS px） */
async function boxOf(page, sel, baseSel = null) {
  return page.evaluate(
    ([s, b]) => {
      const el = document.querySelector(s);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const o = b ? document.querySelector(b).getBoundingClientRect() : { x: 0, y: 0 };
      return { x: r.x - o.x, y: r.y - o.y, w: r.width, h: r.height };
    },
    [sel, baseSel],
  );
}

/** 画面全体（ビューポート）を撮る */
async function viewportShot(page) {
  const buf = await page.screenshot();
  const vp = page.viewportSize();
  return { src: `data:image/png;base64,${buf.toString('base64')}`, w: vp.width, h: vp.height };
}

/** 要素だけを撮る */
async function elementShot(page, sel) {
  const el = await page.$(sel);
  await el.scrollIntoViewIfNeeded();
  const buf = await el.screenshot();
  const r = await boxOf(page, sel);
  return { src: `data:image/png;base64,${buf.toString('base64')}`, w: r.w, h: r.h };
}

const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);

/**
 * 画面写真に番号と枠を重ねる
 * marks: [{ n, box:{x,y,w,h}, at:'left'|'right'|'top'|'tl'|'center', frame?:boolean }]
 */
// 番号の丸は画面の外側（余白）にはみ出して置けるよう、写真の周りに余白を取る
const PAD = 22;
const OFF = 19; // 要素の端から番号の中心までの距離

function figure(shot, marks, displayWidth) {
  const s = displayWidth / shot.w;
  const H = shot.h * s;
  const W = displayWidth + PAD * 2;
  const clampX = (x) => Math.max(16, Math.min(W - 16, x));
  const clampY = (y) => Math.max(16, Math.min(H + PAD * 2 - 16, y));
  const items = marks
    .filter((m) => m.box)
    .map((m) => {
      const b = { x: PAD + m.box.x * s, y: PAD + m.box.y * s, w: m.box.w * s, h: m.box.h * s };
      const at = m.at || 'left';
      // 文字にかぶらないよう、要素の外側に置く
      const pos = {
        left: [b.x - OFF, b.y + b.h / 2],
        right: [b.x + b.w + OFF, b.y + b.h / 2],
        top: [b.x + b.w / 2, b.y - 4],
        tl: [b.x - 2, b.y - 2],
        tr: [b.x + b.w + 2, b.y - 2],
        center: [b.x + b.w / 2, b.y + b.h / 2],
      }[at];
      const frame =
        m.frame === false
          ? ''
          : `<div class="frame" style="left:${b.x - 3}px;top:${b.y - 3}px;width:${b.w + 6}px;height:${b.h + 6}px"></div>`;
      return `${frame}<div class="badge" style="left:${clampX(pos[0])}px;top:${clampY(pos[1])}px">${m.n}</div>`;
    })
    .join('');
  return `<div class="fig" style="width:${W}px;height:${H + PAD * 2}px">
    <div class="shot" style="left:${PAD}px;top:${PAD}px;width:${displayWidth}px;height:${H}px"><img src="${shot.src}" alt=""></div>${items}</div>`;
}

/**
 * 写真に付ける印と説明をまとめて作る。位置が取れなかった項目（例：表示されていない警告）は
 * 飛ばして、番号を 1 から振り直す
 * @param {Array<{box:object|null, at?:string, title:string, desc?:string}>} entries
 */
function numbered(entries) {
  const ok = entries.filter((e) => e.box);
  return {
    marks: ok.map((e, i) => ({ n: i + 1, box: e.box, at: e.at, fig: e.fig })),
    legend: ok.map((e, i) => [i + 1, e.title, e.desc || '']),
  };
}

const STYLE = `
:root { --bg:#0b0f14; --card:#141b24; --card2:#1b2430; --line:#263241; --text:#e6edf3; --muted:#9aa8b8;
  --accent:#2dd4bf; --mark:#fbbf24; --warn:#fb923c; --danger:#f87171; }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--text);
  font-family: 'Hiragino Sans','Noto Sans CJK JP','Noto Sans JP',system-ui,sans-serif; }
.page { width: 580px; padding: 30px 26px 34px; }
.step { color: var(--accent); font-weight: 800; font-size: 14px; letter-spacing: .08em; }
h1 { font-size: 30px; line-height: 1.25; margin: 6px 0 8px; }
.lead { color: var(--muted); font-size: 15.5px; line-height: 1.65; margin: 0 0 20px; }
.shots { display: grid; gap: 18px; justify-items: center; }
.cap { color: var(--muted); font-size: 13px; text-align: center; margin: -8px 0 0; }
.fig { position: relative; }
.shot { position: absolute; border-radius: 22px; overflow: hidden; border: 1px solid var(--line);
  box-shadow: 0 10px 30px rgb(0 0 0 / 45%); }
.shot img { display:block; width:100%; height:100%; }
.frame { position:absolute; border: 3px solid var(--mark); border-radius: 12px; box-shadow: 0 0 0 2px rgb(0 0 0 / 35%); }
.badge { position:absolute; transform: translate(-50%,-50%); width: 32px; height: 32px; border-radius: 50%;
  background: var(--mark); color: #1a1200; font-weight: 900; font-size: 17px; display:grid; place-items:center;
  border: 3px solid #0b0f14; box-shadow: 0 2px 6px rgb(0 0 0 / 50%); }
ol { list-style: none; padding: 0; margin: 24px 0 0; display: grid; gap: 14px; }
li { display: grid; grid-template-columns: 32px 1fr; gap: 12px; align-items: start; }
li .n { width: 32px; height: 32px; border-radius: 50%; background: var(--mark); color:#1a1200; font-weight: 900;
  display:grid; place-items:center; font-size: 16px; }
li b { display:block; font-size: 17px; margin-top: 3px; }
li span { display:block; color: var(--muted); font-size: 14.5px; line-height: 1.6; margin-top: 2px; }
.box { margin-top: 22px; padding: 14px 16px; border-radius: 14px; background: var(--card); border: 1px solid var(--line);
  font-size: 14.5px; line-height: 1.7; }
.box h2 { margin: 0 0 6px; font-size: 15px; color: var(--accent); }
.box.warn { border-color: color-mix(in srgb, var(--warn) 60%, var(--line)); }
.box.warn h2 { color: var(--warn); }
.chips { display:flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; }
.chip { padding: 4px 10px; border-radius: 999px; font-weight: 700; font-size: 13.5px; }
.foot { margin-top: 20px; color: var(--muted); font-size: 12.5px; }
`;

function pageHtml({ step, title, lead, figures, legend, extra = '' }) {
  const li = legend
    .map(([n, b, s]) => `<li><div class="n">${n}</div><div><b>${esc(b)}</b>${s ? `<span>${esc(s)}</span>` : ''}</div></li>`)
    .join('');
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><style>${STYLE}</style></head><body>
  <div class="page">
    <div class="step">${esc(step)}</div>
    <h1>${esc(title)}</h1>
    <p class="lead">${esc(lead)}</p>
    <div class="shots">${figures.join('')}</div>
    <ol>${li}</ol>
    ${extra}
    <div class="foot">Cornering — https://riki8492.github.io/Cornering/</div>
  </div></body></html>`;
}

async function render(browser, html, file) {
  const page = await browser.newPage({ viewport: { width: 580, height: 800 }, deviceScaleFactor: 2 });
  await page.setContent(html, { waitUntil: 'load' });
  const el = await page.$('.page');
  await el.screenshot({ path: path.join(OUT, file) });
  await page.close();
  console.log('  →', path.relative(ROOT, path.join(OUT, file)));
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const srv = await serve();
  const base = `http://127.0.0.1:${srv.address().port}/`;
  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  });
  // 音声合成は記録だけにする（ヘッドレスでは鳴らないため）
  await ctx.addInitScript(() => {
    window.SpeechSynthesisUtterance = function (t) {
      this.text = t;
    };
    Object.defineProperty(window, 'speechSynthesis', { value: { speak() {} } });
  });
  const page = await ctx.newPage();
  await page.goto(base);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await sleep(500);

  // ---------- 1. 全体の流れ ----------
  console.log('1. 全体の流れ');
  {
    const shot = await viewportShot(page);
    const tab = (v) => boxOf(page, `.tabbar [data-view="${v}"]`);
    const marks = [
      { n: 1, box: await tab('drive'), at: 'top' },
      { n: 2, box: await tab('calc'), at: 'top' },
      { n: 3, box: await tab('vehicle'), at: 'top' },
      { n: 4, box: await tab('info'), at: 'top' },
      { n: 5, box: await boxOf(page, '#btn-start'), at: 'left' },
      { n: 6, box: await boxOf(page, '#btn-demo'), at: 'right' },
    ];
    await render(
      browser,
      pageHtml({
        step: 'CORNERING の使い方',
        title: '設定 → デモで確認 → 計測開始',
        lead: '道路のカーブ半径 R から、その車で曲がれる上限速度を表示するアプリ。画面は下の 4 つのタブで切り替えます',
        figures: [figure(shot, marks, 390)],
        legend: [
          [1, '走行', '走りながら、次のコーナーの R と上限速度を表示'],
          [2, '計算', '好きな R・路面・勾配で上限速度を調べる'],
          [3, '車両（最初にここ）', '車種・重量・外寸・タイヤ・車高を設定'],
          [4, '説明', '計算の仕組みと注意点'],
          [5, '計測開始', 'GPS で実走。位置情報を「許可」（iPhone はモーションセンサーも）'],
          [6, 'デモ走行', '架空の峠道を自動で走らせて、家で見え方を確認'],
        ],
        extra: `<div class="box"><h2>スマホで使うには</h2>Safari / Chrome でサイトを開き、共有メニューから「ホーム画面に追加」。アプリのように起動でき、計測中は画面が消えません</div>`,
      }),
      '01-overview.png',
    );
  }

  // ---------- 2. 車両の設定 ----------
  console.log('2. 車両の設定');
  {
    await page.setViewportSize({ width: 390, height: 1290 });
    await page.click('[data-view="vehicle"]');
    await page.selectOption('#preset-maker', 'ホンダ');
    await page.selectOption('#preset-body', 'wagon');
    await page.selectOption('#preset-select', 'accord-tourer-cw2');
    await page.fill('[data-veh="lowerFrontMm"]', '20');
    await page.fill('[data-veh="lowerRearMm"]', '25');
    await page.evaluate(() => window.scrollTo(0, 0));
    await sleep(300);
    const shot = await viewportShot(page);
    const card = (sel) => page.evaluate((s) => {
      const r = document.querySelector(s).closest('.card').getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    }, sel);
    const marks = [
      { n: 1, box: await boxOf(page, '#preset-maker'), at: 'left' },
      { n: 2, box: await boxOf(page, '#preset-body'), at: 'right' },
      { n: 3, box: await boxOf(page, '#preset-select'), at: 'left' },
      { n: 4, box: await boxOf(page, '#preset-hint'), at: 'left' },
      { n: 5, box: await card('[data-veh="massKg"]'), at: 'tl' },
      { n: 6, box: await card('[data-veh="widthMm"]'), at: 'tl' },
      { n: 7, box: await card('[data-veh="lowerFrontMm"]'), at: 'tl' },
    ];
    await render(
      browser,
      pageHtml({
        step: 'STEP 1',
        title: '車両を設定する',
        lead: '車種を選ぶと諸元が一括で入ります。選んだあとも全部書き換えられます（例：アコードツアラー CW2・前 20mm／後 25mm ダウン）',
        figures: [figure(shot, marks, 390)],
        legend: [
          [1, 'メーカー', '国産 9 社・輸入 9 社。名前の横の数字は車種数'],
          [2, 'ボディタイプ', '軽・コンパクト・セダン・ワゴン・SUV・ミニバン・スポーツで絞り込み'],
          [3, '車種', '代表グレードの目安値が入る。無ければ「選択しない（手入力）」のまま'],
          [4, '選んだ車の情報', '値を変えると「一部変更あり」。重量配分が推定値の車は「推定」と出る'],
          [5, '重量', '車検証の「前前軸重」「後後軸重」があれば上書きすると正確'],
          [6, '外寸', '車検証の長さ・幅・高さ。ローダウンしていても全高は純正のまま'],
          [7, '車高の変更', '下げた量を入れると重心高を自動で補正（上げたならマイナス）'],
        ],
        extra: `<div class="box"><h2>タイヤを替えているなら</h2>下の「駆動系・タイヤ」で、タイヤの種類・幅・摩耗状態も合わせてください。限界速度にいちばん効くのはタイヤです</div>`,
      }),
      '02-vehicle.png',
    );
  }

  // ---------- 3〜5. デモ走行中の画面 ----------
  console.log('3〜5. 走行画面（デモ走行）');
  await page.setViewportSize({ width: 390, height: 1450 });
  await page.click('[data-view="drive"]');
  await page.evaluate(() => window.scrollTo(0, 0));
  // プレビューはキャンバスなので DOM から位置が取れない。描いた文字の位置を 1 フレーム単位で記録する
  await page.evaluate(() => {
    window.__frameNo = 0;
    window.__frame = [];
    const P = CanvasRenderingContext2D.prototype;
    const fill = P.fillText;
    const clear = P.clearRect;
    P.clearRect = function (...a) {
      if (this.canvas.id === 'preview') {
        window.__frameNo++;
        window.__frame = [];
      }
      return clear.apply(this, a);
    };
    P.fillText = function (t, x, y, ...rest) {
      if (this.canvas.id === 'preview') {
        window.__frame.push({ t: String(t), x, y, w: this.measureText(t).width, font: this.font });
      }
      return fill.call(this, t, x, y, ...rest);
    };
  });
  await page.click('#btn-demo');

  const waitFor = async (fn, timeout) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      if (await page.evaluate(fn)) return true;
      await sleep(150);
    }
    return false;
  };

  // コーナーの手前 60〜160m で「減速が必要」（橙か赤）になった瞬間を撮る
  await waitFor(() => {
    const t = document.querySelector('#next-dist').textContent;
    const d = parseFloat(t);
    const st = document.querySelector('#card-next').className;
    return t.includes('m 先') && d >= 60 && d <= 160 && /state-(slow|danger)/.test(st) && !!document.querySelector('#next-eta').textContent;
  }, 60000);

  // 4. 次のコーナーのカード
  console.log('4. 次のコーナー');
  const nextCard = await elementShot(page, '#card-next');
  const cardState = await page.$eval('#card-next', (e) => e.className);
  const cardBox = (sels) =>
    page.evaluate((ss) => {
      const c = document.querySelector('#card-next').getBoundingClientRect();
      const rs = ss.map((s) => document.querySelector(s).getBoundingClientRect()).filter((r) => r.width > 0);
      const x0 = Math.min(...rs.map((r) => r.x));
      const y0 = Math.min(...rs.map((r) => r.y));
      const x1 = Math.max(...rs.map((r) => r.right));
      const y1 = Math.max(...rs.map((r) => r.bottom));
      return { x: x0 - c.x, y: y0 - c.y, w: x1 - x0, h: y1 - y0 };
    }, sels);
  const card = numbered([
    { box: await cardBox(['#next-dir', '#next-class']), at: 'left', title: '向き・きつさ', desc: 'ヘアピン（R30 未満）／きつい（〜60）／ややきつい（〜120）／ゆるい（〜250）／ごくゆるい' },
    { box: await cardBox(['#next-dist', '#next-eta']), at: 'left', title: '入口までの距離と秒数', desc: '今の速度のまま走ったら何秒で入口に着くか' },
    { box: await cardBox(['#card-next .curve-r', '#next-elev']), at: 'left', title: 'R・標高・勾配', desc: '入口と出口の標高差から上り・下りを判定。下りは早めの減速が必要' },
    { box: await cardBox(['#next-rec', '#next-lim']), at: 'right', title: '安全上限 ／ 理論限界', desc: '安全上限は限界の横G の半分（設定で変更可）。理論限界は理想条件の値' },
    { box: await cardBox(['#next-delta']), at: 'right', title: '必要な減速', desc: '安全上限より何 km/h 速いか（遅ければ「余裕」）' },
    { box: await cardBox(['#card-next .approach']), at: 'left', title: '接近バー', desc: '入口に近づくほど伸びる' },
    { box: (await page.$eval('#next-then', (e) => !!e.textContent)) ? await cardBox(['#next-then']) : null, at: 'left', title: 'その次のコーナー', desc: '連続するカーブの心づもりに' },
  ]);

  // 5. 道路形状（同じ瞬間）。撮影と文字位置の記録が同じフレームになるまで撮り直す
  console.log('5. 道路形状');
  let preview = null;
  let texts = [];
  for (let i = 0; i < 6; i++) {
    const n1 = await page.evaluate(() => window.__frameNo);
    preview = await elementShot(page, '#preview');
    const r = await page.evaluate(() => ({ n: window.__frameNo, t: window.__frame }));
    if (r.n === n1) {
      texts = r.t;
      break;
    }
  }
  const pv = await boxOf(page, '#preview');
  const find = (re, test = () => true) => texts.find((t) => re.test(t.t) && test(t));
  const nextLabel = find(/^(左|右) .+ R\d+$/);
  const entryLabel = find(/^\d+m$/, (t) => t.font.includes('bold'));
  const otherLabel = find(/^R\d+/, (t) => !t.font.includes('bold') && t.x > 0 && t.y > 12);
  const shapeEntries = [
    { fig: 'shape', box: nextLabel && { x: nextLabel.x - 8, y: nextLabel.y - 18, w: nextLabel.w + 16, h: 42 }, at: 'tl', title: '次のコーナー', desc: '太い帯と吹き出しで、向き・きつさ・R・安全上限を表示' },
    { fig: 'shape', box: entryLabel && { x: entryLabel.x - 2, y: entryLabel.y - 13, w: entryLabel.w + 4, h: 17 }, at: 'right', title: '入口の線と距離', desc: '白い線がコーナーの入口' },
    { fig: 'shape', box: otherLabel && { x: otherLabel.x - 2, y: otherLabel.y - 13, w: otherLabel.w + 4, h: 17 }, at: 'right', title: 'ほかのカーブ', desc: '小さな灰色の文字で R と勾配' },
    { fig: 'shape', box: { x: pv.w / 2 - 12, y: pv.h * 0.86 - 16, w: 24, h: 28 }, at: 'right', title: '自車', desc: '今いる位置。道の色は、今の速度のままだと危ない所ほど赤い' },
  ];

  // 3. 走行画面の全体。警告が出ている瞬間を待つ
  console.log('3. 走行画面');
  await waitFor(() => !document.querySelector('#alert').hidden, 40000);
  await page.evaluate(() => window.scrollTo(0, 0));
  // 画面の高さを中身に合わせ、下の余白を詰める
  const contentH = await page.evaluate(() => Math.ceil(document.querySelector('.attribution').getBoundingClientRect().bottom + 16 + 60));
  await page.setViewportSize({ width: 390, height: contentH });
  await sleep(250);
  const drive = await viewportShot(page);
  const alertVisible = await page.$eval('#alert', (e) => !e.hidden);
  const dr = numbered([
    { box: await boxOf(page, '.controls'), at: 'left', title: '計測開始 ／ デモ走行', desc: '実走は計測開始。家ではデモ走行で確認' },
    { box: await boxOf(page, '.speed-block'), at: 'left', title: '速度・横G・走っている道路', desc: '横G は今どれだけ横に踏ん張っているか' },
    { box: alertVisible ? await boxOf(page, '#alert') : null, at: 'left', title: '警告', desc: '減速が必要なとき、何 m で何 km/h まで落とすかを表示（警告音も鳴らせる）' },
    { box: await boxOf(page, '#card-next'), at: 'tl', title: '次のコーナー', desc: '向き・きつさ・距離・上限速度（詳しくは次の画像）' },
    { box: await boxOf(page, '#card-now'), at: 'tl', title: '現在のカーブ', desc: 'センサーで測った今の R と勾配、その R の上限速度' },
    { box: await boxOf(page, '.panel-switch'), at: 'left', title: '表示の切り替え', desc: '道路形状と地図・現在地を切り替え' },
    { box: await boxOf(page, '#preview'), at: 'tl', title: '前方の道路形状', desc: '進行方向が上。今の速度で危ない所ほど赤くなる' },
    { box: await boxOf(page, '#surface-chips'), at: 'left', title: '路面状態', desc: '雨・雪のときは停車中に切り替え。上限速度が下がる' },
    { box: await boxOf(page, '.status-bar'), at: 'left', title: '状態表示', desc: 'GPS の精度・地図データ・R の測り方・標高データ' },
  ]);

  // 5. 地図
  console.log('5. 地図');
  await page.setViewportSize({ width: 390, height: 1450 });
  await page.click('[data-panel="map"]');
  await sleep(6000);
  const map = await elementShot(page, '.panel-box');
  const mrel = (sel) => boxOf(page, sel, '.panel-box');
  const sm = numbered([
    ...shapeEntries,
    { fig: 'map', box: await mrel('.car-icon'), at: 'left', title: '現在地', desc: '矢印が進行方向。灰色の線は走ってきた軌跡' },
    { fig: 'map', box: await mrel('.curve-label.next span'), at: 'tl', title: '次のコーナーのラベル', desc: '入口までの距離と安全上限' },
    { fig: 'map', box: await mrel('.leaflet-control-layers'), at: 'left', title: '地図の種類', desc: '地理院地図・航空写真・OpenStreetMap' },
    { fig: 'map', box: await mrel('.map-recenter'), at: 'left', title: '現在地ボタン', desc: '指で地図を動かすと追従が止まる。押すと現在地に戻る' },
  ]);
  await page.click('#btn-demo'); // デモ停止
  await page.click('[data-panel="shape"]');

  await render(
    browser,
    pageHtml({
      step: 'STEP 2',
      title: '走行画面の見方',
      lead: 'スマホはホルダーに固定して「計測開始」。走行中は画面を操作せず、音声案内と色で状況をつかみます（画面はデモ走行中）',
      figures: [figure(drive, dr.marks, 390)],
      legend: dr.legend,
    }),
    '03-drive.png',
  );

  const stateName = cardState.includes('danger') ? '赤' : cardState.includes('slow') ? '橙' : '緑';
  const stateChips = `<div class="chips">
      <span class="chip" style="background:#2dd4bf;color:#071311">緑：安全上限以下</span>
      <span class="chip" style="background:#fb923c;color:#2a1400">橙：減速が必要</span>
      <span class="chip" style="background:#f87171;color:#2a0505">赤：強いブレーキが必要／限界超え</span></div>`;
  await render(
    browser,
    pageHtml({
      step: 'STEP 3',
      title: '次のコーナーの読み方',
      lead: `カードの枠の色が、今の速度でそのコーナーに入って大丈夫かを表します（この画面は「${stateName}」の状態）`,
      figures: [figure(nextCard, card.marks, 500)],
      legend: card.legend,
      extra: `<div class="box"><h2>枠の色</h2>${stateChips}</div>`,
    }),
    '04-next-corner.png',
  );

  await render(
    browser,
    pageHtml({
      step: 'STEP 4',
      title: '道路形状と地図',
      lead: '走行画面の下段は「道路形状」と「地図・現在地」を切り替えられます。どちらも次のコーナーだけが強調されます',
      figures: [
        figure(preview, sm.marks.filter((m) => m.fig === 'shape'), 470),
        '<p class="cap">道路形状（進行方向が上）</p>',
        figure(map, sm.marks.filter((m) => m.fig === 'map'), 470),
        '<p class="cap">地図・現在地</p>',
      ],
      legend: sm.legend,
    }),
    '05-shape-and-map.png',
  );

  // ---------- 6. 計算タブ ----------
  console.log('6. 計算');
  {
    await page.setViewportSize({ width: 390, height: 1480 });
    await page.click('[data-view="calc"]');
    await page.fill('#calc-r', '50');
    await page.fill('#calc-entry', '520');
    await page.fill('#calc-exit', '514');
    await page.fill('#calc-angle', '90');
    await page.evaluate(() => window.scrollTo(0, 0));
    await sleep(300);
    const shot = await viewportShot(page);
    const marks = [
      { n: 1, box: await boxOf(page, '#calc-r'), at: 'left' },
      { n: 2, box: await page.evaluate(() => {
        const a = document.querySelector('[data-env="surface"]').closest('.field').getBoundingClientRect();
        const b = document.querySelector('[data-env="bankPct"]').closest('.field').getBoundingClientRect();
        return { x: a.x, y: a.y, w: b.right - a.x, h: a.height };
      }), at: 'left' },
      { n: 3, box: await page.evaluate(() => {
        const a = document.querySelector('#calc-entry').closest('.field').getBoundingClientRect();
        const b = document.querySelector('#calc-grade').getBoundingClientRect();
        const c = document.querySelector('#calc-exit').closest('.field').getBoundingClientRect();
        return { x: a.x, y: a.y, w: c.right - a.x, h: b.bottom - a.y };
      }), at: 'left' },
      { n: 4, box: await page.evaluate(() => {
        const r = document.querySelector('[data-env="safety"]').closest('.field').getBoundingClientRect();
        return { x: r.x, y: r.y, w: r.width, h: r.height };
      }), at: 'left' },
      { n: 5, box: await boxOf(page, '.result-main'), at: 'left' },
      { n: 6, box: await boxOf(page, '#res-detail'), at: 'left' },
      { n: 7, box: await page.evaluate(() => {
        const r = document.querySelector('.speed-table').closest('.card').getBoundingClientRect();
        return { x: r.x, y: r.y, w: r.width, h: Math.min(r.height, window.innerHeight - r.y - 70) };
      }), at: 'tl' },
    ];
    await render(
      browser,
      pageHtml({
        step: 'STEP 5',
        title: '計算タブで調べる',
        lead: '走る前に、気になるカーブの上限速度を机上で調べられます（例：R50・90°・入口 520m → 出口 514m の下り）',
        figures: [figure(shot, marks, 390)],
        legend: [
          [1, 'カーブ半径 R', '数値を入れるか、R15〜R500 のボタンで選ぶ'],
          [2, '路面・片勾配', '路面は雨や雪で切り替え。片勾配はカーブ内側への傾き（%）'],
          [3, '入口・出口の標高と角度', '上り・下りを考慮。標高差とカーブの長さから勾配を出す'],
          [4, '安全係数', '安全上限を限界の横G の何割にするか（初期値 50%）'],
          [5, '安全上限 ／ 理論限界', 'この 2 つが答え'],
          [6, '詳しい内訳', '限界を決める要因（アンダー・オーバー等）、転覆限界、道路の設計速度など'],
          [7, '半径別の速度表', 'R ごとの上限速度の一覧'],
        ],
      }),
      '06-calc.png',
    );
  }

  // ---------- 7. 走行時の設定と注意 ----------
  console.log('7. 走行時の設定');
  {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.click('[data-view="vehicle"]');
    await page.check('[data-pref="voice"]');
    await sleep(200);
    const sel = '[data-pref="voice"]';
    await page.$eval(sel, (e) => e.closest('.card').setAttribute('id', '__prefs'));
    const shot = await elementShot(page, '#__prefs');
    const row = (k) => page.evaluate((key) => {
      const c = document.querySelector('#__prefs').getBoundingClientRect();
      const r = document.querySelector(`[data-pref="${key}"]`).closest('.field').getBoundingClientRect();
      return { x: r.x - c.x, y: r.y - c.y, w: r.width, h: r.height };
    }, k);
    const marks = [
      { n: 1, box: await row('sound'), at: 'left' },
      { n: 2, box: await row('voice'), at: 'left' },
      { n: 3, box: await boxOf(page, '#btn-voice-test', '#__prefs'), at: 'right' },
      { n: 4, box: await row('gyro'), at: 'left' },
      { n: 5, box: await row('map'), at: 'left' },
      { n: 6, box: await row('elevation'), at: 'left' },
    ];
    await render(
      browser,
      pageHtml({
        step: 'STEP 6',
        title: '走行時の設定と注意',
        lead: '車両タブのいちばん下で設定します。走行中に画面を見なくて済むよう、音声案内をおすすめします',
        figures: [figure(shot, marks, 500)],
        legend: [
          [1, '警告音', '速度超過・減速が必要なときにピッと鳴る'],
          [2, '音声案内（おすすめ）', '入口の約 7 秒前に「左、きつい、アール60、100メートル先、50キロまで減速」。減速が必要なときは「減速」と警告も読む'],
          [3, '音声案内をテスト', 'Apple Music などの音楽は止まらず、読み上げの間だけ音量が下がる。音楽を流したまま押して確かめられる'],
          [4, 'ジャイロ', 'スマホを固定すると、今のカーブの R を正確に測れる'],
          [5, '地図データ', 'OpenStreetMap で前方のカーブを先読み（通信あり）'],
          [6, '標高データ', '国土地理院の標高で上り・下りを考慮（通信あり）'],
        ],
        extra: `<div class="box warn"><h2>必ず守ること</h2>
          ・運転中にスマホを見たり操作したりしない（設定は停車中か同乗者が）<br>
          ・表示はきれいな路面で一定速度のまま曲がった場合の理論値。実際の限界はもっと低い<br>
          ・法定速度・指定速度が常に優先。限界付近で公道を走らない<br>
          ・地図の形は実際の道と数 m〜十数 m ずれることがある</div>`,
      }),
      '07-settings.png',
    );
  }

  await browser.close();
  srv.close();
  console.log('完了：', path.relative(ROOT, OUT));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
