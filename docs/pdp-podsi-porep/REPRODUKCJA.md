# Reprodukcja na devnecie: PDP (raw + CAR) → PoDSI (FRC-0058) → PoRep

Ten dokument opisuje, jak samodzielnie postawić lokalny devnet, który odpowiada wersjom z mainnetu (NV29), i przejść całą ścieżkę: dane raw i CAR → PDP → agregat PoDSI → deal DDO → zaselowany sektor PoRep → niezależna weryfikacja.

- **Szybka droga:** §4–§6, a potem jeden skrypt `docs/pdp-podsi-porep/e2e.sh` (§7).
- **Ręcznie, krok po kroku:** §8.
- **Instrukcja z perspektywy klienta i SP, bez Dockera:** `INSTRUKCJA-UZYTKOWNIKA.md`.

---

## 1. Kontekst

**Zadanie (Jakub Sztandera, FilOz):** sprawdzić blokady dla ścieżki *PDP pieces (CAR albo flat objects) → PoDSI → PoRep*. W Boost PoDSI przyjmowało tylko CAR-y. Otwarte pytanie brzmiało: **czy SP potrafi przyjąć raw pieces w PoDSI**. To fundament pod backup MSP do PoRep.

```
random.bin (raw), backup.tar (raw), child.car (CAR)
        │  klient: Synapse SDK → PDP (Curio, PDPVerifier/FWSS on-chain)
        ▼
PDP SP serwuje /piece/<CID>
        │  klient wysyła do PoRep SP tylko manifest (CID + URL + raw|car)
        ▼
PoRep SP (Curio mk20, deal DDO bez datacap): pobiera dzieci po HTTP → sprawdza CommP
        → buduje agregat FRC-0058 → sealing → aktywacja sektora on-chain
        ▼
weryfikacja: bajty, PDP on-chain, wiadomości sektora on-chain, podsicheck (indeks + dowody włączenia)
```

## 2. Wyniki referencyjne

| Przebieg | Zawartość agregatu | Wynik |
|---|---|---|
| 2026-10-27, stary stos (NV28, Curio ce15c0c, FOC v1.1.0) | raw (tekst + zera) + CAR | PASS dla PoDSI → PoRep. **Data set PDP nie powstał on-chain** (PDPVerifier 3.1.0 był niezgodny z Curio). Wynik historyczny. |
| 2026-10-28, test 1, nowy stos | raw (tekst + zera) + CAR, agregat 8 MiB = cały sektor 0 | PASS: data set PDP on-chain, CommD = agregat (on-chain), `podsicheck` OK, PDP dowodzi dalej |
| 2026-10-28, test 2, nowy stos | **tylko raw**: losowe 1,5 MB + `tar` 680 KB, agregat 4 MiB w sektorze 8 MiB | PASS: `podsicheck` OK, CommD sektora = agregat + zera = `UnsealedCid` on-chain, losowe bajty w agregacie mają SHA-256 identyczny z oryginałem |
| 2026-10-28, **przebieg od zera** po poprawkach, `e2e.sh` | 2× raw (losowe + `tar`) + CAR, agregat 4 MiB w sektorze 8 MiB | **PASS bez ręcznych kroków** (§9) |
| 2026-10-28, **dwa niezależne węzły** (PDP na A, PoRep na B), `TWO_NODE=1 e2e.sh` | 2× raw + CAR, agregat 4 MiB w sektorze 8 MiB węzła B | **PASS**: dokładnie 1 pobranie A → B na plik, podmienione dane odrzucone (§9a) |

**Stos (stan mainnetu z 2026-10-28):**

| Składnik | Wersja |
|---|---|
| Sieć | NV28 w genesis → **NV29 „Solstice” na epoce 200**, aktorzy v19.0.1 (bundle devnet) |
| Lotus | v1.38.3 (`29d72bd`), budowany ze źródeł, wariant `debug` (2k + uproszczona weryfikacja PoSt) |
| Curio | upstream v1.29.0 (`409a2ab`) + łatki z `patches/curio/` (szczegóły pod tabelą) |
| Kontrakty FOC | filecoin-services v1.5.0 (`649e23f`), PDPVerifier 3.5.0, FWSS z ERC-8167 |
| Klient PDP | Synapse SDK v2.0.2 (`8f47ccd`) |
| Sektory | 8 MiB |

**Łatki Curio** (nakładane przy buildzie; zweryfikowane źródła w `.cache` pozostają czyste):

| Łatka | Autor | Zmienia | Wpływ na test raw |
|---|---|---|---|
| `0001` | harness (przed tym zadaniem) | `sptool`: flagi `--notification-*` dla mk20. **Serwer:** `mk20/ddo_v1.go` (deal z adresem rynku, ale bez `market_deal_id`, pomija weryfikację kontraktu zamiast błędu) i `tasks/piece/task_park_piece.go` (limit zasobów ParkPiece 64 GiB → 8 MiB, rozmiar devnetu) | brak: nasze deale nie mają adresu rynku, a limit zasobów nie dotyczy formatu danych |
| `0002` | to zadanie | `sptool`: 3. kolumna manifestu `car` \| `raw` → `Format.Raw` (pole istnieje w API Curio: `market/mk20/types.go`, `Raw *FormatBytes`) | **kluczowy**: bez niego `sptool` oznacza każde dziecko jako CAR (`toolbox_deal_client.go:1849–1870` upstream) |
| `0003` | to zadanie | skrypt startowy `contracts-bootstrap` (klucze FWSS v1.5.0) | brak: infrastruktura devnetu |

