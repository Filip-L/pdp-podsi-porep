// podsicheck: independent PoDSI (FRC-0058) verification of an aggregate piece.
//
//	podsicheck <aggregate-file> <aggregate-padded-size> <aggregate-root-v1> <child-CIDv2>...
//
// <aggregate-root-v1> is the aggregate CommP (= sector CommD when the aggregate fills the sector).
// Optional: SECTOR_SIZE=<padded> SECTOR_COMMD=<baga…> additionally checks that a sector holding
// only this aggregate (zero-padded to SECTOR_SIZE) has exactly that on-chain UnsealedCid.
//
//  0. checks that the file itself is the aggregate (CommP of all its bytes = aggregate root),
//  1. parses the Data Segment Index stored at the end of the aggregate,
//  2. recomputes CommP of every indexed segment from the aggregate bytes,
//  3. checks each expected child is indexed and builds/verifies its inclusion proof
//     against the aggregate root (what an on-chain verifier would do).
package main

import (
	"bytes"
	"fmt"
	"io"
	"os"
	"strconv"

	commputil "github.com/filecoin-project/go-commp-utils/v2"
	"github.com/filecoin-project/go-data-segment/datasegment"
	commcid "github.com/filecoin-project/go-fil-commcid"
	commp "github.com/filecoin-project/go-fil-commp-hashhash"
	"github.com/filecoin-project/go-state-types/abi"
	"github.com/ipfs/go-cid"
)

func must(err error) {
	if err != nil {
		fmt.Println("FAIL:", err)
		os.Exit(1)
	}
}

