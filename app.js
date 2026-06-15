// Copymagna — fully client-side reader. No backend: the iPad fetches mangacopy directly
// (CORS is open) and decrypts the web-reader payload in-browser with Web Crypto.
// Requires the iPad to be on a network/proxy where mangacopy reads (e.g. Hong Kong).

// ---------------- config ----------------
const API = 'https://api.manga2026.xyz/api/v3';     // 热辣漫画 search/browse
const SITE = 'https://www.manga2026.xyz';            // 热辣漫画 reading
let CCT = 'op0zzpvv.nmn.00p';                      // AES key (site's `var cct`; refreshed from reader pages)
const APP_HEADERS = { version: '3.0.0', platform: '3', source: 'copyApp', webp: '1', region: '1' };

// ---------------- AES-CBC decrypt (Web Crypto) ----------------
// payload = 16-char IV (utf8) + hex ciphertext; key = cct (utf8, 16 bytes); PKCS7 auto-stripped.
async function aesDecrypt(payload, keyStr = CCT) {
  const enc = new TextEncoder();
  const iv = enc.encode(payload.slice(0, 16));
  const hex = payload.slice(16);
  const ct = new Uint8Array(hex.match(/.{1,2}/g).map(h => parseInt(h, 16)));
  const key = await crypto.subtle.importKey('raw', enc.encode(keyStr), { name: 'AES-CBC' }, false, ['decrypt']);
  const pt = await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, key, ct);
  return new TextDecoder().decode(pt);
}

// ---------------- data layer ----------------
const metaCache = {};   // path_word -> {name, cover, author}
const comicCache = {};  // path_word -> groups map

