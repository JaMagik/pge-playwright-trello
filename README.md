# PGE → Trello (Playwright, GitHub Actions)

**Cel**: codziennie pobrać z portalu PGE Dystrybucja aktualne przetargi i dodać *tylko nowe* do dwóch list Trello: **Rzeszów (OR)** i **Skarżysko-Kamienna (OSK)**.

## Jak uruchomić (bez kosztów)
1. Zrób prywatne repo na GitHubie i wrzuć tu pliki z tego folderu.
2. W repo ustaw *Secrets* (Settings → Secrets and variables → Actions → *New repository secret*):
   - `TRELLO_KEY`
   - `TRELLO_TOKEN`
   - `BOARD_ID`
   - `LIST_RZESZOW_ID`
   - `LIST_SKARZYSKO_ID`
3. Wejdź w zakładkę **Actions**, włącz workflow i uruchom ręcznie **Run workflow** (albo poczekaj na CRON).
4. Karty tworzą się tylko dla numerów zawierających `/OR/` (Rzeszów) lub `/OSK/` (Skarżysko).

## Co robi skrypt
- Otwiera stronę *Aktualne* portalu i **przechwytuje wywołania JSON** (np. `/current/api/list`).
- Z JSON‑a bierze: `id` (do linku `/.../<id>/details`), `noticeNumber`, `title`, `deadline`.
- Filtruje **OR/OSK** i sprawdza na tablicy Trello, czy karta o tym numerze już istnieje.
- Dodaje **tylko nowe**: nazwa, opis, termin + **załącznik z linkiem do szczegółów**.

## Lokalnie
```bash
npm i
npx playwright install chromium
TRELLO_KEY=xxx TRELLO_TOKEN=yyy BOARD_ID=zzz LIST_RZESZOW_ID=... LIST_SKARZYSKO_ID=... node index.js
```
