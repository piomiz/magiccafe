# Magic Cafe

Wypożyczalnia napojów i dobrych momentów: kombucha, kawa, matcha, shaki, soki i shoty jako kasety VHS z przepisem na odwrocie.

Strona: https://piomiz.github.io/magiccafe/

Na telefonie: otwórz stronę i wybierz „Dodaj do ekranu głównego” (Android: „Zainstaluj aplikację”).

## Silnik wiedzy (Supabase)
Przepisy mistrzów V60, reguły mielenia i oceny kombuchy są w bazie Supabase (projekt `mixstory`, schemat `magiccafe`).
Ocena zdjęć (kombucha, mielenie, etykieta) idzie przez Edge Function `magiccafe` → Anthropic API.
Sekrety funkcji: `ANTHROPIC_API_KEY` (wymagany), `ANTHROPIC_MODEL`, `MC_DAILY_LIMIT` (dziennie łącznie, domyślnie 150), `MC_CLIENT_LIMIT` (na urządzenie, domyślnie 25).
Kod funkcji: `supabase/functions/magiccafe/index.ts`.
