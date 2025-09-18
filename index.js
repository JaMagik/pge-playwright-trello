import { chromium } from 'playwright';

const DEBUG = process.env.DEBUG?.toString() === '1';
const BASE = 'https://swpp2.gkpge.pl';
const LIST_URL = BASE + '/app/demand/notice/public/current/list'
  + '?demandOrganization_orgName=000000010007&demandOrganization_withSuborgs=true';

// Trello config from environment
const TRELLO_KEY        = process.env.TRELLO_KEY;
const TRELLO_TOKEN      = process.env.TRELLO_TOKEN;
const BOARD_ID          = process.env.BOARD_ID;
const LIST_RZESZOW_ID   = process.env.LIST_RZESZOW_ID;
const LIST_SKARZYSKO_ID = process.env.LIST_SKARZYSKO_ID;

for (const [k,v] of Object.entries({TRELLO_KEY,TRELLO_TOKEN,BOARD_ID,LIST_RZESZOW_ID,LIST_SKARZYSKO_ID})) {
  if (!v) { console.error('Brak zmiennej środowiskowej:', k); process.exit(1); }
}

const RESP_PATTERNS = [
  /\/app\/demand\/notice\/public\/current\/api\/list/i,
  /\/app\/demand\/notice\/public\/api\/notices/i,
  /\/app\/demand\/notice\/public\/notices/i,
  /\/api\/public\/demand\/notice\/search/i,
  /\/api\/demand\/notice\/public\/search/i,
  /\/api\/.*notice/i
];

