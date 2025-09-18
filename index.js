import { chromium } from 'playwright';

const BASE = 'https://swpp2.gkpge.pl';
const LIST_URL = BASE + '/app/demand/notice/public/current/list'
  + '?demandOrganization_orgName=000000010007&demandOrganization_withSuborgs=true';

// Trello config from environment
const TRELLO_KEY        = process.env.TRELLO_KEY;
const TRELLO_TOKEN      = process.env.TRELLO_TOKEN;
const BOARD_ID          = process.env.BOARD_ID;
const LIST_RZESZOW_ID   = process.env.LIST_RZESZOW_ID;
const LIST_SKARZYSKO_ID = process.env.LIST_SKARZYSKO_ID;

if (!TRELLO_KEY || !TRELLO_TOKEN || !BOARD_ID || !LIST_RZESZOW_ID || !LIST_SKARZYSKO_ID) {
  console.error('Missing env. Please set TRELLO_KEY, TRELLO_TOKEN, BOARD_ID, LIST_RZESZOW_ID, LIST_SKARZYSKO_ID');
  process.exit(1);
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

async function captureListJson(page) {
  let got = null;

  page.on('response', async (resp) => {
    try {
      const url = resp.url();
      if (!/\/api\/.*(notice|notices)/.test(url)) return;
      const ct = (resp.headers()['content-type'] || '').toLowerCase();
      if (!ct.includes('application/json')) return;
      const json = await resp.json().catch(()=>null);
      if (!json) return;
      const arr = Array.isArray(json) ? json : (json.content || json.items || json.data || json.results || []);
      if (Array.isArray(arr) && arr.length) {
        got = arr;
      }
    } catch {}
  });

  await page.goto(LIST_URL, { waitUntil: 'networkidle' });

  if (!got) {
    // Try to call the API from inside the page context (cookies + xsrf will be present)
    got = await page.evaluate(async () => {
      const endpoints = [
        '/app/demand/notice/public/current/api/list',
        '/app/demand/notice/public/api/notices',
        '/app/demand/notice/public/notices/search'
      ];
      const bodies = [
        { page:0, size:200, sort:['publicationDate,desc'], filters: { demandOrganization_orgName:'000000010007', demandOrganization_withSuborgs:true, onlyCurrent:true } },
        { page:0, size:200, sort:['publicationDate,desc'], demandOrganization_orgName:'000000010007', demandOrganization_withSuborgs:true, onlyCurrent:true }
      ];
      for (const ep of endpoints) {
        for (const body of bodies) {
          try {
            const res = await fetch(ep, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
            if (res.ok) {
              const j = await res.json();
              const arr = Array.isArray(j) ? j : (j.content || j.items || j.data || j.results || []);
              if (Array.isArray(arr) && arr.length) return arr;
            }
          } catch {}
        }
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
    const m = /POST\/[A-Z0-9/.\-]+\/\d{4}/.exec((c.name || '').toUpperCase());
    if (m) set.add(m[0]);
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
  const page = await browser.newPage({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36'
  });

  const items = await captureListJson(page);
  await browser.close();

  if (!items.length) {
    console.log('Nie przechwycono JSON-a listy – to rzadkie, ale możliwe.');
    process.exit(0);
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