Logika obsługi raw po stronie serwera (walidacja mk20, pobieranie, CommP, agregacja, indeksowanie, sealing) to kod upstream bez zmian.

**To nie jest kopia mainnetu.** Wersje oprogramowania i protokołu są takie same, ale sektory są małe, czasy krótkie, PoSt uproszczony, a kontrakty wdrażane od nowa.

---

## 3. Zmiany w forku względem `CodeWarriorr/porep-market-devnet`

| Plik | Zmiana |
|---|---|
| `versions.lock.yaml`, `tools/src/runtime-lock.ts` (+ testy) | Lotus v1.38.3, Curio v1.29.0 (upstream), filecoin-services v1.5.0 (pełny graf submodułów), aktorzy v18 → v19.0.1, Go 1.26.10. Schemat sieci jest ogólny: `upgrade_name/upgrade_epoch/genesis_actors/upgrade_actors` zamiast FireHorse/v17/v18. Usunięty obraz `lotus_devnet`. |
| `docker/curio-all-in-one.Dockerfile` | Etap `lotus-builder` (`make debug-lotus debug-lotus-miner debug-lotus-seed debug-lotus-shed`), bo obrazy `lotus-v1.38.x-devnet` nie istnieją. Etap `evm-builder` (asembler `wjmelements/evm`, wymagany do deployu ERC-8167). Łatka `0002`. |
| `patches/curio/0002-…` | `sptool … deal --aggregate`: opcjonalna 3. kolumna manifestu `car` \| `raw`. |
| `patches/curio/0003-…` | Bootstrap kontraktów rozumie klucze FWSS v1.5.0 (`FWSS_DISPATCHER_ADDRESS`, view = proxy). |
| `scripts/devnet-build.sh`, `devnet-common.sh` | Kontekst Lotusa ze źródeł. Łatka 0003 nakładana na kopię kontekstu. **Fingerprint obrazów obejmuje Dockerfile i wszystkie łatki.** |
| `scripts/devnet-up.sh` | `SSRFAllowedHosts = ["piece-server:12320", "curio:12310"]`, z migracją starszej listy. |
| `scripts/devnet-deploy.sh` | Od NV29 pomija nadawanie datacap MetaAllocatorowi (FIP-0118 zamroził verifreg). |
| `scripts/devnet-status.sh`, `e2e/…` | Gotowość = NV29 / aktorzy v19. |
| `docker/compose.curio-devnet.yaml` | `PDP_SERVICE_CAPACITY_TIB=1024` dla Curio (obejście błędu upstream, §10). |
| `docs/pdp-podsi-porep/` | Ten dokument, instrukcja użytkownika, `e2e.sh`, `podsicheck/` (sprawdza też, że cały plik ma CommP = CID agregatu). |
| `demo/` | Aplikacja webowa: własne pliki → PDP (Synapse) → agregat → deal mk20 → sektor, z weryfikacją każdego kroku (`demo/README.md`). |

---

## 4. Wymagania (macOS, Apple Silicon)

| Narzędzie | Instalacja | Uwagi |
|---|---|---|
| Docker Desktop | <https://www.docker.com/products/docker-desktop/> | ≥ 8 GB RAM dla Dockera (Settings → Resources) |
| Homebrew | <https://brew.sh> | |
| `just` | `brew install just` | |
| **Bash 5** | `brew install bash` | **wymagany**: skrypty używają `declare -A`, macOS ma Bash 3.2 |
| Node.js ≥ 22 | `brew install node` | |
| `git`, `curl`, `jq`, `shasum` | zwykle już są (`brew install jq`) | |

Miejsce na dysku: ~40 GB (obrazy, parametry proofs ~5 GB, źródła, cache Go/Rust).

> **Powłoka:** komendy są pisane dla Bash. W zsh/fish uruchom najpierw `/opt/homebrew/bin/bash`. W zsh zapisy typu `$CID:raw` są interpretowane jako modyfikatory zmiennych (`:r`), co psuje URL-e. Używaj `"${CID}:…"`.

---

## 5. Build

```bash
git clone https://github.com/Filip-L/pdp-podsi-porep.git && cd pdp-podsi-porep
export PATH=/opt/homebrew/bin:$PATH        # Bash 5 przed systemowym

just bootstrap                 # przypięte źródła → .cache/sources (Curio, Lotus, FOC v1.5.0 z submodułami…)
npm --prefix tools ci          # narzędzia harnessu (używane przez just status)
docker pull yugabytedb/yugabyte:2024.1.0.0-b129@sha256:5074792658b19c1379d79fdfe418d33a6587c2637422f56d0d224d8bbbe277a8
just build                     # pierwszy raz ~30–60 min (Lotus i Curio ze źródeł, filecoin-ffi w Rust)
```

Kontrola obrazu:

```bash
docker run --rm porep-market-curio-devnet/curio-all-in-one:409a2ab3510d \
  sh -c 'lotus --version; curio --version; command -v evm'
# lotus version 1.38.3+debug+git.29d72bd / curio version 1.29.0+debug+… / /usr/local/bin/evm
```

Postęp buildu: `tail -f $(ls -t .runtime/devnet/logs/build-*.log | head -1)`.

---

## 6. Start sieci

```bash
just up        # albo: just reset (kasuje stan i stawia od nowa)
just status    # czeka na epokę 200 / NV29 / aktorów v19 → "ready provider=t010xx epoch=…"
```

