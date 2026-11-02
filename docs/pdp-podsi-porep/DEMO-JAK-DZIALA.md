# Demo PDP → PoDSI → PoRep: jak działa, krok po kroku

Opis aplikacji `demo/` (port 8787) na podstawie przebiegów z 2026-10-29 na lokalnym devnecie (NV29, Lotus v1.38.3, Curio v1.29.0 `409a2ab`, FOC v1.5.0, Synapse SDK v2.0.2). Każdy krok ma: co robi aplikacja (plik i linia w `demo/`), czego używa (link do oficjalnej dokumentacji albo źródła) i jak to sprawdzić ręcznie.

Powiązane: `DEMO-PRZEPLYW-DANYCH.md` (skąd pochodzi każda wartość) i `DEMO-KOD.md` (łańcuch wywołań z plikiem i linią w `demo/`).

Topologia, o którą prosił Kuba: **jeden transfer, z węzła PDP prosto do węzła PoRep**. Orkiestrator (demo) przesyła tylko CID-y i URL-e, nigdy bajty.

| Węzeł | Rola | Kontener | Miner | Baza HarmonyDB |
|---|---|---|---|---|
| A | PDP (Synapse/FWSS) | `porep-market-curio-devnet-curio-1` | t01005 | `yugabyte` |
| B | tylko PoRep | `porep-node-b-curio-porep-1` | t01035 | `curio_porep` |

---

## 0. Dowód, że demo działa

Sprawdzone na danych, które już są w devnecie (bez nowych uploadów):

| Deal | SP | Pliki (format) | Sektor | Oś czasu (10 kroków) | On-chain | PoDSI |
|---|---|---|---|---|---|---|
| `01M63HXYM1Y1JAX3Y86YGR21SW` | B t01035 | `losowe.bin` (raw), `notatki.md` (raw), `dane.car` (car) | 0 | wszystkie ✓ | PreCommit i ProveCommit exit 0 | OK |
| `01M63J75SBEDN46CCQHNMTR1V1` | A t01005 | `dane.car` (car), `losowe.bin` (raw) | 0 | wszystkie ✓ | exit 0 | OK |
| `01M63K60X33P996M1BZ6FF99PM` | B t01035 | `podstep.txt`, `backup.bin` (raw) | 1 | wszystkie ✓ (po odblokowaniu indeksowania, §12.2) | exit 0 | OK |
| **`01M63T1XSWF973P0KX1DE9C638`** | B t01035 | **prawdziwy CAR 1 500 383 B + raw 1 500 000 B** | 4 | wszystkie ✓ | exit 0 | OK |
| `01M63XSVN71QFZ98RNEGZQAJQ7` | B t01035 | te same dwa pliki co wyżej | 6 | wszystkie ✓ | exit 0 | nie uruchamiano |
| `01M63XQJDY31HF332Q9CQQ1FAC` | B t01035 | 3 pliki, w tym 2 identyczne | – | stoi na AggregateDeals | – | – (błąd Curio, §12.1) |

Najmocniejszy przykład to deal z sektorem 4: jedno dziecko CAR i jedno raw w tym samym agregacie, na osobnym węźle PoRep.

- Węzeł B pobrał dokładnie 2 pliki (`ParkPiece`: 2 udane, 0 nieudanych; żaden inny deal nie nachodził na to okno).
- `PreCommitSectorBatch2` (exit 0) zawiera `UnsealedCid = baga6ea4seaqofrsmiqmz5ilrurjnbl6vfvkxgye4k5zwij5lc6zzpnihmyr4yli`, czyli CID agregatu policzony przez klienta, zanim cokolwiek wysłał.
- `ProveCommitSectors3` (exit 0, wysokość 2459) zawiera jeden kawałek: ten agregat, 8 388 608 B.
- `podsicheck` na bajtach pobranych z węzła B: CommP całego pliku = korzeń agregatu, 2 wpisy indeksu z poprawnym CommP, oba dowody włączenia `VERIFIED=true`, CommD sektora = `UnsealedCid` on-chain.
- PDP na węźle A dalej działa: kawałek CAR (data set 1, pieceId 9) ma `pieceLive = true`, PieceCID on-chain = lokalny, bajty z `/piece/` = oryginał (sha256), `lastProvenEpoch` rośnie (4814 przy wysokości 4871).

