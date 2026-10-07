package platform

// A copy of kete-job-host internal/contract/shape.go (a separate Go module): the Zod shape rules
// for the jobs-v1 runtime bodies. Keep the two in step.

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"reflect"
	"strings"
)

// strict marks a struct whose JSON object refuses unknown fields (Zod `strictObject`). Structs
// without it ignore unknown fields (Zod `object`: responses, which the platform may extend).
type strict interface{ strictObject() }

var strictType = reflect.TypeFor[strict]()

var rawMessageType = reflect.TypeFor[json.RawMessage]()

// decodeShape decodes one JSON value into v (a pointer to a struct) with the shape rules of the
// contract's Zod schemas, which encoding/json alone doesn't apply: a field without `omitempty` is
// required, a JSON null is accepted only for a field tagged `shape:"nullable"` (a null optional
// field is refused, not read as absent), strict objects refuse unknown fields, and nothing may
// follow the value. The value rules are the type's Validate, applied by the caller.
func decodeShape(data []byte, v any) error {
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.UseNumber()
	var raw any
	if err := dec.Decode(&raw); err != nil {
		return errors.New("not valid JSON")
	}
	if _, err := dec.Token(); !errors.Is(err, io.EOF) {
		return errors.New("trailing data after the JSON value")
	}
	t := reflect.TypeOf(v)
	if t == nil || t.Kind() != reflect.Pointer {
		return errors.New("decode: v must be a pointer")
	}
	if err := checkShape(raw, t.Elem(), ""); err != nil {
		return err
	}
	if err := json.Unmarshal(data, v); err != nil {
		return fmt.Errorf("wrong type: %v", err)
	}
	return nil
}

func checkShape(raw any, t reflect.Type, path string) error {
	for t.Kind() == reflect.Pointer {
		t = t.Elem()
	}
	if t == rawMessageType || t.Kind() == reflect.Interface {
		return nil
	}
	switch t.Kind() {
	case reflect.Struct:
		obj, ok := raw.(map[string]any)
		if !ok {
			return fmt.Errorf("%s: not an object", orRoot(path))
		}
		known := map[string]bool{}
		for i := range t.NumField() {
			f := t.Field(i)
			if !f.IsExported() {
				continue
			}
			name, opts, _ := strings.Cut(f.Tag.Get("json"), ",")
			if name == "-" {
				continue
			}
			if name == "" {
				name = f.Name
			}
			known[name] = true
			fp := join(path, name)
			val, present := obj[name]
			switch {
			case !present:
				if !strings.Contains(","+opts+",", ",omitempty,") {
					return fmt.Errorf("%s: required", fp)
				}
			case val == nil:
				if f.Tag.Get("shape") != "nullable" {
					return fmt.Errorf("%s: null", fp)
				}
			default:
				if err := checkShape(val, f.Type, fp); err != nil {
					return err
				}
			}
		}
		if t.Implements(strictType) || reflect.PointerTo(t).Implements(strictType) {
			for k := range obj {
				if !known[k] {
					return fmt.Errorf("%s: unknown field", join(path, k))
				}
			}
		}
	case reflect.Slice, reflect.Array:
		arr, ok := raw.([]any)
		if !ok {
			return fmt.Errorf("%s: not an array", orRoot(path))
		}
		for i, el := range arr {
			ep := fmt.Sprintf("%s[%d]", orRoot(path), i)
			if el == nil {
				return fmt.Errorf("%s: null", ep)
			}
			if err := checkShape(el, t.Elem(), ep); err != nil {
				return err
			}
		}
	}
	// Scalars: encoding/json refuses a value of the wrong type.
	return nil
}

func join(path, name string) string {
	if path == "" {
		return name
	}
	return path + "." + name
}

func orRoot(path string) string {
	if path == "" {
		return "value"
	}
	return path
}