Pierwszy start może się nie udać, bo Lotus pobiera parametry proofs (~5 GB). Poczekaj, aż kontener `lotus` będzie `healthy`, i uruchom `just up` ponownie.

**Co się dzieje podczas startu (około 20–25 min do pełnej gotowości):**

| Etap | Jak podejrzeć | Gotowe, gdy |
|---|---|---|
| Łańcuch NV28 → NV29 na epoce 200 | `docker exec porep-market-curio-devnet-lotus-1 sh -c 'lotus chain head --height; lotus state network-version'` | `Network Version: 29` |
| Deploy kontraktów FOC v1.5.0 (~10–15 min) | `docker logs -f porep-market-curio-devnet-contracts-bootstrap-1` | `Contract bootstrap completed`, kontener `Exited (0)` |
| Rejestracja SP w PDP (rejestr, approve, endorse, USDFC) | `docker logs porep-market-curio-devnet-curio-1 \| grep provider-bootstrap` | `Provider bootstrap done` i plik `/var/lib/curio/provider.ready` |
| Konfiguracja klienta Synapse | `docker exec porep-market-curio-devnet-piece-server-1 ls /var/lib/contracts/devnet-info.json` | plik istnieje |

Porty na hoście: Lotus RPC `2234`, Curio market/PDP `22310`, GUI Curio <http://127.0.0.1:24701>, Postgres (Yugabyte) `25433`, piece-server `22320`.

---

## 7. Cały test jednym skryptem

```bash
bash docs/pdp-podsi-porep/e2e.sh
```

Skrypt wykonuje kroki z §8 i zatrzymuje się na pierwszym nieudanym sprawdzeniu. Dowody (sumy kontrolne, log Synapse, manifest, agregat, wynik `podsicheck`) zapisuje w `.runtime/pdp-podsi-porep/<znacznik czasu>/`. Kończy się linią `PASS: PDP -> PoDSI -> PoRep (…)`.

Zmienna `PDP_PIECE_BASE` ustawia, skąd PoRep SP pobiera dzieci (domyślnie `http://curio:12310`, czyli ten sam SP co PDP; patrz §11).

---

## 8. Krok po kroku ręcznie

Kroki sprawdzone przez wklejanie komend dokładnie w tej postaci (2026-10-29, dwa węzły, deal `01M62B8DQ2S8M5NAG5EYS28G79`, sektor 3 węzła B: wszystko OK).

**Zanim zaczniesz:**

```bash
/opt/homebrew/bin/bash          # Bash 5 (funkcje poniżej nie działają w fish, a zsh psuje "$CID:…")
caffeinate -dims &              # laptop nie może zasnąć: po uśpieniu Curio przestaje brać zadania (§10)
cd ~/Desktop/Filecoin/pdp-podsi-porep
just status                     # "ready provider=t010xx …"
```

Pomocnicze funkcje (Bash):

```bash
P=porep-market-curio-devnet
SQL() { docker exec $P-yugabyte-1 bin/ysqlsh -h yugabyte -U yugabyte -d yugabyte -c "$1"; }   # baza węzła A (PDP)
CLI() { docker exec -w /var/lib/curio-client $P-piece-server-1 bash -c "$1"; }   # „maszyna klienta”
CAST() { docker exec $P-curio-1 cast call --rpc-url http://lotus:1234/rpc/v1 "$@"; }
# miner węzła A (PDP); nie bierz "pierwszego z list-miners": po starcie węzła B lista zaczyna się od B
PROVIDER=$(docker exec $P-yugabyte-1 bin/ysqlsh -h yugabyte -U yugabyte -d yugabyte -Atc \
  "SELECT config FROM curio.harmony_config WHERE title='base'" | grep -o 't0[0-9]*' | head -1)
PDP=$(docker exec $P-curio-1 jq -r .contracts.pdp_verifier /var/lib/contracts/contract_addresses.json)
echo "PROVIDER=$PROVIDER PDP=$PDP"   # np. PROVIDER=t01004
SQL "SELECT count(*) FROM curio.harmony_machines;"   # musi być ≥ 1, inaczej docker restart $P-curio-1
```

**8.1 Synapse SDK v2.0.2 (klient PDP)**, raz na devnet (`e2e.sh` też to robi; jeśli katalog już jest, pomiń):

```bash
CLI '[ -d synapse-sdk ] || git clone -q https://github.com/FilOzone/synapse-sdk.git synapse-sdk
     cd synapse-sdk && git checkout -q synapse-sdk-v2.0.2 &&
     export CI=true && npx -y pnpm@11.24.0 install --frozen-lockfile && npx -y pnpm@11.24.0 build'
```

**8.2 Dane i CID liczone lokalnie:**

```bash
CLI 'mkdir -p e2e/car && cd e2e && head -c 1500000 /dev/urandom > random.bin && tar -cf backup.tar -C / etc
     sptool --actor t01000 toolbox mk12-client generate-rand-car -s 99700 car && mv car/*.car child.car && sha256sum *.*'
for f in random.bin backup.tar child.car; do CLI "sptool --actor $PROVIDER toolbox mk20-client commp e2e/$f" | grep 'CommP CID'; done
# zapisz: R=<random.bin>  T=<backup.tar>  C=<child.car>
```

**8.3 Upload do PDP:**

