# Demo: co się dzieje i skąd brane są dane

Uzupełnienie do `DEMO-JAK-DZIALA.md`. Tamten dokument opisuje kroki i oficjalną dokumentację. Ten odpowiada na dwa pytania przy każdym kroku: **co się dzieje** i **skąd pochodzi każda wartość**, którą demo liczy, wysyła albo pokazuje. Gdzie dokładnie leży kod: `DEMO-KOD.md`.

## Źródła danych

Demo nie ma własnej bazy. Każda wartość pochodzi z jednego z tych źródeł:

| Skrót | Źródło | Jak demo je czyta | Kto by to miał w prawdziwym wdrożeniu |
|---|---|---|---|
| **UŻYTKOWNIK** | plik i wybory w przeglądarce | formularz HTTP | klient |
| **DEVNET-INFO** | `/var/lib/contracts/devnet-info.json` (montowany z `.runtime/devnet/data/contracts`, tylko do odczytu) | `readFileSync` przy każdym użyciu | klient zna swój klucz i adresy kontraktów z konfiguracji sieci |
| **LOKALNIE** | obliczenia w kontenerze demo (sha256, CommP, plan agregatu, podpis) | kod TypeScript i programy Go `aggplan`, `podsicheck` | klient |
| **SYNAPSE** | odpowiedzi Synapse SDK (SP PDP + kontrakty FOC) | `@filoz/synapse-sdk` | klient |
| **ŁAŃCUCH** | Lotus JSON-RPC `http://lotus:1234/rpc/v1` i kontrakt PDPVerifier przez viem | `fetch` / `readContract` | każdy |
| **SP-HTTP** | HTTP Curio: `/piece/<CID>` (A i B), `/pdp/ping` (A), `/market/mk20/*` (B) | `fetch` | klient |
| **SP-DB** | HarmonyDB Curio (Postgres, Yugabyte): baza `yugabyte` dla A, `curio_porep` dla B | `pg`, tylko `SELECT` | **tylko SP**. Prawdziwy klient tego nie ma; UI podpisuje te kontrole „baza SP” |
| **STAN-DEMO** | `/data/state.json` (z hosta `.runtime/demo/state.json`) | JSON w pamięci, zapis po każdej zmianie | aplikacja klienta |

Pliki z dysku demo:

| Ścieżka w kontenerze | Na hoście | Zawartość |
|---|---|---|
| `/data/state.json` | `.runtime/demo/state.json` | lista plików i deali (rekordy opisane niżej) |
| `/data/state-<run_id>.json` | `.runtime/demo/` | archiwum po `just reset` (inny `run_id` w DEVNET-INFO) |
| `/data/files/<id>` | `.runtime/demo/files/` | oryginalne bajty każdego wgranego pliku |
| `/data/aggregates/<deal>.bin` | `.runtime/demo/aggregates/` | agregat pobrany od SP PoRep przy weryfikacji PoDSI |

---

## 1. Start i pasek statusu

**Co się dzieje:** przeglądarka co 4 s pyta `GET /api/status`, `GET /api/files`, `GET /api/deals`. Przy każdym zapytaniu `/api/*` demo porównuje `run_id` z DEVNET-INFO z zapisanym. Jeśli się różni (był `just reset`), stare pliki i deale idą do archiwum, a lista startuje pusta.

| Wartość w UI | Skąd |
|---|---|
| epoka, opóźnienie łańcucha | ŁAŃCUCH: `ChainHead` (wysokość i znacznik czasu bloku) minus zegar, podzielone przez `StateGetNetworkParams.BlockDelaySecs` |
| „devnet stoi na stałe” | LOKALNIE: opóźnienie ≥ 900 epok |
| NV | ŁAŃCUCH: `StateNetworkVersion` |
| adres klienta (0x… i f410…) | DEVNET-INFO: `users[0].evm_addr`, `users[0].native_addr` |
| adres PDPVerifier | DEVNET-INFO: `contracts.pdp_verifier_proxy_addr` |
| ostrzeżenie „SP PDP nie przyjmuje uploadów” | SP-HTTP: `GET <pdp_service_url>/pdp/ping` ≠ 200 (adres z DEVNET-INFO `pdp_sps[]`) |
| węzły A i B: miner | SP-DB: `harmony_config`, wyrażenie `MinerAddresses = ["t0…"]` |
| węzły: „PDP + PoRep” albo „PoRep” | SP-DB: `harmony_config`, czy któraś warstwa ma `EnablePDP = true` |
| węzły: ostrzeżenie „Curio nie przyjmuje zadań” | SP-DB: `count(*)` z `harmony_machines` = 0 |
| adres rynku węzła | ŁAŃCUCH: `StateMinerInfo(miner).Multiaddrs` → `/dns/curio-porep/tcp/12310/ws` → `http://curio-porep:12310` |
| limity rozmiaru pliku | konfiguracja demo (`127 B`, `4 000 000 B`) |