async function jget(url, headers) {
  const r = await fetch(url, { headers });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

async function search(q, offset = 0) {
  const d = await jget(`${API}/search/comic?q=${encodeURIComponent(q)}&limit=21&offset=${offset}&platform=3`, APP_HEADERS);
  return (d.results?.list || []).map(slim);
}
async function browse(ordering = '-popular', offset = 0) {
  const d = await jget(`${API}/comics?limit=21&offset=${offset}&ordering=${encodeURIComponent(ordering)}&platform=3`, APP_HEADERS);
  return (d.results?.list || []).map(slim);
}
function slim(c) {
  const m = { path_word: c.path_word, name: c.name, cover: c.cover, author: (c.author || []).map(a => a.name) };
  metaCache[c.path_word] = m;
  return m;
}

// IMPORTANT: be a polite single-request client, exactly like the browser. The site rate-limits the
// IP aggressively — bursts/retries get the whole IP (and all devices on it) temporarily blocked.
// So: ONE plain request per action. No retry, no credentials, no custom headers (avoids CORS preflight).
const siteFetch = (url) => fetch(url);

// One request → all groups + their chapters (decrypted).
async function getComic(pw) {
  if (comicCache[pw]) return comicCache[pw];
  const groups = {};
  let total = 0;
  try {
    const d = await siteFetch(`${SITE}/comicdetail/${pw}/chapters`).then(r => r.json());
    if (d.results) {
      const j = JSON.parse(await aesDecrypt(d.results));
      const groupsRaw = j.build?.groups || j.groups || {};
      for (const [k, g] of Object.entries(groupsRaw)) {
        const chapters = (g.chapters || []).map(c => ({
          uuid: c.uuid || c.id || c.chapter_id || c.comic_chapter_id,
          name: c.name || c.title || c.tname || '',
          index: c.index ?? c.idx ?? 0,
        })).filter(c => c.uuid);
        groups[g.path_word || k] = { path_word: g.path_word || k, name: g.name || k, count: g.count ?? chapters.length, chapters };
        total += chapters.length;
      }
    }
  } catch { /* return empty; user can refresh */ }
  if (total > 0) comicCache[pw] = groups;  // cache only when populated, so a refresh can retry
  return groups;
}

// One request → reader page → decrypt the embedded contentKey → ordered image URLs.
async function getImages(pw, uuid) {
  try {
    const html = await siteFetch(`${SITE}/comic/${pw}/chapter/${uuid}`).then(r => r.text());
    const cct = (html.match(/var cct\s*=\s*'([^']*)'/) || [])[1];
    if (cct) CCT = cct;
    const ck = (html.match(/var contentKey\s*=\s*'([^']*)'/) || [])[1] || '';
    if (ck) {
      const arr = JSON.parse(await aesDecrypt(ck, cct || CCT));
      return arr.map(x => x.url).filter(Boolean);
    }
  } catch { /* return empty; user can refresh */ }
  return [];
}

// ---------------- DOM helpers ----------------
const $ = (s, r = document) => r.querySelector(s);
const el = (tag, props = {}, kids = []) => { const n = Object.assign(document.createElement(tag), props); for (const k of [].concat(kids)) n.append(k); return n; };

const view = $('#view'), backBtn = $('#backBtn'), dlBtn = $('#dlBtn');
const searchForm = $('#searchForm'), searchInput = $('#searchInput');
const readerEl = $('#reader'), pageImg = $('#page'), readerTitle = $('#readerTitle'), pageInd = $('#pageInd');
const dlChip = $('#dlChip'), spinner = $('#spinner');

// ---------------- progress (localStorage) ----------------
const LS = 'copymagna.v1';
const load = () => { try { return JSON.parse(localStorage.getItem(LS) || '{}'); } catch { return {}; } };
const save = (p) => localStorage.setItem(LS, JSON.stringify(p));
let store = load();
const cs = (pw) => (store[pw] ||= { read: {}, downloaded: {} });

// ---------------- nav ----------------
let homeCtx = { mode: 'browse', ordering: '-popular', q: '' };
let currentPw = null;
const setBack = (s) => { backBtn.hidden = !s; };
backBtn.onclick = () => { if (currentPw) showHome(); };

// ================= HOME =================
async function showHome(keepInput = false) {
  currentPw = null; setBack(false); closeReader();
  if (!keepInput) searchInput.value = homeCtx.q;
  view.innerHTML = '';
  const tabs = el('div', { className: 'tabs' });
  for (const [ord, label] of [['-popular', '熱門'], ['-datetime_updated', '最近更新'], ['-datetime_created', '最新上架']]) {
    const b = el('button', { className: 'tab' + (homeCtx.mode === 'browse' && homeCtx.ordering === ord ? ' active' : ''), textContent: label });
    b.onclick = () => { homeCtx = { mode: 'browse', ordering: ord, q: '' }; searchInput.value = ''; showHome(); };
    tabs.append(b);
  }
  view.append(tabs, el('div', { className: 'loading', textContent: '載入中…' }));
  try {
    const list = homeCtx.mode === 'search' ? await search(homeCtx.q) : await browse(homeCtx.ordering);
    view.lastChild.remove();
    if (!list.length) return void view.append(el('div', { className: 'empty', textContent: '沒有結果' }));
    const grid = el('div', { className: 'grid' });
    for (const c of list) grid.append(card(c));
    view.append(grid);
  } catch (e) { view.lastChild.remove(); view.append(errBox(e)); }
}
function card(c) {
  const n = el('div', { className: 'card' }, [
    el('img', { className: 'cover', src: c.cover, loading: 'lazy', alt: c.name }),
    el('div', { className: 't', textContent: c.name }),
    el('div', { className: 'a', textContent: (c.author || []).join(', ') }),
  ]);
  n.onclick = () => showDetail(c.path_word);
  return n;
}
searchForm.onsubmit = (e) => {
  e.preventDefault();
  const q = searchInput.value.trim(); if (!q) return;
  homeCtx = { mode: 'search', ordering: '-popular', q }; searchInput.blur(); showHome(true);
};

// ================= DETAIL =================
let detailReverse = false;
async function showDetail(pw, group) {
  currentPw = pw; setBack(true); closeReader();
  view.innerHTML = ''; view.append(el('div', { className: 'loading', textContent: '載入中…' }));
  try {
    const groups = await getComic(pw);
    const keys = Object.keys(groups);
    let active = group && groups[group] ? group : (groups.default && groups.default.chapters.length ? 'default' : (keys.find(k => groups[k].chapters.length) || keys[0]));
    const g = groups[active] || { chapters: [] };
    const meta = metaCache[pw] || { name: pw, cover: '', author: [] };
    const st = cs(pw);
    view.innerHTML = '';
    view.append(el('div', { className: 'detail-head' }, [
      el('img', { className: 'cover', src: meta.cover, alt: meta.name }),
      el('div', {}, [el('h1', { textContent: meta.name }), el('div', { className: 'meta', textContent: (meta.author || []).join(', ') })]),
    ]));
    if (st.chapterUuid && st.group === active && g.chapters.some(c => c.uuid === st.chapterUuid)) {
      const r = el('button', { className: 'resume', textContent: `繼續閱讀：${st.chapterName || ''}` });
      r.onclick = () => openReader(pw, st.chapterUuid, st.page || 0, false, active);
      view.append(r);
    }
    if (keys.length > 1) {
      const gt = el('div', { className: 'tabs' });
      for (const k of keys) {
        const t = el('button', { className: 'tab' + (k === active ? ' active' : ''), textContent: `${groups[k].name}${groups[k].count ? ' ' + groups[k].count : ''}` });
        t.onclick = () => showDetail(pw, k); gt.append(t);
      }
      view.append(gt);
    }
    const head = el('div', { className: 'tabs' });
    const rev = el('button', { className: 'tab', textContent: detailReverse ? '倒序 ▼' : '正序 ▲' });
    rev.onclick = () => { detailReverse = !detailReverse; showDetail(pw, active); };
    head.append(el('div', { className: 'section-title', textContent: `共 ${g.chapters.length} 話` }), rev);
    view.append(head);
    if (g.chapters.length === 0) {
      const box = el('div', { className: 'empty' });
      box.append(el('div', { textContent: '暫無章節（站點此刻無響應,請過一會兒再點「重試」,別連續猛點）' }));
      const retry = el('button', { className: 'btn', textContent: '重試（發 1 次請求）', style: 'margin-top:12px' });
      retry.onclick = () => { delete comicCache[pw]; showDetail(pw); };  // single fresh request
      box.append(retry);
      view.append(box);
    }
    const ordered = detailReverse ? g.chapters.slice().reverse() : g.chapters;
    const grid = el('div', { className: 'ch-grid' });
    for (const c of ordered) {
      const b = el('button', { className: 'ch' + (st.read[c.uuid] ? ' read' : '') + (st.chapterUuid === c.uuid ? ' current' : '') });
      b.append(c.name);
      if (st.downloaded[c.uuid]) b.append(el('span', { className: 'dot', textContent: '●' }));
      b.onclick = () => openReader(pw, c.uuid, 0, false, active);
      grid.append(b);
    }
    view.append(grid);
  } catch (e) { view.innerHTML = ''; view.append(errBox(e)); }
}

// ================= READER =================
const R = { pw: null, group: 'default', chs: [], idx: -1, uuid: null, name: '', images: [], page: 0, busy: false };
const showReader = () => { readerEl.hidden = false; document.body.style.overflow = 'hidden'; };
function closeReader() { if (readerEl.hidden) return; readerEl.hidden = true; readerEl.classList.remove('ui-on'); document.body.style.overflow = ''; pageImg.removeAttribute('src'); }

async function openReader(pw, uuid, startPage = 0, startAtEnd = false, group = 'default') {
  showReader(); spinner.hidden = false; readerEl.classList.remove('ui-on');
  R.pw = pw; R.group = group; R.busy = true;
  try {
    const groups = await getComic(pw);
    R.chs = (groups[group] || groups.default || Object.values(groups)[0] || { chapters: [] }).chapters;
    R.idx = R.chs.findIndex(c => c.uuid === uuid);
    R.images = await getImages(pw, uuid);
    R.uuid = uuid; R.name = R.chs[R.idx]?.name || '';
    R.page = startAtEnd ? Math.max(0, R.images.length - 1) : Math.min(startPage, Math.max(0, R.images.length - 1));
    readerTitle.textContent = R.name; spinner.hidden = true;
    if (!R.images.length) { readerTitle.textContent = '本話無圖片（地區限制？確認 iPad 已掛香港代理）'; readerEl.classList.add('ui-on'); return; }
    renderPage(); persist(); downloadChapter(pw, uuid, R.images);
  } catch (e) { spinner.hidden = true; readerTitle.textContent = '載入失敗：' + e.message; readerEl.classList.add('ui-on'); }
  finally { R.busy = false; }
}
function renderPage() {
  const url = R.images[R.page]; if (!url) return;
  pageImg.src = url; pageInd.textContent = `${R.page + 1} / ${R.images.length}`;
  for (const i of [R.page + 1, R.page + 2, R.page - 1]) if (R.images[i]) { const im = new Image(); im.src = R.images[i]; }
  if (R.page >= R.images.length - 1) markRead(R.pw, R.uuid);
  persist();
}
function persist() { const st = cs(R.pw); st.chapterUuid = R.uuid; st.chapterName = R.name; st.page = R.page; st.group = R.group; save(store); }
const markRead = (pw, uuid) => { cs(pw).read[uuid] = true; save(store); };

async function nextPage() { if (R.busy) return; if (R.page < R.images.length - 1) { R.page++; renderPage(); } else await gotoChapter(R.idx + 1, false); }
async function prevPage() { if (R.busy) return; if (R.page > 0) { R.page--; renderPage(); } else await gotoChapter(R.idx - 1, true); }
async function gotoChapter(idx, atEnd) { const ch = R.chs[idx]; if (!ch) return flash(atEnd ? '已是第一話' : '已是最後一話'); await openReader(R.pw, ch.uuid, 0, atEnd, R.group); }
function flash(m) { dlChip.hidden = false; dlChip.textContent = m; clearTimeout(flash._t); flash._t = setTimeout(() => { dlChip.hidden = true; }, 1200); }

// auto-download whole chapter (warms the service-worker image cache for offline)
let dlAbort = null;
async function downloadChapter(pw, uuid, urls) {
  if (dlAbort) dlAbort.aborted = true;
  const ac = { aborted: false }; dlAbort = ac;
  const st = cs(pw);
  if (st.downloaded[uuid]) { dlChip.hidden = true; return; }
  const total = urls.length; let ok = 0, fail = 0, i = 0;
  dlChip.hidden = false; dlChip.textContent = `下載中 0/${total}`;
  const loadOne = (u) => new Promise(res => { const im = new Image(); im.onload = () => res(true); im.onerror = () => res(false); im.src = u; });
  const worker = async () => {
    while (i < urls.length && !ac.aborted) {
      const u = urls[i++]; (await loadOne(u)) ? ok++ : fail++;
      if (uuid === R.uuid && !ac.aborted) dlChip.textContent = `下載中 ${ok + fail}/${total}`;
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
  if (ac.aborted) return;
  if (fail === 0) { st.downloaded[uuid] = true; save(store); if (uuid === R.uuid) { dlChip.textContent = `已快取 ${total} 頁 ✓`; setTimeout(() => { if (dlChip.textContent.includes('✓')) dlChip.hidden = true; }, 1500); } }
  else if (uuid === R.uuid) dlChip.textContent = `已快取 ${ok}/${total}（${fail} 失敗，重開可重試）`;
}

// reader input: tap right=next, left=prev, center=toggle; + swipe + keys
let down = null;
readerEl.addEventListener('pointerdown', (e) => { if (e.target.closest('.reader-ui')) { down = null; return; } down = { x: e.clientX, y: e.clientY, t: Date.now() }; });
readerEl.addEventListener('pointerup', (e) => {
  if (!down) return; const dx = e.clientX - down.x, dy = e.clientY - down.y, d = down; down = null;
  if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy)) return void (dx < 0 ? nextPage() : prevPage());
  if (Math.abs(dx) < 12 && Math.abs(dy) < 12 && Date.now() - d.t < 500) {
    const x = e.clientX / window.innerWidth;
    if (x > 0.65) nextPage(); else if (x < 0.35) prevPage(); else readerEl.classList.toggle('ui-on');
  }
});
$('#readerBack').onclick = () => { closeReader(); if (currentPw) showDetail(currentPw); };
$('#prevCh').onclick = () => gotoChapter(R.idx - 1, false);
$('#nextCh').onclick = () => gotoChapter(R.idx + 1, false);
window.addEventListener('keydown', (e) => {
  if (readerEl.hidden) return;
  if (e.key === 'ArrowRight' || e.key === ' ') { e.preventDefault(); nextPage(); }
  else if (e.key === 'ArrowLeft') prevPage();
  else if (e.key === 'Escape') { closeReader(); if (currentPw) showDetail(currentPw); }
});

// ================= SETTINGS =================
dlBtn.onclick = showSettings;
async function showSettings() {
  currentPw = null; setBack(true); closeReader(); searchInput.value = '';
  backBtn.onclick = () => { backBtn.onclick = () => { if (currentPw) showHome(); }; showHome(); };
  view.innerHTML = '';
  view.append(el('h1', { textContent: '設定', style: 'font-size:20px' }));
  view.append(el('div', { className: 'banner', textContent: 'iPad 需掛香港代理才能讀內容（搜尋/瀏覽不需要）。下載過的章節會離線快取在本機。' }));
  const clearHist = el('button', { className: 'btn', textContent: '清除閱讀記錄' });
  clearHist.onclick = () => { store = {}; save(store); flash('已清除'); };
  view.append(el('div', { className: 'settings-row' }, [el('span', { textContent: '閱讀進度' }), clearHist]));
  const clearCache = el('button', { className: 'btn danger', textContent: '清除離線快取' });
  clearCache.onclick = async () => { clearCache.textContent = '清除中…'; if (window.caches) for (const k of await caches.keys()) await caches.delete(k); for (const pw in store) store[pw].downloaded = {}; save(store); clearCache.textContent = '已清除'; };
  view.append(el('div', { className: 'settings-row' }, [el('span', { textContent: '離線圖片快取' }), clearCache]));
}

function errBox(e) {
  return el('div', { className: 'banner', textContent: '載入失敗：' + e.message + '（讀取內容需要 iPad 掛香港代理；搜尋/瀏覽則不需要）' });
}

// ---------------- boot ----------------
window.cm = { showHome, showDetail, openReader };
showHome();
