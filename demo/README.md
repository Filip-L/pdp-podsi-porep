# Demo: własne pliki → PDP → agregat PoDSI → sektor PoRep

Prosta aplikacja webowa na lokalny devnet z tego repo. Pokazuje całą ścieżkę z perspektywy klienta i przy każdym kroku podaje dowód: co mówi klient, co widzi SP i co jest zapisane on-chain.

1. **Upload**: wybierasz pliki z komputera. Synapse SDK v2.0.2 zapisuje je w PDP (Curio, węzeł A).
2. **Sprawdzenie PDP**: PieceCID policzony lokalnie, bajty z `/piece/` = oryginał, PieceCID zapisany w PDPVerifier, `pieceLive`, dowody PDP. Do tego gotowe komendy do skopiowania.
3. **Agregat**: zaznaczasz pliki (min. 2). Klient liczy CID agregatu i układ plików z samych PieceCID (FRC-0058), zanim cokolwiek wyśle.
4. **Deal**: wybierasz SP PoRep (węzeł A albo osobny węzeł B). Demo wysyła deal mk20 z manifestem (CID + URL w PDP + `raw`/`car`), podpisany tym samym kluczem co płatności Synapse (adres f410, `CurioAuth delegated`). Bez `sptool` i bez łatki `0002`.
5. **Oś czasu**: przyjęcie → pobranie z PDP (licznik pobrań) → CommP → agregat → sealing → PreCommit → PoRep → ProveCommit → sektor aktywny.
6. **PoDSI**: demo pobiera agregat od SP PoRep przez `/piece/` i sprawdza go `podsicheck` (go-data-segment): indeks, CommP segmentów, dowody włączenia, CommD sektora = `UnsealedCid` on-chain.

Dokumentacja demo w `docs/pdp-podsi-porep/`: `DEMO-JAK-DZIALA.md` (kroki, oficjalna dokumentacja, łatka `sptool` `0002`), `DEMO-PRZEPLYW-DANYCH.md` (skąd pochodzi każda wartość), `DEMO-KOD.md` (gdzie co jest w kodzie).

## Uruchomienie

Devnet musi działać (`just status` → `ready`). Dla wariantu z osobnym SP PoRep najpierw `bash docs/pdp-podsi-porep/two-node/up.sh`.

```bash
cd demo
docker compose up -d --build     # pierwszy raz kilka minut
open http://127.0.0.1:8787
```

Zatrzymanie: `docker compose down`. Stan demo (pliki, deale, pobrane agregaty) leży w `.runtime/demo/`. Po `just reset` demo samo zaczyna od pustej listy (stara lista trafia do `state-<run>.json`), ale kontener trzeba odtworzyć, bo reset tworzy nową sieć Dockera: `docker compose up -d --force-recreate`.

**Laptop nie może spać.** Krótkie uśpienie wyłącza przyjmowanie zadań przez Curio (demo pokaże ostrzeżenie z komendą restartu). Uśpienie dłuższe niż ~1 h (900 epok devnetu) zatrzymuje łańcuch na stałe i wymaga `just reset`. Patrz `docs/pdp-podsi-porep/REPRODUKCJA.md` §10.

## Jak to jest zbudowane

| Część | Technologia | Plik |
|---|---|---|
| Frontend | React + Vite + Tailwind | `web/src/` |
| Backend | Node + Hono (TypeScript, `tsx`) | `server/index.ts` |
| PDP | Synapse SDK v2.0.2, viem (PDPVerifier) | `server/pdp.ts` |
| Deal PoRep | API mk20 Curio v1.29.0 (`/market/mk20/deal`, `/status`) | `server/mk20.ts` |
| Łańcuch | Lotus JSON-RPC (`StateDecodeParams` dla wiadomości sektora) | `server/lotus.ts` |
| Podgląd SP | HarmonyDB (Postgres) każdego węzła Curio | `server/db.ts`, `server/deals.ts` |
| Agregat i PoDSI | Go: `aggplan/` (CID agregatu z CID-ów plików), `docs/pdp-podsi-porep/podsicheck` | `server/podsi.ts` |

Kontener demo działa w sieci Dockera devnetu, bo Synapse i Curio podają adresy wewnętrzne (`curio:12310`, `curio-porep:12310`, `lotus:1234`).

Praca nad samym UI z hot reloadem: `npm install && npm run dev` (http://127.0.0.1:5173, API idzie do kontenera na :8787).

## Ograniczenia

- Pliki od 127 B do ~4 MB: sektory devnetu mają 8 MiB, a agregat (sloty plików do potęgi 2 + indeks) musi się w nim zmieścić.
- Licznik pobrań przy węźle A (ten sam SP dla PDP i PoRep) obejmuje też inne zadania tego węzła. Dokładny jest dla osobnego węzła B.
- „Podgląd SP” (baza Curio) to informacja, której prawdziwy klient nie ma; demo oznacza ją jako źródło „baza SP”.
- Tylko lokalnie: klucz prywatny klienta devnetu jest w backendzie.