func main() {
	if len(os.Args) < 5 {
		fmt.Println("usage: [SECTOR_SIZE=… SECTOR_COMMD=…] podsicheck <aggregate-file> <padded-size> <aggregate-root-v1> <child-CIDv2>...")
		os.Exit(2)
	}
	f, err := os.Open(os.Args[1])
	must(err)
	defer f.Close()
	size, err := strconv.ParseUint(os.Args[2], 10, 64)
	must(err)
	dealSize := abi.PaddedPieceSize(size)
	commD, err := cid.Decode(os.Args[3])
	must(err)
	if v1, _, err := commcid.PieceCidV1FromV2(commD); err == nil {
		commD = v1 // accept the aggregate root as PieceCIDv2 (bafkzcib…) too
	}

	// 0. The whole file must be the aggregate itself: its CommP over every byte (segments, padding
	// and index alike) must equal the aggregate root. Without this, bytes outside the indexed
	// segments could differ and every check below would still pass.
	whole := &commp.Calc{}
	n, err := io.Copy(whole, f)
	must(err)
	wholeRaw, wholeSize, err := whole.Digest()
	must(err)
	wholeCID, err := commcid.DataCommitmentV1ToCID(wholeRaw)
	must(err)
	fileOK := wholeCID.Equals(commD) && abi.PaddedPieceSize(wholeSize) == dealSize && n == int64(dealSize.Unpadded())
	fmt.Printf("== aggregate file: %d B, CommP of all bytes %s (padded %d)  equals aggregate root: %v\n", n, wholeCID, wholeSize, fileOK)
	if !fileOK {
		must(fmt.Errorf("the file is not the aggregate %s of size %d", commD, dealSize))
	}

	// 1. Data Segment Index
	idxStart := datasegment.DataSegmentIndexStartOffset(dealSize)
	_, err = f.Seek(int64(idxStart), io.SeekStart)
	must(err)
	idx, err := datasegment.ParseDataSegmentIndex(f)
	must(err)
	entries, err := idx.ValidEntries()
	must(err)
	fmt.Printf("== Data Segment Index (unpadded offset %d, max %d entries): %d valid entries\n",
		idxStart, datasegment.MaxIndexEntriesInDeal(dealSize), len(entries))

	indexed := map[cid.Cid]datasegment.SegmentDesc{}
	for i, e := range entries {
		// 2. recompute CommP of the segment bytes straight from the aggregate
		buf := make([]byte, e.UnpaddedLength())
		_, err := f.ReadAt(buf, int64(e.UnpaddedOffest()))
		must(err)
		cp := &commp.Calc{}
		_, err = cp.Write(buf)
		must(err)
		raw, psz, err := cp.Digest()
		must(err)
		got, err := commcid.DataCommitmentV1ToCID(raw)
		must(err)
		ok := got.Equals(e.PieceCID()) && psz == e.Size
		fmt.Printf("  [%d] CommP=%s\n      offset=%d (unpadded %d) size=%d padded  first bytes=%q\n      recomputed CommP from aggregate bytes: %s  match=%v\n",
			i, e.PieceCID(), e.Offset, e.UnpaddedOffest(), e.Size, bytes.TrimRight(buf[:16], "\x00"), got, ok)
		if !ok {
			must(fmt.Errorf("segment %d bytes do not match its index entry", i))
		}
		indexed[e.PieceCID()] = e
	}

	// 3. expected children + inclusion proofs against the sector CommD
	var pieces []abi.PieceInfo
	for _, a := range os.Args[4:] {
		v2, err := cid.Decode(a)
		must(err)
		v1, payload, err := commcid.PieceCidV1FromV2(v2)
		must(err)
		e, found := indexed[v1]
		if !found {
			must(fmt.Errorf("child %s (v1 %s) is NOT in the index", a, v1))
		}
		fmt.Printf("== child %s\n   v1=%s payload=%d B  -> indexed at offset %d, size %d\n", a, v1, payload, e.Offset, e.Size)
		pieces = append(pieces, abi.PieceInfo{PieceCID: v1, Size: abi.PaddedPieceSize(e.Size)})
	}

	agg, err := datasegment.NewAggregate(dealSize, pieces)
	must(err)
	aggCID, err := agg.PieceCID()
	must(err)
	fmt.Printf("== aggregate rebuilt from children: %s  equals aggregate root: %v\n", aggCID, aggCID.Equals(commD))
	if !aggCID.Equals(commD) {
		must(fmt.Errorf("aggregate CID != given aggregate root"))
	}
	for _, p := range pieces {
		proof, err := agg.ProofForPieceInfo(p)
		must(err)
		aux, err := proof.ComputeExpectedAuxData(datasegment.InclusionVerifierData{CommPc: p.PieceCID, SizePc: p.Size})
		must(err)
		ok := aux.CommPa.Equals(commD) && aux.SizePa == dealSize
		fmt.Printf("== inclusion proof %s: proof path len %d+%d -> root %s size %d  VERIFIED=%v\n",
			p.PieceCID, len(proof.ProofSubtree.Path), len(proof.ProofIndex.Path), aux.CommPa, aux.SizePa, ok)
		if !ok {
			must(fmt.Errorf("inclusion proof does not resolve to the aggregate root"))
		}
	}
	fmt.Println("PoDSI OK: every child is indexed, its bytes match its CommP, and its inclusion proof resolves to the aggregate root")

	if ss, sc := os.Getenv("SECTOR_SIZE"), os.Getenv("SECTOR_COMMD"); ss != "" && sc != "" {
		sectorSize, err := strconv.ParseUint(ss, 10, 64)
		must(err)
		want, err := cid.Decode(sc)
		must(err)
		// Same helpers Curio uses; the proof type only bounds the maximum size.
		comm, sz, err := commputil.PieceAggregateCommP(abi.RegisteredSealProof_StackedDrg64GiBV1_1,
			[]abi.PieceInfo{{PieceCID: aggCID, Size: dealSize}})
		must(err)
		if uint64(sz) < sectorSize {
			comm, err = commputil.ZeroPadPieceCommitment(comm, sz.Unpadded(), abi.PaddedPieceSize(sectorSize).Unpadded())
			must(err)
		}
		fmt.Printf("== sector CommD from [aggregate %d B + zero fill to %d B]: %s  equals on-chain UnsealedCid: %v\n",
			dealSize, sectorSize, comm, comm.Equals(want))
		if !comm.Equals(want) {
			must(fmt.Errorf("sector CommD mismatch"))
		}
	}
}
