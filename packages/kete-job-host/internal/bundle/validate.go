package bundle

import (
	"bytes"
	"crypto/sha1"
	"encoding/hex"
	"strconv"
	"strings"
	"unicode/utf16"
	"unicode/utf8"
)

// Entry is one validated manifest entry, in manifest order. Deleted entries carry only the path.
type Entry struct {
	Path    string
	Deleted bool
	// Mode is 100644 or 100755, from the manifest only (tar modes are ignored).
	Mode string
	Data []byte
	// BlobSHA is git's blob id of Data, computed here.
	BlobSHA string
	// Binary: a NUL in the first BinarySniffBytes bytes. Inline: valid UTF-8 without NUL.
	Binary, Inline bool
}

// Refusal is why a bundle is refused: Reason is exactly the platform's BundleRefusalCode;
// Detail names the offending path (informational, never sent anywhere as is).
type Refusal struct {
	Reason string
	Detail string
}

func (r *Refusal) Error() string { return "bundle refused: " + r.Reason }

// BlobSHA is git's blob id of data.
func BlobSHA(data []byte) string {
	h := sha1.New()
	h.Write([]byte("blob " + strconv.Itoa(len(data)) + "\x00"))
	h.Write(data)
	return hex.EncodeToString(h.Sum(nil))
}

// isBinary is git's heuristic: a NUL in the first BinarySniffBytes bytes.
func isBinary(data []byte) bool {
	return bytes.IndexByte(data[:min(len(data), BinarySniffBytes)], 0) >= 0
}

// decode is TextDecoder('utf-8', {fatal: true}): strict UTF-8, a leading BOM dropped.
func decode(b []byte) (string, bool) {
	if !utf8.Valid(b) {
		return "", false
	}
	return strings.TrimPrefix(string(b), "\ufeff"), true
}

// refusalDetail shows controls, format characters and lone surrogates as U+FFFD and cuts the
// path to 200 characters (the platform also redacts secret shapes; a detail is never sent here).
func refusalDetail(path string) string {
	var b strings.Builder
	n := 0
	for i := 0; i < len(path) && n < 200; n++ {
		r, size := utf8.DecodeRuneInString(path[i:])
		i += size
		if r == utf8.RuneError || r < 0x20 || r == 0x7f || isFormat(r) {
			r = utf8.RuneError
		}
		b.WriteRune(r)
	}
	return b.String()
}

func isFormat(r rune) bool {
	return r == 0xad || (r >= 0x600 && r <= 0x605) || r == 0x61c || r == 0x6dd || r == 0x70f || (r >= 0x200b && r <= 0x200f) ||
		(r >= 0x202a && r <= 0x202e) || (r >= 0x2060 && r <= 0x2064) || (r >= 0x2066 && r <= 0x206f) || r == 0xfeff || (r >= 0xfff9 && r <= 0xfffb) ||
		(r >= 0xe0001 && r <= 0xe007f)
}

type manifestItem struct {
	path    string
	mode    string
	deleted bool
}

// utf16Len is a string's length in UTF-16 code units (zod's min(1) counts those).
func utf16Len(s string) int {
	n := 0
	for _, r := range s {
		n += utf16.RuneLen(r)
	}
	return n
}

// schemaItem applies the manifest item schema: a strict object {path, mode} or {path, deleted:
// true}, path a non-empty string.
func schemaItem(v jsonValue) (manifestItem, bool) {
	if v.kind != jsonObject {
		return manifestItem{}, false
	}
	p, ok := v.obj["path"]
	if !ok || p.kind != jsonString || utf16Len(p.str) < 1 {
		return manifestItem{}, false
	}
	if len(v.obj) != 2 {
		return manifestItem{}, false
	}
	if m, ok := v.obj["mode"]; ok {
		if m.kind != jsonString || (m.str != "100644" && m.str != "100755") {
			return manifestItem{}, false
		}
		return manifestItem{path: p.str, mode: m.str}, true
	}
	if d, ok := v.obj["deleted"]; ok && d.kind == jsonBool && d.bool {
		return manifestItem{path: p.str, deleted: true}, true
	}
	return manifestItem{}, false
}

func prefixes(path string) []string {
	parts := strings.Split(path, "/")
	out := make([]string, 0, len(parts)-1)
	for i := 1; i < len(parts); i++ {
		out = append(out, strings.Join(parts[:i], "/"))
	}
	return out
}

// checkManifest: path rules, duplicates, case collisions and ancestor conflicts across the whole
// manifest (platform checkManifest, same order).
func checkManifest(items []manifestItem) *Refusal {
	seen := map[string]bool{}
	spellings := map[string]string{}
	var files []string
	fileSet := map[string]bool{}
	dirs := map[string]bool{}
	for _, item := range items {
		if r := CheckPath(item.path); r != "" {
			return &Refusal{Reason: r, Detail: refusalDetail(item.path)}
		}
		if seen[item.path] {
			return &Refusal{Reason: "duplicate_path", Detail: refusalDetail(item.path)}
		}
		seen[item.path] = true
		folded := foldPath(item.path)
		pairs := [][2]string{{item.path, folded}}
		for _, p := range prefixes(item.path) {
			pairs = append(pairs, [2]string{p, foldPath(p)})
		}
		for _, pr := range pairs {
			if first, ok := spellings[pr[1]]; ok && first != pr[0] {
				return &Refusal{Reason: "case_collision", Detail: refusalDetail(item.path)}
			}
			spellings[pr[1]] = pr[0]
		}
		if !fileSet[folded] {
			fileSet[folded] = true
			files = append(files, folded)
		}
		for _, p := range prefixes(folded) {
			dirs[p] = true
		}
	}
	for _, f := range files {
		if dirs[f] {
			return &Refusal{Reason: "ancestor_conflict", Detail: refusalDetail(f)}
		}
	}
	return nil
}

