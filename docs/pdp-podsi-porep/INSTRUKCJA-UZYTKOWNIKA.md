# Instrukcja użytkownika: dane z PDP → agregat PoDSI → sektor PoRep

Instrukcja dla dwóch ról, **Klienta** (właściciela danych) i **SP** (operatora Curio). Opisuje, jak przejść całą ścieżkę:

1. przygotować dane (plik surowy i plik CAR),
2. wrzucić je do **PDP** (Proof of Data Possession, gorąca kopia u SP),
3. sprawdzić, że są poprawne,
4. zrobić z nich **agregat PoDSI** (FRC-0058),
5. zlecić **deal DDO**, po którym SP **zaseluje** agregat w sektorze **PoRep**,
6. sprawdzić on-chain, że sektor zawiera dokładnie ten agregat.

Komendy są zapisane tak, jak wykonuje się je na zwykłych maszynach klienta i SP, bez Dockera. Dodatek A pokazuje, gdzie te same rzeczy leżą w lokalnym devnecie.

> Ścieżka została sprawdzona 2026-10-28 na lokalnym devnecie z **wersjami oprogramowania i protokołu z mainnetu**: NV29 „Solstice”, aktorzy v19.0.1 (bundle devnetowy), Lotus v1.38.3 (wariant `debug`), Curio v1.29.0, kontrakty FOC (filecoin-services) v1.5.0 z PDPVerifier 3.5.0 (świeży deploy), Synapse SDK v2.0.2. Devnet ma sektory 8 MiB, krótkie czasy i uproszczoną weryfikację PoSt, więc **nie jest identyczną konfiguracją produkcyjnego mainnetu**. Wartości referencyjne w §10 pochodzą z jednego przebiegu.

---

## 0. Pojęcia w pigułce

| Pojęcie | Co to jest |
|---|---|
| **PieceCID / CommP** | Kryptograficzny „odcisk” danych (drzewo Merkle po paddingu fr32). Ten sam plik zawsze daje ten sam CID. **v2** (`bafkzcib…`) wiąże też dokładny rozmiar danych, **v1** (`baga6ea4seaq…`) tylko commitment. Do identyfikacji pliku porównuj CIDv2 (albo commitment **i** rozmiar); sam v1 nie odróżni pliku od tego samego pliku z dopisanymi zerami. |
| **Raw vs CAR** | *Raw* to dowolne bajty (np. backup, obraz dysku). *CAR* to format kontenera IPLD. PDP i PoDSI przyjmują jedno i drugie; ma to znaczenie tylko dla indeksowania i pobierania po CID IPFS. |
| **PDP** | Kontrakt PDPVerifier i usługa FWSS. SP trzyma dane „na gorąco” i regularnie dowodzi on-chain, że je ma. Dane są przypisane do **data setu**. |
| **PoDSI / agregat** | Wiele małych kawałków ułożonych w jeden duży (wyrównane do potęg 2) plus **indeks** na końcu. CID agregatu da się policzyć z samych metadanych kawałków. |
| **DDO** | Direct Data Onboarding: deal bez rynku f05. Od NV29 **bez alokacji datacap** (FIP-0118 zamroził FIL+). Każdy nowy sektor ma pełną moc QA. |
| **CommD** | Odcisk niezaszyfrowanej zawartości sektora. **CommD = CID agregatu tylko wtedy, gdy agregat wypełnia cały sektor** (jak w teście: agregat 8 MiB w sektorze 8 MiB). Mniejszy agregat w sektorze 32/64 GiB jest jednym z kawałków sektora i jego włączenie dowodzi się osobno. |

---

## 1. Składniki

**Po stronie SP:**
- Lotus v1.38.3 (lub zgodny węzeł),
- Curio v1.29.0 z HarmonyDB (Yugabyte),
- parametry proofs dla rozmiaru sektora,
- miner (aktor) z adresem kontrolnym i portfelem z FIL,
- publicznie (lub dla klienta) dostępny endpoint HTTP Curio (`/pdp`, `/piece`, `/market/mk20`).

