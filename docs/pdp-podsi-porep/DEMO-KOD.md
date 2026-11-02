# Demo: co faktycznie się wykonuje i gdzie to jest w kodzie

Trzeci dokument z serii:
- `DEMO-JAK-DZIALA.md`: kroki i oficjalna dokumentacja;
- `DEMO-PRZEPLYW-DANYCH.md`: skąd pochodzi każda wartość;
- ten: łańcuch wywołań przy każdej akcji, z plikiem i linią w `demo/`.

Ścieżki są względem `demo/`. Numery linii według stanu z 2026-10-29.

---

## 1. Jak demo jest uruchomione

| Co | Gdzie | Szczegóły |
|---|---|---|
| Budowa obrazu | `Dockerfile` | Etap `go` (`golang:1.26-trixie`): buduje `podsicheck` (z `../docs/pdp-podsi-porep/podsicheck`, przez `additional_contexts`) i `aggplan`. Etap końcowy (`node:24-trixie-slim`): `npm ci`, `npm run build` (Vite → `dist/`), binarki Go do `/usr/local/bin/` |
| Proces | `Dockerfile`, `CMD` | `npx tsx server/index.ts`, jeden proces Node. Serwuje API i statyczny frontend |
| Sieć | `compose.yaml` | zewnętrzna sieć `porep-market-curio-devnet_default`, czyli ta sama co devnet. Stąd nazwy `lotus`, `curio`, `curio-porep`, `yugabyte` działają bez mapowania |
| Port | `compose.yaml` | `127.0.0.1:8787:8787` (tylko lokalnie) |
| Wolumeny | `compose.yaml` | `../.runtime/devnet/data/contracts` → `/var/lib/contracts` (tylko odczyt, `devnet-info.json`); `../.runtime/demo` → `/data` (stan demo) |
| Konfiguracja | `server/config.ts:3–27` | zmienne środowiskowe z domyślnymi wartościami: `PORT`, `DEVNET_INFO_PATH`, `LOTUS_RPC`, `DATA_DIR`, `WEB_DIR`, `AGGPLAN_BIN`, `PODSICHECK_BIN`, `DB_*`. Lista węzłów A/B (baza, kontener), `dealDurationEpochs`, limity plików |
| Tryb deweloperski UI | `vite.config.ts` | `npm run dev`: Vite na :5173, `/api` przekierowane do :8787 |

Po `just reset` devnet tworzy nową sieć Dockera, więc kontener trzeba odtworzyć: `docker compose up -d --force-recreate`.

---

## 2. Mapa plików

### Backend (`server/`)

| Plik | Odpowiada za | Najważniejsze funkcje (linia) |
|---|---|---|
| `index.ts` | serwer Hono, wszystkie trasy `/api/*`, statyczny frontend | `isCar` (44), trasy (25–134), `serveStatic` (136–137), `serve` (139) |
| `config.ts` | konfiguracja, odczyt `devnet-info.json`, mapowanie adresów na porty hosta | `config` (3), `hostUrl` (36), `loadDevnetInfo` (50) |
| `store.ts` | stan demo w pamięci i w `/data/state.json`, typy rekordów | `FileRecord` (8), `AggregatePlan` (29), `DealRecord` (39), `load` (62), `save` (84), `syncRun` (91), `event` (105) |
| `pdp.ts` | Synapse: upload do PDP, weryfikacja PDP, zdrowie SP PDP | `devnet` (24), `depositWithApprove` (53), `enqueueUpload` (72), `upload` (76), `pdpHealth` (135), `pieceUrl` (148), `verifyFile` (155), `lastProvenEpoch` (211) |
| `mk20.ts` | klient Curio Market 2.0: podpis, deal, status | `client` (17), `authHeader` (30), `call` (43), `buildDeal` (61), `submitDeal` (89), `dealStatus` (96) |
| `podsi.ts` | uruchamianie `aggplan` i `podsicheck` | `planAggregate` (12), `verifyPodsi` (25) |
| `deals.ts` | tworzenie deala, widok deala, kroki osi czasu | `readyFiles` (9), `planFor` (16), `createDeal` (26), `overlapping` (66), `dealView` (77), `steps` (171) |
| `lotus.ts` | Lotus JSON-RPC | `lotus` (7), `chainHeight` (18), `chainLag` (28), `minerInfo` (38), `multiaddrToUrl` (43), `marketUrl` (57), `sectorInfo` (68), `sectorMessages` (84) |
| `nodes.ts` | wykrywanie węzłów Curio z ich baz | `inspect` (20), `getNodes` (37, cache 5 s), `nodeByMiner` (44) |
| `db.ts` | pule połączeń `pg`, po jednej na bazę HarmonyDB | `pool` (8), `query` (18) |