```bash
CLI 'cd synapse-sdk && NETWORK=devnet DEVNET_INFO_PATH=/var/lib/contracts/devnet-info.json \
     node utils/example-storage-e2e.js /var/lib/curio-client/e2e/random.bin /var/lib/curio-client/e2e/backup.tar /var/lib/curio-client/e2e/child.car'
# oczekiwane: "Provider 1 - pieceId: …, dataSetId: N" dla każdego pliku, "VERIFIED …", "=== SUCCESS"
```

**8.4 Weryfikacja PDP:**

```bash
curl -fsS "http://127.0.0.1:22310/piece/$R" | shasum -a 256      # = suma random.bin z 8.2
CAST $PDP 'dataSetLive(uint256)(bool)' N                         # true
CAST $PDP 'getNextPieceId(uint256)(uint256)' N                   # następny wolny pieceId
CAST $PDP 'getDataSetLastProvenEpoch(uint256)(uint256)' N        # epoka ostatniego dowodu
SQL "SELECT id, piece_cid, piece_raw_size, long_term FROM curio.parked_pieces ORDER BY id;"
#  pliki: /var/lib/curio/piece/s-t00-<id> w kontenerze curio
```

**8.5 Oczekiwany agregat** (`--piece-size` musi pasować dokładnie; przy niezgodności helper podaje właściwą wartość w `deal size mismatch: expected X, got Y`):

```bash
CLI "cd e2e && sptool --actor $PROVIDER toolbox mk20-client aggregate --out=false --piece-size 4194304 \
     --files random.bin --files backup.tar --files child.car"
# EXPECTED=<CommP CID>
```

**8.6 Manifest i deal** (kolejność dzieci jak w 8.5; 3. kolumna z łatki `0002`):

```bash
CLI "printf '%s\thttp://curio:12310/piece/%s\traw\n%s\thttp://curio:12310/piece/%s\traw\n%s\thttp://curio:12310/piece/%s\tcar\n' \
     $R $R $T $T $C $C > e2e/manifest.tsv"
CLI "sptool --verbose --actor $PROVIDER toolbox mk20-client deal --provider $PROVIDER --pcidv2 $EXPECTED \
     --aggregate e2e/manifest.tsv --duration 518400 --indexing=true --announce=false" 2>&1 | grep 'generated deal id'
# DEAL=<id>
SQL "SELECT data::text FROM curio.market_mk20_deal WHERE id='$DEAL';"     # source_aggregate.pieces[].format: raw/raw/car
```

**8.7 Obserwacja** (na devnecie od deala do aktywnego sektora mijało ~4–5 min):

```bash
SQL "SELECT aggr_index, piece_cid, downloaded, aggregated, sector, sealed, indexed, complete FROM curio.market_mk20_pipeline WHERE id='$DEAL';"
SQL "SELECT sector_number, after_sdr, after_precommit_msg_success, after_commit_msg_success, failed, failed_reason FROM curio.sectors_sdr_pipeline;"
```

Sekwencja: dzieci `downloaded = t` (Curio pobiera kawałki PDP drugi raz jako kopie tymczasowe) → jeden wiersz agregatu `aggregated = t`, `sector = S` (agregat zapisany jako nowy `parked_piece`, kopie tymczasowe usunięte) → SDR → PreCommit → Commit → `sealed / indexed / complete = t`.

**8.8 Weryfikacja on-chain:**

```bash
docker exec $P-curio-1 sptool --actor $PROVIDER sectors status S        # Activation, Sector Type: Deals, QAPower 80 MiB (10×, NV29)
docker exec $P-lotus-1 sh -c "H=\$(lotus chain head --height); lotus state list-messages --to $PROVIDER --toheight \$(( H > 2000 ? H - 2000 : 0 )) |
  jq -s -r '.[] | select(.Method==28 or .Method==34) | \"\(.Method) \(.Params)\"' |
  while read m p; do lotus chain decode params --encoding=base64 $PROVIDER \$m \"\$p\"; done"
# 28 PreCommitSectorBatch2: UnsealedCid sektora S (CommD), DealIDs null
# 34 ProveCommitSectors3:   Pieces = [agregat EXPECTED (v1), Size], VerifiedAllocationKey null
```

`--toheight` ogranicza przeszukiwanie do ostatnich 2000 epok (~2 h devnetu). Bez niego, na dłużej działającym devnecie, Lotus zwraca `failed to load state tree … could not find`, bo stary stan został już usunięty. Starszy sektor: zwiększ 2000.

**8.9 PoDSI (`podsicheck`):**

```bash
ID=$(docker exec $P-yugabyte-1 bin/ysqlsh -h yugabyte -U yugabyte -d yugabyte -Atc \
  "SELECT p.id FROM curio.parked_pieces p JOIN curio.market_mk20_pipeline m ON m.piece_cid = p.piece_cid
   WHERE m.id = '$DEAL' AND p.long_term ORDER BY p.id DESC LIMIT 1")   # plik agregatu tego deala
mkdir -p /tmp/podsi && docker cp $P-curio-1:/var/lib/curio/piece/s-t00-$ID /tmp/podsi/aggregate.bin
docker run --rm -v "$PWD/docs/pdp-podsi-porep/podsicheck:/w" -v /tmp/podsi:/data:ro -w /w golang:1.26-trixie \
  sh -c "SECTOR_SIZE=8388608 SECTOR_COMMD=<UnsealedCid z 8.8> go run . /data/aggregate.bin 4194304 $EXPECTED $R $T $C"
# 4194304 = --piece-size z 8.5
# PoDSI OK … / sector CommD … equals on-chain UnsealedCid: true
```