Węzły demo zna z konfiguracji (nazwa bazy i kontenera). Miner i adres rynku odkrywa sam, cache 5 s.

---

## 2. Wgranie pliku

**Co się dzieje:** przeglądarka wysyła plik i wybrany format (`wykryj` / `raw` / `CAR`) jako `multipart/form-data`. Serwer zapisuje bajty na dysk, tworzy rekord pliku i wstawia go do kolejki uploadu. Odpowiada od razu; upload trwa w tle.

| Pole rekordu pliku | Skąd |
|---|---|
| `id` | LOKALNIE: `randomUUID()` |
| `name`, `size` | UŻYTKOWNIK: nazwa i długość pliku |
| `sha256` | LOKALNIE: z bajtów pliku |
| `format` | LOKALNIE: `raw`, jeśli użytkownik wybrał raw. W przeciwnym razie `car` tylko wtedy, gdy bajty parsują się jako CAR (nagłówek i wszystkie bloki). Wybór „CAR” dla pliku, który nie jest CAR-em, kończy się błędem |
| `status` | `queued`, potem zmieniany przez upload |
| `events[]` | LOKALNIE: dziennik zdarzeń; każde ma czas i tekst |

Nazwa pliku nie wpływa na format. Plik `.car`, który nie jest CAR-em, dostaje zdarzenie z ostrzeżeniem i trafia jako `raw`.

---

## 3. Upload do PDP (w tle)

**Co się dzieje:** jeden upload naraz (wspólny portfel). Kolejne kroki zapisują się w `events[]`, więc UI widzi postęp przy następnym odświeżeniu.

| # | Co się dzieje | Wejście (skąd) | Wynik zapisany w rekordzie |
|---|---|---|---|
| 1 | Synapse dla devnetu | DEVNET-INFO: sieć, kontrakty, `users[0].private_key_hex` | – (obiekt w pamięci, odtwarzany po zmianie `run_id`) |
| 2 | PieceCID liczony u klienta | LOKALNIE: bajty z `/data/files/<id>` → `Piece.calculate` | `localPieceCid` |
| 3 | Wybór SP PDP | SYNAPSE: `createContexts({ copies: 1 })` (rejestr SP on-chain) | zdarzenie z `provider.id` i adresem SP |
| 4 | Koszt i depozyt | SYNAPSE: `prepare(...)` (stan Filecoin Pay on-chain) | zdarzenie z hashem transakcji, jeśli była potrzebna |
| 4a | Dopłata obejściem (devnet) | DEVNET-INFO: `mockusdfc_addr`, `filecoin_pay_v1_addr`; kwota = max(potrzebna, 10 USDFC) | zdarzenie z hashem `deposit` |
| 5 | SP przyjął bajty | SYNAPSE callback `onStored` | `status = stored` |
| 6 | Transakcja dodania do data setu | SYNAPSE callback `onPiecesAdded` | `status = committing`, `txHash` |
| 7 | Potwierdzenie on-chain | SYNAPSE callback `onPiecesConfirmed` | zdarzenie z `dataSetId`, `pieceId` |
| 8 | Wynik | SYNAPSE: `result.pieceCid`, `copies[0]` | `pieceCid`, `providerId`, `dataSetId`, `pieceId`, `retrievalUrl` |
| 9 | Wysokość łańcucha zaraz po dodaniu | ŁAŃCUCH: `eth_blockNumber` (viem `getBlockNumber`) | `addedHeight`, `status = ready` |

Błąd na dowolnym kroku daje `status = failed` i `error`. „Ponów” wstawia ten sam rekord do kolejki jeszcze raz. Restart kontenera w trakcie uploadu oznacza plik jako `failed` (kolejka żyje tylko w pamięci).

---

