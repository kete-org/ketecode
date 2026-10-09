package gitproto

import (
	"bytes"
	"compress/zlib"
	"crypto/sha1"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"strconv"
)

// Object is a git object.
type Object struct {
	Type string // commit, tree, blob or tag
	Data []byte
}

// PackLimits bound what ReadPack accepts (the pack is hostile).
type PackLimits struct {
	MaxPackBytes, MaxInflatedBytes int64
	MaxObjects, MaxDeltaDepth      int
}

// BasePackLimits are the base-tree fetch's caps: 16 MiB packed, 64 MiB inflated, 200,000
// objects, delta chains at most 50 deep (the platform's BASE_PACK_LIMITS).
var BasePackLimits = PackLimits{MaxPackBytes: 16 << 20, MaxInflatedBytes: 64 << 20, MaxObjects: 200_000, MaxDeltaDepth: 50}

// PackError is ReadPack's refusal: Reason is too_large or invalid.
type PackError struct {
	Reason string
	Detail string
}

func (e *PackError) Error() string { return "gitproto: " + e.Detail }

func packErr(reason, detail string) *PackError { return &PackError{Reason: reason, Detail: detail} }

var typeNames = map[byte]string{1: "commit", 2: "tree", 3: "blob", 4: "tag"}
var typeCodes = map[string]byte{"commit": 1, "tree": 2, "blob": 3, "tag": 4}

const (
	ofsDelta = 6
	refDelta = 7
)

// ObjectID is git's object id: the SHA-1 of `<type> <size>\0<data>`, lowercase hex.
func ObjectID(typ string, data []byte) string {
	h := sha1.New()
	h.Write([]byte(typ + " " + strconv.Itoa(len(data)) + "\x00"))
	h.Write(data)
	return hex.EncodeToString(h.Sum(nil))
}

type rawObj struct {
	kind  byte // 0 full, ofsDelta, refDelta
	typ   string
	data  []byte
	ofs   int
	refID string
}

// ReadPack parses a hostile version 2 or 3 pack and returns its objects by id. It refuses (never
// truncates) a pack over the caps, a bad header, object header, zlib stream, size, delta or
// trailing checksum, trailing data, and a REF_DELTA whose base isn't in the pack. Deltas are
// resolved iteratively; every id is computed from content.
func ReadPack(b []byte, lim PackLimits) (objs map[string]Object, err error) {
	defer func() {
		if r := recover(); r != nil {
			objs, err = nil, packErr("invalid", "pack: unreadable")
		}
	}()
	return readPack(b, lim)
}