### 8a. Ręcznie na dwóch węzłach (PDP na A, PoRep na B)

Kroki 8.1–8.5 bez zmian: dane trafiają do PDP na węźle A. Od 8.5 zmienia się tylko to, **do kogo idzie deal i gdzie patrzysz**:

```bash
bash docs/pdp-podsi-porep/two-node/up.sh            # jeśli węzeł B jeszcze nie działa (~5 min)
B=porep-node-b-curio-porep-1
SQLB() { docker exec $P-yugabyte-1 bin/ysqlsh -h yugabyte -U yugabyte -d curio_porep -c "$1"; }   # baza węzła B
PROVIDER=$(docker exec $B cat /var/lib/curio/miner)   # np. t01035: od teraz PROVIDER = węzeł B
SQLB "SELECT count(*) FROM curio.harmony_machines;"    # musi być ≥ 1, inaczej docker restart $B
```

| Krok | Zmiana dla dwóch węzłów |
|---|---|
| 8.5 | bez zmian (z nowym `PROVIDER`) |
| 8.6 | manifest **bez zmian**: URL-e dalej wskazują `http://curio:12310` (węzeł A). Deal z `--provider $PROVIDER` trafia do B, bo `sptool` znajduje adres B on-chain (`found storage provider … /dns/curio-porep/…` w logu `--verbose`). Kontrola formatów: `SQLB` zamiast `SQL` |
| 8.7 | `SQLB` zamiast `SQL` |
| 8.8 | bez zmian (z nowym `PROVIDER`) |
| 8.9 | zapytanie o `ID` z `-d curio_porep` zamiast `-d yugabyte`, a `docker cp $B:/var/lib/curio/piece/s-t00-$ID …` zamiast `$P-curio-1` |

**Transfer A → B (scenariusz Kuby):**

```bash
SQLB "SELECT result, count(*) FROM curio.harmony_task_history WHERE name='ParkPiece'
      AND work_start >= (SELECT created_at FROM curio.market_mk20_deal WHERE id='$DEAL') GROUP BY 1;"
#  t | 3          ← dokładnie jedno udane pobranie na plik
SQL "SELECT count(*) FROM curio.market_mk20_deal WHERE id='$DEAL';"
#  0            ← węzeł A (PDP) nie zna deala, tylko serwował /piece/
docker logs $B 2>&1 | grep -i parkpiece | tail     # podgląd pobierania na B
```

PDP na A dalej dowodzi: `CAST $PDP 'getDataSetLastProvenEpoch(uint256)(uint256)' N` rośnie (A nie zmienia się po dealu na B).

Podmiana danych (krok 11 `e2e.sh`) wymaga osobnego uploadu „podróbki” i osobnego deala. Najprościej zobaczyć ją w skrypcie: `TWO_NODE=1 bash docs/pdp-podsi-porep/e2e.sh`.

---

## 9. Przebieg od zera po poprawkach (2026-10-28)

`just build` → `just reset` → `just status` → `bash docs/pdp-podsi-porep/e2e.sh`, bez żadnych ręcznych poprawek.

| Krok | Wynik |
|---|---|
| Start sieci | ~15 min do `ready provider=t01004 epoch=200`, NV29 |
| Kontrakty FOC v1.5.0 | `Contract bootstrap completed` (`Exited (0)`), PDPVerifier 3.5.0 |
| Rejestracja SP w PDP | **automatyczna**: 5 znaczników `.init.pdp.*` + `provider.ready` (poprawka pojemności działa) |
| Upload (Synapse v2.0.2) | data set 1, `pieceId` 3/4/5, `VERIFIED` ×3, bajty z `/piece/` identyczne (SHA-256) |
| Agregat | 4 MiB, `bafkzcibcaai3giwznha6ewzstqf62e36himcnwwhmexznr6lfwm26qmzfb5skjy` |
| Deal | `01M612YS9MK3A2V32C627WM7Q4`, dzieci `raw / raw / car` |
| Sealing | ~4 min od deala do `complete`, sektor 1, Activation 296, `Sector Type: Deals`, QAPower 80 MiB |
| On-chain | ProveCommit: kawałek = agregat (4 MiB, `datacap: null`). PreCommit `UnsealedCid` = `baga6ea4seaqfa7p2…zela` |
| `podsicheck` | 3 wpisy indeksu (losowe od offsetu 0, `etc/` od 2097152, CAR `roots` od 3145728), CommP z bajtów zgodne, 3× dowód włączenia `VERIFIED`, **CommD sektora (agregat + zera) = `UnsealedCid` on-chain** |
| PDP dalej dowodzi | data set 1 udowodniony na epoce 340 (przed: 221) |

Dodatkowo deal z przerwanego wcześniej uruchomienia skryptu (`01M612XDMXFR9XNPRAN32750R9`, te same typy plików) zakończył się samodzielnie w sektorze 0 (Activation 269).

Dowody: `.runtime/pdp-podsi-porep/20261028-120447/` (sumy kontrolne, log Synapse, manifest, agregat, wynik `podsicheck`).

---

## 9a. Dwa niezależne węzły: PDP (A) → PoRep (B)

To scenariusz Kuby: **jeden transfer, bezpośrednio z węzła PDP do węzła PoRep**, bez orkiestratora w ścieżce danych.