**Po stronie klienta:**
- Node.js ≥ 22 i **Synapse SDK v2.0.2** (klient PDP),
- **`sptool`** z Curio v1.29.0 z łatką `0002` (kolumna raw/car w manifeście agregatu; patrz §11),
- `cast` (Foundry) do zapytań on-chain (opcjonalnie), `curl`, `cmp`/`sha256sum`,
- portfel klienta: **FIL** na gaz oraz **USDFC** na opłaty za PDP (Filecoin Pay).

**Kontrakty (adresy z `deployments.json` sieci):** PDPVerifier (proxy), FilecoinWarmStorageService (proxy), FilecoinPay, ServiceProviderRegistry, USDFC.

---

## 2. Przygotowanie SP (jednorazowo)

Zakładamy już działającego SP Curio: połączenie z Lotus i HarmonyDB, klucze i uprawnienia minera, storage i działające zadania sealingu. Poniższe ustawienia włączają ścieżkę ingest/PDP/mk20, ale nie zastępują instalacji i konfiguracji sealingu.

### 2.1 Subsystemy Curio

W warstwie konfiguracji, która działa na maszynie z rynkiem (np. `market`):

```toml
[Subsystems]
  EnablePDP = true          # PDP: przyjmowanie i dowodzenie danych
  EnableParkPiece = true    # pobieranie/parkowanie kawałków
  EnableCommP = true        # liczenie CommP po stronie SP
  EnableDealMarket = true   # Market 2.0 (mk20) – deal DDO

[HTTP]
  Enable = true
  DomainName = "<twoja.domena>"   # pod tą nazwą klient i Synapse widzą SP
  # DNS musi wskazywać na SP. Jeśli TLS kończy się na reverse proxy: DelegateTLS = true,
  # w przeciwnym razie skonfiguruj TLS w samym Curio.

[Ingest]
  # Curio domyślnie NIE pobiera danych z prywatnych adresów (ochrona SSRF).
  # Jeśli źródło kawałków jest w sieci prywatnej (np. ten sam Curio po nazwie wewnętrznej),
  # dopisz host:port. Zmiana wymaga restartu Curio.
  SSRFAllowedHosts = ["<host-zrodla>:<port>"]
```

Kontrola, gdzie Curio trzyma dane:

```bash
curio cli storage list
#  Use: Seal Store, Local: <ścieżka>   ← tu trafią kawałki (piece/), sektory (sealed/, cache/)
```

### 2.2 Produkty Market 2.0

W GUI Curio (zakładka Market 2.0 / ustawienia mk20) lub w bazie (`curio.market_mk20_products`, `curio.market_mk20_data_source`) muszą być włączone:

- produkty: `ddo_v1`, `retrieval_v1` (opcjonalnie `pdp_v1`),
- źródła danych: `http` i **`aggregate`**.

Lista klientów (`curio.market_mk20_clients`) może być pusta **tylko przy `[Market.StorageMarketConfig.MK20] DenyUnknownClients = false`** (domyślnie). Jeśli odrzucasz nieznanych klientów, dodaj adres portfela, którym klient podpisuje deal w `sptool` (`allowed = true`).

### 2.3 Rejestracja usługi PDP

Najpierw zaimportuj do Curio **klucz PDP** (GUI → PDP, lub RPC `ImportPDPKey`) i zasil odpowiadający mu adres FIL-em na gaz. Portfel minera nie zastępuje klucza PDP. Potem GUI Curio → **PDP** → rejestracja usługi (lub RPC `FSRegister`): nazwa, opis, lokalizacja, **pojemność w GiB (minimum 100)**. Rejestracja zapisuje SP w `ServiceProviderRegistry`. Na mainnecie SP musi następnie zostać **zatwierdzony** w FWSS (i opcjonalnie dostać endorsement) przez operatora usługi. Na devnecie robi to skrypt startowy.

Kontrola:

```bash
cast call <ServiceProviderRegistry> "getProviderIdByAddress(address)(uint256)" <adres EVM SP>   # ≠ 0
cast call <FWSS> "isProviderApproved(uint256)(bool)" <providerId>                                # true
```

---

## 3. Przygotowanie klienta (jednorazowo)

Najpierw wskaż węzły sieci. Wszystkie trzy muszą wskazywać **tę samą sieć**:

