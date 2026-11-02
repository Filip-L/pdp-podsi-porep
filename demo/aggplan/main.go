// aggplan: plans a PoDSI (FRC-0058) aggregate from child PieceCIDv2s alone, without reading any data.
//
//	aggplan <child-CIDv2>...
//
// The aggregate size and CID are computed exactly like `sptool toolbox mk20-client aggregate`
// (lib/testutils.CreateAggregateFromCars in Curio): datasegment.ComputeDealPlacement, then the
// next power of two above the placement plus the index, then datasegment.NewAggregate.
// Prints JSON: aggregate CIDs and sizes, and where each child lands in the aggregate.
package main

import (
	"encoding/json"
	"fmt"
	"math/bits"
	"os"

	"github.com/filecoin-project/go-data-segment/datasegment"
	commcid "github.com/filecoin-project/go-fil-commcid"
	"github.com/filecoin-project/go-state-types/abi"
	"github.com/ipfs/go-cid"
)

type child struct {
	PieceCidV2 string `json:"pieceCidV2"`
	PieceCidV1 string `json:"pieceCidV1"`
	Payload    uint64 `json:"payloadSize"`
	PaddedSize uint64 `json:"paddedSize"`
	Offset     uint64 `json:"offset"`
}

type plan struct {
	AggregateV2     string  `json:"aggregateCidV2"`
	AggregateV1     string  `json:"aggregateCidV1"`
	PieceSize       uint64  `json:"pieceSize"`
	PayloadSize     uint64  `json:"payloadSize"`
	IndexOffset     uint64  `json:"indexOffset"`
	MaxIndexEntries uint    `json:"maxIndexEntries"`
	Children        []child `json:"children"`
}

func fail(err error) {
	_ = json.NewEncoder(os.Stdout).Encode(map[string]string{"error": err.Error()})
	os.Exit(1)
}

// paddedSize is the power-of-two padded piece size that holds payload bytes after fr32 expansion.
func paddedSize(payload uint64) uint64 {
	p := uint64(128)
	for abi.PaddedPieceSize(p).Unpadded() < abi.UnpaddedPieceSize(payload) {
		p <<= 1
	}
	return p
}

func main() {
	if len(os.Args) < 3 {
		fail(fmt.Errorf("an aggregate needs at least 2 children"))
	}
	var deals []abi.PieceInfo
	var children []child
	for _, a := range os.Args[1:] {
		v2, err := cid.Decode(a)
		if err != nil {
			fail(fmt.Errorf("child %s: %w", a, err))
		}
		v1, payload, err := commcid.PieceCidV1FromV2(v2)
		if err != nil {
			fail(fmt.Errorf("child %s is not a PieceCIDv2: %w", a, err))
		}
		size := paddedSize(payload)
		deals = append(deals, abi.PieceInfo{PieceCID: v1, Size: abi.PaddedPieceSize(size)})
		children = append(children, child{PieceCidV2: a, PieceCidV1: v1.String(), Payload: payload, PaddedSize: size})
	}

	_, upsize, err := datasegment.ComputeDealPlacement(deals)
	if err != nil {
		fail(err)
	}
	pieceSize := abi.PaddedPieceSize(1 << (64 - bits.LeadingZeros64(upsize+256)))

	agg, err := datasegment.NewAggregate(pieceSize, deals)
	if err != nil {
		fail(err)
	}
	v1, err := agg.PieceCID()
	if err != nil {
		fail(err)
	}
	v2, err := commcid.PieceCidV2FromV1(v1, uint64(pieceSize.Unpadded()))
	if err != nil {
		fail(err)
	}
	for i, e := range agg.Index.Entries {
		children[i].Offset = e.Offset
	}
	_ = json.NewEncoder(os.Stdout).Encode(plan{
		AggregateV2:     v2.String(),
		AggregateV1:     v1.String(),
		PieceSize:       uint64(pieceSize),
		PayloadSize:     uint64(pieceSize.Unpadded()),
		IndexOffset:     datasegment.DataSegmentIndexStartOffset(pieceSize),
		MaxIndexEntries: datasegment.MaxIndexEntriesInDeal(pieceSize),
		Children:        children,
	})
}
