package orchestration

// The strict JSON reader for plan files (orchestrations-v1 `parsePlanJson`): RFC 8259 syntax,
// canonical non-negative integers only, and no two members of an object whose names are equal or
// equal ignoring ASCII case. encoding/json can't be used: it matches member names
// case-insensitively, keeps the last duplicate, accepts any number spelling and turns a lone
// surrogate escape into U+FFFD (changing what a digest would cover). Strings keep a lone surrogate
// as its WTF-8 bytes, so it compares like the platform's UTF-16 string and fails utf8.ValidString,
// which the schema then refuses.

import (
	"regexp"
	"strconv"
	"strings"
	"unicode/utf16"
	"unicode/utf8"
)

// jsonKind is a decoded value's type.
type jsonKind int

const (
	kindNull jsonKind = iota
	kindBool
	kindNumber
	kindString
	kindArray
	kindObject
)

// jsonValue is one decoded value. Objects keep their members in order; names are unique (a
// duplicate or case-variant name is refused while parsing).
type jsonValue struct {
	kind    jsonKind
	b       bool
	num     float64
	str     string
	arr     []jsonValue
	members []jsonMember
}

type jsonMember struct {
	name  string
	value jsonValue
}

func (v jsonValue) get(name string) (jsonValue, bool) {
	for _, m := range v.members {
		if m.name == name {
			return m.value, true
		}
	}
	return jsonValue{}, false
}

// planJSONError is a syntax error (not_json) or a non-canonical document (not_canonical).
type planJSONError struct{ reason Refusal }

func (e *planJSONError) Error() string { return string(e.reason) }

var (
	numberRe    = regexp.MustCompile(`^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?`)
	canonicalRe = regexp.MustCompile(`^(?:0|[1-9][0-9]*)$`)
)

// maxDepth is the deepest nesting a plan file may have (a Kete addition both readers apply: the
// plan file needs 4 levels; deeper is not_json, so no reader recurses without bound).
const maxDepth = 8

type planParser struct {
	text  string
	i     int
	depth int
}

// enter counts one more open container; past maxDepth the document is not_json.
func (p *planParser) enter() {
	p.depth++
	if p.depth > maxDepth {
		p.fail()
	}
}

func (p *planParser) fail() { panic(&planJSONError{reason: RefuseNotJSON}) }

func (p *planParser) ws() {
	for p.i < len(p.text) {
		switch p.text[p.i] {
		case ' ', '\t', '\n', '\r':
			p.i++
		default:
			return
		}
	}
}

func (p *planParser) peek() byte {
	if p.i < len(p.text) {
		return p.text[p.i]
	}
	return 0
}

// str scans a string's extent as the platform does (a backslash skips the next unit), then decodes
// it with JSON's string rules.
func (p *planParser) str() string {
	start := p.i
	p.i++
	for p.i < len(p.text) && p.text[p.i] != '"' {
		if p.text[p.i] == '\\' {
			p.i += 2
		} else {
			p.i++
		}
	}
	if p.i >= len(p.text) {
		p.fail()
	}
	p.i++
	s, ok := decodeJSONString(p.text[start+1 : p.i-1])
	if !ok {
		p.fail()
	}
	return s
}

// decodeJSONString is JSON.parse of one string literal's body: no raw control characters, only
// the eight escapes and \uXXXX; surrogate pairs combine, a lone surrogate stays (as WTF-8).
func decodeJSONString(body string) (string, bool) {
	var b strings.Builder
	for i := 0; i < len(body); {
		c := body[i]
		if c < 0x20 {
			return "", false
		}
		if c != '\\' {
			b.WriteByte(c)
			i++
			continue
		}
		if i+1 >= len(body) {
			return "", false
		}
		e := body[i+1]
		i += 2
		switch e {
		case '"', '\\', '/':
			b.WriteByte(e)
		case 'b':
			b.WriteByte('\b')
		case 'f':
			b.WriteByte('\f')
		case 'n':
			b.WriteByte('\n')
		case 'r':
			b.WriteByte('\r')
		case 't':
			b.WriteByte('\t')
		case 'u':
			u, ok := hex4(body, i)
			if !ok {
				return "", false
			}
			i += 4
			if utf16.IsSurrogate(rune(u)) && u < 0xDC00 && i+6 <= len(body) && body[i] == '\\' && body[i+1] == 'u' {
				if lo, ok := hex4(body, i+2); ok && lo >= 0xDC00 && lo <= 0xDFFF {
					b.WriteRune(utf16.DecodeRune(rune(u), rune(lo)))
					i += 6
					continue
				}
			}
			if utf16.IsSurrogate(rune(u)) {
				writeWTF8(&b, u)
			} else {
				b.WriteRune(rune(u))
			}
		default:
			return "", false
		}
	}
	return b.String(), true
}