```bash
export FULLNODE_API_INFO="<token>:/dns/<lotus>/tcp/1234/http"  # Lotus API dla sptool (albo LOTUS_PATH do lokalnego repo Lotusa)
export RPC_URL="https://<endpoint-EVM>/rpc/v1"                  # dla Synapse
export ETH_RPC_URL="$RPC_URL"                                   # dla cast
export CURIO_MK12_CLIENT_REPO="$HOME/.curio-client"             # repo klienta sptool (portfel podpisujący deale)
```

`sptool` i Synapse używają **różnych portfeli**: sptool ma własny w `CURIO_MK12_CLIENT_REPO`, Synapse używa `PRIVATE_KEY`. Zanotuj oba adresy. Allowlista SP (§2.2) dotyczy portfela sptool.

```bash
# klient deali (sptool) – tworzy repo z portfelem klienta
sptool --actor <dowolny-miner> toolbox mk20-client init
sptool --actor <dowolny-miner> toolbox mk12-client wallet default   # zasil ten adres FIL-em

# klient PDP (Synapse SDK v2.0.2)
git clone https://github.com/FilOzone/synapse-sdk.git && cd synapse-sdk
git checkout synapse-sdk-v2.0.2
npx pnpm@11.24.0 install --frozen-lockfile && npx pnpm@11.24.0 build
```

Synapse potrzebuje klucza prywatnego portfela z FIL i USDFC (`PRIVATE_KEY=0x…`) oraz wyboru sieci (`NETWORK=mainnet|calibnet|devnet`). Przy pierwszym uploadzie sam robi depozyt w Filecoin Pay i zatwierdzenie operatora (FWSS), a potem tylko z nich korzysta.

---

## 4. Krok 1: przygotowanie danych (klient)

Przykład z testu: jeden plik **surowy** i jeden **CAR**.

```bash
mkdir -p test
# raw: 2 MiB, tekst na początku, potem zera
dd if=/dev/zero of=test/child-raw.bin bs=1048576 count=2
printf "RAW-NOT-CAR\n" | dd of=test/child-raw.bin conv=notrunc
# CAR: dowolny prawdziwy CAR (tu losowy, ~117 KB)
rm -rf prep && mkdir prep    # pusty katalog: prep/*.car musi wskazywać dokładnie jeden plik
sptool --actor <miner> toolbox mk12-client generate-rand-car -s 99700 ./prep && cp prep/*.car test/child-car.car
```

CAR jest losowy, więc jego CID, rozmiar i CID agregatu odczytujesz z własnego przebiegu. Tylko plik raw daje zawsze ten sam CID.

**Jak podejrzeć dane:**

```bash
ls -l test/                      # rozmiary (raw 2097152 B, CAR 120107 B)
sha256sum test/*                 # skróty do porównania (macOS: shasum -a 256 test/*)
head -c 32 test/child-raw.bin | xxd    # początek pliku raw – widać "RAW-NOT-CAR"
car ls test/child-car.car | head       # zawartość CAR (narzędzie go-car), opcjonalnie
```

**Policz PieceCID lokalnie**, przed wysłaniem czegokolwiek:

```bash
sptool --actor <miner> toolbox mk20-client commp test/child-raw.bin   # → CommP CID: bafkzcib…  (to PieceCIDv2)
sptool --actor <miner> toolbox mk20-client commp test/child-car.car
```

Zapisz oba CID (`RAW`, `CAR`). Do tych wartości porównuje się wszystko, co wydarzy się dalej.

> Pułapka: pliku nie wolno zmieniać po policzeniu CID. Każdy bajt zmienia CID.

---

## 5. Krok 2: wrzucenie do PDP (klient)

```bash
cd synapse-sdk
# oba pliki jednym wywołaniem → trafią do tego samego SP i tego samego data setu
NETWORK=<sieć> PRIVATE_KEY=0x… RPC_URL="$RPC_URL" \
  node utils/example-storage-e2e.js ../test/child-raw.bin ../test/child-car.car
```

Zapisz z wyniku dla każdego pliku: **providerId, adres/URL SP, dataSetId, pieceId i PieceCIDv2**. Nie zakładaj wartości z tej instrukcji (`1`, `0`, `1`). SDK sam wybiera providerów i może tworzyć repliki u kilku SP. Do agregatu potrzebny jest SP, który będzie też selował sektor (albo którego `/piece/` jest dostępne dla tego SP).

