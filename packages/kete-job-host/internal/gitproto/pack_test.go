package gitproto

import (
	"bytes"
	"compress/zlib"
	"crypto/sha1"
	"encoding/binary"
	"encoding/hex"
	"strings"
	"testing"
)

// rawEntry is one hand-built pack entry.
type rawEntry struct {
	code   byte
	size   int    // declared size (default len(data))
	extra  []byte // OFS/REF delta base bytes
	data   []byte // inflated content (object or delta)
	zdata  []byte // overrides the zlib stream
	ofsRel int    // with code 6: relative offset to the base (computed from baseIdx when >= 0)
	base   int    // index of the base entry for code 6, -1 otherwise
}

func zlibBytes(b []byte) []byte {
	var buf bytes.Buffer
	w := zlib.NewWriter(&buf)
	_, _ = w.Write(b)
	_ = w.Close()
	return buf.Bytes()
}

func ofsBytes(rel int) []byte {
	n := uint64(rel)
	out := []byte{byte(n & 127)}
	for n >>= 7; n > 0; n >>= 7 {
		n--
		out = append([]byte{byte(128 | (n & 127))}, out...)
	}
	return out
}

// buildPack writes entries (count overrides the header's count when >= 0).
func buildPack(entries []rawEntry, count int, trailing []byte) []byte {
	var body bytes.Buffer
	body.WriteString("PACK")
	_ = binary.Write(&body, binary.BigEndian, uint32(2))
	if count < 0 {
		count = len(entries)
	}
	_ = binary.Write(&body, binary.BigEndian, uint32(count))
	starts := make([]int, len(entries))
	for i, e := range entries {
		starts[i] = body.Len()
		size := e.size
		if size == 0 && e.data != nil {
			size = len(e.data)
		}
		s := uint64(size)
		c := e.code<<4 | byte(s&15)
		s >>= 4
		for s > 0 {
			body.WriteByte(c | 0x80)
			c = byte(s & 0x7f)
			s >>= 7
		}
		body.WriteByte(c)
		if e.code == ofsDelta {
			body.Write(ofsBytes(starts[i] - starts[e.base]))
		}
		body.Write(e.extra)
		if e.zdata != nil {
			body.Write(e.zdata)
		} else {
			body.Write(zlibBytes(e.data))
		}
	}
	body.Write(trailing)
	sum := sha1.Sum(body.Bytes())
	body.Write(sum[:])
	return body.Bytes()
}

func varint(n int) []byte {
	var out []byte
	for {
		b := byte(n & 0x7f)
		n >>= 7
		if n > 0 {
			out = append(out, b|0x80)
		} else {
			return append(out, b)
		}
	}
}

// delta builds a delta: copy base[0:copyN], then insert ins.
func delta(base []byte, copyN int, ins []byte) []byte {
	d := append(varint(len(base)), varint(copyN+len(ins))...)
	if copyN > 0 {
		d = append(d, 0x80|0x10, byte(copyN)) // offset 0, size byte 0
	}
	d = append(d, byte(len(ins)))
	return append(d, ins...)
}

func TestZlibConsumesExactly(t *testing.T) {
	z := zlibBytes([]byte(strings.Repeat("hello world ", 1000)))
	in := append(append([]byte{}, z...), []byte("TRAILING GARBAGE")...)
	data, consumed, err := inflate(in, 12000)
	if err != nil || len(data) != 12000 || consumed != len(z) {
		t.Fatalf("consumed %d want %d err %v", consumed, len(z), err)
	}
	if _, _, err := inflate(in, 11999); !IsPackError(err, "invalid") {
		t.Fatalf("an object larger than declared: %v", err)
	}
	if _, _, err := inflate(in, 12001); !IsPackError(err, "invalid") {
		t.Fatalf("an object smaller than declared: %v", err)
	}
}

func TestWriteReadRoundTrip(t *testing.T) {
	objs := []Object{{"blob", []byte("hello\n")}, {"blob", nil}, {"tree", TreeBody([]TreeEntry{{"100644", "a", ObjectID("blob", []byte("hello\n"))}})}, {"commit", []byte("tree x\n\nmsg\n")}}
	got, err := ReadPack(WritePack(objs), BasePackLimits)
	if err != nil || len(got) != 4 {
		t.Fatalf("%v %d", err, len(got))
	}
	for _, o := range objs {
		g, ok := got[ObjectID(o.Type, o.Data)]
		if !ok || g.Type != o.Type || !bytes.Equal(g.Data, o.Data) {
			t.Errorf("%s missing or changed", o.Type)
		}
	}
	// git's own id for "hello\n".
	if id := ObjectID("blob", []byte("hello\n")); id != "ce013625030ba8dba906f756967f9e9ca394464a" {
		t.Errorf("blob id %s", id)
	}
}