### Programy Go

| Plik | Wywoływany przez | Robi |
|---|---|---|
| `aggplan/main.go` | `server/podsi.ts:14` (`execFile`) | argumenty: PieceCID v2 dzieci. Wyjście: JSON planu. `PieceCidV1FromV2` (66), `ComputeDealPlacement` (75), rozmiar `1 << bitlen(upsize + 256)` (79), `NewAggregate` (81), `PieceCidV2FromV1` (89), offsety z `agg.Index.Entries` (93). Błąd: JSON `{"error": …}` i kod 1 |
| `../docs/pdp-podsi-porep/podsicheck/main.go` | `server/podsi.ts:35` (`execFile` z `SECTOR_SIZE`, `SECTOR_COMMD`) | argumenty: plik, rozmiar, korzeń, dzieci. Krok 0: CommP całego pliku (55–69). Indeks i CommP segmentów (71–102). Dzieci w indeksie (104–116). Odbudowa agregatu (119–125). Dowody włączenia (127–137). `PoDSI OK` (139). CommD sektora (141–158) |

### Frontend (`web/src/`)

| Plik | Odpowiada za | Najważniejsze miejsca (linia) |
|---|---|---|
| `main.tsx` | montowanie Reacta | – |
| `api.ts` | typy odpowiedzi i wywołania `/api/*` | `request` (109), `api` (122–138) |
| `App.tsx` | nagłówek, ostrzeżenia, odświeżanie co 4 s | `refresh` (15), `setInterval` (29), ostrzeżenie łańcucha (62), PDP (70), węzły (77) |
| `Files.tsx` | wybór formatu, upload, tabela plików, „Sprawdź” | wybór formatu (28, 65–69), `upload` (33), `FileRow` (111), `FileDetails` (163), `verify` (168), kontrole (232–254) |
| `Aggregate.tsx` | zaznaczone pliki, plan, wybór SP, wysłanie deala | domyślny SP (27–29), plan (31–41), `fits` (43–44), `submit` (47), `Layout` (127) |
| `Deals.tsx` | karta deala, oś czasu, kontrole, PoDSI | `DealCard` (28), odpytywanie (33–54), `podsi` (56), kontrole transferu i łańcucha (~105–175), przycisk PoDSI (188), `PodsiResult` (200), `DealBadge` (237) |
| `ui.tsx` | wspólne elementy: `Badge`, `Button`, `Check`, `Copy`, `Mono` | – |
| `index.css` | `@import "tailwindcss";` | – |

---

## 3. Co się wykonuje przy każdej akcji

### 3.1 Otwarcie strony i odświeżanie