func readPack(buf []byte, lim PackLimits) (map[string]Object, error) {
	if int64(len(buf)) > lim.MaxPackBytes {
		return nil, packErr("too_large", "pack: over the packed size cap")
	}
	if len(buf) < 32 {
		return nil, packErr("invalid", "pack: too short")
	}
	if string(buf[:4]) != "PACK" {
		return nil, packErr("invalid", "pack: bad signature")
	}
	if v := binary.BigEndian.Uint32(buf[4:8]); v != 2 && v != 3 {
		return nil, packErr("invalid", "pack: unsupported version")
	}
	count := binary.BigEndian.Uint32(buf[8:12])
	if uint64(count) > uint64(lim.MaxObjects) {
		return nil, packErr("too_large", "pack: too many objects")
	}
	end := len(buf) - 20
	sum := sha1.Sum(buf[:end])
	if !bytes.Equal(sum[:], buf[end:]) {
		return nil, packErr("invalid", "pack: checksum mismatch")
	}

	var inflated int64
	budget := func(n int64) error {
		inflated += n
		if inflated > lim.MaxInflatedBytes {
			return packErr("too_large", "pack: over the inflated size cap")
		}
		return nil
	}

	raws := map[int]*rawObj{}
	order := make([]int, 0, count)
	off := 12
	for i := uint32(0); i < count; i++ {
		start := off
		if off >= end {
			return nil, packErr("invalid", "pack: truncated")
		}
		c := buf[off]
		off++
		typeCode := (c >> 4) & 7
		size := uint64(c & 15)
		shift := uint(4)
		for c&0x80 != 0 {
			if off >= end || shift > 35 {
				return nil, packErr("invalid", "pack: bad object header")
			}
			c = buf[off]
			off++
			size += uint64(c&0x7f) << shift
			shift += 7
		}
		ro := &rawObj{}
		switch {
		case typeCode == ofsDelta:
			if off >= end {
				return nil, packErr("invalid", "pack: bad delta offset")
			}
			c = buf[off]
			off++
			rel := uint64(c & 0x7f)
			n := 0
			for c&0x80 != 0 {
				n++
				if off >= end || n > 8 {
					return nil, packErr("invalid", "pack: bad delta offset")
				}
				c = buf[off]
				off++
				rel = (rel+1)*128 + uint64(c&0x7f)
			}
			if rel > uint64(start) {
				return nil, packErr("invalid", "pack: delta base outside the pack")
			}
			base := start - int(rel)
			if _, ok := raws[base]; base < 12 || !ok {
				return nil, packErr("invalid", "pack: delta base outside the pack")
			}
			ro.kind, ro.ofs = ofsDelta, base
		case typeCode == refDelta:
			if off+20 > end {
				return nil, packErr("invalid", "pack: truncated delta base")
			}
			ro.kind, ro.refID = refDelta, hex.EncodeToString(buf[off:off+20])
			off += 20
		default:
			t, ok := typeNames[typeCode]
			if !ok {
				return nil, packErr("invalid", "pack: unknown object type")
			}
			ro.typ = t
		}
		if size > uint64(lim.MaxInflatedBytes) || inflated+int64(size) > lim.MaxInflatedBytes {
			return nil, packErr("too_large", "pack: over the inflated size cap")
		}
		data, consumed, err := inflate(buf[off:end], int64(size))
		if err != nil {
			return nil, err
		}
		if err := budget(int64(size)); err != nil {
			return nil, err
		}
		off += consumed
		ro.data = data // the object, or the delta
		raws[start] = ro
		order = append(order, start)
	}
	if off != end {
		return nil, packErr("invalid", "pack: trailing data")
	}

	type known struct {
		obj   Object
		depth int
	}
	byOffset := map[int]known{}
	byID := map[string]known{}
	waitOfs := map[int][]int{}
	waitID := map[string][]int{}
	resolved := 0
	var work []int
	markKnown := func(at int, o Object, depth int) string {
		id := ObjectID(o.Type, o.Data)
		k := known{o, depth}
		byOffset[at] = k
		if _, ok := byID[id]; !ok {
			byID[id] = k
		}
		resolved++
		return id
	}
	wake := func(at int, id string) {
		work = append(work, waitOfs[at]...)
		work = append(work, waitID[id]...)
		delete(waitOfs, at)
		delete(waitID, id)
	}
	resolve := func(at int) (bool, error) {
		r := raws[at]
		var base known
		var ok bool
		if r.kind == ofsDelta {
			base, ok = byOffset[r.ofs]
		} else {
			base, ok = byID[r.refID]
		}
		if !ok {
			return false, nil
		}
		depth := base.depth + 1
		if depth > lim.MaxDeltaDepth {
			return false, packErr("too_large", "pack: delta chain too deep")
		}
		data, err := applyDelta(base.obj.Data, r.data, lim.MaxInflatedBytes-inflated)
		if err != nil {
			return false, err
		}
		if err := budget(int64(len(data))); err != nil {
			return false, err
		}
		wake(at, markKnown(at, Object{Type: base.obj.Type, Data: data}, depth))
		return true, nil
	}
	for _, at := range order {
		r := raws[at]
		if r.kind == 0 {
			wake(at, markKnown(at, Object{Type: r.typ, Data: r.data}, 0))
		} else {
			ok, err := resolve(at)
			if err != nil {
				return nil, err
			}
			if !ok {
				if r.kind == ofsDelta {
					waitOfs[r.ofs] = append(waitOfs[r.ofs], at)
				} else {
					waitID[r.refID] = append(waitID[r.refID], at)
				}
			}
		}
		for len(work) > 0 {
			next := work[len(work)-1]
			work = work[:len(work)-1]
			ok, err := resolve(next)
			if err != nil {
				return nil, err
			}
			if !ok {
				return nil, packErr("invalid", "pack: delta base missing")
			}
		}
	}
	if resolved != len(order) {
		return nil, packErr("invalid", "pack: delta base missing")
	}
	out := make(map[string]Object, len(byID))
	for id, k := range byID {
		out[id] = k.obj
	}
	return out, nil
}