Na co patrzeć w wyniku:

```
  Selected SP 1 (0x…)                         ← providerId SP
  Creating new data set: 1                    ← (albo użycie istniejącego)
  Stored: bafkzcib…                           ← musi być równy RAW / CAR z kroku 1
  Committed on SP 1 (tx: 0x…)                 ← transakcja dodania do data setu
File: …/child-raw.bin
  PieceCID: bafkzcib…
  [Primary]   Provider 1 - pieceId: 0, dataSetId: 1   ← numer kawałka i data set
  VERIFIED: 2 MB matches original             ← SDK pobrał dane z powrotem i porównał
=== SUCCESS: All files uploaded, replicated, and verified ===
```

**Co dzieje się u SP:** Curio przyjmuje bajty, liczy CommP, zapisuje plik w piece parku (§6.2) i dodaje kawałek do data setu w PDPVerifier. Od tej chwili kontrakt co jakiś czas losuje wyzwania, a SP musi je udowodnić.

---

## 6. Krok 3: sprawdzenie poprawności

### 6.1 Klient: dane wracają identyczne

```bash
curl -fSs -o back.bin https://<domena-SP>/piece/<RAW> && cmp test/child-raw.bin back.bin && echo RAW OK
curl -fSs -o back.car https://<domena-SP>/piece/<CAR> && cmp test/child-car.car back.car && echo CAR OK
# -f: błąd HTTP nie zostanie zapisany jako „dane”
```

### 6.2 Klient: stan on-chain data setu (PDPVerifier)

```bash
PDP=<adres proxy PDPVerifier>; DS=<dataSetId z uploadu>
cast call $PDP "dataSetLive(uint256)(bool)" $DS                  # true
cast call $PDP "getNextPieceId(uint256)(uint256)" $DS            # NASTĘPNY wolny pieceId (tu 2, bo dodano 0 i 1)
cast call $PDP "getDataSetLeafCount(uint256)(uint256)" $DS       # suma liści 32 B kawałków (tu 69836)
cast call $PDP "getNextChallengeEpoch(uint256)(uint256)" $DS     # zaplanowane wyzwanie
cast call $PDP "getDataSetLastProvenEpoch(uint256)(uint256)" $DS # epoka ostatniego udanego dowodu
```

`getNextPieceId` to kolejny identyfikator, a nie licznik obecnie przechowywanych kawałków (usunięte kawałki go nie zmniejszają).

### 6.3 SP: gdzie fizycznie leżą pliki i jak je podejrzeć

Kawałki trafiają do **piece parku**: katalog `piece/` w ścieżce storage z `curio cli storage list`. Pliki nazywają się `s-t00-<id>`, gdzie `<id>` to numer w tabeli `parked_pieces`:

```sql
SELECT id, piece_cid, piece_raw_size, long_term, complete FROM curio.parked_pieces ORDER BY id;
--  id  | piece_cid (v1, baga…) | piece_raw_size | long_term | complete
--    1 | baga6ea4seaqodk3…     |        2097152 | t         | t      ← kopia PDP pliku raw
--  101 | baga6ea4seaqk2kj…     |         120107 | t         | t      ← kopia PDP pliku CAR
```

```bash
ls -l <storage>/piece/                         # s-t00-1 (2 MiB), s-t00-101 (117 KB)
cmp <storage>/piece/s-t00-1 test/child-raw.bin # plik raw jest zapisany 1:1, bez żadnej otoczki
```

`long_term = t` oznacza kopię trwałą (PDP). GUI Curio pokazuje to samo w zakładkach **PDP** (data sety, kawałki) oraz **Market → Pieces**.

---

## 7. Krok 4: agregat PoDSI (klient)

### 7.1 Oczekiwany CID agregatu (lokalnie, bez wysyłania danych)

Klient liczy u siebie, jaki będzie CID agregatu, niezależnie od SP. Ten helper czyta pliki i lokalnie składa agregat (domyślnie zapisuje też plik `.piece`; `--out=false` go usuwa). Kolejność plików musi być taka sama jak w manifeście (§7.2):

```bash
sptool --actor <miner> toolbox mk20-client aggregate --piece-size 8388608 \
  --files test/child-raw.bin --files test/child-car.car
# → CommP CID: bafkzcib…   ← EXPECTED
```