```
App.tsx:27  useEffect → refresh() teraz i co 4000 ms (App.tsx:29)
  └─ równolegle: GET /api/status, GET /api/files, GET /api/deals

index.ts:20  middleware /api/*  → syncRun(devnet().runId)          store.ts:91
               nowy run_id → state.json do state-<stary>.json, pusta lista
index.ts:25  GET /api/status
  ├─ chainLag()            lotus.ts:28   ChainHead + StateGetNetworkParams
  ├─ networkVersion()      lotus.ts:22   StateNetworkVersion
  ├─ getNodes(true)        nodes.ts:37   dla A i B: inspect() (nodes.ts:20)
  │    ├─ SELECT title, config FROM curio.harmony_config         → miner, EnablePDP
  │    ├─ SELECT count(*) FROM curio.harmony_machines            → ostrzeżenie
  │    └─ marketUrl(miner)  lotus.ts:57  StateMinerInfo → multiaddrToUrl (lotus.ts:43)
  └─ pdpHealth()           pdp.ts:135   GET <pdp_service_url>/pdp/ping (timeout 5 s)
index.ts:41  GET /api/files  → state.files
index.ts:109 GET /api/deals  → state.deals
```

### 3.2 Wgranie pliku

```
Files.tsx:33   upload(list) → po kolei dla każdego pliku: api.upload(f, format)  (api.ts:125)
                 POST /api/files  (multipart: file, format)

index.ts:56    POST /api/files
  ├─ parseBody, sprawdzenie rozmiaru (61–62)
  ├─ isCar(bytes)  index.ts:44   CarReader.fromBytes + przejście po wszystkich blokach
  ├─ format: raw | car (65–66); „car” dla nie-CAR → błąd 400
  ├─ sha256, randomUUID, writeFile /data/files/<id>  (67–77)
  ├─ state.files.unshift, event(...)  (78–82); ostrzeżenie dla „.car”, który nie jest CAR-em (80–82)
  └─ enqueueUpload(rec)  pdp.ts:72   → odpowiedź od razu (rekord ze status=queued)
```

### 3.3 Upload do PDP (kolejka w tle)

```
pdp.ts:72   enqueueUpload: queue = queue.then(() => upload(rec))   jeden naraz
pdp.ts:76   upload(rec)
  ├─ devnet()                      pdp.ts:24   Synapse.create(...) z devnet-info (cache wg run_id)
  ├─ Piece.calculate(bytes)        pdp.ts:81   → rec.localPieceCid
  ├─ storage.createContexts({copies: 1})   pdp.ts:86
  ├─ storage.prepare({context, pieceSizes})  pdp.ts:88
  │    ├─ transakcja bez zgody → depositWithApprove(depositAmount)  pdp.ts:53
  │    │     viem: approve(FilecoinPay, kwota) → receipt → deposit(USDFC, user, kwota) → receipt
  │    └─ transakcja ze zgodą → transaction.execute()  pdp.ts:93
  ├─ storage.upload(bytes, {contexts, callbacks})  pdp.ts:97
  │    onStored → status=stored | onPiecesAdded → status=committing, txHash | onPiecesConfirmed → zdarzenie
  ├─ wynik: pieceCid, providerId, dataSetId, pieceId, retrievalUrl  pdp.ts:117–121
  ├─ getBlockNumber() → addedHeight; status=ready   pdp.ts:122–123
  └─ catch → status=failed, error (125–128); save() (130)
```

„Ponów”: `Files.tsx:186` → `POST /api/files/:id/retry` (`index.ts:87`). Wymaga `status=failed` i ponownie woła `enqueueUpload`.

### 3.4 „Sprawdź” plik

```
Files.tsx:168  verify() → GET /api/files/:id/verify
index.ts:98    → verifyFile(rec)  pdp.ts:155
  ├─ Promise.all (165–173): readContract × 6 na PDPVerifier + getBlockNumber
  │    dataSetLive, pieceLive, getPieceCid, getNextPieceId, getDataSetLastProvenEpoch, getNextChallengeEpoch
  ├─ CID.decode(getPieceCid.data)       pdp.ts:174
  ├─ fetch(pieceUrl(rec)) → sha256      pdp.ts:176–179
  └─ komendy cast/curl z hostUrl(...)   pdp.ts:181–207
Files.tsx:232–254   kontrole; „SP udowodnił po dodaniu”: lastProvenEpoch > addedHeight (246)
```

