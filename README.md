# Magic Cafe

Wypożyczalnia napojów i dobrych momentów: kombucha, kawa, matcha, shaki, soki i shoty jako kasety VHS z przepisem na odwrocie.

Strona: https://piomiz.github.io/magiccafe/

Na telefonie: otwórz stronę i wybierz „Dodaj do ekranu głównego” (Android: „Zainstaluj aplikację”).

## Silnik wiedzy (Supabase)
Przepisy mistrzów V60, reguły mielenia i oceny kombuchy są w bazie Supabase (projekt `mixstory`, schemat `magiccafe`).
Ocena zdjęć (kombucha, mielenie, etykieta) idzie przez Edge Function `magiccafe` → Anthropic API.
Sekrety funkcji: `ANTHROPIC_API_KEY` (wymagany), `ANTHROPIC_MODEL`, `MC_DAILY_LIMIT` (dziennie łącznie, domyślnie 150), `MC_CLIENT_LIMIT` (na urządzenie, domyślnie 25).
Kod funkcji: `supabase/functions/magiccafe/index.ts`.

## Dziennik nastawu i kopia zapasowa
Nastawy są zapisane w przeglądarce (localStorage). Karta nastawu zapisuje parametry w chwili startu fermentacji; suwaki później to tylko podgląd. Poprawki karty trafiają do dziennika.
Kopia: plik JSON (Nastaw → Kopia zapasowa) albo kopia w chmurze w tabeli `magiccafe.journals` pod prywatnym 16-znakowym kodem.
Terminy (nastaw, degustacja, butelkowanie, koniec F2) eksportują się do kalendarza jako plik .ics albo link Google Kalendarz.

## Baza pytań (zakładka Pytania)
Źródło prawdy: tabela `magiccafe.faq`. Kopia offline: `faq.json`. Pusta tabela wczytuje się sama z `faq.json` z GitHub Pages,
więc żeby zaktualizować bazę: zmień `faq.json`, wypchnij, a potem w Supabase `truncate magiccafe.faq`.
„Zapytaj AI” idzie przez akcję `ask` Edge Function (te same limity co ocena zdjęć).