## 4. „Sprawdź” plik w PDP

**Co się dzieje:** na żądanie (przycisk) demo czyta wszystko od nowa, nic nie bierze z pamięci poza identyfikatorami.

| Kontrola w UI | Porównuje | Źródło lewej strony | Źródło prawej strony |
|---|---|---|---|
| PieceCID lokalny = potwierdzony przez SP | `localPieceCid` vs `pieceCid` | LOKALNIE (krok 3.2) | SYNAPSE (krok 3.8) |
| Bajty z `/piece/` = oryginał | sha256 | SP-HTTP: `GET retrievalUrl` (węzeł A) | LOKALNIE: `sha256` z kroku 2 |
| PDPVerifier zapisał ten PieceCID | CID | ŁAŃCUCH: `getPieceCid(dataSetId, pieceId)` dekodowany do CID | `pieceCid` |
| Kawałek aktywny | `true` | ŁAŃCUCH: `dataSetLive`, `pieceLive` | – |
| SP udowodnił dane po dodaniu pliku | epoka | ŁAŃCUCH: `getDataSetLastProvenEpoch` | `addedHeight` (krok 3.9) |
| „następne wyzwanie”, „teraz” | – | ŁAŃCUCH: `getNextChallengeEpoch`, `eth_blockNumber` | – |

Komendy „zweryfikuj sam” składa z tych samych wartości. Adresy wewnętrzne (`curio:12310`, `lotus:1234`) zamienia na porty hosta (`127.0.0.1:22310`, `:2234`).

---

## 5. Plan agregatu

**Co się dzieje:** po zaznaczeniu co najmniej 2 gotowych plików przeglądarka wysyła ich `id`. Serwer bierze ich `pieceCid` (SYNAPSE, zapisane w kroku 3.8) i uruchamia `aggplan`.

| Wartość planu | Skąd |
|---|---|
| `children[].pieceCidV1`, `payloadSize` | LOKALNIE: rozkład PieceCID v2 dziecka |
| `children[].paddedSize` | LOKALNIE: najmniejsza potęga 2, która mieści dane po Fr32 |
| `children[].offset` | LOKALNIE: wpisy indeksu z `NewAggregate` |
| `pieceSize` | LOKALNIE: następna potęga 2 nad (miejsce dzieci + 256) |
| `aggregateCidV1`, `aggregateCidV2` | LOKALNIE: `NewAggregate(...).PieceCID()` |
| `indexOffset`, `maxIndexEntries` | LOKALNIE: funkcje `go-data-segment` dla `pieceSize` |
| rozmiar sektora każdego SP („mieści się”) | ŁAŃCUCH: `StateMinerInfo(miner).SectorSize` |

**Kolejność dzieci** to kolejność zaznaczania w UI. Inna kolejność daje inny CID agregatu.

Plan powstaje **bez bajtów**, tylko z CID-ów. To ten sam CID, który SP potem musi odtworzyć z prawdziwych bajtów (krok 8 w `DEMO-JAK-DZIALA.md`).

---

## 6. Wysłanie deala

**Co się dzieje:** serwer liczy plan jeszcze raz (nie ufa przeglądarce), sprawdza rozmiar, buduje JSON deala, podpisuje i wysyła do SP PoRep. SP odpowiada 200 albo błędem; przy błędzie demo nic nie zapisuje.

Skąd każde pole wysłanego deala:

| Pole w JSON | Skąd |
|---|---|
| `identifier` | LOKALNIE: nowy ULID |
| `client` | DEVNET-INFO: `users[0].native_addr` (f410…, ten sam klucz co płatności Synapse) |
| `data.piece_cid` | LOKALNIE: `aggregateCidV2` z planu |
| `data.format.aggregate.type` | stała `1` (FRC-0058) |
| `source_aggregate.pieces[].piece_cid` | SYNAPSE: `pieceCid` pliku |
| `source_aggregate.pieces[].format` | LOKALNIE: `format` pliku z kroku 2 (`raw: {}` albo `car: {}`) |
| `source_aggregate.pieces[].source_http.urls[].url` | SYNAPSE: `retrievalUrl` pliku (`http://curio:12310/piece/<CID>`). Bez niego: DEVNET-INFO `pdp_service_url` + `/piece/` + CID |
| `products.ddo_v1.provider` | UŻYTKOWNIK: wybrany SP; lista z SP-DB (krok 1) |
| `products.ddo_v1.duration` | stała `518400` (minimum Curio dla nowych deali) |
| `products.retrieval_v1` | stałe: `indexing: true`, `announce_payload: false`, `announce_piece: false` |
| nagłówek `Authorization` | LOKALNIE: podpis klucza `users[0].private_key_hex` nad `sha256(adres || "POST" || "/market/mk20/deal" || bieżąca minuta)` |
| adres, na który idzie deal | SP-DB/ŁAŃCUCH: `marketUrl` węzła z kroku 1 (z `StateMinerInfo.Multiaddrs`) |