Ścieżka CLI (bez demo, z `sptool` i łatką `0002`) przeszła osobno: `TWO_NODE=1 bash docs/pdp-podsi-porep/e2e.sh`, PASS 2026-10-29 (deal `01M63M59HVYWVR7Q35TREV8256`, sektor 3, dowody w `.runtime/pdp-podsi-porep/20261029-114355/`).

---

## 1. Wgranie pliku do aplikacji

**Co robi demo:** `POST /api/files` (`demo/server/index.ts:56`).

1. Sprawdza rozmiar: od 127 B (minimum PDP) do 4 MB (sektory devnetu mają 8 MiB, a agregat potrzebuje co najmniej 2 plików).
2. Wykrywa format. Plik jest `car` tylko wtedy, gdy parsuje się jako CAR v1, czyli nagłówek i każdy blok (`isCar()`, `index.ts:44`). Wszystko inne to `raw`. Sama nazwa `.car` niczego nie zmienia. Plik z rozszerzeniem `.car`, który nie jest CAR-em, dostaje ostrzeżenie z komendą `npx ipfs-car pack`.
3. Liczy sha256 oryginału (do późniejszego porównania z tym, co odda SP).

**Biblioteki:**
- [`@ipld/car`, `CarReader.fromBytes`](https://github.com/ipld/js-car) i [specyfikacja CAR v1](https://ipld.io/specs/transport/car/carv1/).
- [`ipfs-car`](https://github.com/storacha/ipfs-car): tworzy prawdziwy CAR z dowolnego pliku.
- [Hono](https://hono.dev) jako serwer HTTP backendu.

---

## 2. Zapis do PDP przez Synapse

**Co robi demo:** `upload()` w `demo/server/pdp.ts:76`. Uploady idą po kolei, bo dzielą jeden portfel (równoległe transakcje ścigałyby się o nonce).

| Krok | Kod | Dokumentacja |
|---|---|---|
| Klient Synapse dla devnetu: `Synapse.create({ chain: toChain(validateDevnetInfo(devnet-info.json)), account, source })` | `pdp.ts:24` | [Devnet Configuration](https://docs.filecoin.cloud/resources/devnet/), [Synapse SDK](https://docs.filecoin.cloud/developer-guides/synapse/) |
| Lokalny PieceCID (CommP, PieceCID v2): `Piece.calculate(bytes)` z `@filoz/synapse-core/piece` | `pdp.ts:81` | [Synapse Core → Storage (`piece.calculate`)](https://docs.filecoin.cloud/developer-guides/synapse-core/#storage), [FRC-0069 PieceCID v2](https://github.com/filecoin-project/FIPs/blob/master/FRCs/frc-0069.md) |
| Wybór SP PDP: `synapse.storage.createContexts({ copies: 1 })` | `pdp.ts:86` | [Storage Operations → Multiple Contexts](https://docs.filecoin.cloud/developer-guides/storage/storage-operations/#multiple-contexts) |
| Koszty i depozyt: `synapse.storage.prepare({ context, pieceSizes })`, potem `transaction.execute()` | `pdp.ts:88–95` | [Storage Costs → Upload Preparation](https://docs.filecoin.cloud/developer-guides/storage/storage-costs/#upload-preparation) |
| Obejście dla devnetu: `approve` + `deposit` (viem), gdy trzeba dopłacić bez nowej zgody | `pdp.ts:53` | [Payment Operations → Fund Your Account](https://docs.filecoin.cloud/developer-guides/payments/payment-operations/#fund-your-account) (wariant „two transactions”), [Filecoin Pay](https://docs.filecoin.cloud/core-concepts/filecoin-pay-overview/) |
| Upload z callbackami `onStored`, `onPiecesAdded`, `onPiecesConfirmed` | `pdp.ts:97` | [Upload Pipeline → Upload with Callbacks](https://docs.filecoin.cloud/developer-guides/storage/upload-pipeline/#upload-with-callbacks) |
| Wynik: `pieceCid`, `copies[0].{providerId, dataSetId, pieceId, retrievalUrl}` | `pdp.ts:115` | [Upload Pipeline → Simple Upload](https://docs.filecoin.cloud/developer-guides/storage/upload-pipeline/#simple-upload) |

**Dlaczego obejście płatności:** Synapse dopłaca depozyt przez `depositWithPermit` (podpis [ERC-2612](https://eips.ethereum.org/EIPS/eip-2612)). Mock USDFC na devnecie nie ma `nonces()`, więc ta transakcja się wywraca. Dokumentacja Synapse opisuje `approve` + `deposit` jako równoważną drogę w dwóch transakcjach. Na mainnecie (prawdziwy USDFC) obejście nie jest potrzebne.

**Co się dzieje po stronie SP PDP (węzeł A):** Curio przyjmuje bajty i sam liczy PieceCID. Potem dodaje kawałek do data setu w kontrakcie PDPVerifier (`addPieces`) i od tej pory odpowiada na wyzwania PDP. Opis protokołu: [Proof of Data Possession](https://docs.filecoin.cloud/core-concepts/pdp-overview/), kontrakty: [FilOzone/pdp](https://github.com/FilOzone/pdp), [FilOzone/filecoin-services (FWSS)](https://github.com/FilOzone/filecoin-services), Curio jako SP PDP: [Curio-PDP](https://docs.curiostorage.org/getting-started/curio-pdp), [Enable PDP](https://docs.curiostorage.org/experimental-features/enable-pdp).

---

## 3. Sprawdzenie, że plik jest w PDP („Sprawdź” w UI)

**Co robi demo:** `verifyFile()` (`pdp.ts:155`). Czyta stan prosto z łańcucha i z SP, bez pośredników:

| Sprawdzenie | Jak |
|---|---|
| Data set i kawałek żyją | `PDPVerifier.dataSetLive(setId)`, `pieceLive(setId, pieceId)` |
| PieceCID zapisany on-chain = lokalny | `getPieceCid(setId, pieceId)` → dekodowanie CID (`multiformats`) |
| SP dowodzi | `getDataSetLastProvenEpoch`, `getNextChallengeEpoch`. Demo pokazuje dowód dopiero po wysokości dodania pliku |
| SP oddaje te same bajty | `GET <retrievalUrl>` = `http://curio:12310/piece/<PieceCID>`, porównanie sha256 z oryginałem |

Biblioteki i źródła: [viem `readContract`](https://viem.sh/docs/contract/readContract), [Retrieval → Direct SP Retrieval](https://docs.filecoin.cloud/core-concepts/retrieval/#direct-sp-retrieval), interfejs PDPVerifier w [FilOzone/pdp](https://github.com/FilOzone/pdp).

**Ręcznie** (komendy, które demo pokazuje przy pliku; przykład dla data setu 1, kawałka 9):

```bash
C=porep-market-curio-devnet-curio-1
PDP=$(docker exec $C jq -r .info.contracts.pdp_verifier_proxy_addr /var/lib/contracts/devnet-info.json)
CAST() { docker exec $C cast call --rpc-url http://lotus:1234/rpc/v1 "$@"; }
CAST $PDP 'getPieceCid(uint256,uint256)((bytes))' 1 9
CAST $PDP 'pieceLive(uint256,uint256)(bool)' 1 9                    # true
CAST $PDP 'getDataSetLastProvenEpoch(uint256)(uint256)' 1          # rośnie z czasem
curl -s http://127.0.0.1:22310/piece/bafkzcibeug3cgehz2jctvpeqtx2afk3dwxhcavs6krt4a5psxtlcdepgs52hx2jkei | shasum -a 256
#  b958da9d74c165e8…  = sha256 z UI (prawdziwy CAR, 1 500 383 B)
```

---

## 4. Plan agregatu PoDSI (przed wysłaniem czegokolwiek)

**Co robi demo:** `POST /api/plan` → `planAggregate()` (`demo/server/podsi.ts:12`) uruchamia `demo/aggplan` (Go).

Klient liczy CID agregatu i układ plików **z samych PieceCID dzieci**, bez bajtów:

1. `commcid.PieceCidV1FromV2(v2)`: z PieceCID v2 wyciąga CommP i rozmiar danych (`aggplan/main.go:66`).
2. `datasegment.ComputeDealPlacement(deals)`: miejsce każdego dziecka (wyrównanie do potęgi 2) (`main.go:75`).
3. Rozmiar agregatu = następna potęga 2 nad (miejsce dzieci + indeks). Dokładnie tak liczy Curio i `sptool mk20-client aggregate`.
4. `datasegment.NewAggregate(pieceSize, deals)` → `PieceCID()` agregatu, offset indeksu (`DataSegmentIndexStartOffset`), liczba wpisów (`MaxIndexEntriesInDeal`).

UI pokazuje pasek z układem i sprawdza, czy agregat mieści się w sektorze wybranego SP (`StateMinerInfo.SectorSize`).

**Dokumentacja:**
- [FRC-0058 Verifiable Data Aggregation (PoDSI)](https://github.com/filecoin-project/FIPs/blob/master/FRCs/frc-0058.md): wpis indeksu ma 64 B (CommDS 32 B, Offset 8 B, Size 8 B, Checksum 16 B), indeks leży na końcu agregatu.
- [go-data-segment](https://github.com/filecoin-project/go-data-segment), [API `datasegment`](https://pkg.go.dev/github.com/filecoin-project/go-data-segment/datasegment).
- [Curio Market 2.0 → Architecture → Aggregation](https://docs.curiostorage.org/market-2.0/architecture): obsługiwany jest tylko `AggregateTypeV1` (FRC-0058), a kolejność dzieci ma znaczenie.

---

## 5. Deal do SP PoRep (Market 2.0 / mk20)

**Co robi demo:** `POST /api/deals` → `createDeal()` (`demo/server/deals.ts:26`) → `buildDeal()` i `submitDeal()` (`demo/server/mk20.ts:61`, `:89`).

1. **Adres SP:** demo zna węzły z konfiguracji. Dla obcego minera bierze adres rynku z `StateMinerInfo.Multiaddrs`, tak jak `sptool` ([Lotus API → State](https://lotus.filecoin.io/reference/lotus/state/)).
2. **Manifest:** dla każdego dziecka `piece_cid` (v2), `format` (`raw` albo `car`) i `source_http.urls = [<URL /piece/ na węźle A>]`. Całość ma `format.aggregate.type = 1` i `piece_cid` = CID agregatu z kroku 4.
3. **Produkty:** `ddo_v1` (provider, `duration: 518400`, bez adresu rynku) oraz `retrieval_v1` (`indexing: true`, `announce_piece: false`).
4. **Podpis:** nagłówek `Authorization: CurioAuth delegated:<adres>:<podpis>`. Podpisywane jest `sha256(adres || METODA || ścieżka || minuta RFC3339)`. Klucz to ten sam klucz Ethereum, którym Synapse płaci za PDP, jako adres f410 (`authHeader()`, `mk20.ts:30`). Bez `sptool` i bez osobnego portfela.
5. `POST /market/mk20/deal`, potem `GET /market/mk20/status/{id}` do `complete`.

**Dokumentacja:**
- [Market 2.0 → Deal Processing](https://docs.curiostorage.org/market-2.0/deal-processing): ścieżka „Provider-Pull Deal” (`POST /deal`, potem `GET /status/{id}`), statusy `accepted → processing → sealing → indexing → complete`.
- [Market 2.0 → Architecture](https://docs.curiostorage.org/market-2.0/architecture): obiekt `DataSource`, `PieceDataFormat { car | aggregate | raw }`, nagłówek `CurioAuth` (typy kluczy `secp256k1`, `bls`, `delegated`), okno ważności podpisu (bieżąca i poprzednia minuta).
- [Market 2.0 → HTTP API](https://docs.curiostorage.org/market-2.0/http-api), [OpenAPI](https://docs.curiostorage.org/experimental-features/market-2.0-api).
- [DDO v1](https://docs.curiostorage.org/market-2.0/products/ddo_v1): `duration ≥ 518400`, `retrieval_v1` wymagany, `announce_piece = false`. Ta strona mówi też „Raw format cannot be indexed”. Dotyczy to formatu całego deala; nasz deal ma format `aggregate`, więc `indexing: true` przechodzi.
- Implementacja podpisu w Curio: [`market/mk20/client/auth.go`](https://github.com/filecoin-project/curio/blob/v1.29.0/market/mk20/client/auth.go).
- Krzywa i hashe: [noble-curves](https://github.com/paulmillr/noble-curves) (secp256k1 nad `keccak256(digest)`, tak jak Lotus weryfikuje podpisy `delegated`).

### 5a. To samo z `sptool`: łatka `0002`

Demo woła API mk20 bezpośrednio i od razu wysyła `format: { raw: {} }`. **Serwer Curio v1.29.0 akceptuje to bez zmian**: pole `Raw *FormatBytes` istnieje w API ([`market/mk20/types.go:73`](https://github.com/filecoin-project/curio/blob/v1.29.0/market/mk20/types.go#L73)).

Brak jest tylko w kliencie CLI. `sptool toolbox mk20-client deal --aggregate <manifest>` ([dokumentacja `sptool`](https://docs.curiostorage.org/curio-cli/sptool)) czyta manifest w formacie `pieceCidV2<TAB>url` i każdemu dziecku na sztywno wpisuje `Format.Car` ([`toolbox_deal_client.go:1826` i `:1843–1846`](https://github.com/filecoin-project/curio/blob/v1.29.0/cmd/sptool/toolbox_deal_client.go#L1826-L1856)). Dziecko raw wysłane przez niezmienione `sptool` byłoby więc opisane jako CAR.

Łatka `patches/curio/0002-sptool-mk20-aggregate-raw-subpieces.patch` dodaje opcjonalną trzecią kolumnę manifestu:

```diff
-				if len(parts) != 2 {
-					return fmt.Errorf("invalid line format. Expected pieceCidV2, url at %s", line)
+				if len(parts) != 2 && len(parts) != 3 {
+					return fmt.Errorf("invalid line format. Expected pieceCidV2, url[, car|raw] at %s", line)
 				}
 ...
+				// Optional third column selects the sub-piece format; CAR stays the default.
+				format := mk20.PieceDataFormat{Car: &mk20.FormatCar{}}
+				if len(parts) == 3 {
+					switch parts[2] {
+					case "car":
+					case "raw":
+						format = mk20.PieceDataFormat{Raw: &mk20.FormatBytes{}}
+					default:
+						return fmt.Errorf("invalid sub-piece format %q, expected car or raw at %s", parts[2], line)
+					}
+				}
```

Manifest z łatką:

```
bafkzcib…dziecko1	http://curio:12310/piece/bafkzcib…dziecko1	car
bafkzcib…dziecko2	http://curio:12310/piece/bafkzcib…dziecko2	raw
```

Bez trzeciej kolumny `sptool` zachowuje się jak upstream (CAR), więc łatka jest wstecznie zgodna. Pełna ścieżka CLI: `REPRODUKCJA.md` §8.6 i `INSTRUKCJA-UZYTKOWNIKA.md` §9.

---

## 6. Węzeł B pobiera pliki z węzła A (jedyny transfer)

**Kto co robi:** demo wysyła tylko manifest. Węzeł B sam pobiera bajty z URL-i w manifeście, czyli z endpointu `/piece/<PieceCID>` SP PDP na węźle A. Węzeł A nie wie o dealu (`market_mk20_deal` na A ma 0 wierszy); dla niego to zwykły retrieval.

**W Curio (węzeł B):**
1. Przyjęcie deala zapisuje dla każdego dziecka wiersz w `parked_pieces` (`long_term = false`, kopia tymczasowa) i `parked_piece_refs` z URL-em.
2. Zadanie **`ParkPiece`** czyta URL i strumieniuje bajty na dysk SP: `dealdata.NewUrlReader(...)`, potem `WritePiece(...)` ([`tasks/piece/task_park_piece.go:203`](https://github.com/filecoin-project/curio/blob/v1.29.0/tasks/piece/task_park_piece.go#L203)). Plik ląduje jako `/var/lib/curio/piece/s-t00-<id>`.
3. Jeśli podano kilka URL-i, próbuje kolejnych; błąd jest dopiero wtedy, gdy żaden nie zadziała.

**Dokumentacja:**
- [Market 2.0 → Deal Processing → Provider-Pull Deal](https://docs.curiostorage.org/market-2.0/deal-processing): „Use this path when the storage provider should fetch data from client-supplied sources”.
- [Curio → Sealing → Piece Park](https://docs.curiostorage.org/design/sealing).
- Endpoint, z którego B pobiera: [Curio → Retrievals](https://docs.curiostorage.org/curio-market/retrievals) („`/piece/{cid}` … serves the content directly”).

**Co demo pokazuje:** krok „Pobranie z PDP” z licznikiem udanych i nieudanych `ParkPiece` w oknie od przyjęcia deala do zbudowania agregatu (`deals.ts`, zapytanie do `harmony_task_history`). Jeśli w tym samym czasie na tym SP trwał inny deal, demo to zaznacza, bo licznik jest wtedy wspólny.

**Ręcznie:**

```bash
P=porep-market-curio-devnet; B=porep-node-b-curio-porep-1; DEAL=01M63T1XSWF973P0KX1DE9C638
SQLB() { docker exec $P-yugabyte-1 bin/ysqlsh -h yugabyte -U yugabyte -d curio_porep -c "$1"; }
SQL()  { docker exec $P-yugabyte-1 bin/ysqlsh -h yugabyte -U yugabyte -d yugabyte    -c "$1"; }
SQLB "SELECT result, count(*) FROM curio.harmony_task_history WHERE name='ParkPiece'
      AND work_start >= (SELECT created_at FROM curio.market_mk20_deal WHERE id='$DEAL') GROUP BY 1;"
SQL  "SELECT count(*) FROM curio.market_mk20_deal WHERE id='$DEAL';"     # 0: węzeł A nie zna deala
docker exec $B ls -la /var/lib/curio/piece /var/lib/curio/sealed           # pliki na dysku B
docker logs $B 2>&1 | grep -i parkpiece | tail
```

**Czy to fizyczna kopia?** Tak. Bajty przechodzą przez sieć z A na B i są zapisywane na dysku B. Kopia tymczasowa (`long_term = f`) jest usuwana po zbudowaniu agregatu (zadanie `DropPiece`). Na B zostaje agregat (`long_term = t`) i sektor.

---

## 7. Jak SP sprawdza CommP każdego pliku

**W Curio (węzeł B):** zadanie **`CommP`** ([`tasks/storage-market/task_commp.go:236`](https://github.com/filecoin-project/curio/blob/v1.29.0/tasks/storage-market/task_commp.go#L200-L237)):

1. Czyta pobrane bajty z dysku i przepuszcza je przez `proof.DataCidWriter`. Sprawdza, że liczba bajtów = rozmiar z deala.
2. Jeśli trzeba, dopełnia CommP do rozmiaru z PieceCID (`PadCommP`).
3. Porównuje z PieceCID z manifestu. Przy różnicy: `commP mismatch calculated … and supplied …`, zadanie kończy się błędem.

CommP liczy się z **bajtów takich, jakie są**, więc dla `raw` i `car` to ta sama operacja. Format wpływa tylko na indeksowanie (krok 10). Ten sam PieceCID policzyły już wcześniej trzy strony: klient (Synapse, krok 2), SP PDP (Curio A) i kontrakt PDPVerifier (zapis on-chain). Przez to podmiana danych na węźle A wychodzi tutaj.

**Dokumentacja:**
- [Filecoin spec → Piece](https://spec.filecoin.io/systems/filecoin_files/piece/): czym jest CommP (korzeń drzewa Merkle po paddingu Fr32).
- [FRC-0069 PieceCID v2](https://github.com/filecoin-project/FIPs/blob/master/FRCs/frc-0069.md): CommP + rozmiar danych w jednym CID.
- [go-fil-commp-hashhash](https://github.com/filecoin-project/go-fil-commp-hashhash): implementacja CommP używana w Go.
- [Curio Storage Market → CommP tasks](https://docs.curiostorage.org/curio-market/storage-market).

**Przetestowane** (`e2e.sh`, krok 11, `TWO_NODE=1`): podrobione bajty o innej długości odpadają już przy pobraniu. Te same długości odpadają tutaj, z `commP mismatch`.

---

## 8. Budowa agregatu na węźle B

**W Curio (węzeł B):** zadanie **`AggregateDeals`** ([`tasks/storage-market/task_aggregation.go`](https://github.com/filecoin-project/curio/blob/v1.29.0/tasks/storage-market/task_aggregation.go#L189-L284)):

| Linia (v1.29.0) | Co robi |
|---|---|
| 189 | `datasegment.ComputeDealPlacement(pinfos)`: miejsce dzieci, to samo co u klienta w kroku 4 |
| 198 | `datasegment.NewAggregate(next, pinfos)`: indeks PoDSI |
| 203 | `aggr.AggregateObjectReader(readers)`: strumień dziecko 1 + padding + dziecko 2 + … + indeks na końcu |
| 211–218 | transakcja: wiersz `parked_pieces` dla agregatu (`long_term = true`) |
| 273 | `WriteUploadPiece(...)`: zapis agregatu na dysk i jednoczesne liczenie jego CommP |
| 278–284 | CommP i rozmiar agregatu muszą być równe CID agregatu z deala (`commP mismatch` przy różnicy) |

Bajty dziecka raw leżą w agregacie dokładnie tak, jak je wgrałeś (w dealu z sektorem 4 dziecko raw zaczyna się od `# Dokument testo…`), a dziecko CAR jako CAR (zaczyna się od nagłówka `roots`). Nic nie jest pakowane ani przepisywane.

**Dokumentacja:** [FRC-0058](https://github.com/filecoin-project/FIPs/blob/master/FRCs/frc-0058.md), [Market 2.0 → Architecture → Aggregation](https://docs.curiostorage.org/market-2.0/architecture), [go-data-segment](https://github.com/filecoin-project/go-data-segment).

---

## 9. Sealing i zapis na łańcuchu

**W Curio (węzeł B):** agregat trafia do sektora. Potok: `SDR → TreeD → TreeRC → PreCommitBatch → PoRep → CommitBatch`. Opis potoku: [Curio → Sealing → Sealing Pipeline](https://docs.curiostorage.org/design/sealing).

Na łańcuchu są dwie wiadomości od minera:

| Wiadomość | Metoda aktora minera | Co w niej sprawdzamy |
|---|---|---|
| `PreCommitSectorBatch2` | 28 | `UnsealedCid` (CommD sektora) = CID agregatu |
| `ProveCommitSectors3` | 34 (DDO, [FIP-0076](https://github.com/filecoin-project/FIPs/blob/master/FIPS/fip-0076.md)) | lista kawałków sektora = `[agregat, 8 388 608 B]` |

Numery metod: [go-state-types `builtin/v16/miner/methods.go`](https://github.com/filecoin-project/go-state-types/blob/master/builtin/v16/miner/methods.go).

**Co robi demo:** `sectorMessages()` w `demo/server/lotus.ts` wyszukuje wiadomości minera (`StateListMessages`), czyta je (`ChainGetMessage`) i dekoduje parametry (`StateDecodeParams`). Pokazuje exit code każdej wiadomości. Krok „Sektor aktywny” bierze z `StateSectorGetInfo` (`Activation`). Krok PoDSI jest dostępny dopiero po PreCommit z exit code 0. Metody RPC: [Lotus API → State](https://lotus.filecoin.io/reference/lotus/state/), [Lotus API → Chain](https://lotus.filecoin.io/reference/lotus/chain/).

**Ręcznie** (sprawdzone na sektorze 4 t01035):

```bash
L=porep-market-curio-devnet-lotus-1
docker exec $L lotus state sector t01035 4                     # SealedCID, Activation, Expiration
docker exec $L sh -c 'lotus chain decode params --encoding=base64 t01035 28 \
  "$(lotus chain get-message <CID PreCommit z UI> | jq -r .Params)"'   # → "UnsealedCid": baga6ea4seaqofrsm…
```

Pełne wyszukiwanie wiadomości bez znajomości CID: `REPRODUKCJA.md` §8.8 (z ograniczeniem `--toheight`).

---

## 10. Indeksowanie i koniec deala

Po aktywacji sektora Curio robi **`Indexing`** (bloki CAR dzieci do lokalnego indeksu; dziecko raw nie ma bloków IPLD do zaindeksowania) i zapisuje kawałek w `market_piece_deal`. Status klienta przechodzi na `complete`. Dopiero wtedy demo zapala ostatni krok „SP zakończył deal”.

Dokumentacja: [Curio → Indexing](https://docs.curiostorage.org/curio-market/indexing), statusy: [Deal Processing → Status Checks](https://docs.curiostorage.org/market-2.0/deal-processing).

---

## 11. Weryfikacja PoDSI przez klienta

**Co robi demo:** przycisk „Sprawdź PoDSI” → `verifyPodsi()` (`demo/server/podsi.ts:25`):

1. Pobiera agregat od SP PoRep jak każdy klient: `GET http://curio-porep:12310/piece/<CID agregatu v2>` ([Curio → Retrievals](https://docs.curiostorage.org/curio-market/retrievals)). Zapis w `.runtime/demo/aggregates/`.
2. Uruchamia `podsicheck` (`docs/pdp-podsi-porep/podsicheck`, Go, [go-data-segment](https://pkg.go.dev/github.com/filecoin-project/go-data-segment/datasegment)):

| # | Sprawdzenie | Funkcja |
|---|---|---|
| 0 | CommP **całego** pobranego pliku = korzeń agregatu, a rozmiar = rozmiar deala | `commp.Calc` po wszystkich bajtach |
| 1 | Indeks PoDSI z końca pliku: liczba poprawnych wpisów, offset i rozmiar każdego | `DataSegmentIndexStartOffset`, `ParseDataSegmentIndex` |
| 2 | CommP bajtów każdego segmentu, wyciętych z agregatu = CommDS we wpisie = PieceCID dziecka z PDP | `commp.Calc` na wycinku |
| 3 | Agregat odbudowany z samych CID dzieci = korzeń | `NewAggregate(...).PieceCID()` |
| 4 | Dowód włączenia każdego dziecka prowadzi do korzenia | `ProofForPieceInfo`, `ComputeExpectedAuxData` |
| 5 | CommD sektora (agregat + zera do rozmiaru sektora) = `UnsealedCid` z PreCommit on-chain | `PieceAggregateCommP`, `ZeroPadPieceCommitment` |

Wynik OK wymaga linii `equals on-chain UnsealedCid: true`. Krok 0 dodano po przeglądzie GPT: bez niego plik z podmienionymi bajtami poza segmentami i indeksem też by przeszedł. Przetestowane: zmiana jednego bajtu na offsecie 1 000 000 jest odrzucana.

**Ręcznie:**

```bash
curl -sI http://127.0.0.1:22410/piece/<CID agregatu v2>   # 200 OK od węzła B, dopiero po „complete”
```

---

## 12. Znane problemy (znalezione w trakcie)

1. **Ten sam agregat drugi raz na tym samym SP blokuje deal** (Curio, do zgłoszenia). Deal `01M63XQJ…` miał dzieci o identycznej treści, a w efekcie ten sam CID agregatu co wcześniejszy deal `01M63TE0…` (sektor 5). `AggregateDeals` znajduje istniejący agregat `long_term` i otwiera go wewnątrz transakcji bazy ([`task_aggregation.go:211–218`](https://github.com/filecoin-project/curio/blob/v1.29.0/tasks/storage-market/task_aggregation.go#L211-L218)). Kończy się to błędem `cannot use a non-transaction func in a transaction`, po 3 próbach deal stoi w `processing`, a tymczasowa kopia dziecka zostaje na dysku. Demo dziś tego nie blokuje.
2. **Pobranie `/piece/<agregat>` przed końcem indeksowania blokuje indeksowanie** (Curio). Błąd trafia do 5-sekundowego cache błędów czytnika kawałków, który dzieli retrieval i indeksowanie. Indeksowanie zużywa wtedy swoje 3 próby i deal nie dochodzi do `complete`. Demo blokuje PoDSI do `complete`. Odblokowanie: `REPRODUKCJA.md` §10.
3. **Mock USDFC bez `nonces()`** (devnet): obejście `approve` + `deposit` (krok 2).
4. **Uśpienie laptopa**: krótkie usuwa wiersz `harmony_machines` (wtedy `docker restart`), dłuższe niż ~1 h zatrzymuje łańcuch na stałe (`just reset`, potem `docker compose up -d --force-recreate` w `demo/`).

---

## 13. Mapa: krok → plik demo → dokumentacja

| # | Krok | Demo | Główna dokumentacja |
|---|---|---|---|
| 1 | Wgranie, wykrycie CAR | `server/index.ts:44–85` | [js-car](https://github.com/ipld/js-car) |
| 2 | Zapis do PDP | `server/pdp.ts:76–131` | [Upload Pipeline](https://docs.filecoin.cloud/developer-guides/storage/upload-pipeline/) |
| 3 | Weryfikacja PDP | `server/pdp.ts:155–209` | [PDP overview](https://docs.filecoin.cloud/core-concepts/pdp-overview/) |
| 4 | Plan agregatu | `aggplan/main.go`, `server/podsi.ts:12` | [FRC-0058](https://github.com/filecoin-project/FIPs/blob/master/FRCs/frc-0058.md) |
| 5 | Deal mk20 | `server/mk20.ts`, `server/deals.ts:26` | [Market 2.0](https://docs.curiostorage.org/market-2.0/architecture) |
| 5a | `sptool` + łatka `0002` | `patches/curio/0002-…` | [sptool](https://docs.curiostorage.org/curio-cli/sptool) |
| 6 | Pobranie A → B | (Curio `ParkPiece`) | [Deal Processing](https://docs.curiostorage.org/market-2.0/deal-processing) |
| 7 | CommP | (Curio `CommP`) | [Filecoin spec: Piece](https://spec.filecoin.io/systems/filecoin_files/piece/) |
| 8 | Agregat | (Curio `AggregateDeals`) | [go-data-segment](https://github.com/filecoin-project/go-data-segment) |
| 9 | Sealing, on-chain | `server/lotus.ts`, `server/deals.ts` | [Curio Sealing](https://docs.curiostorage.org/design/sealing), [Lotus State API](https://lotus.filecoin.io/reference/lotus/state/) |
| 10 | Indeksowanie | (Curio `Indexing`) | [Curio Indexing](https://docs.curiostorage.org/curio-market/indexing) |
| 11 | PoDSI u klienta | `server/podsi.ts:25`, `podsicheck/` | [`datasegment` API](https://pkg.go.dev/github.com/filecoin-project/go-data-segment/datasegment) |