### 3.5 Plan agregatu

```
Aggregate.tsx:31  useEffect na zmianę zaznaczenia; < 2 pliki → brak planu
                  api.plan(selected) → POST /api/plan
index.ts:104      → planFor(ids)  deals.ts:16
  ├─ readyFiles(ids)  deals.ts:9    wszystkie ready, ≥ 2
  ├─ planAggregate(pieceCid[])  podsi.ts:12  → execFile aggplan → JSON
  └─ dla każdego węzła z minerem: minerInfo(miner).SectorSize
Aggregate.tsx:43–44  fits = plan.pieceSize ≤ SectorSize wybranego SP
Aggregate.tsx:127    Layout: pasek z offsetami dzieci i indeksem
```

### 3.6 Wysłanie deala

```
Aggregate.tsx:47  submit() → api.createDeal(selected, provider) → POST /api/deals
index.ts:111      → createDeal(ids, provider)  deals.ts:26
  ├─ readyFiles + planAggregate (27–28)         plan liczony ponownie na serwerze
  ├─ minerInfo(provider).SectorSize; za duży → błąd (29–30)
  ├─ nodeByMiner(provider)?.marketUrl ?? marketUrl(provider)  (31–33)
  ├─ buildDeal(provider, plan, [{pieceCidV2, url: pieceUrl(f), format}])  (36–40) → mk20.ts:61
  ├─ chainHeight() → createdHeight  (41)
  ├─ submitDeal(url, deal)  (42) → mk20.ts:89 → call('POST', '/deal')  mk20.ts:43
  │     authHeader('POST', '/market/mk20/deal')  mk20.ts:30
  │       sha256(addrBytes || "POST" || path || minuta RFC3339) → secp256k1.sign(keccak256(digest))
  │       → "CurioAuth delegated:<b64 [4,10,eth20]>:<b64 [3] + r‖s + v>"
  │     HTTP ≠ 200 → błąd „SP odrzucił deal”, nic nie zapisane
  └─ state.deals.unshift(rec); save()  (43–56)
```

### 3.7 Karta deala (odpytywanie)

```
Deals.tsx:33   load(): GET /api/deals/:id; następne za 5 s, a po complete i aktywnym sektorze za 30 s; po błędzie za 10 s
index.ts:116   → dealView(deal)  deals.ts:77
  ├─ nodeByMiner(provider)                        nodes.ts:44
  ├─ dealStatus(marketUrl, id)   mk20.ts:96       GET /market/mk20/status/<id> (podpisany)
  ├─ jeśli węzeł dostępny (deals.ts:82–138), baza węzła:
  │    85   SELECT created_at FROM curio.market_mk20_deal
  │    87   SELECT … FROM curio.market_mk20_pipeline ORDER BY aggr_index
  │    95   SELECT sector_num FROM curio.market_piece_deal
  │    102  ParkPiece ok/failed z curio.harmony_task_history w oknie [created_at, aggregatedAt]
  │    108  ostatnie błędy ParkPiece/CommP/AggregateDeals w tym oknie
  │    117  SELECT … FROM curio.sectors_sdr_pipeline (gdy sektor znany)
  │    125  deal.complete = wszystkie wiersze complete albo potok sprzątnięty i jest market_piece_deal
  │    133  overlapping(deal)  deals.ts:66
  ├─ jeśli sektor znany (141–159):
  │    sectorInfo → StateSectorGetInfo
  │    sectorMessages(miner, sector, createdHeight − 5)  lotus.ts:84
  │       (tylko gdy PreCommit lub ProveCommit nie ma jeszcze exit 0)
  │       StateListMessages → ChainGetMessage → metoda 28/34 → StateDecodeParams → StateSearchMsg
  │    minerInfo → SectorSize; pieceIsAggregate = kawałek ProveCommit == (aggregateCidV1, pieceSize)
  ├─ lastProvenEpoch(dataSetId) dla plików deala  (162–165)
  ├─ save()  (166)
  └─ steps(...)  deals.ts:171   10 kroków, reguły w 180–245
Deals.tsx      oś czasu + kontrole z podpisanym źródłem; DealBadge (237) na podstawie kroków
```

