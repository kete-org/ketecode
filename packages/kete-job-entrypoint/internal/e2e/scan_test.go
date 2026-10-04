//go:build e2e

package e2e

import (
	"archive/tar"
	"bytes"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/kete-org/ketecode/packages/kete-job-entrypoint/internal/fakeplatform"
)

// TestExportScan (AC4): the claim, callback and clone tokens and the gateway key are nowhere in the
// stopped job container's filesystem. The `docker export` tar streams in (-export -) and each file
// is searched in chunks with an overlap, so nothing is ever written to disk.
//
// Piece A3: kete's audit log never lands in kete's data dir; the entrypoint's root-owned copy of the
// audit pipe is 0600 and byte-equal to the uploaded audit (empty when nothing was uploaded); and the
// lifecycle's refused symlink write left no file in kete's home.
func TestExportScan(t *testing.T) {
	if *export == "" {
		t.Skip("no -export")
	}
	var tokens fakeplatform.StateTokens
	readJSON(t, filepath.Join(*stateDir, "tokens.json"), &tokens)
	needles := map[string][]byte{
		"claim token": []byte(tokens.Claim), "callback token": []byte(tokens.Callback),
		"clone token": []byte(tokens.Clone), "gateway key": []byte(tokens.GatewayKey),
	}
	overlap := 0
	for name, n := range needles {
		if len(n) < 16 {
			t.Fatalf("the %s is too short to scan for (%d bytes)", name, len(n))
		}
		overlap = max(overlap, len(n)-1)
	}
	var in io.Reader = os.Stdin
	if *export != "-" {
		f, err := os.Open(*export)
		if err != nil {
			t.Fatal(err)
		}
		defer f.Close()
		in = f
	}
	const (
		auditCopy   = "var/log/kete-job/kete.audit.jsonl"
		keteAudit   = "var/lib/kete-job/kete/.local/share/kete/audit"
		planted     = "var/lib/kete-job/kete/e2e-written"
		maxAuditLen = 20_000_000
	)
	var copied bytes.Buffer
	sawCopy := false
	tr := tar.NewReader(in)
	buf := make([]byte, 1<<20+overlap)
	files, total := 0, int64(0)
	for {
		h, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatalf("export: %v", err)
		}
		name := strings.TrimPrefix(h.Name, "./")
		if name == keteAudit || strings.HasPrefix(name, keteAudit+"/") {
			t.Errorf("kete's data dir has an audit entry: /%s", name)
		}
		if name == planted {
			t.Errorf("the refused symlink write created /%s", name)
		}
		if name == auditCopy {
			sawCopy = true
			if h.Typeflag != tar.TypeReg || h.Uid != 0 || h.Mode&0o777 != 0o600 {
				t.Errorf("/%s: type %c uid %d mode %o, want a root 0600 regular file", name, h.Typeflag, h.Uid, h.Mode&0o777)
			}
		}
		if h.Typeflag != tar.TypeReg {
			for name, n := range needles {
				if bytes.Contains([]byte(h.Linkname), n) || bytes.Contains([]byte(h.Name), n) {
					t.Errorf("the %s is in the name of %s", name, h.Name)
				}
			}
			continue
		}
		files++
		kept := 0
		for {
			n, err := io.ReadFull(tr, buf[kept:])
			window := buf[:kept+n]
			if name == auditCopy && copied.Len() < maxAuditLen+1 {
				copied.Write(buf[kept : kept+n])
			}
			for name, needle := range needles {
				if bytes.Contains(window, needle) {
					t.Errorf("the %s is in /%s", name, h.Name)
					delete(needles, name) // report each once; keep scanning for the others
				}
			}
			total += int64(n)
			if err == io.EOF || err == io.ErrUnexpectedEOF {
				break
			}
			if err != nil {
				t.Fatalf("export: %s: %v", h.Name, err)
			}
			kept = min(overlap, len(window))
			copy(buf, window[len(window)-kept:])
		}
	}
	if !sawCopy {
		t.Errorf("no /%s in the export", auditCopy)
	} else {
		uploaded, err := os.ReadFile(filepath.Join(*stateDir, "uploads", "audit"))
		if errors.Is(err, os.ErrNotExist) {
			uploaded = nil
		} else if err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(copied.Bytes(), uploaded) {
			t.Errorf("/%s (%d bytes) differs from the uploaded audit (%d bytes)", auditCopy, copied.Len(), len(uploaded))
		}
	}
	if files < 100 {
		t.Fatalf("only %d files in the export: not the job container's filesystem?", files)
	}
	t.Logf("scanned %d files, %d bytes", files, total)
}