// Validate validates a compressed bundle as hostile (platform validateBundle): the entries in
// manifest order, or the first refusal.
func Validate(compressed []byte) ([]Entry, *Refusal) {
	if len(compressed) > MaxCompressed {
		return nil, &Refusal{Reason: "bundle_too_large"}
	}
	var (
		manifest    map[string]manifestItem
		order       []manifestItem
		refusal     *Refusal
		binaries    int
		found       = map[string]Entry{}
		manifestSet bool
	)
	stop := func(r *Refusal) bool { refusal = r; return false }
	reader := &tarReader{
		maxSize: func(index int) int {
			if index == 0 {
				return MaxManifest
			}
			return MaxFile
		},
		onEntry: func(e tarEntry, index int) bool {
			if index == 0 {
				if name, ok := decode(e.name); !ok || name != "manifest.json" {
					return stop(&Refusal{Reason: "manifest_not_first"})
				}
				text, ok := decode(e.data)
				if !ok || strings.IndexByte(text, 0) >= 0 {
					return stop(&Refusal{Reason: "manifest_invalid"})
				}
				v, err := parseJSON([]byte(text))
				if err != nil {
					return stop(&Refusal{Reason: "manifest_invalid"})
				}
				if v.kind == jsonArray && len(v.array) > MaxEntries {
					return stop(&Refusal{Reason: "too_many_entries"})
				}
				if v.kind != jsonArray {
					return stop(&Refusal{Reason: "manifest_invalid"})
				}
				items := make([]manifestItem, 0, len(v.array))
				for _, el := range v.array {
					it, ok := schemaItem(el)
					if !ok {
						return stop(&Refusal{Reason: "manifest_invalid"})
					}
					items = append(items, it)
				}
				if r := checkManifest(items); r != nil {
					return stop(r)
				}
				manifest = map[string]manifestItem{}
				for _, it := range items {
					manifest[it.path] = it
				}
				order, manifestSet = items, true
				return true
			}
			name, ok := decode(e.name)
			if !ok {
				return stop(&Refusal{Reason: "invalid_path"})
			}
			if !strings.HasPrefix(name, "files/") {
				return stop(&Refusal{Reason: "outside_files", Detail: refusalDetail(name)})
			}
			path := strings.TrimPrefix(name, "files/")
			item, ok := manifest[path]
			if !ok {
				return stop(&Refusal{Reason: "unlisted_file", Detail: refusalDetail(path)})
			}
			if item.deleted {
				return stop(&Refusal{Reason: "deleted_with_entry", Detail: refusalDetail(path)})
			}
			if _, dup := found[path]; dup {
				return stop(&Refusal{Reason: "duplicate_entry", Detail: refusalDetail(path)})
			}
			binary := isBinary(e.data)
			if binary {
				if len(e.data) > MaxBinaryFile {
					return stop(&Refusal{Reason: "binary_too_large", Detail: refusalDetail(path)})
				}
				binaries++
				if binaries > MaxBinaries {
					return stop(&Refusal{Reason: "too_many_binaries"})
				}
			}
			inline := utf8.Valid(e.data) && bytes.IndexByte(e.data, 0) < 0
			if FindSecretShape(e.data) != "" {
				return stop(&Refusal{Reason: "secret_shape", Detail: refusalDetail(path)})
			}
			found[path] = Entry{Path: path, Mode: item.mode, Data: e.data, BlobSHA: BlobSHA(e.data), Binary: binary, Inline: inline}
			return true
		},
	}

	gz := gunzip(compressed, reader.push, MaxDecompressed)
	if refusal != nil {
		return nil, refusal
	}
	if reader.refusal != "" {
		return nil, &Refusal{Reason: tarCode(reader.refusal, manifestSet)}
	}
	if gz != "" {
		return nil, &Refusal{Reason: gz}
	}
	if r := reader.end(); r != "" {
		return nil, &Refusal{Reason: tarCode(r, manifestSet)}
	}
	if !manifestSet {
		return nil, &Refusal{Reason: "manifest_not_first"}
	}
	entries := make([]Entry, 0, len(order))
	for _, it := range order {
		if it.deleted {
			entries = append(entries, Entry{Path: it.path, Deleted: true})
			continue
		}
		e, ok := found[it.path]
		if !ok {
			return nil, &Refusal{Reason: "missing_file", Detail: refusalDetail(it.path)}
		}
		entries = append(entries, e)
	}
	return entries, nil
}

// tarCode maps the tar reader's codes to bundle codes: a size refusal is named by what it hit.
func tarCode(code string, manifestSeen bool) string {
	if code == "entry_too_large" {
		if manifestSeen {
			return "file_too_large"
		}
		return "manifest_too_large"
	}
	return code
}
