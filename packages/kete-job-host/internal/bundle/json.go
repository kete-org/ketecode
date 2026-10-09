package bundle

import (
	"errors"
	"unicode/utf16"
	"unicode/utf8"
)

// A strict JSON reader for manifest.json with JavaScript's JSON.parse semantics where they decide
// the outcome (encoding/json differs: it matches field names case-insensitively and replaces lone
// UTF-16 surrogates with U+FFFD):
//   - object keys are exact, and a repeated key's last value wins;
//   - strings are UTF-16 as in JavaScript: an escaped surrogate pair is one character, and a lone
//     surrogate is kept, encoded as WTF-8 (invalid UTF-8, so the path rules refuse it as the
//     platform's isWellFormed check does);
//   - whitespace is space, tab, LF and CR only.
//
// Only the top-level array, its elements and their members' scalar values are materialised;
// anything nested deeper is checked for syntax iteratively and kept as an opaque value (V8's
// JSON.parse has no depth limit either).

type jsonKind int

const (
	jsonOther jsonKind = iota // a number, null, or a container below the materialised depth
	jsonString
	jsonBool
	jsonArray
	jsonObject
)

type jsonValue struct {
	kind  jsonKind
	str   string
	bool  bool
	array []jsonValue
	obj   map[string]jsonValue
}

var errJSON = errors.New("bundle: invalid JSON")

type jsonParser struct {
	s []byte
	i int
}

// parseJSON parses a whole JSON text (valid UTF-8, no BOM: the caller decoded it).
func parseJSON(text []byte) (jsonValue, error) {
	p := &jsonParser{s: text}
	p.ws()
	v, err := p.value(0)
	if err != nil {
		return jsonValue{}, err
	}
	p.ws()
	if p.i != len(p.s) {
		return jsonValue{}, errJSON
	}
	return v, nil
}

func (p *jsonParser) ws() {
	for p.i < len(p.s) {
		switch p.s[p.i] {
		case ' ', '\t', '\n', '\r':
			p.i++
		default:
			return
		}
	}
}

// value parses one value; containers deeper than depth 2 are skipped.
func (p *jsonParser) value(depth int) (jsonValue, error) {
	if p.i >= len(p.s) {
		return jsonValue{}, errJSON
	}
	switch c := p.s[p.i]; {
	case c == '"':
		s, err := p.str()
		return jsonValue{kind: jsonString, str: s}, err
	case c == '[' || c == '{':
		if depth >= 2 {
			return jsonValue{}, p.skipContainer()
		}
		if c == '[' {
			return p.arrayAt(depth)
		}
		return p.objectAt(depth)
	case c == 't':
		return jsonValue{kind: jsonBool, bool: true}, p.lit("true")
	case c == 'f':
		return jsonValue{kind: jsonBool}, p.lit("false")
	case c == 'n':
		return jsonValue{}, p.lit("null")
	default:
		return jsonValue{}, p.number()
	}
}

func (p *jsonParser) lit(word string) error {
	if len(p.s)-p.i < len(word) || string(p.s[p.i:p.i+len(word)]) != word {
		return errJSON
	}
	p.i += len(word)
	return nil
}

// number: -?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?
func (p *jsonParser) number() error {
	digits := func() int {
		n := 0
		for p.i < len(p.s) && p.s[p.i] >= '0' && p.s[p.i] <= '9' {
			p.i++
			n++
		}
		return n
	}
	if p.i < len(p.s) && p.s[p.i] == '-' {
		p.i++
	}
	if p.i >= len(p.s) {
		return errJSON
	}
	if p.s[p.i] == '0' {
		p.i++
	} else if digits() == 0 {
		return errJSON
	}
	if p.i < len(p.s) && p.s[p.i] == '.' {
		p.i++
		if digits() == 0 {
			return errJSON
		}
	}
	if p.i < len(p.s) && (p.s[p.i] == 'e' || p.s[p.i] == 'E') {
		p.i++
		if p.i < len(p.s) && (p.s[p.i] == '+' || p.s[p.i] == '-') {
			p.i++
		}
		if digits() == 0 {
			return errJSON
		}
	}
	return nil
}

func hexVal(c byte) (uint16, bool) {
	switch {
	case c >= '0' && c <= '9':
		return uint16(c - '0'), true
	case c >= 'a' && c <= 'f':
		return uint16(c-'a') + 10, true
	case c >= 'A' && c <= 'F':
		return uint16(c-'A') + 10, true
	}
	return 0, false
}