| | Węzeł A (istniejący) | Węzeł B (`two-node/`) |
|---|---|---|
| Rola | tylko PDP: Synapse wrzuca tu pliki, dowody PDP on-chain | tylko PoRep: deal DDO, pobranie, agregat, sealing |
| Miner / portfel | `t01004` / domyślny portfel Lotusa | **własny** (`t01035`), **własny portfel** (osobne nonce) |
| Baza HarmonyDB | `yugabyte` | **osobna** `curio_porep` w tym samym Yugabyte (to nie jest klaster z A) |
| Konfiguracja | jak w harnessie | `EnablePDP = false`, `EnableWinningPost = false`, `DomainName = "curio-porep"`, `SSRFAllowedHosts = ["curio:12310"]` |

Uruchomienie (devnet musi być `ready`):

```bash
bash docs/pdp-podsi-porep/two-node/up.sh          # tworzy bazę curio_porep, minera, startuje węzeł B (~5 min)
TWO_NODE=1 bash docs/pdp-podsi-porep/e2e.sh       # PDP na A, deal i sealing na B + liczenie transferów + podmiana danych
bash docs/pdp-podsi-porep/two-node/up.sh down     # usuwa węzeł B, jego dane i bazę
```

Węzeł B to osobny projekt Docker (`porep-node-b`) podpięty do sieci devnetu. Główny harness (7 usług) się nie zmienia. Curio węzła B samo ogłasza na łańcuchu swój adres `/dns/curio-porep/tcp/12310/ws`, a `sptool` klienta znajduje go po minerze.

**Wynik (2026-10-28):**

| Sprawdzenie | Wynik |
|---|---|
| Upload do PDP na A | data set 1, `pieceId` 6/7/8, `VERIFIED` ×3 |
| Deal | `01M61C2VS6R4F47QR4PXQNPKM5` wysłany do `t01035` (B), dzieci `raw / raw / car`, źródło `http://curio:12310/piece/…` (A) |
| Węzeł A widział deal? | **nie**, tylko serwował `/piece/` |
| Transfery A → B | **3 udane pobrania na 3 pliki, 0 nieudanych** (ParkPiece na B od chwili deala) |
| Sealing na B | sektor 0 minera `t01035`, Activation 2685, `Sector Type: Deals`, QAPower 80 MiB |
| On-chain | ProveCommit: kawałek = agregat (4 MiB, `datacap: null`). `UnsealedCid` = agregat + zera (`podsicheck`) |
| `podsicheck` | 3 wpisy indeksu, CommP z bajtów zgodne, 3× dowód włączenia `VERIFIED` |
| PDP na A dalej dowodzi | data set 1 udowodniony na epoce 2737 |

**Podmienione dane (węzeł PDP podaje inne bajty niż CID w dealu):**

| Wariant | Co się stało na węźle B |
|---|---|
| Inna długość (CID `random.bin` 1 500 000 B, URL serwuje `backup.tar` 696 320 B) | pobieranie przerwane (`unexpected EOF` po 696 320 B): CIDv2 zawiera długość. Agregat nie powstał |
| **Ta sama długość, inna treść** (URL serwuje inny losowy plik 1 500 000 B) | pobieranie **przyjęło** bajty (`complete = t`), ale etap CommP je **odrzucił**: `commP mismatch calculated baga6ea4seaqip25… and supplied baga6ea4seaqc7vqk…`. Agregat nie powstał |

Węzeł PoRep nie musi więc ufać węzłowi PDP: złe dane nie trafią do sektora.

Ten wariant jest krokiem 11 w `TWO_NODE=1 e2e.sh`. Pełny automatyczny przebieg 2026-10-28 (deal `01M61YSKRDN4C3FS467FNNX8Z9`, sektor 2 węzła B): wszystkie kroki 0–11 `OK`, w tym 3 pobrania na 3 pliki i odrzucenie podmiany przez `commP mismatch`. Dowody: `.runtime/pdp-podsi-porep/20261028-201113/`. Ponownie na świeżym devnecie 2026-10-29 (deal `01M63M59HVYWVR7Q35TREV8256`, sektor 3 węzła B, `podsicheck` z kontrolą CommP całego pliku): PASS, dowody `.runtime/pdp-podsi-porep/20261029-114355/`.

**Obserwacje z wariantu dwuwęzłowego:**

1. **Zatruty wpis lokalny.** Przy podmianie tej samej długości węzeł B zapisuje złe bajty w swoim magazynie kawałków pod zadeklarowanym CID (`parked_pieces.complete = t`), a odrzuca je dopiero etap CommP. Nie sprawdzono, czy późniejszy, uczciwy deal na ten sam CID nie utknie na tym wpisie.
2. **Pobieranie, które wyczerpie limit prób (`MaxFailures`), blokuje wpis na stałe** (`complete = f` i martwy `task_id`). Kolejny deal z tym CID nie ruszy, dopóki wpis nie zostanie ręcznie zwolniony (§10).
3. **Dwóch producentów bloków na małym devnecie.** Gdy węzeł B miał moc i produkował bloki, przy blokach co 4 s węzeł A tracił swoje bloki (`our block was not included`, slash filter Lotusa). Po 7 nieudanych WinPost Curio A zaczęło odpowiadać na PDP `503` (`PDPTaskFailures`), więc uploady Synapse przestały działać. Dlatego węzeł B ma `EnableWinningPost = false` (sektor utrzymuje WindowPoSt). Na mainnecie pojedynczy SP rzadko wygrywa bloki, więc to efekt devnetu.