`--piece-size` to padded rozmiar **agregatu**, a nie dowolnie wybrany rozmiar sektora. Musi być dokładnie równy rozmiarowi wynikającemu z ułożenia dzieci i miejsca na indeks (najbliższa potęga 2). W przeciwnym razie helper zwraca `deal size mismatch` i podaje właściwą wartość. Dla plików z testu to 8 MiB. Taki agregat może trafić jako mniejszy kawałek do sektora 32/64 GiB, ale wtedy CommD sektora nie będzie równy CID agregatu (§0).

Nie używaj pliku manifestu, który ten helper zapisuje obok wyniku (wpisuje do dzieci rozmiar padded zamiast raw).

**Jak wygląda agregat w środku** (FRC-0058):

```
offset 0            : child-raw.bin (2 MiB raw → kawałek 4 MiB padded)
offset 4161536      : child-car.car (117 KB → kawałek 128 KiB padded), wyrównany do potęgi 2
… zera (padding) …
ostatnie ~4 KB      : Data Segment Index – tabela wpisów (CommP, offset, rozmiar, suma kontrolna) dla każdego dziecka
```

### 7.2 Manifest agregatu

Każdy wiersz zawiera: PieceCIDv2 dziecka, URL źródła i format (`raw` albo `car`). Źródłem jest **PDP SP**, czyli endpoint `/piece/<CID>`. SP składa agregat z kawałków, które już ma albo które pobierze po HTTP. Klient nie musi przesyłać danych drugi raz.

```bash
printf '%s\t%s\traw\n%s\t%s\tcar\n' \
  "$RAW" "https://<domena-SP>/piece/$RAW" \
  "$CAR" "https://<domena-SP>/piece/$CAR" > mixed.tsv
```

---

## 8. Krok 5: deal DDO → sealing (klient zleca, SP wykonuje)

### 8.1 Zlecenie (klient)

```bash
# --duration: minimum dla deali bez alokacji to 518400 epok (~180 dni)
# --verbose (globalny) pokazuje w logu "generated deal id"
sptool --verbose --actor "$PROVIDER" toolbox mk20-client deal \
  --provider "$PROVIDER" \
  --pcidv2 "$EXPECTED" \
  --aggregate mixed.tsv \
  --duration 518400 \
  --indexing=true \
  --announce=false
```

- **Nie podawaj `--allocation`**: od NV29 Curio odrzuca nowe deale z alokacją.
- `--market-address` jest potrzebny tylko wtedy, gdy deal ma przejść weryfikację kontraktu rynku (`CurioDealViewV1.verifyDeal`). Pusty adres oznacza brak takiej weryfikacji.
- Opcjonalnie `--notification-address/--notification-payload` (FIP-0109): kontrakt dostanie powiadomienie przy aktywacji sektora. Te flagi w `sptool` dodaje łatka `0001`; niezmodyfikowane CLI v1.29.0 ich nie ma.

ID deala (ULID) jest w logu `--verbose` (`generated deal id`) albo w GUI SP (Market 2.0 → Deals). Status z perspektywy klienta:

```bash
sptool --actor <miner> toolbox mk20-client deal-status --provider https://<domena-SP> --id <DEAL>
#  State: complete   (etykieta „PDP Status” w wyniku dotyczy każdego deala mk20)
```

### 8.2 Co robi SP (obserwacja)

```sql
-- postęp deala
SELECT aggr_index, piece_cid_v2, downloaded, after_commp, aggregated, sector, sealed, indexed, complete
FROM curio.market_mk20_pipeline WHERE id = '<DEAL>' ORDER BY aggr_index;
-- kopie kawałków
SELECT id, piece_cid, piece_raw_size, long_term, complete FROM curio.parked_pieces ORDER BY id;
-- sealing
SELECT sector_number, after_sdr, after_tree_r, after_precommit_msg_success, after_porep, after_commit_msg_success, failed
FROM curio.sectors_sdr_pipeline;
```

Sekwencja z testu (od deala do aktywnego sektora ~4 min na devnecie, na mainnecie z 32 GiB to godziny):