func hex4(s string, at int) (uint16, bool) {
	if at+4 > len(s) {
		return 0, false
	}
	n, err := strconv.ParseUint(s[at:at+4], 16, 16)
	if err != nil {
		return 0, false
	}
	return uint16(n), true
}

// writeWTF8 writes a lone surrogate as the three bytes UTF-8 would use for it (not valid UTF-8).
func writeWTF8(b *strings.Builder, u uint16) {
	b.WriteByte(0xE0 | byte(u>>12))
	b.WriteByte(0x80 | byte(u>>6)&0x3F)
	b.WriteByte(0x80 | byte(u)&0x3F)
}

// foldASCII lowercases A-Z only (the platform's duplicate-name rule).
func foldASCII(s string) string {
	return strings.Map(func(r rune) rune {
		if r >= 'A' && r <= 'Z' {
			return r + 'a' - 'A'
		}
		return r
	}, s)
}

func (p *planParser) value() jsonValue {
	p.ws()
	switch c := p.peek(); c {
	case '{':
		p.i++
		p.enter()
		defer func() { p.depth-- }()
		out := jsonValue{kind: kindObject, members: []jsonMember{}}
		seen := map[string]bool{}
		p.ws()
		if p.peek() == '}' {
			p.i++
			return out
		}
		for {
			p.ws()
			if p.peek() != '"' {
				p.fail()
			}
			name := p.str()
			folded := foldASCII(name)
			if seen[folded] {
				panic(&planJSONError{reason: RefuseNotCanonical})
			}
			seen[folded] = true
			p.ws()
			if p.peek() != ':' {
				p.fail()
			}
			p.i++
			out.members = append(out.members, jsonMember{name: name, value: p.value()})
			p.ws()
			switch p.peek() {
			case ',':
				p.i++
				continue
			case '}':
				p.i++
				return out
			}
			p.fail()
		}
	case '[':
		p.i++
		p.enter()
		defer func() { p.depth-- }()
		out := jsonValue{kind: kindArray, arr: []jsonValue{}}
		p.ws()
		if p.peek() == ']' {
			p.i++
			return out
		}
		for {
			out.arr = append(out.arr, p.value())
			p.ws()
			switch p.peek() {
			case ',':
				p.i++
				continue
			case ']':
				p.i++
				return out
			}
			p.fail()
		}
	case '"':
		return jsonValue{kind: kindString, str: p.str()}
	}
	for _, w := range []struct {
		word string
		v    jsonValue
	}{{"true", jsonValue{kind: kindBool, b: true}}, {"false", jsonValue{kind: kindBool}}, {"null", jsonValue{kind: kindNull}}} {
		if strings.HasPrefix(p.text[p.i:], w.word) {
			p.i += len(w.word)
			return w.v
		}
	}
	end := min(len(p.text), p.i+400)
	m := numberRe.FindString(p.text[p.i:end])
	if m == "" {
		p.fail()
	}
	p.i += len(m)
	if !canonicalRe.MatchString(m) {
		panic(&planJSONError{reason: RefuseNotCanonical})
	}
	n, err := strconv.ParseFloat(m, 64)
	if err != nil && n == 0 { // ErrRange still returns ±Inf, which the schema's bounds refuse
		p.fail()
	}
	return jsonValue{kind: kindNumber, num: n}
}

// parsePlanJSON parses text (already valid UTF-8) strictly. The error is a *planJSONError.
func parsePlanJSON(text string) (v jsonValue, err error) {
	defer func() {
		if r := recover(); r != nil {
			e, ok := r.(*planJSONError)
			if !ok {
				panic(r)
			}
			err = e
		}
	}()
	p := &planParser{text: text}
	v = p.value()
	p.ws()
	if p.i != len(p.text) {
		p.fail()
	}
	return v, nil
}

// hasLoneSurrogate reports a decoded string holding a lone surrogate (its WTF-8 bytes): the input
// was valid UTF-8, so invalid UTF-8 here can only come from an escape.
func hasLoneSurrogate(s string) bool { return !utf8.ValidString(s) }