Rekord deala zapisany w STAN-DEMO:

| Pole | Skąd |
|---|---|
| `id` | = `identifier` |
| `createdAt` | zegar demo |
| `createdHeight` | ŁAŃCUCH: `ChainHead` tuż przed wysłaniem (od tej wysokości demo szuka wiadomości sektora) |
| `provider`, `nodeKey`, `marketUrl`, `client`, `fileIds`, `plan` | jak wyżej |
| `sector`, `aggregatedAt`, `complete`, `chain`, `podsi` | uzupełniane później (kroki 7–9) |

---

## 7. Oś czasu deala

**Co się dzieje:** każda karta deala co 5 s pyta `GET /api/deals/<id>`. Po aktywnym sektorze i zakończeniu co 30 s. Serwer przy każdym zapytaniu czyta wszystko od nowa i liczy 10 kroków. Nie ma osobnego procesu w tle: postęp liczy się wtedy, gdy ktoś patrzy.

### 7.1 Co serwer czyta przy każdym odświeżeniu

| Dane | Źródło | Zapytanie |
|---|---|---|
| status deala u SP | SP-HTTP: `GET /market/mk20/status/<id>` (podpisany, ten sam klient) | `ddo_v1.status`, `ddo_v1.errorMsg` |
| kiedy SP przyjął deal | SP-DB | `market_mk20_deal.created_at` |
| stan każdego dziecka | SP-DB | `market_mk20_pipeline`: `downloaded`, `after_commp`, `aggregated`, `sector`, `sealed`, `indexed`, `complete` |
| sektor po sprzątnięciu potoku | SP-DB | `market_piece_deal.sector_num` (Curio usuwa wiersze potoku po zakończeniu; ten zostaje) |
| liczba pobrań | SP-DB | `harmony_task_history`, `name = 'ParkPiece'`, w oknie od przyjęcia do zbudowania agregatu |
| błędy w tym oknie | SP-DB | `harmony_task_history`, nieudane `ParkPiece`, `CommP`, `AggregateDeals` (5 ostatnich) |
| sealing sektora | SP-DB | `sectors_sdr_pipeline`: `after_sdr`, `after_tree_r`, `after_precommit_msg…`, `after_porep`, `after_commit_msg…`, `failed…` |
| deale nachodzące na okno pobrań | STAN-DEMO | inne deale na tym samym SP z nakładającym się czasem |
| stan sektora | ŁAŃCUCH | `StateSectorGetInfo` → `SealedCID`, `Activation`, `Expiration` |
| PreCommit | ŁAŃCUCH | `StateListMessages(To: miner, od createdHeight − 5)` → `ChainGetMessage` (metoda 28) → `StateDecodeParams` → `UnsealedCid`; `StateSearchMsg` → wysokość i exit code |
| ProveCommit | ŁAŃCUCH | jak wyżej, metoda 34 → `SectorActivations[].Pieces[]` |
| rozmiar sektora | ŁAŃCUCH | `StateMinerInfo.SectorSize` |
| dowody PDP po dealu | ŁAŃCUCH | `getDataSetLastProvenEpoch` dla data setów plików z deala, porównane z `createdHeight` |

Wiadomości z łańcucha zapisują się w `deal.chain`. Demo szuka ich ponownie tylko do czasu, aż obie mają exit code 0.

### 7.2 Jak liczone są kroki

