import { chromium } from 'playwright';

const DEBUG = (process.env.DEBUG || '1') === '1'; // domyślnie włączone logowanie
const BASE = 'https://swpp2.gkpge.pl';
const LIST_URL = BASE + '/app/demand/notice/public/current/list'
  + '?demandOrganization_orgName=000000010007&demandOrganization_withSuborgs=true';

// Trello config from environment
const TRELLO_KEY        = process.env.TRELLO_KEY;
const TRELLO_TOKEN      = process.env.TRELLO_TOKEN;
const BOARD_ID          = process.env.BOARD_ID;
const LIST_RZESZOW_ID   = process.env.LIST_RZESZOW_ID;
const LIST_SKARZYSKO_ID = process.env.LIST_SKARZYSKO_ID;

// --- sanity check
for (const [k,v] of Object.entries({TRELLO_KEY,TRELLO_TOKEN,BOARD_ID,LIST_RZESZOW_ID,LIST_SKARZYSKO_ID})) {
  if (!v) { console.error('Brak zmiennej środowiskowej:', k); process.exit(1); }
}

function log(...args){ if (DEBUG) console.log(...args); }

function unwrapList(json){
  if (!json) return null;
  if (Array.isArray(json)) return json;
  return json.content || json.items || json.data || json.results || null;
}

function detectRegion(number='', title='') {
  const u = String(number).toUpperCase();
  const t = String(title).toLowerCase();
  if (u.includes('/OR/')  || t.includes('rzesz')) return 'Rzeszów';
  if (u.includes('/OSK/') || t.includes('skarż') || t.includes('skarz')) return 'Skarżysko-Kamienna';
  return '';
}

function normalizeDeadline(v) {
  if (!v) return '';
  if (/^\d{2}-\d{2}-\d{4}\s+\d{2}:\d{2}$/.test(v)) return v;
  const m = /^(\d{4})-(\d{2})-(\d{2})[T\s](\d{2}):(\d{2})/.exec(String(v));
  if (m) return `${m[3]}-${m[2]}-${m[1]} ${m[4]}:${m[5]}`;
  return String(v);
}

function uniqBy(arr, keyFn) {
  const m = new Map();
  for (const x of arr) { const k = keyFn(x); if (!m.has(k)) m.set(k, x); }
  return [...m.values()];
}

async function getSessionHeaders(context){
  const cookies = await context.cookies(BASE);
  const jar = cookies.map(c => `${c.name}=${c.value}`).join('; ');
  const xsrf = cookies.find(c => c.name === 'XSRF-TOKEN');
  const headers = {
    'accept': 'application/json, text/plain, */*',
    'content-type': 'application/json',
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36',
    'referer': LIST_URL,
    'origin': BASE,
    'cookie': jar
  };
  if (xsrf?.value) headers['x-xsrf-token'] = decodeURIComponent(xsrf.value);
  return headers;
}