// str parses a string into UTF-16 units, then WTF-8.
func (p *jsonParser) str() (string, error) {
	p.i++ // the opening quote
	var units []uint16
	for {
		if p.i >= len(p.s) {
			return "", errJSON
		}
		c := p.s[p.i]
		switch {
		case c == '"':
			p.i++
			return wtf8(units), nil
		case c < 0x20:
			return "", errJSON
		case c == '\\':
			if p.i+1 >= len(p.s) {
				return "", errJSON
			}
			e := p.s[p.i+1]
			p.i += 2
			switch e {
			case '"', '\\', '/':
				units = append(units, uint16(e))
			case 'b':
				units = append(units, '\b')
			case 'f':
				units = append(units, '\f')
			case 'n':
				units = append(units, '\n')
			case 'r':
				units = append(units, '\r')
			case 't':
				units = append(units, '\t')
			case 'u':
				if len(p.s)-p.i < 4 {
					return "", errJSON
				}
				var u uint16
				for k := range 4 {
					h, ok := hexVal(p.s[p.i+k])
					if !ok {
						return "", errJSON
					}
					u = u<<4 | h
				}
				p.i += 4
				units = append(units, u)
			default:
				return "", errJSON
			}
		case c < 0x80:
			units = append(units, uint16(c))
			p.i++
		default:
			r, size := utf8.DecodeRune(p.s[p.i:])
			if r == utf8.RuneError && size <= 1 {
				return "", errJSON
			}
			units = utf16.AppendRune(units, r)
			p.i += size
		}
	}
}

// wtf8 encodes UTF-16 units: pairs as their character, lone surrogates as WTF-8 (three bytes,
// never valid UTF-8).
func wtf8(units []uint16) string {
	out := make([]byte, 0, len(units))
	for i := 0; i < len(units); i++ {
		u := units[i]
		if utf16.IsSurrogate(rune(u)) {
			if u < 0xdc00 && i+1 < len(units) && units[i+1] >= 0xdc00 && units[i+1] <= 0xdfff {
				out = utf8.AppendRune(out, utf16.DecodeRune(rune(u), rune(units[i+1])))
				i++
				continue
			}
			out = append(out, 0xe0|byte(u>>12), 0x80|byte(u>>6)&0x3f, 0x80|byte(u)&0x3f)
			continue
		}
		out = utf8.AppendRune(out, rune(u))
	}
	return string(out)
}

func (p *jsonParser) arrayAt(depth int) (jsonValue, error) {
	p.i++
	v := jsonValue{kind: jsonArray, array: []jsonValue{}}
	p.ws()
	if p.i < len(p.s) && p.s[p.i] == ']' {
		p.i++
		return v, nil
	}
	for {
		p.ws()
		e, err := p.value(depth + 1)
		if err != nil {
			return v, err
		}
		v.array = append(v.array, e)
		p.ws()
		if p.i >= len(p.s) {
			return v, errJSON
		}
		switch p.s[p.i] {
		case ',':
			p.i++
		case ']':
			p.i++
			return v, nil
		default:
			return v, errJSON
		}
	}
}

func (p *jsonParser) objectAt(depth int) (jsonValue, error) {
	p.i++
	v := jsonValue{kind: jsonObject, obj: map[string]jsonValue{}}
	p.ws()
	if p.i < len(p.s) && p.s[p.i] == '}' {
		p.i++
		return v, nil
	}
	for {
		p.ws()
		if p.i >= len(p.s) || p.s[p.i] != '"' {
			return v, errJSON
		}
		k, err := p.str()
		if err != nil {
			return v, err
		}
		p.ws()
		if p.i >= len(p.s) || p.s[p.i] != ':' {
			return v, errJSON
		}
		p.i++
		p.ws()
		e, err := p.value(depth + 1)
		if err != nil {
			return v, err
		}
		v.obj[k] = e // the last of repeated keys wins, as in JSON.parse
		p.ws()
		if p.i >= len(p.s) {
			return v, errJSON
		}
		switch p.s[p.i] {
		case ',':
			p.i++
		case '}':
			p.i++
			return v, nil
		default:
			return v, errJSON
		}
	}
}

// skipContainer checks a container's syntax without recursion (scalars through value at a depth
// that never materialises containers).
func (p *jsonParser) skipContainer() error {
	// stack holds ']' or '}'; afterValue says a value just ended in the innermost container.
	var stack []byte
	open := func() {
		if p.s[p.i] == '[' {
			stack = append(stack, ']')
		} else {
			stack = append(stack, '}')
		}
		p.i++
	}
	open()
	expectValue := true // at the start of a container: a value (or key) or the close
	first := true
	for len(stack) > 0 {
		p.ws()
		if p.i >= len(p.s) {
			return errJSON
		}
		top := stack[len(stack)-1]
		c := p.s[p.i]
		if expectValue {
			if first && c == top {
				p.i++
				stack = stack[:len(stack)-1]
				expectValue, first = false, false
				continue
			}
			if top == '}' {
				if c != '"' {
					return errJSON
				}
				if _, err := p.str(); err != nil {
					return err
				}
				p.ws()
				if p.i >= len(p.s) || p.s[p.i] != ':' {
					return errJSON
				}
				p.i++
				p.ws()
				if p.i >= len(p.s) {
					return errJSON
				}
				c = p.s[p.i]
			}
			if c == '[' || c == '{' {
				open()
				expectValue, first = true, true
				continue
			}
			if c == '"' {
				if _, err := p.str(); err != nil {
					return err
				}
			} else if _, err := p.value(2); err != nil {
				return err
			}
			expectValue, first = false, false
			continue
		}
		switch c {
		case ',':
			p.i++
			expectValue, first = true, false
		case top:
			p.i++
			stack = stack[:len(stack)-1]
		default:
			return errJSON
		}
	}
	return nil
}
