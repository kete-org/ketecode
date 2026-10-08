package bundle

import (
	"bytes"
	"math"
)

// A strict push parser for the bundle's tar stream (platform tar.ts): regular files only; every
// other entry type, PAX global headers, PAX keys other than `path`, `GNU.sparse.*` keys, GNU long
// links, two extension headers in a row or one with no entry after it, a bad checksum, a base-256
// size, a header that is neither USTAR nor GNU, and any byte after the two zero blocks that end
// the archive are refused with a fixed code. An entry's data is buffered only up to the size its
// header declared, after that size passed maxSize.

const (
	tarBlock    = 512
	maxPax      = 8192
	maxLongName = 4200
)

type tarEntry struct {
	name, data []byte
}

type tarExtension struct {
	kind string // "pax" or "gnu"
	name []byte
}

type tarState int

const (
	stHeader tarState = iota
	stData
	stPadding
	stEnd1
	stEnded
)

type tarReader struct {
	maxSize func(index int) int
	onEntry func(e tarEntry, index int) bool

	state   tarState
	kind    string // data state: "file", "pax", "gnu"
	size    int
	buffer  []byte
	filled  int
	padding int
	left    int // padding state

	pending   []byte
	extension *tarExtension
	header    []byte
	index     int
	refusal   string
	stopped   bool
}

func field(block []byte, offset, length int) []byte {
	s := block[offset : offset+length]
	if i := bytes.IndexByte(s, 0); i >= 0 {
		return s[:i]
	}
	return s
}

// octal is a numeric field: optional leading spaces, octal digits, then NUL/space padding only.
func octal(block []byte, offset, length int) (int, bool) {
	raw := block[offset : offset+length]
	i := 0
	for i < len(raw) && raw[i] == 0x20 {
		i++
	}
	value, digits := 0.0, 0
	for ; i < len(raw); i++ {
		b := raw[i]
		if b < '0' || b > '7' {
			break
		}
		value = value*8 + float64(b-'0')
		digits++
		if value > 9007199254740991 {
			return 0, false
		}
	}
	for ; i < len(raw); i++ {
		if raw[i] != 0 && raw[i] != 0x20 {
			return 0, false
		}
	}
	if digits == 0 || value > math.MaxInt {
		return 0, false
	}
	return int(value), true
}

func isZero(b []byte) bool {
	for _, x := range b {
		if x != 0 {
			return false
		}
	}
	return true
}

// parsePax parses PAX records strictly: only `path`, once, non-empty, no NUL.
func parsePax(data []byte) ([]byte, string) {
	at := 0
	var path []byte
	for at < len(data) {
		sp := bytes.IndexByte(data[at:], 0x20)
		if sp < 0 || sp > 5 || sp == 0 {
			return nil, "bad_extension"
		}
		space := at + sp
		lenText := data[at:space]
		if lenText[0] < '1' || lenText[0] > '9' {
			return nil, "bad_extension"
		}
		n := 0
		for _, c := range lenText {
			if c < '0' || c > '9' {
				return nil, "bad_extension"
			}
			n = n*10 + int(c-'0')
		}
		end := at + n
		if end > len(data) || data[end-1] != 0x0a {
			return nil, "bad_extension"
		}
		if space+1 > end-1 {
			return nil, "bad_extension"
		}
		record := data[space+1 : end-1]
		eq := bytes.IndexByte(record, 0x3d)
		if eq <= 0 {
			return nil, "bad_extension"
		}
		key := string(record[:eq])
		value := record[eq+1:]
		if len(key) >= len("GNU.sparse.") && key[:len("GNU.sparse.")] == "GNU.sparse." {
			return nil, "sparse"
		}
		if key != "path" {
			return nil, "pax_key"
		}
		if path != nil || len(value) == 0 || bytes.IndexByte(value, 0) >= 0 {
			return nil, "bad_extension"
		}
		path = value
		at = end
	}
	return path, ""
}

// push feeds decompressed bytes; false once refused or stopped.
func (t *tarReader) push(chunk []byte) bool {
	if t.refusal != "" || t.stopped {
		return false
	}
	data := chunk
	if len(t.pending) > 0 {
		data = append(append([]byte(nil), t.pending...), chunk...)
	}
	t.pending = nil
	at := 0
	for at < len(data) && t.refusal == "" && !t.stopped {
		switch t.state {
		case stEnded:
			t.refusal = "trailing_data"
			return false
		case stData:
			take := min(t.size-t.filled, len(data)-at)
			copy(t.buffer[t.filled:], data[at:at+take])
			t.filled += take
			at += take
			if t.filled == t.size {
				t.finishData()
				if t.padding > 0 && t.refusal == "" && !t.stopped {
					t.state, t.left = stPadding, t.padding
				} else if t.refusal == "" && !t.stopped {
					t.state = stHeader
				}
			}
		case stPadding:
			take := min(t.left, len(data)-at)
			at += take
			t.left -= take
			if t.left == 0 {
				t.state = stHeader
			}
		case stHeader, stEnd1:
			if len(data)-at < tarBlock {
				t.pending = append([]byte(nil), data[at:]...)
				return t.refusal == ""
			}
			block := data[at : at+tarBlock]
			at += tarBlock
			t.onBlock(block)
		}
	}
	return t.refusal == "" && !t.stopped
}

