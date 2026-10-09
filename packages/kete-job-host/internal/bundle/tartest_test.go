package bundle

import (
	"archive/tar"
	"io"
)

type testTar struct{ w *tar.Writer }

func newTestTar(w io.Writer) *testTar { return &testTar{w: tar.NewWriter(w)} }

func (t *testTar) add(name string, data []byte) {
	_ = t.w.WriteHeader(&tar.Header{Name: name, Mode: 0o644, Size: int64(len(data)), Typeflag: tar.TypeReg, Format: tar.FormatUSTAR})
	_, _ = t.w.Write(data)
}

func (t *testTar) close() { _ = t.w.Close() }