// inflate reads one zlib stream from the start of b that must inflate to exactly size bytes and
// returns the data and the compressed bytes it consumed. zlib over a bytes.Reader (an
// io.ByteReader) reads no input past the stream's end, so the reader's position is exact.
func inflate(b []byte, size int64) ([]byte, int, error) {
	br := bytes.NewReader(b)
	zr, err := zlib.NewReader(br)
	if err != nil {
		return nil, 0, packErr("invalid", "pack: bad zlib stream")
	}
	data, err := io.ReadAll(io.LimitReader(zr, size+1))
	if err != nil {
		return nil, 0, packErr("invalid", "pack: bad zlib stream")
	}
	if int64(len(data)) > size {
		return nil, 0, packErr("invalid", "pack: object larger than its declared size")
	}
	if int64(len(data)) != size {
		return nil, 0, packErr("invalid", "pack: object size mismatch")
	}
	consumed := len(b) - br.Len()
	if consumed <= 0 {
		return nil, 0, packErr("invalid", "pack: object size mismatch")
	}
	return data, consumed, nil
}

func readVarint(delta []byte, i *int) (uint64, error) {
	var v uint64
	shift := uint(0)
	for {
		if *i >= len(delta) || shift > 35 {
			return 0, packErr("invalid", "pack: bad delta header")
		}
		c := delta[*i]
		*i++
		v += uint64(c&0x7f) << shift
		shift += 7
		if c&0x80 == 0 {
			return v, nil
		}
	}
}

// ApplyDelta applies a git delta to base (exported for tests and callers that hold deltas).
func ApplyDelta(base, delta []byte) ([]byte, error) { return applyDelta(base, delta, 1<<62) }

// applyDelta applies a git delta to base; the result may be at most remaining bytes.
func applyDelta(base, delta []byte, remaining int64) ([]byte, error) {
	i := 0
	src, err := readVarint(delta, &i)
	if err != nil {
		return nil, err
	}
	if src != uint64(len(base)) {
		return nil, packErr("invalid", "pack: delta base size mismatch")
	}
	tgt, err := readVarint(delta, &i)
	if err != nil {
		return nil, err
	}
	if remaining < 0 || tgt > uint64(remaining) {
		return nil, packErr("too_large", "pack: over the inflated size cap")
	}
	out := make([]byte, tgt)
	o := uint64(0)
	for i < len(delta) {
		op := delta[i]
		i++
		switch {
		case op&0x80 != 0:
			var offset, size uint64
			for b := uint(0); b < 4; b++ {
				if op&(1<<b) != 0 {
					if i >= len(delta) {
						return nil, packErr("invalid", "pack: truncated delta")
					}
					offset |= uint64(delta[i]) << (8 * b)
					i++
				}
			}
			for b := uint(0); b < 3; b++ {
				if op&(1<<(4+b)) != 0 {
					if i >= len(delta) {
						return nil, packErr("invalid", "pack: truncated delta")
					}
					size |= uint64(delta[i]) << (8 * b)
					i++
				}
			}
			if size == 0 {
				size = 0x10000
			}
			if offset+size > uint64(len(base)) || o+size > tgt {
				return nil, packErr("invalid", "pack: delta copy out of range")
			}
			copy(out[o:], base[offset:offset+size])
			o += size
		case op > 0:
			n := uint64(op)
			if uint64(i)+n > uint64(len(delta)) || o+n > tgt {
				return nil, packErr("invalid", "pack: delta insert out of range")
			}
			copy(out[o:], delta[i:i+int(n)])
			i += int(n)
			o += n
		default:
			return nil, packErr("invalid", "pack: reserved delta opcode")
		}
	}
	if o != tgt {
		return nil, packErr("invalid", "pack: delta result size mismatch")
	}
	return out, nil
}

// WritePack returns a version 2 pack of objs, undeltified, with its trailing checksum.
func WritePack(objs []Object) []byte {
	var body bytes.Buffer
	body.WriteString("PACK")
	_ = binary.Write(&body, binary.BigEndian, uint32(2))
	_ = binary.Write(&body, binary.BigEndian, uint32(len(objs)))
	for _, o := range objs {
		code, ok := typeCodes[o.Type]
		if !ok {
			panic(fmt.Sprintf("gitproto: unknown object type %q", o.Type))
		}
		size := uint64(len(o.Data))
		c := code<<4 | byte(size&15)
		size >>= 4
		for size > 0 {
			body.WriteByte(c | 0x80)
			c = byte(size & 0x7f)
			size >>= 7
		}
		body.WriteByte(c)
		zw := zlib.NewWriter(&body)
		_, _ = zw.Write(o.Data)
		_ = zw.Close()
	}
	sum := sha1.Sum(body.Bytes())
	body.Write(sum[:])
	return body.Bytes()
}

// IsPackError reports whether err is a pack refusal with the given reason ("" = any).
func IsPackError(err error, reason string) bool {
	var pe *PackError
	return errors.As(err, &pe) && (reason == "" || pe.Reason == reason)
}