| Krok | „gotowe”, gdy | Źródło |
|---|---|---|
| SP przyjął deal | jest `created_at` u SP albo jakikolwiek status mk20 | SP-DB / SP-HTTP |
| Pobranie plików | wszystkie dzieci `downloaded`, albo agregat już jest | SP-DB |
| CommP | wszystkie dzieci `after_commp`, albo agregat już jest | SP-DB |
| Agregat | któreś dziecko `aggregated` albo znany jest sektor | SP-DB |
| Sealing | `after_tree_r` albo PreCommit już widać | SP-DB / ŁAŃCUCH |
| PreCommit | wiadomość 28 z exit code 0 | ŁAŃCUCH |
| PoRep | `after_porep` albo ProveCommit już widać | SP-DB / ŁAŃCUCH |
| ProveCommit | wiadomość 34 z exit code 0 | ŁAŃCUCH |
| Sektor aktywny | ProveCommit OK **i** jego kawałek = (`aggregateCidV1`, `pieceSize`) z planu **i** `StateSectorGetInfo` zwraca sektor | ŁAŃCUCH vs LOKALNIE |
| SP zakończył deal | aktywny **i** (status mk20 `complete` albo wszystkie wiersze potoku `complete`, albo potok już sprzątnięty i jest `market_piece_deal`) | SP-HTTP / SP-DB |

Dodatkowe zasady:
- Gdy sektor jest aktywny, wcześniejsze kroki SP są oznaczane jako gotowe, nawet jeśli Curio usunęło już ich wiersze.
- Pierwszy niegotowy krok jest „w toku”. Zmienia się w „błąd”, gdy jest powód: `sectors_sdr_pipeline.failed`, status mk20 `failed` albo błąd zadania pasujący do `mismatch|EOF|failed`.

Kontrole na karcie deala mają podpisane źródło: „klient”, „baza SP”, „klient → SP”, „wiadomość on-chain”, „stan on-chain”, „PDPVerifier”.

---

## 8. Weryfikacja PoDSI

**Co się dzieje:** przycisk jest aktywny dopiero, gdy ostatni krok jest gotowy. Serwer sprawdza to jeszcze raz i wymaga PreCommit z exit code 0. Potem pobiera agregat i uruchamia `podsicheck`.

| Wejście `podsicheck` | Skąd |
|---|---|
| plik agregatu | SP-HTTP: `GET <marketUrl węzła PoRep>/piece/<aggregateCidV2>`, zapis w `/data/aggregates/<deal>.bin` |
| rozmiar agregatu | LOKALNIE: `plan.pieceSize` |
| oczekiwany korzeń | LOKALNIE: `plan.aggregateCidV2` |
| lista dzieci | LOKALNIE: `plan.children[].pieceCidV2` (= SYNAPSE `pieceCid`) |
| `SECTOR_SIZE` | ŁAŃCUCH: `StateMinerInfo.SectorSize` |
| `SECTOR_COMMD` | ŁAŃCUCH: `UnsealedCid` z PreCommit (metoda 28) |

Wynik w `deal.podsi`: czas, `ok`, pełny tekst wyjścia, rozmiar i sha256 pobranego agregatu. `ok = true` tylko wtedy, gdy wyjście zawiera `equals on-chain UnsealedCid: true`, a `podsicheck` zakończył się kodem 0.

Wiersze wyniku w UI to fragmenty tego tekstu:
- „agregat = zaplanowany”: linia `aggregate file: … equals aggregate root: true`;
- liczba segmentów: linie `recomputed CommP … match=true`;
- dowody włączenia: linie `VERIFIED=true`;
- CommD sektora: linia `equals on-chain UnsealedCid: true`.

---

## 9. Czego demo nie robi samo

- **Bajty plików nie przechodzą przez demo do SP PoRep.** Demo wysyła tylko CID-y i URL-e; SP PoRep pobiera z SP PDP. Demo pobiera bajty tylko w dwóch miejscach: plik z PDP przy „Sprawdź” (porównanie sha256) i agregat od SP PoRep przy PoDSI.
- **SP-DB to podgląd tylko dla demo.** Prawdziwy klient ma tylko status mk20, łańcuch i `/piece/`. Kroki „Pobranie” i „CommP” klient zobaczyłby jedynie jako status `processing`.
- **Nie blokuje** dzieci o tym samym PieceCID w jednym agregacie ani ponownego wysłania tego samego agregatu do tego samego SP (błąd Curio, `DEMO-JAK-DZIALA.md` §12.1).
- **Nie pilnuje deali w tle.** Stan liczy się przy odświeżeniu karty. Zamknięta karta niczego nie psuje; po otwarciu demo doczyta stan.