### 3.8 Weryfikacja PoDSI

```
Deals.tsx:188  przycisk aktywny, gdy ostatni krok = done
Deals.tsx:56   podsi() → POST /api/deals/:id/podsi, potem ponowny GET widoku
index.ts:122   → dealView(deal) jeszcze raz
  ├─ ostatni krok ≠ done → błąd (126)
  ├─ brak PreCommit z exit 0 → błąd (127–129)
  └─ verifyPodsi(deal, sectorSize, unsealedCid)  podsi.ts:25
       ├─ fetch(<marketUrl>/piece/<aggregateCidV2>) → /data/aggregates/<deal>.bin
       ├─ execFile podsicheck <plik> <pieceSize> <aggregateCidV2> <dzieci v2…>
       │    env SECTOR_SIZE, SECTOR_COMMD
       └─ ok = kod 0 i wyjście zawiera „equals on-chain UnsealedCid: true”
  deal.podsi = {...}; save()  (index.ts:131–132)
Deals.tsx:200  PodsiResult: dzieli wyjście na linie i pokazuje 4 kontrole + pełny tekst
```

---

## 4. Wszystkie odwołania na zewnątrz

### Lotus JSON-RPC (`lotus.ts:7`, POST `http://lotus:1234/rpc/v1`)

| Metoda | Gdzie | Po co |
|---|---|---|
| `ChainHead` | `lotus.ts:19`, `:29` | wysokość, znacznik czasu |
| `StateGetNetworkParams` | `lotus.ts:30` | `BlockDelaySecs` |
| `StateNetworkVersion` | `lotus.ts:23` | NV w nagłówku |
| `StateMinerInfo` | `lotus.ts:39` | `SectorSize`, `Multiaddrs` |
| `StateSectorGetInfo` | `lotus.ts:69` | sektor: `SealedCID`, `Activation`, `Expiration` |
| `StateListMessages` | `lotus.ts:85` | wiadomości do minera od wysokości |
| `ChainGetMessage` | `lotus.ts:88` | metoda i parametry |
| `StateDecodeParams` | `lotus.ts:90` | dekodowanie metod 28 i 34 |
| `StateSearchMsg` | `lotus.ts:91` | wysokość i exit code |

### Kontrakty (viem, RPC Lotusa przez Synapse `chain`)

| Wywołanie | Gdzie |
|---|---|
| PDPVerifier: `dataSetLive`, `pieceLive`, `getPieceCid`, `getNextPieceId`, `getDataSetLastProvenEpoch`, `getNextChallengeEpoch` | `pdp.ts:12–19` (ABI), `:165–173`, `:211` |
| mock USDFC `approve`, Filecoin Pay `deposit` | `pdp.ts:44–67` |
| wszystko inne (rejestr SP, FWSS, data sety, `addPieces`) | wewnątrz Synapse SDK (`pdp.ts:86–114`) |

### HTTP do Curio

| Żądanie | Gdzie | Węzeł |
|---|---|---|
| `GET /pdp/ping` | `pdp.ts:139` | A (SP PDP) |
| upload PDP i retrieval przez Synapse | `pdp.ts:97` | A |
| `GET /piece/<CID pliku>` | `pdp.ts:177` | A |
| `POST /market/mk20/deal` | `mk20.ts:89` | wybrany SP PoRep |
| `GET /market/mk20/status/<id>` | `mk20.ts:96` | wybrany SP PoRep |
| `GET /piece/<CID agregatu>` | `podsi.ts:26` | wybrany SP PoRep |

### HarmonyDB (tylko `SELECT`, `db.ts:18`)