function isJsonContent(resp) {
  const ct = (resp.headers()['content-type'] || '').toLowerCase();
  return ct.includes('application/json') || ct.includes('json');
}
function urlLooksLikeList(u='') {
  return RESP_PATTERNS.some(r => r.test(u));
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

async function captureListJson(page) {
  let got = null;
  const seen = new Set();

  page.on('response', async (resp) => {
    try {
      const url = resp.url();
      if (seen.has(url)) return;
      if (!urlLooksLikeList(url)) return;
      if (!isJsonContent(resp)) return;
      const json = await resp.json().catch(()=>null);
      if (!json) return;
      const arr = Array.isArray(json) ? json : (json.content || json.items || json.data || json.results || []);
      if (Array.isArray(arr) && arr.length) {
        got = arr;
        seen.add(url);
        if (DEBUG) console.log('[capture:onResponse] JSON z', url, '→', arr.length);
      }
    } catch (e) {}
  });

  await page.goto(LIST_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle').catch(()=>{});

  // 1) Spróbuj poczekać aż pojawi się któryś z JSON‑ów
  const resp = await page.waitForResponse(r => urlLooksLikeList(r.url()) && isJsonContent(r), { timeout: 15000 }).catch(() => null);
  if (resp) {
    try {
      const j = await resp.json();
      const arr = Array.isArray(j) ? j : (j.content || j.items || j.data || j.results || []);
      if (Array.isArray(arr) && arr.length) {
        got = arr;
        if (DEBUG) console.log('[capture:waitForResponse] JSON z', resp.url(), '→', arr.length);
      }
    } catch {}
  }

  // 2) Fallback: zrób fetch z wnętrza strony (ma ciasteczka + XSRF)
  if (!got) {
    if (DEBUG) console.log('[capture:fallback] Próbuję fetch w kontekście strony (POST i GET, różne endpoints)…');
    got = await page.evaluate(async () => {
      function unwrap(j){
        if (!j) return null;
        if (Array.isArray(j)) return j;
        return j.content || j.items || j.data || j.results || null;
      }
      const qs = '?demandOrganization_orgName=000000010007&demandOrganization_withSuborgs=true&page=0&size=200&sort=publicationDate,desc&onlyCurrent=true';
      const endpoints = [
        '/app/demand/notice/public/current/api/list',
        '/app/demand/notice/public/api/notices',
        '/app/demand/notice/public/notices',
        '/api/public/demand/notice/search'
      ];
      const xsrf = decodeURIComponent((document.cookie.split('; ').find(s=>s.startsWith('XSRF-TOKEN='))||'').split('=')[1]||'');
      const headers = xsrf ? { 'content-type': 'application/json', 'x-xsrf-token': xsrf } : { 'content-type': 'application/json' };
      const bodies = [
        { page:0, size:200, sort:['publicationDate,desc'], filters: { demandOrganization_orgName:'000000010007', demandOrganization_withSuborgs:true, onlyCurrent:true } },
        { page:0, size:200, sort:['publicationDate,desc'], demandOrganization_orgName:'000000010007', demandOrganization_withSuborgs:true, onlyCurrent:true },
        { page:0, size:200, query:'', search:'', filters:{ onlyCurrent:true, demandOrganization_orgName:'000000010007', demandOrganization_withSuborgs:true } }
      ];
      // POST warianty
      for (const ep of endpoints) {
        for (const b of bodies) {
          try {
            const r = await fetch(ep, { method:'POST', headers, body: JSON.stringify(b), credentials:'same-origin' });
            if (r.ok) {
              const j = await r.json().catch(()=>null);
              const arr = unwrap(j);
              if (arr && arr.length) return arr;
            }
          } catch {}
        }
      }
      // GET warianty
      for (const ep of endpoints) {
        try {
          const r = await fetch(ep + qs, { method:'GET', credentials:'same-origin', headers: { 'accept':'application/json' } });
          if (r.ok) {
            const j = await r.json().catch(()=>null);
            const arr = unwrap(j);
            if (arr && arr.length) return arr;
          }
        } catch {}
      }
      return null;
    });
  }

  if (!got) return [];
  // Usuń duplikaty i zwróć
  return uniqBy(got, it => String(it.id || it.noticeId || it.noticeID || it.demandNoticeId || it.demandId || '') + '|' + String(it.noticeNumber || it.number || it.code || ''));
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
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36',
    viewport: { width: 1366, height: 900 }
  });
  const page = await context.newPage();

  const items = await captureListJson(page);
  await browser.close();

  if (!items.length) {
    console.log('Nie przechwycono JSON-a listy – dodaję tryb rozszerzony logowania (włącz DEBUG=1).');
    process.exit(0);
  }

  if (DEBUG) {
    const sample = items.slice(0, 3).map(it => ({
      id: it.id || it.noticeId || it.noticeID || it.demandNoticeId || it.demandId,
      number: it.noticeNumber || it.number || it.code,
      title: it.title || it.subject || it.name
    }));
    console.log('[debug] Próbka JSON:', sample);
  }

  const tenders = items.map(it => {
    const id = it.id || it.noticeId || it.noticeID || it.demandNoticeId || it.demandId;
    const number = String(it.noticeNumber || it.number || it.code || '').trim();
    const title  = String(it.title || it.subject || it.name || '').trim();
    const deadline = it.submissionDeadline || it.offerSubmissionDeadline || it.deadline || it.offersSubmissionDate || '';
    const region = detectRegion(number, title);
    const url = id ? `${BASE}/app/demand/notice/public/${id}/details` : LIST_URL;
    return { id, number, title, deadline, region, url };
  }).filter(t => t.number && t.region);

  console.log(`Pobrano ${tenders.length} rekordów (po filtrowaniu OR/OSK).`);

  const existing = await trelloGetExistingNumbers();
  const fresh = tenders.filter(t => !existing.has(t.number.toUpperCase()));

  console.log(`Do utworzenia: ${fresh.length}`);

  for (const t of fresh) {
    try {
      await trelloCreateCard(t);
      console.log('Dodano:', t.number);
      await new Promise(r => setTimeout(r, 400));
    } catch (e) {
      console.error('Błąd dodawania', t.number, e);
    }
  }
}

main().catch(err => { console.error(err); process.exit(1); });