---

## 10. Rozwiązywanie problemów

| Objaw | Przyczyna | Rozwiązanie |
|---|---|---|
| `declare: -A: invalid option` | Bash 3.2 z macOS | `brew install bash`, PATH z `/opt/homebrew/bin` na początku |
| `required Yugabyte image is missing` | harness nie pobiera obrazu | `docker pull` z §5 |
| `Curio market config was not created within 300 seconds` | pierwszy start, Lotus pobiera parametry proofs | poczekaj na `healthy` Lotusa, `just up` ponownie |
| Synapse: `No endorsed provider available … 503`; w logu Curio `Service Unavailable … PDPTaskFailures: Task: WinPost, Failures: 7` | Curio zgłasza PDP jako niedostępne po serii nieudanych WinPost (na devnecie: dwóch producentów bloków, przeciążenie) | wyłącz produkcję bloków na drugim węźle (`EnableWinningPost = false`); licznik błędów wygasa po kilku minutach. Restart Curio może pomóc przy zawieszonym heartbeat storage (`couldn't find a suitable path`) |
| Po uśpieniu laptopa: PDP `503` z `ChainSync … behind` | łańcuch devnetu stał i teraz nadrabia epoki; Curio celowo nie obsługuje klientów na zaległym łańcuchu | poczekaj, aż `/pdp/ping` zwróci 200 (kilka minut) |
| Deal stoi (dzieci `downloaded = f`, zadania ParkPiece bez właściciela), w logu `violates foreign key constraint "harmony_task_owner_id_fkey"`, tabela `harmony_machines` pusta | laptop zasnął (wystarczy kilkanaście minut). Wpis maszyny Curio wygasł i został usunięty, a działający proces nie rejestruje się ponownie, więc nie przejmuje zadań. Zdarzało się głównie węzłowi B | restart tego węzła Curio (`docker restart porep-node-b-curio-porep-1` albo `…-curio-1`). Deal rusza sam po restarcie. Zapobieganie: `caffeinate -dims &` na czas pracy |
| Łańcuch nie rośnie (`lotus chain head` stoi), w logu `lotus-miner`: `lookback height N is at or after base height N`, `nullRounds: 899`; PDP `503` z `ChainSync … behind (Xh behind)` | komputer spał dłużej niż ~1 h (900 epok po 4 s). Lotus nie wydobędzie bloku po więcej niż 900 pustych rundach (finalność), więc devnet **nie odblokuje się sam** | `bash docs/pdp-podsi-porep/two-node/up.sh down`, `just reset`, potem węzeł B od nowa. Zapobieganie: zasilacz + `sudo pmset -c sleep 0` albo `caffeinate -dims` |
| Sektor aktywny on-chain, ale deal stoi na `indexing` (`indexed = f`, zadanie `Indexing` zniknęło); w historii zadań 3 błędy w ciągu ułamka sekundy: `getting piece reader … piece cid baga…: no deals found` | ktoś pobrał `/piece/<CID agregatu>` **zanim** SP skończył deal. Curio zapamiętuje błąd odczytu na 5 s pod samym CID (`lib/cachedreader`, `PieceErrorCacheTTL`), wspólnie dla pobrań klienta i dla indeksowania; indeksowanie dostaje błąd z gałęzi „retrieval”, a jego 3 próby (`MaxFailures`) mieszczą się w tych 5 s | `SQL "UPDATE curio.market_mk20_pipeline SET indexing_task_id = NULL WHERE id = '<DEAL>' AND indexed = FALSE AND indexing_task_id NOT IN (SELECT id FROM curio.harmony_task);"` (Curio sam zaplanuje indeksowanie). Zapobieganie: pobierać agregat dopiero po `complete` (demo i `e2e.sh` tak robią) |
| `failed to load state tree … ipld: could not find …` z `lotus state list-messages` | Lotus usunął stary stan łańcucha, a komenda przeszukuje całą historię | `--toheight <wysokość>` (§8.8) |
| `refusing explicit call due to state fork at epoch 200` | zapytanie (`cast call`, eth_call) trafiło dokładnie w epokę upgrade'u | jednorazowe, ponów po kilku sekundach (`e2e.sh` ponawia sam) |
| `image manifest Dockerfile/patch hash mismatch` | zmienił się Dockerfile albo łatka | `just build` (z cache trwa krótko) |
| contracts-bootstrap: `Missing the evm assembler` | obraz bez etapu `evm-builder` | `just build` z aktualnym Dockerfile |
| contracts-bootstrap: `missing FWSS implementation address in deployments.json` | FWSS v1.5.0 (ERC-8167) ma nowe klucze | łatka `0003` (jest w `devnet-build.sh`); `just build` |
| `provider id not assigned yet` w nieskończoność; w logu `FSRegister failed: storage capacity must be at least 100 GiB` | Curio v1.29.0: `FSRegister` przyjmuje GiB, a entrypoint podaje `1` | compose ustawia `PDP_SERVICE_CAPACITY_TIB=1024`. Ręcznie: RPC `CurioWeb.FSRegister` z `1024` i `touch /var/lib/curio/.init.pdp.register` |
| `ParkPiece … non-public ip … not allowed` | `curio:12310` nie jest w `SSRFAllowedHosts` | `just up` (migruje listę) i **restart Curio** |
| Dzieci stoją na `downloaded = f`, zadania ParkPiece zniknęły | wyczerpane `MaxFailures = 10` (np. przez SSRF) | `SQL "UPDATE curio.parked_pieces SET task_id = NULL WHERE complete = FALSE AND long_term = FALSE AND task_id NOT IN (SELECT id FROM curio.harmony_task);"` |
| `deal size mismatch: expected X, got Y` | zły `--piece-size` agregatu | użyj `Y` |
| `invalid line format … Expected pieceCidV2, url` | `sptool` bez łatki `0002` | `just build` |
| Deal odrzucony z `allocation` | NV29: datacap zamrożony | nie podawaj `--allocation` |
| Synapse: `PaymentsService fundSync failed … The contract function "nonces" reverted` (adres = `mockusdfc_addr`) | po kilku uploadach na jednym devnecie depozyt klienta w Filecoin Pay się wyczerpał. Synapse dopłaca go podpisem ERC-2612 `permit`, a mock USDFC devnetu nie ma `nonces()` | dopłata bez `permit`: `approve(FilecoinPay, kwota)` na USDFC i `deposit(USDFC, klient, kwota)` na FilecoinPay (`e2e.sh` i demo robią to same, gdy trzeba) |
| Synapse v2: `getClientDataSets … reverted` | kontrakty FWSS starsze niż wymagane przez SDK v2 | ten stos ma FWSS v1.5.0. Ze starymi kontraktami użyj Synapse v0.40.2 |