1. Dwa wiersze dzieci (`raw`, `car`), `downloaded = f → t`. SP **pobiera kawałki PDP drugi raz**, od siebie, jako tymczasowe kopie (`long_term = f`).
2. Jeden wiersz agregatu: `piece_cid_v2 = EXPECTED`, `aggregated = t`, `sector = 0`. Agregat zostaje zapisany jako nowy plik w piece parku (`s-t00-301`, 8323072 B), a kopie tymczasowe są usuwane.
3. Sealing: SDR → TreeD/TreeC/TreeR → PreCommit (on-chain) → PoRep → Commit (on-chain).
4. Deal: `sealed = t → indexed = t → complete = t`.

GUI SP: **Sectors** (postęp sealingu), **Market 2.0 → Deals** (stan deala), **Tasks** (zadania i błędy).

---

## 9. Krok 6: weryfikacja końcowa

### 9.1 Sektor jest aktywny on-chain

```bash
sptool --actor <miner> sectors status 0      # lub: lotus state sector <miner> 0
#  Activation: <epoka>      Sector Type: Deals
#  QAPower: 80MiB  (dla sektora 8 MiB → pełny mnożnik 10×, bez datacap: efekt NV29/FIP-0118)
```

`ActiveSectors: NO` tuż po aktywacji jest normalne: sektor staje się aktywny po pierwszym WindowPoSt.

Odczyt z Lotusa potwierdza istnienie i aktywację sektora oraz jego CommR (`SealedCID`). CommD poniżej pochodzi z **lokalnych metadanych SP**. Do pełnego audytu zachowaj też CID-y wiadomości PreCommit/ProveCommit i ich receipts.

### 9.2 Sektor zawiera dokładnie ten agregat

```sql
-- sp_id = numer minera bez prefiksu (t01005 → 1005); baza może obsługiwać wielu minerów
SELECT sector_num, orig_sealed_cid, orig_unsealed_cid FROM curio.sectors_meta WHERE sp_id = 1005 AND sector_num = 0;
SELECT sector_num, piece_cid, piece_size FROM curio.sectors_meta_pieces WHERE sp_id = 1005 AND sector_num = 0;
```

**Warunek sukcesu:** `orig_unsealed_cid` (CommD) ma ten sam rdzeń co `EXPECTED`:

```
CommD     baga6ea4seaq h6lby4ddqytvnlbqwpfevri74bxnmz4yofgxd6dqylsyejpw4oci
EXPECTED  bafkzcibcaaj h6lby4ddqytvnlbqwpfevri74bxnmz4yofgxd6dqylsyejpw4oci
```

### 9.3 Zajrzyj do agregatu (SP)

```bash
A=<storage>/piece/s-t00-<id agregatu>
grep -boa "RAW-NOT-CAR" $A                                        # 0:RAW-NOT-CAR → raw leży na początku
cmp -n 2097152 <storage>/piece/s-t00-1 $A && echo "raw = pierwsze 2 MiB agregatu"
dd if="$A" bs=1 skip=4161536 count=120107 2>/dev/null | cmp <storage>/piece/s-t00-101 - && echo "CAR na offsecie 4161536"
```

To porównanie sprawdza plik agregatu w piece parku, **nie** odczyt (retrieval) z zaselowanego sektora.

Plik surowy siedzi w agregacie **bajt w bajt, bez opakowania w CAR**. To odpowiedź na pytanie „czy SP może przyjąć raw w PoDSI”: tak.

### 9.4 Weryfikacja PoDSI: czy agregat zawiera dokładnie te pliki

Porównanie CID i offsetów to tylko poszlaka. Pełna weryfikacja według FRC-0058 robi cztery rzeczy:

0. sprawdza, że plik to dokładnie agregat: CommP wszystkich jego bajtów = CID agregatu (bez tego bajty poza segmentami mogłyby się różnić niezauważone);
1. czyta **indeks** (Data Segment Index) z końca agregatu, czyli listę zawartych kawałków (CommP, offset, rozmiar, suma kontrolna);
2. dla każdego wpisu **liczy CommP z bajtów agregatu** pod wskazanym offsetem i porównuje z wpisem;
3. dla każdego oczekiwanego pliku buduje **dowód włączenia** (inclusion proof) i sprawdza, że prowadzi on do **CommD sektora**. Tak samo weryfikowałby to kontrakt lub audytor on-chain, bez dostępu do danych.