// end says the input ended: the archive must have ended with two zero blocks.
func (t *tarReader) end() string {
	if t.refusal != "" || t.stopped {
		return t.refusal
	}
	if t.state != stEnded || len(t.pending) > 0 {
		t.refusal = "truncated"
	}
	return t.refusal
}

func (t *tarReader) onBlock(block []byte) {
	if t.state == stEnd1 {
		if !isZero(block) {
			t.refusal = "bad_header"
			return
		}
		t.state = stEnded
		return
	}
	if isZero(block) {
		if t.extension != nil {
			t.refusal = "dangling_extension"
			return
		}
		t.state = stEnd1
		return
	}
	stored, ok := octal(block, 148, 8)
	sum := 0
	for i := range tarBlock {
		if i >= 148 && i < 156 {
			sum += 0x20
		} else {
			sum += int(block[i])
		}
	}
	if !ok || stored != sum {
		t.refusal = "bad_checksum"
		return
	}
	magic := string(block[257:265])
	ustar := magic == "ustar\x0000"
	gnu := magic == "ustar  \x00"
	if !ustar && !gnu {
		t.refusal = "bad_header"
		return
	}
	if block[124]&0x80 != 0 {
		t.refusal = "base256_size"
		return
	}
	size, ok := octal(block, 124, 12)
	if !ok {
		t.refusal = "bad_header"
		return
	}
	typ := block[156]
	padding := (tarBlock - size%tarBlock) % tarBlock
	if typ == 'x' || typ == 'L' {
		if t.extension != nil {
			t.refusal = "double_extension"
			return
		}
		limit := maxPax
		if typ == 'L' {
			limit = maxLongName
		}
		if size > limit || size == 0 {
			t.refusal = "bad_extension"
			return
		}
		t.kind = "pax"
		if typ == 'L' {
			t.kind = "gnu"
		}
		t.state, t.size, t.buffer, t.filled, t.padding = stData, size, make([]byte, size), 0, padding
		return
	}
	if typ == 'g' {
		t.refusal = "pax_global"
		return
	}
	if typ == 'K' {
		t.refusal = "gnu_long_link"
		return
	}
	if typ != '0' && typ != 0 {
		t.refusal = "entry_type"
		return
	}
	if size > t.maxSize(t.index) {
		t.refusal = "entry_too_large"
		return
	}
	t.header = append([]byte(nil), block...)
	t.kind = "file"
	if size == 0 {
		t.size, t.buffer, t.filled, t.padding = 0, []byte{}, 0, 0
		t.finishData()
		if t.refusal == "" {
			t.state = stHeader
		}
		return
	}
	t.state, t.size, t.buffer, t.filled, t.padding = stData, size, make([]byte, size), 0, padding
}

func (t *tarReader) finishData() {
	switch t.kind {
	case "pax":
		path, code := parsePax(t.buffer)
		if code != "" {
			t.refusal = code
			return
		}
		if path == nil {
			t.refusal = "bad_extension"
			return
		}
		t.extension = &tarExtension{kind: "pax", name: path}
		return
	case "gnu":
		nul := bytes.IndexByte(t.buffer, 0)
		if nul <= 0 || !isZero(t.buffer[nul:]) {
			t.refusal = "bad_extension"
			return
		}
		t.extension = &tarExtension{kind: "gnu", name: append([]byte(nil), t.buffer[:nul]...)}
		return
	}
	header := t.header
	var name []byte
	if t.extension != nil {
		name = t.extension.name
	} else {
		base := field(header, 0, 100)
		var prefix []byte
		if string(header[257:265]) != "ustar  \x00" {
			prefix = field(header, 345, 155)
		}
		if len(prefix) > 0 {
			name = append(append(append([]byte(nil), prefix...), '/'), base...)
		} else {
			name = append([]byte(nil), base...)
		}
	}
	t.extension = nil
	t.header = nil
	data := t.buffer
	t.buffer = nil
	proceed := t.onEntry(tarEntry{name: name, data: data}, t.index)
	t.index++
	if !proceed {
		t.stopped = true
	}
}