async function tryFetchListDirect(context){
  const headers = await getSessionHeaders(context);
  const qs = 'demandOrganization_orgName=000000010007&demandOrganization_withSuborgs=true&page=0&size=200&sort=publicationDate,desc&onlyCurrent=true';
  const endpoints = [
    '/app/demand/notice/public/current/api/list',
    '/app/demand/notice/public/api/notices',
    '/app/demand/notice/public/notices',
    '/app/demand/notice/public/notices/search',
    '/api/public/demand/notice/search',
    '/api/demand/notice/public/search'
  ];

  const bodies = [
    { page:0, size:200, sort:['publicationDate,desc'], filters: { demandOrganization_orgName:'000000010007', demandOrganization_withSuborgs:true, onlyCurrent:true } },
    { page:0, size:200, sort:['publicationDate,desc'], demandOrganization_orgName:'000000010007', demandOrganization_withSuborgs:true, onlyCurrent:true },
    { page:0, size:200, query:'', search:'', filters:{ onlyCurrent:true, demandOrganization_orgName:'000000010007', demandOrganization_withSuborgs:true } },
    { page:0, size:200 }
  ];

  // POST warianty
  for (const ep of endpoints) {
    for (const body of bodies) {
      const url = BASE + ep;
      try {
        const res = await fetch(url, { method:'POST', headers, body: JSON.stringify(body) });
        const txt = await res.text();
        const ok = res.ok && txt.trim().startsWith('{') || txt.trim().startsWith('[');
        log('[POST]', ep, res.status, ok ? 'json' : 'not-json');
        if (!ok) continue;
        const j = JSON.parse(txt);
        const arr = unwrapList(j);
        if (arr?.length) {
          log('→ trafiony endpoint POST:', ep, 'items:', arr.length);
          return arr;
        }
      } catch (e) {
        log('[POST] err', ep, e.toString().slice(0,120));
      }
    }
  }

  // GET warianty
  for (const ep of endpoints) {
    const url = BASE + ep + (ep.includes('?') ? '&' : '?') + qs;
    try {
      const res = await fetch(url, { method:'GET', headers });
      const txt = await res.text();
      const ok = res.ok && (txt.trim().startsWith('{') || txt.trim().startsWith('['));
      log('[GET]', ep, res.status, ok ? 'json' : 'not-json');
      if (!ok) continue;
      const j = JSON.parse(txt);
      const arr = unwrapList(j);
      if (arr?.length) {
        log('→ trafiony endpoint GET:', ep, 'items:', arr.length);
        return arr;
      }
    } catch (e) {
      log('[GET] err', ep, e.toString().slice(0,120));
    }
  }

  return null;
}

