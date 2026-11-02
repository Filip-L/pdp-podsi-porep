# Demo PDP → PoDSI → PoRep: diagram sekwencji

Diagram powstał na podstawie kodu w `demo/` (backend `demo/server/*.ts`, frontend `demo/web/src/*.tsx`) oraz Curio v1.29.0.
Przy strzałkach podano `plik:linia`.

Powiązane: [DEMO-JAK-DZIALA.md](DEMO-JAK-DZIALA.md) · [DEMO-PRZEPLYW-DANYCH.md](DEMO-PRZEPLYW-DANYCH.md) · [DEMO-KOD.md](DEMO-KOD.md)

```mermaid
sequenceDiagram
    autonumber
    actor U as Użytkownik
    participant UI as Przeglądarka<br/>(demo/web)
    participant API as Backend demo<br/>(demo/server, Hono)
    participant SYN as Synapse SDK<br/>(w backendzie)
    participant A as Curio A<br/>SP PDP (t01005)
    participant CH as Łańcuch<br/>(Lotus, FWSS, PDPVerifier)
    participant B as Curio B<br/>SP PoRep (t01035)
    participant GO as Programy Go<br/>(aggplan, podsicheck)

    Note over U,GO: Krok 1. Wgranie pliku do PDP

    U->>UI: wybiera plik i format (raw, car, wykryj)
    UI->>API: POST /api/files (Files.tsx:33 → index.ts:56)
    API->>API: isCar(bytes) (index.ts:44)<br/>sha256, zapis /data/files/<id>
    API-->>UI: rekord pliku, status queued
    API->>API: enqueueUpload(rec) (pdp.ts:72)<br/>kolejka, jeden upload naraz
    API->>SYN: upload(rec) (pdp.ts:76)<br/>Piece.calculate → lokalny PieceCID
    SYN->>CH: createContexts, prepare<br/>(wybór SP PDP, wymagany depozyt)
    opt brakuje depozytu
        SYN->>CH: Filecoin Pay: approve + deposit (pdp.ts:53)
    end
    SYN->>A: synapse.storage.upload(bytes) (pdp.ts:97)
    A-->>SYN: onStored: bajty przyjęte, PieceCID potwierdzony
    A->>CH: addPieces do data setu (tx)
    CH-->>SYN: onPiecesConfirmed: dataSetId, pieceId
    SYN-->>API: copies[0]: dataSetId, pieceId, retrievalUrl (pdp.ts:117-121)
    API->>API: status ready, zapis state.json

    loop co 4 s (App.tsx:29)
        UI->>API: GET /api/status, GET /api/files
        API->>A: GET /pdp/ping (pdpHealth, pdp.ts:135)
        API->>CH: ChainHead, NetworkVersion (lotus.ts)
    end

    Note over U,GO: Krok 2. Sprawdzenie pliku w PDP (opcjonalne)

    U->>UI: klika „Sprawdź” (Files.tsx:168)
    UI->>API: GET /api/files/:id/verify (index.ts:98)
    API->>CH: verifyFile (pdp.ts:155): dataSetLive, pieceLive,<br/>getPieceCid, lastProvenEpoch
    API->>A: GET /piece/<PieceCID>
    A-->>API: bajty pliku
    API-->>UI: sha256 zgodny z oryginałem, PieceCID zgodny z łańcuchem

    Note over U,GO: Krok 3. Plan agregatu

    U->>UI: zaznacza pliki
    UI->>API: POST /api/plan (Aggregate.tsx:31 → index.ts:104)
    API->>GO: planAggregate (podsi.ts:12) → aggplan <PieceCID…>
    GO-->>API: CID agregatu, offsety, rozmiary, offset indeksu
    API-->>UI: układ agregatu, czy mieści się w sektorze

    Note over U,GO: Krok 4. Deal mk20 (do SP PoRep idą tylko URL-e)

    U->>UI: wybiera SP PoRep, klika „Wyślij deal”
    UI->>API: POST /api/deals (Aggregate.tsx:47 → index.ts:111)
    API->>API: createDeal (deals.ts:26)<br/>pieceUrl(f) = retrievalUrl z PDP (pdp.ts:148)
    API->>CH: minerInfo (rozmiar sektora), ChainHead
    API->>API: buildDeal (mk20.ts:61)<br/>source_aggregate.pieces[].source_http.url,<br/>format raw lub car
    API->>B: POST /market/mk20/deal (submitDeal, mk20.ts:89)<br/>Authorization: CurioAuth delegated (mk20.ts:30)
    B-->>API: 200 OK
    API-->>UI: DealRecord (zapis state.json)

    Note over U,GO: Krok 5. Curio B sam pobiera dane z PDP i pieczętuje sektor (bez udziału demo)

    loop dla każdego pliku z dealu
        B->>A: GET /piece/<PieceCID> (ParkPiece,<br/>task_park_piece.go:203 NewUrlReader)
        A-->>B: bajty pliku → /var/lib/curio/piece/
        B->>B: CommP z bajtów, porównanie z CID z dealu<br/>(task_commp.go:236)
    end
    B->>B: AggregateDeals (task_aggregation.go:189-284)<br/>pliki + zera + indeks Data Segment → jeden kawałek
    B->>B: sealing: SDR, drzewa, PoRep
    B->>CH: PreCommit (UnsealedCid = CID agregatu)
    B->>CH: ProveCommit (sektor aktywny)
    B->>B: indeksowanie (IndexAggregate, index_helpers.go:201)<br/>każdy plik (raw i CAR): CID pliku → offset w agregacie<br/>CAR dodatkowo: bloki IPLD (CID bloku → offset)

    loop karta dealu, odpytywanie (Deals.tsx:33-54)
        UI->>API: GET /api/deals/:id (index.ts:116)
        API->>B: dealView (deals.ts:77): SQL w bazie Curio B<br/>(market_mk20_deal, pipeline, market_piece_deal)
        API->>B: GET /market/mk20/status/:id (mk20.ts:96)
        API->>CH: stan sektora, wiadomości PreCommit i ProveCommit
        API-->>UI: 10 kroków osi czasu (deals.ts:171)
    end

    Note over U,GO: Krok 6. Weryfikacja PoDSI

    U->>UI: klika „PoDSI” (Deals.tsx:56)
    UI->>API: POST /api/deals/:id/podsi (index.ts:122)
    API->>CH: UnsealedCid sektora, rozmiar sektora
    API->>B: GET /piece/<CID agregatu> (verifyPodsi, podsi.ts:26)
    B-->>API: bajty agregatu → /data/aggregates/<id>
    API->>GO: podsicheck (podsi.ts:35)
    GO->>GO: indeks Data Segment, CommP każdego pliku,<br/>dowody włączenia, CommD sektora
    GO-->>API: wynik, ok gdy CommD równy on-chain UnsealedCid
    API-->>UI: PodsiResult (Deals.tsx:200)
```

## Jak czytać

- **Bajty plików idą tylko dwoma drogami:**
  - przeglądarka → backend → Synapse → Curio A (krok 1);
  - Curio A → Curio B (krok 5, ParkPiece).
  Do Curio B demo wysyła wyłącznie JSON z CID-ami i adresami URL (krok 4).
- **Krok 5 dzieje się bez udziału demo.** Demo tylko obserwuje postęp: odpytuje bazę Curio B, `/market/mk20/status` i łańcuch.
- **Krok 6 robi to, co mógłby zrobić każdy z zewnątrz.** Pobiera agregat publicznym `/piece/`, a potem porównuje go z łańcuchem.

## Podgląd

- GitHub, GitLab i VS Code (z rozszerzeniem Markdown Preview Mermaid Support) renderują diagram bezpośrednio.
- Gotowy obraz: [DEMO-SEKWENCJA.png](DEMO-SEKWENCJA.png).
- Można też wkleić blok ` ```mermaid ` na https://mermaid.live.