---

## 11. Wnioski dla Kuby

1. **Raw w PoDSI → PoRep działa po stronie SP.** Curio v1.29.0 zapisuje dziecko jako `format: raw`, pobiera je, sprawdza CommP, układa w agregacie FRC-0058 bez opakowania w CAR, indeksuje i seluje. Wpisy indeksu PoDSI, CommP liczone z bajtów agregatu, dowody włączenia oraz `UnsealedCid` i lista kawałków w wiadomościach sektora on-chain są spójne. Żaden kod serwera związany z obsługą raw nie wymagał zmian. Testowane Curio ma dwie drobne zmiany serwerowe z łatki `0001` harnessu, niezwiązane z formatem danych (§2). Brak był tylko w kliencie `sptool` (łatka `0002`). Klient wołający API mk20 bezpośrednio może od razu wysłać `Format.Raw`.
2. **Model docelowy (doprecyzowany przez Kubę): jeden transfer, bezpośrednio z węzła PDP do węzła PoRep.** Orkiestrator nie jest w ścieżce danych. Pokazane: klient wysyła tylko manifest (CID + URL + format), a węzeł PoRep sam pobiera fragmenty po HTTP z `/piece/<CID>` i weryfikuje ich CommP.
3. **Dwa niezależne węzły (PDP ≠ PoRep) działają (§9a).** Węzeł PoRep pobrał każdy kawałek **dokładnie raz**, bezpośrednio z `/piece/` węzła PDP. Węzeł PDP nie widział deala. Węzeł PoRep weryfikuje dane: inna długość jest odrzucana przy pobieraniu, a ta sama długość z inną treścią na etapie CommP (`commP mismatch`). Węzeł PoRep nie musi więc ufać węzłowi PDP. Uwagi: złe bajty zostają zapisane lokalnie pod zadeklarowanym CID (zatruty wpis), a pobieranie po wyczerpaniu limitu prób blokuje się do ręcznego zwolnienia. Węzeł PoRep zapisuje agregat jako osobny plik przed sealingiem; to lokalna kopia, nie transfer. Nie sprawdzono dostępności ani opłat za pobieranie po stronie PDP SP na mainnecie (FWSS/FilBeam).
4. **Przedwczesne pobranie agregatu może trwale zablokować deal (Curio v1.29.0).** Jeśli klient zapyta o `/piece/<CID agregatu>` po aktywacji sektora, ale przed zakończeniem indeksowania, Curio zapamiętuje błąd odczytu (5 s, klucz = sam CID) i podaje go też zadaniu indeksowania. Jego 3 próby mieszczą się w tym oknie, więc deal zostaje na `indexing` do ręcznego zwolnienia (§10). Odtworzone 2026-10-29 przez demo (deal `01M63K60X33P996M1BZ6FF99PM`, logi węzła B: pobranie 10:31:04.8, trzy błędy indeksowania 10:31:07.08–07.15). Kandydat na zgłoszenie upstream: osobny klucz pamięci błędów dla trybu retrieval albo odstęp między próbami indeksowania.
5. **Długość pliku raw nie jest zapisana w indeksie PoDSI** (indeks zna rozmiar po paddingu). Dokładną długość ma CIDv2 dziecka. Przy przywracaniu backupu z agregatu trzeba przechować CIDv2, inaczej na końcu pliku zostaną zera.
6. **NV29 (FIP-0118):** deale DDO tylko bez alokacji, minimalny czas 518400 epok, a każdy nowy sektor ma pełną moc QA (10×) bez datacapu.
7. **Nie testowano:** odczytu z zaselowanego sektora (unseal/retrieval), sektorów 32/64 GiB i parametrów produkcyjnych, wielu (setek) plików w agregacie, transferu PDP SP → PoRep SP przez internet (różne hosty i serwerownie, publiczny HTTPS, duże pliki, limity lub opłaty po stronie PDP SP). Oba węzły zawsze należą do tego samego łańcucha Filecoin; w teście dane szły zwykłym HTTP w prywatnej sieci Dockera.