async function captureListJson(page, context) {
  let got = null;
  page.on('response', async (resp) => {
    try {
      const url = resp.url();
      const ct = (resp.headers()['content-type'] || '').toLowerCase();
      if (!ct.includes('json')) return;
      if (!/\/app\/demand\/notice\/public\//.test(url) && !/\/api\//.test(url)) return;
      const json = await resp.json().catch(()=>null);
      const arr = unwrapList(json);
      if (arr?.length) {
        got = arr;
        log('[onResponse] JSON z', url, '→', arr.length);
      }
    } catch {}
  });

  log('→ Nawigacja do LIST_URL…');
  await page.goto(LIST_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle').catch(()=>{});
  // krótka pauza na XHR-y
  await page.waitForTimeout(1500);

  // Spróbuj bezpośrednich wywołań, używając nagłówków z sesji
  if (!got) {
    log('→ Próba bezpośrednich wywołań JSON (POST/GET) z nagłówkami sesji)…');
    got = await tryFetchListDirect(context);
  }

  // Ostatnia próba: fetch w kontekście strony
  if (!got) {
    log('→ Fallback: fetch() wewnątrz strony z XSRF/cookie…');
    got = await page.evaluate(async () => {
      function unwrap(j){ if (!j) return null; if (Array.isArray(j)) return j; return j.content || j.items || j.data || j.results || null; }
      const qs = '?demandOrganization_orgName=000000010007&demandOrganization_withSuborgs=true&page=0&size=200&sort=publicationDate,desc&onlyCurrent=true';
      const endpoints = [
        '/app/demand/notice/public/current/api/list',
        '/app/demand/notice/public/api/notices',
        '/app/demand/notice/public/notices',
        '/app/demand/notice/public/notices/search'
      ];
      const xsrf = decodeURIComponent((document.cookie.split('; ').find(s=>s.startsWith('XSRF-TOKEN='))||'').split('=')[1]||'');
      const headers = xsrf ? { 'content-type': 'application/json', 'x-xsrf-token': xsrf } : { 'content-type': 'application/json' };
      const bodies = [
        { page:0, size:200, sort:['publicationDate,desc'], filters: { demandOrganization_orgName:'000000010007', demandOrganization_withSuborgs:true, onlyCurrent:true } },
        { page:0, size:200, sort:['publicationDate,desc'], demandOrganization_orgName:'000000010007', demandOrganization_withSuborgs:true, onlyCurrent:true },
        { page:0, size:200, query:'', search:'', filters:{ onlyCurrent:true, demandOrganization_orgName:'000000010007', demandOrganization_withSuborgs:true } }
      ];
      for (const ep of endpoints) {
        for (const b of bodies) {
          try {
            const r = await fetch(ep, { method:'POST', headers, body: JSON.stringify(b), credentials:'same-origin' });
            if (r.ok) {
              const j = await r.json().catch(()=>null);
              const arr = unwrap(j);
              if (arr?.length) return arr;
            }
          } catch {}
        }
      }
      for (const ep of endpoints) {
        try {
          const r = await fetch(ep + qs, { method:'GET', credentials:'same-origin', headers: { 'accept':'application/json' } });
          if (r.ok) {
            const j = await r.json().catch(()=>null);
            const arr = unwrap(j);
            if (arr?.length) return arr;
          }
        } catch {}
      }
      return null;
    });
  }

  return got || [];
}

async function trelloGetExistingNumbers() {
  const url = `https://api.trello.com/1/boards/${BOARD_ID}/cards?fields=name&key=${TRELLO_KEY}&token=${TRELLO_TOKEN}`;
  const res = await fetch(url);
  const cards = await res.json();
  const set = new Set();
  for (const c of cards) {
    const m = /(POST\/[A-Z0-9/.\-]+\/\d{4})/i.exec((c.name || '').toUpperCase());
    if (m) set.add(m[1]);
  }
  return set;
}

async function trelloCreateCard(t) {
  const listId = t.region === 'Rzeszów' ? LIST_RZESZOW_ID : LIST_SKARZYSKO_ID;
  const name = `${t.number} — ${t.title || 'Bez tytułu'}`;
  const desc = `Oddział: ${t.region}\nTermin składania: ${normalizeDeadline(t.deadline) || 'brak danych'}\n\nLink: ${t.url}`;
  const params = new URLSearchParams({ idList: listId, name, desc, key: TRELLO_KEY, token: TRELLO_TOKEN });
  const res = await fetch('https://api.trello.com/1/cards', { method: 'POST', body: params });
  const j = await res.json();
  if (j && j.id && t.url) {
    const p2 = new URLSearchParams({ url: t.url, key: TRELLO_KEY, token: TRELLO_TOKEN });
    await fetch(`https://api.trello.com/1/cards/${j.id}/attachments`, { method: 'POST', body: p2 });
  }
  return j && j.id;
}

async function main() {
  console.log('▶︎ Runner start (Playwright v3)…');
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36',
    viewport: { width: 1366, height: 900 }
  });
  const page = await context.newPage();

  const items = await captureListJson(page, context);
  await browser.close();

  if (!items.length) {
    console.log('⛔ Nie przechwycono JSON-a listy – możliwa zmiana endpointu po stronie PGE.');
    console.log('   Włącz DEBUG=1 dla rozszerzonych logów (Actions → Run workflow → Variables).');
    process.exit(0);
  }

  const sample = items.slice(0, 3).map(it => ({
    id: it.id || it.noticeId || it.noticeID || it.demandNoticeId || it.demandId,
    number: it.noticeNumber || it.number || it.code,
    title: it.title || it.subject || it.name
  }));
  log('[sample]', sample);

  const tenders = items.map(it => {
    const id = it.id || it.noticeId || it.noticeID || it.demandNoticeId || it.demandId;
    const number = String(it.noticeNumber || it.number || it.code || '').trim();
    const title  = String(it.title || it.subject || it.name || '').trim();
    const deadline = it.submissionDeadline || it.offerSubmissionDeadline || it.deadline || it.offersSubmissionDate || '';
    const region = detectRegion(number, title);
    const url = id ? `${BASE}/app/demand/notice/public/${id}/details` : LIST_URL;
    return { id, number, title, deadline, region, url };
  }).filter(t => t.number && t.region);

  console.log(`✅ Pobrano ${tenders.length} rekordów (po filtrowaniu OR/OSK).`);

  const existing = await trelloGetExistingNumbers();
  const fresh = tenders.filter(t => !existing.has(t.number.toUpperCase()));

  console.log(`🆕 Do utworzenia: ${fresh.length}`);

  for (const t of fresh) {
    try {
      await trelloCreateCard(t);
      console.log('➕ Dodano:', t.number);
      await new Promise(r => setTimeout(r, 400));
    } catch (e) {
      console.error('Błąd dodawania', t.number, e);
    }
  }
  console.log('🏁 Zakończono.');
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