func TestDeltas(t *testing.T) {
	base := []byte(strings.Repeat("base content ", 10))
	d1 := delta(base, 20, []byte("+one"))
	want1 := append(append([]byte{}, base[:20]...), "+one"...)
	d2 := delta(want1, 10, []byte("+two"))
	want2 := append(append([]byte{}, want1[:10]...), "+two"...)
	baseID := ObjectID("blob", base)
	raw, _ := hex.DecodeString(baseID)
	// ofs delta on the base, then a ref delta on that delta's result (by id), declared before its base
	// resolves to exercise the waiting list: the ref delta comes first.
	id1 := ObjectID("blob", want1)
	raw1, _ := hex.DecodeString(id1)
	p := buildPack([]rawEntry{
		{code: refDelta, extra: raw1, data: d2, base: -1},
		{code: 3, data: base, base: -1},
		{code: ofsDelta, data: d1, base: 1},
	}, -1, nil)
	got, err := ReadPack(p, BasePackLimits)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got[id1].Data, want1) || !bytes.Equal(got[ObjectID("blob", want2)].Data, want2) || got[baseID].Type != "blob" {
		t.Fatalf("deltas not resolved: %d objects", len(got))
	}
	// A ref delta whose base isn't in the pack (thin).
	p = buildPack([]rawEntry{{code: refDelta, extra: raw, data: d1, base: -1}}, -1, nil)
	if _, err := ReadPack(p, BasePackLimits); !IsPackError(err, "invalid") || !strings.Contains(err.Error(), "base missing") {
		t.Errorf("thin pack: %v", err)
	}
	// Depth cap.
	lim := BasePackLimits
	lim.MaxDeltaDepth = 1
	p = buildPack([]rawEntry{{code: 3, data: base, base: -1}, {code: ofsDelta, data: d1, base: 0}, {code: refDelta, extra: raw1, data: d2, base: -1}}, -1, nil)
	if _, err := ReadPack(p, lim); !IsPackError(err, "too_large") {
		t.Errorf("depth: %v", err)
	}
	if _, err := ReadPack(p, BasePackLimits); err != nil {
		t.Errorf("depth 2 within the default cap: %v", err)
	}
}

func TestApplyDeltaRefusals(t *testing.T) {
	base := []byte("0123456789")
	cases := map[string][]byte{
		"base size":    append(varint(9), varint(1)...),
		"reserved op":  append(append(varint(10), varint(1)...), 0),
		"copy range":   append(append(varint(10), varint(5)...), 0x80|0x01|0x10, 8, 5),
		"insert range": append(append(varint(10), varint(1)...), 3, 'a', 'b', 'c'),
		"short result": append(append(varint(10), varint(5)...), 1, 'a'),
		"truncated":    append(append(varint(10), varint(5)...), 0x80|0x01),
		"bad header":   {0x80},
	}
	for name, d := range cases {
		if _, err := ApplyDelta(base, d); !IsPackError(err, "") {
			t.Errorf("%s: %v", name, err)
		}
	}
	if _, err := applyDelta(base, append(varint(10), varint(100)...), 50); !IsPackError(err, "too_large") {
		t.Errorf("target over remaining: %v", err)
	}
}

func TestReadPackRefusals(t *testing.T) {
	good := WritePack([]Object{{"blob", []byte("x")}})
	fix := func(b []byte) []byte { // re-checksum
		b = b[:len(b)-20]
		s := sha1.Sum(b)
		return append(b, s[:]...)
	}
	big := bytes.Repeat([]byte("a"), 4096)
	cases := []struct {
		name, reason string
		pack         []byte
		lim          PackLimits
	}{
		{"short", "invalid", []byte("PACK"), BasePackLimits},
		{"signature", "invalid", fix(append([]byte("KCAP"), good[4:]...)), BasePackLimits},
		{"version", "invalid", fix(append(append([]byte("PACK"), 0, 0, 0, 4), good[8:]...)), BasePackLimits},
		{"checksum", "invalid", append(append([]byte{}, good[:len(good)-1]...), good[len(good)-1]^1), BasePackLimits},
		{"packed size", "too_large", good, PackLimits{MaxPackBytes: 10, MaxInflatedBytes: 1 << 20, MaxObjects: 10, MaxDeltaDepth: 5}},
		{"objects", "too_large", good, PackLimits{MaxPackBytes: 1 << 20, MaxInflatedBytes: 1 << 20, MaxObjects: 0, MaxDeltaDepth: 5}},
		{"inflated", "too_large", WritePack([]Object{{"blob", big}}), PackLimits{MaxPackBytes: 1 << 20, MaxInflatedBytes: 100, MaxObjects: 10, MaxDeltaDepth: 5}},
		{"count over entries", "invalid", buildPack([]rawEntry{{code: 3, data: []byte("x"), base: -1}}, 2, nil), BasePackLimits},
		{"trailing data", "invalid", buildPack([]rawEntry{{code: 3, data: []byte("x"), base: -1}}, -1, []byte("junk")), BasePackLimits},
		{"unknown type", "invalid", buildPack([]rawEntry{{code: 5, data: []byte("x"), base: -1}}, -1, nil), BasePackLimits},
		{"size mismatch", "invalid", buildPack([]rawEntry{{code: 3, size: 5, data: []byte("x"), base: -1}}, -1, nil), BasePackLimits},
		{"inflates past size", "invalid", buildPack([]rawEntry{{code: 3, size: 1, zdata: zlibBytes([]byte("xyz")), base: -1}}, -1, nil), BasePackLimits},
		{"bad zlib", "invalid", buildPack([]rawEntry{{code: 3, size: 3, zdata: []byte{0x78, 0x9c, 0xff, 0xff, 0xff}, base: -1}}, -1, nil), BasePackLimits},
	}
	for _, c := range cases {
		if _, err := ReadPack(c.pack, c.lim); !IsPackError(err, c.reason) {
			t.Errorf("%s: %v, want %s", c.name, err, c.reason)
		}
	}
	// An OFS_DELTA pointing outside the pack (before the header / at no entry).
	p := buildPack([]rawEntry{{code: 3, data: []byte("x"), base: -1}}, 2, nil)
	p = p[:len(p)-20]
	p = append(p, ofsDelta<<4|1, 100) // rel 100 > offset
	p = append(p, zlibBytes([]byte("x"))...)
	s := sha1.Sum(p)
	if _, err := ReadPack(append(p, s[:]...), BasePackLimits); !IsPackError(err, "invalid") {
		t.Errorf("ofs outside: %v", err)
	}
}