| Tabela | Gdzie |
|---|---|
| `curio.harmony_config` | `nodes.ts:23` |
| `curio.harmony_machines` | `nodes.ts:26` |
| `curio.market_mk20_deal` | `deals.ts:85` |
| `curio.market_mk20_pipeline` | `deals.ts:87` |
| `curio.market_piece_deal` | `deals.ts:95` |
| `curio.harmony_task_history` | `deals.ts:102`, `:108` |
| `curio.sectors_sdr_pipeline` | `deals.ts:117` |

### Procesy

| Program | Gdzie |
|---|---|
| `aggplan` | `podsi.ts:14` |
| `podsicheck` | `podsi.ts:35` |

---

## 5. Zachowanie w czasie i przy błędach

| Sytuacja | Co robi kod | Gdzie |
|---|---|---|
| dwa uploady naraz | idą po kolei (jedna obietnica-kolejka) | `pdp.ts:70–74` |
| restart w trakcie uploadu | przy starcie rekordy ≠ `ready`/`failed` → `failed` „upload przerwany restartem demo” | `store.ts:72–78` |
| `just reset` | nowy `run_id` → archiwum `state-<run>.json`, pusta lista, nowy obiekt Synapse | `store.ts:91`, `pdp.ts:26` |
| dowolny wyjątek w trasie | JSON `{ error }` z kodem 400 | `index.ts:18` |
| węzeł bez bazy | `available = false`, `problem` z komunikatem; karta deala bez części SP | `nodes.ts:31–33`, `deals.ts:82` |
| Curio po uśpieniu (brak `harmony_machines`) | ostrzeżenie z `docker restart <kontener>` | `nodes.ts:30` |
| łańcuch stoi | ostrzeżenie; ≥ 900 epok: „just reset” | `lotus.ts:28`, `App.tsx:62` |
| SP PDP zwraca 503 | ostrzeżenie w nagłówku; upload Synapse się nie uda i plik dostanie `failed` | `pdp.ts:135`, `App.tsx:70` |
| SP odrzuca deal | błąd w panelu agregatu, deal nie jest zapisany | `mk20.ts:91`, `Aggregate.tsx:54–55` |
| Curio usunęło wiersze potoku | kroki biorą sektor z `market_piece_deal`; po aktywacji wszystkie kroki SP = gotowe | `deals.ts:94–98`, `:229` |
| inny deal w tym samym oknie pobrań | licznik oznaczony jako niejednoznaczny | `deals.ts:66`, `Deals.tsx:~111–115` |
| zadanie Curio z błędem | aktywny krok → „błąd” z treścią błędu | `deals.ts:231–245` |
| PoDSI przed `complete` | zablokowane w UI i na serwerze (wczesne `/piece/` psuje indeksowanie w Curio) | `Deals.tsx:188`, `index.ts:126` |

Cache: węzły 5 s (`nodes.ts:38`), Synapse do zmiany `run_id` (`pdp.ts:26`), wiadomości sektora do uzyskania exit 0 (`deals.ts:144`). Pozostałe dane czytane są przy każdym zapytaniu.

---

## 6. Gdzie zmienić typowe rzeczy

| Chcę | Plik |
|---|---|
| inne limity rozmiaru pliku, czas trwania deala | `server/config.ts:24–26` |
| dodać węzeł Curio | `server/config.ts:19–22` (baza + kontener); miner i adres wykryją się same |
| inne pola deala (np. `start_epoch`, adres rynku) | `server/mk20.ts:61–87` |
| blokować duplikaty PieceCID w agregacie | `server/deals.ts:9` (`readyFiles`) |
| zmienić reguły kroków osi czasu | `server/deals.ts:171–247` |
| dodać kontrolę do PoDSI | `../docs/pdp-podsi-porep/podsicheck/main.go` i `web/src/Deals.tsx:200` |
| zmienić częstotliwość odświeżania | `web/src/App.tsx:29`, `web/src/Deals.tsx:43` |
