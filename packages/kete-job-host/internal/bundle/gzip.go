package bundle

import (
	"bytes"
	"compress/flate"
	"encoding/binary"
	"errors"
	"hash/crc32"
	"io"
)

// A strict single-member gunzip (RFC 1952; platform gzip.ts): the header parsed by hand, the
// deflate data inflated with every output byte counted (reading stops at maxOut), the CRC-32 and
// ISIZE trailer checked, and the trailer must be the last bytes: a second member or any trailing
// byte is refused.

const (
	fText    = 1
	fHCRC    = 2
	fExtra   = 4
	fName    = 8
	fComment = 16
)

// chunkSize is the inflate output chunk the platform's Node stream emits (createInflateRaw
// chunkSize 64 KiB): the decompressed cap is checked per chunk, before the tar reader sees it, so
// a refusal inside the chunk that crosses the cap loses to decompressed_too_large there too.
const chunkSize = 64 * 1024

// gzipHeaderLength is where the deflate data starts, or -1 for a malformed header.
func gzipHeaderLength(in []byte) int {
	if len(in) < 18 || in[0] != 0x1f || in[1] != 0x8b || in[2] != 8 {
		return -1
	}
	flags := in[3]
	if flags&^(fText|fHCRC|fExtra|fName|fComment) != 0 {
		return -1
	}
	at := 10
	if flags&fExtra != 0 {
		if at+2 > len(in) {
			return -1
		}
		at += 2 + (int(in[at]) | int(in[at+1])<<8)
		if at > len(in) {
			return -1
		}
	}
	for _, f := range []byte{fName, fComment} {
		if flags&f != 0 {
			end := bytes.IndexByte(in[at:], 0)
			if end < 0 {
				return -1
			}
			at += end + 1
		}
	}
	if flags&fHCRC != 0 {
		at += 2
	}
	if at > len(in) {
		return -1
	}
	return at
}

// gunzip inflates in's one member, handing each output chunk to onData (returning false stops
// reading, which counts as success). It returns "" or the platform's gzip refusal code.
func gunzip(in []byte, onData func([]byte) bool, maxOut int) string {
	start := gzipHeaderLength(in)
	if start < 0 {
		return "bad_gzip"
	}
	// A bytes.Reader is an io.ByteReader: flate then reads exactly the deflate data, so the
	// reader's position afterwards is where the trailer starts.
	src := bytes.NewReader(in[start:])
	fr := flate.NewReader(src)
	defer fr.Close()
	buf := make([]byte, chunkSize)
	out := 0
	var crc uint32
	for {
		n, end, err := readChunk(fr, buf)
		if n > 0 {
			out += n
			if out > maxOut {
				return "decompressed_too_large"
			}
			crc = crc32.Update(crc, crc32.IEEETable, buf[:n])
			if !onData(buf[:n]) {
				return ""
			}
		}
		if err != nil {
			return "bad_gzip"
		}
		if end {
			break
		}
	}
	consumed := len(in) - start - src.Len()
	trailer := start + consumed
	if trailer+8 > len(in) {
		return "truncated"
	}
	if binary.LittleEndian.Uint32(in[trailer:]) != crc || binary.LittleEndian.Uint32(in[trailer+4:]) != uint32(out) {
		return "bad_gzip"
	}
	after := trailer + 8
	if after == len(in) {
		return ""
	}
	if after+1 < len(in) && in[after] == 0x1f && in[after+1] == 0x8b {
		return "multi_member_gzip"
	}
	return "trailing_data"
}

// readChunk fills buf from the inflater: n bytes, end once the deflate stream has ended (io.EOF),
// err for anything else (corrupt or cut-off data).
func readChunk(r io.Reader, buf []byte) (n int, end bool, err error) {
	for n < len(buf) {
		m, err := r.Read(buf[n:])
		n += m
		if errors.Is(err, io.EOF) {
			return n, true, nil
		}
		if err != nil {
			return n, false, err
		}
	}
	return n, false, nil
}