Narzędzie: `podsicheck/` w tym katalogu. Używa go-data-segment v0.0.1, tej samej wersji co Curio v1.29.0. Wymaga Go ≥ 1.26.

```bash
cd docs/pdp-podsi-porep/podsicheck
SECTOR_SIZE=<rozmiar sektora> SECTOR_COMMD=<UnsealedCid sektora z chaina> \
  go run . <plik-agregatu> <rozmiar-padded agregatu> <CID agregatu v1 (baga…)> <dziecko 1 (bafkzcib…)> <dziecko 2> …
# plik agregatu: u SP <storage>/piece/s-t00-<id agregatu> (albo pobrany przez /piece/<EXPECTED>)
# UnsealedCid sektora: z parametrów wiadomości PreCommit (patrz niżej), nie z bazy SP
# SECTOR_* są opcjonalne: dodatkowo sprawdzają, że CommD sektora = agregat + wypełnienie zerami
```

`UnsealedCid` sektora z chaina (parametry PreCommitSectorBatch2, metoda 28; ProveCommitSectors3, metoda 34, pokazuje listę kawałków sektora):

```bash
lotus state list-messages --to <miner> --toheight <epoka sprzed PreCommit> |
  jq -s -r '.[] | select(.Method==28 or .Method==34) | "\(.Method) \(.Params)"' |
  while read m p; do lotus chain decode params --encoding=base64 <miner> $m "$p"; done
# --toheight: bez niego węzeł bez pełnej historii (typowy Lotus) zwraca "failed to load state tree"
```

Wynik z testu:

```
== Data Segment Index (unpadded offset 8319008, max 64 entries): 2 valid entries
  [0] CommP=baga…bjfb6jy  offset=0       size=4194304  first bytes="RAW-NOT-CAR\n"   match=true
  [1] CommP=baga…nmclski  offset=4194304 size=131072   first bytes="<\xa2eroots…"     match=true
== aggregate rebuilt from children: baga…oci  equals sector CommD: true
== inclusion proof baga…bjfb6jy … VERIFIED=true
== inclusion proof baga…nmclski … VERIFIED=true
PoDSI OK
```

Wpis `[0]` zaczyna się od treści pliku (`RAW-NOT-CAR`), a nie od nagłówka CAR. To dowód, że plik surowy siedzi w agregacie bez opakowania. Wpis `[1]` zaczyna się nagłówkiem CAR (`roots`).

### 9.5 PDP nadal działa

```bash
cast call $PDP "getDataSetLastProvenEpoch(uint256)(uint256)" 1   # wartość rośnie po każdym okresie dowodzenia
```

W teście PDP udowodnił data set 1 na epoce 393, czyli już po zaselowaniu tych samych danych w sektorze 0. Obie formy przechowywania działają równolegle i niezależnie.

---

## 10. Wartości referencyjne z testu 2026-10-28

Wszystkie ID i CID poniżej (poza RAW) pochodzą z **jednego przebiegu**. U Ciebie będą inne, bo CAR jest losowy, a ID nadaje sieć.

| Co | Wartość |
|---|---|
| RAW (2097152 B) | `bafkzcibeqcah4epbvnqpavophxayooibjrvwb3iocdhmpxsxaetksmmc4jpqusq7e4` (zawsze ten sam dla tego pliku) |
| CAR (120107 B, losowy) | `bafkzcibd2vgqzljjhx43yliqkw55rn3iuvph5y25qg2akob2fwyq7wrl25vqjojj` |
| Data set PDP | 1 (raw → pieceId 0, CAR → pieceId 1), PDPVerifier 3.5.0 |
| EXPECTED (agregat 8 MiB) | `bafkzcibcaajh6lby4ddqytvnlbqwpfevri74bxnmz4yofgxd6dqylsyejpw4oci` |
| Deal | `01M60YWRWBARCTP249E2Z3C5QY` |
| Sektor | t01005 / 0, Activation 341, QAPower 80 MiB |
| CommD | `baga6ea4seaqh6lby4ddqytvnlbqwpfevri74bxnmz4yofgxd6dqylsyejpw4oci` |
| Pliki u SP | `s-t00-1` (raw, PDP), `s-t00-101` (CAR, PDP), `s-t00-301` (agregat, 8323072 B) |

