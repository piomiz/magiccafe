# Magic Cafe

Wypożyczalnia napojów i dobrych momentów: kombucha, kawa, matcha, shaki, soki i shoty jako kasety VHS z przepisem na odwrocie.

Strona: https://piomiz.github.io/magiccafe/

Na telefonie: otwórz stronę i wybierz „Dodaj do ekranu głównego” (Android: „Zainstaluj aplikację”).

## Silnik wiedzy (Supabase)
Przepisy mistrzów V60, reguły mielenia i oceny kombuchy są w bazie Supabase (projekt `mixstory`, schemat `magiccafe`).
Ocena zdjęć (kombucha, mielenie, etykieta) idzie przez Edge Function `magiccafe` → Anthropic API.
Sekrety funkcji: `ANTHROPIC_API_KEY` (wymagany), `ANTHROPIC_MODEL`, `MC_DAILY_LIMIT` (dziennie łącznie, domyślnie 150), `MC_CLIENT_LIMIT` (na urządzenie, domyślnie 25).
Kod funkcji: `supabase/functions/magiccafe/index.ts`.

## Karty klubowe (profile) i udostępnianie
Ikona karty w nagłówku otwiera okno „Kto dziś ogląda?”. Każda karta (imię, awatar, kolor) ma osobne ulubione, nastawy, dzienniki,
ustawienia i własny kod kopii w chmurze. Dane aktywnej karty leżą w zwykłych kluczach localStorage; nieaktywne karty są zapisane
w `magiccafe-profiles-v1` i podmieniane przy przełączeniu (aplikacja się przeładowuje). Nową kartę zakłada się z czystym stanem.
W tym samym oknie jest udostępnianie aplikacji: udostępnianie systemowe (Web Share), kopiowanie linku, WhatsApp, e-mail i kod QR
z adresem `https://piomiz.github.io/magiccafe/` (SVG wbudowany w index.html).

## Dziennik nastawu i kopia zapasowa
Nastawy są zapisane w przeglądarce (localStorage). Karta nastawu zapisuje parametry w chwili startu fermentacji; suwaki później to tylko podgląd. Poprawki karty trafiają do dziennika.
Kopia: plik JSON (Nastaw → Kopia zapasowa) albo kopia w chmurze w tabeli `magiccafe.journals` pod prywatnym 16-znakowym kodem.
Terminy (nastaw, degustacja, butelkowanie, koniec F2) eksportują się do kalendarza jako plik .ics albo link Google Kalendarz.

## Baza pytań (zakładka Pytania)
Źródło prawdy: tabela `magiccafe.faq`. Kopia offline: `faq.json`. Pusta tabela wczytuje się sama z `faq.json` z GitHub Pages,
więc żeby zaktualizować bazę: zmień `faq.json`, wypchnij, a potem w Supabase `truncate magiccafe.faq`.
„Zapytaj AI” idzie przez akcję `ask` Edge Function (te same limity co ocena zdjęć).

## Kawa → Sprzęt (Lelit Bianca + Fiorenzato F4 Nano)
Ustawienia na start, profile łopatką, mapa mielenia, dziennik strzałów i harmonogram serwisu z przypomnieniami .ics (RRULE).
Dane sprzętu są wbudowane w index.html (obiekt GEAR); daty serwisu i strzały w localStorage `aloha-kawa-gear-v1` (objęte kopią zapasową).

## Kawa → Palarnie (wyszukiwarka kaw z lokalnych palarni)
Kawy z polskich palarni (speciality i klasycznych) z ceną za 100 g, limitowanymi seriami, nowościami i linkiem do sklepu palarni.
„Przyrządź” ustawia kawę w zakładce Ziarno (kraj, palenie, obróbka, palarnia), więc przepisy dopasowują się same.
Dane: tabele `magiccafe.roasters` i `magiccafe.coffees`. Oferty pobiera Edge Function `magiccafe-sync`
(Shopify `/products.json`, WooCommerce Store API), uruchamiana przez pg_cron `magiccafe-sync-palarnie` co 10 minut po 2 palarnie,
każda palarnia raz na ok. 20 h. Wyszukiwanie: akcja `coffees` w funkcji `magiccafe`.
Kod: `supabase/functions/magiccafe-sync/index.ts`. Palarnia, która nie chce być na liście: `consent_status = 'odmowa'` w `magiccafe.roasters`.