---

## 11. Znane ograniczenia i pułapki

1. **Jeden transfer PDP → PoRep.** Dane idą raz, bezpośrednio z węzła PDP do węzła PoRep, a klient wysyła tylko manifest. Sprawdzone na dwóch niezależnych węzłach Curio na jednym devnecie (osobne minery, portfele i bazy; `REPRODUKCJA.md` §8a/§9a): jedno pobranie na plik, węzeł PDP nie widzi deala, a podmienione bajty węzeł PoRep odrzuca (`commP mismatch`). Nie sprawdzono transferu przez internet (różne hosty, HTTPS). Węzeł PoRep zapisuje agregat jako osobny plik przed sealingiem (lokalna kopia). Kopie tymczasowe dzieci Curio v1.29 kasuje.
2. **`sptool` bez łatki 0002** traktuje każde dziecko agregatu jako CAR. Samo Curio (serwer) przyjmuje `raw` bez zmian, łatka dotyczy tylko narzędzia klienta.
3. **SSRF:** pobieranie z adresów prywatnych wymaga `[Ingest] SSRFAllowedHosts` i restartu Curio.
4. **Curio v1.29.0, rejestracja PDP:** `FSRegister` przyjmuje pojemność w **GiB (min. 100)**. Skrypt dockerowy Curio przekazuje `1`, co jest błędem upstream. W GUI podawaj ≥ 100.
5. **filecoin-services v1.5.0 (ERC-8167):** świeży deploy v1.5.0 zapisuje do `deployments.json` `FWSS_DISPATCHER_ADDRESS` zamiast `FWSS_IMPLEMENTATION_ADDRESS` i nie zapisuje `FWSS_VIEW_ADDRESS`, bo funkcje view obsługuje proxy FWSS. Starsze wpisy sieci w tym pliku mogą nadal mieć dawne klucze. Deploy wymaga asemblera `evm` (`make install-evm`).
6. **NV29:** brak alokacji datacap (`--allocation` jest odrzucane), minimalny czas deala to 518400 epok.
7. **Synapse a wersja kontraktów:** SDK v2.x wymaga FWSS z paginowanym `getClientDataSets(address,uint256,uint256)`. FWSS v1.1.0 go nie ma (wtedy działa Synapse v0.40.2), FWSS v1.5.0 ma.

---

## Dodatek A: odpowiedniki w lokalnym devnecie (porep-market-devnet)

| Rola w instrukcji | Gdzie w devnecie |
|---|---|
| maszyna klienta (`sptool` klienta, Synapse, pliki testowe) | kontener `porep-market-curio-devnet-piece-server-1`, katalog `/var/lib/curio-client` |
| maszyna SP (`curio`, `sptool` SP) | kontener `porep-market-curio-devnet-curio-1`, storage `/var/lib/curio` (piece park: `/var/lib/curio/piece`) |
| HarmonyDB (SQL) | `docker exec porep-market-curio-devnet-yugabyte-1 bin/ysqlsh -h yugabyte -U yugabyte -d yugabyte` (host: port 25433) |
| `https://<domena-SP>` | z hosta `http://127.0.0.1:22310`, z kontenerów `http://curio:12310` |
| GUI Curio | <http://127.0.0.1:24701> |
| Lotus RPC | `http://127.0.0.1:2234/rpc/v1` (z kontenerów `http://lotus:1234/rpc/v1`) |
| adresy kontraktów | `/var/lib/contracts/contract_addresses.json`, `devnet-info.json` |
| Synapse na devnecie | `NETWORK=devnet DEVNET_INFO_PATH=/var/lib/contracts/devnet-info.json` (klucz brany z devnet-info) |
| miner / providerId PDP | np. `t01004` / `1` (zależy od uruchomienia – `just status`) |
| osobny SP PoRep (węzeł B) | kontener `porep-node-b-curio-porep-1`, miner np. `t01035`, baza `-d curio_porep`, z kontenerów `http://curio-porep:12310` |

Komendy dockerowe (ten sam stos co tutaj) są w `REPRODUKCJA.md` §8 (jeden SP) i §8a (PDP SP ≠ PoRep SP).
