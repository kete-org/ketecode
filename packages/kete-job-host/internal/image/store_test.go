package image

import (
	"archive/tar"
	"bytes"
	"context"
	"errors"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/google/go-containerregistry/pkg/name"
	"github.com/google/go-containerregistry/pkg/registry"
	v1 "github.com/google/go-containerregistry/pkg/v1"
	"github.com/google/go-containerregistry/pkg/v1/empty"
	"github.com/google/go-containerregistry/pkg/v1/mutate"
	"github.com/google/go-containerregistry/pkg/v1/remote"
	"github.com/google/go-containerregistry/pkg/v1/tarball"
	"github.com/google/go-containerregistry/pkg/v1/types"
)

type entry struct {
	name, body, link string
	typ              byte
	mode             int64
	uid              int
}

func layerOf(t *testing.T, es ...entry) v1.Layer {
	t.Helper()
	var buf bytes.Buffer
	tw := tar.NewWriter(&buf)
	for _, e := range es {
		h := &tar.Header{Name: e.name, Typeflag: e.typ, Mode: e.mode, Uid: e.uid, Gid: e.uid, Linkname: e.link}
		if h.Mode == 0 {
			h.Mode = 0o644
			if e.typ == tar.TypeDir {
				h.Mode = 0o755
			}
		}
		if e.typ == tar.TypeReg {
			h.Size = int64(len(e.body))
		}
		if err := tw.WriteHeader(h); err != nil {
			t.Fatal(err)
		}
		if e.typ == tar.TypeReg {
			if _, err := tw.Write([]byte(e.body)); err != nil {
				t.Fatal(err)
			}
		}
	}
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	b := buf.Bytes()
	l, err := tarball.LayerFromOpener(func() (io.ReadCloser, error) { return io.NopCloser(bytes.NewReader(b)), nil })
	if err != nil {
		t.Fatal(err)
	}
	return l
}

func reg(name string, body string) entry { return entry{name: name, body: body, typ: tar.TypeReg} }
func dir(name string) entry              { return entry{name: name, typ: tar.TypeDir} }

func pushImage(t *testing.T, host string, layers ...v1.Layer) (string, v1.Image) {
	t.Helper()
	img, err := mutate.AppendLayers(empty.Image, layers...)
	if err != nil {
		t.Fatal(err)
	}
	cf, _ := img.ConfigFile()
	cf.OS, cf.Architecture = "linux", "amd64"
	img, err = mutate.ConfigFile(img, cf)
	if err != nil {
		t.Fatal(err)
	}
	img = mutate.MediaType(img, types.OCIManifestSchema1)
	idx := mutate.AppendManifests(empty.Index, mutate.IndexAddendum{Add: img, Descriptor: v1.Descriptor{Platform: &v1.Platform{OS: "linux", Architecture: "amd64"}}})
	ref, _ := name.ParseReference(host+"/kete-org/kete-job:test", name.Insecure)
	if err := remote.WriteIndex(ref, idx); err != nil {
		t.Fatal(err)
	}
	d, _ := idx.Digest()
	return host + "/kete-org/kete-job@" + d.String(), img
}

func testStore(t *testing.T) *Store {
	if _, err := exec.LookPath("mkfs.ext4"); err != nil {
		t.Skip("mkfs.ext4 not installed")
	}
	if os.Geteuid() != 0 {
		t.Skip("unpacking with ownership needs root (CI runs the tests with sudo)")
	}
	return &Store{Dir: t.TempDir(), Arch: "amd64", Name: []name.Option{name.Insecure}}
}

// debugfs lists or reads paths in an ext4 image without mounting it.
func debugfs(t *testing.T, img, cmd string) string {
	t.Helper()
	out, err := exec.Command("debugfs", "-R", cmd, img).CombinedOutput()
	if err != nil {
		t.Fatalf("debugfs %s: %v: %s", cmd, err, out)
	}
	return string(out)
}

func TestRootfsConversion(t *testing.T) {
	s := testStore(t)
	srv := httptest.NewServer(registry.New(registry.Logger(log.New(io.Discard, "", 0))))
	defer srv.Close()
	u, _ := url.Parse(srv.URL)

	base := layerOf(t,
		dir("etc"), reg("etc/keep", "keep"), reg("etc/gone", "gone"),
		entry{name: "home", typ: tar.TypeDir, mode: 0o755}, entry{name: "home/job", typ: tar.TypeDir, mode: 0o750, uid: 1001},
		dir("opq"), reg("opq/old", "old"), dir("deep"), dir("deep/sub"), reg("deep/sub/lower", "lower"),
		dir("usr"), dir("usr/bin"), entry{name: "usr/bin/tool", body: "#!/bin/sh\n", typ: tar.TypeReg, mode: 0o755, uid: 1000},
		entry{name: "usr/bin/alias", typ: tar.TypeSymlink, link: "tool"},
		entry{name: "usr/bin/hard", typ: tar.TypeLink, link: "usr/bin/tool"},
		entry{name: "dev/null", typ: tar.TypeChar},
	)
	top := layerOf(t,
		reg("etc/.wh.gone", ""),
		dir("opq"), reg("opq/.wh..wh..opq", ""), reg("opq/new", "new"),
		// A file under a parent this layer creates implicitly survives the layer's own opaque marker.
		reg("deep/sub/file", "kept"), reg("deep/.wh..wh..opq", ""),
		reg("etc/added", "added"),
	)
	ref, _ := pushImage(t, u.Host, base, top)
	path, err := s.Rootfs(context.Background(), ref)
	if err != nil {
		t.Fatal(err)
	}
	fi, err := os.Stat(path)
	if err != nil || fi.Mode().Perm() != 0o444 {
		t.Fatalf("rootfs %v %v", fi, err)
	}
	if !strings.Contains(debugfs(t, path, "stats"), "Filesystem volume name:   kete-root") {
		t.Fatal("label")
	}
	etc := debugfs(t, path, "ls -p /etc")
	for _, want := range []string{"/keep/", "/added/"} {
		if !strings.Contains(etc, want) {
			t.Errorf("/etc lacks %s: %s", want, etc)
		}
	}
	if strings.Contains(etc, "/gone/") || strings.Contains(etc, ".wh.") {
		t.Errorf("whiteout not applied: %s", etc)
	}
	opq := debugfs(t, path, "ls -p /opq")
	if strings.Contains(opq, "/old/") || !strings.Contains(opq, "/new/") {
		t.Errorf("opaque dir not applied: %s", opq)
	}
	tool := debugfs(t, path, "stat /usr/bin/tool")
	if !strings.Contains(tool, "Links: 2") || !strings.Contains(tool, "User:  1000") || !strings.Contains(tool, "Mode:  0755") {
		t.Errorf("tool: %s", tool)
	}
	if home := debugfs(t, path, "stat /home/job"); !strings.Contains(home, "User:  1001") || !strings.Contains(home, "Mode:  0750") {
		t.Errorf("directory owner/mode not carried: %s", home)
	}
	if sub := debugfs(t, path, "ls -p /deep/sub"); !strings.Contains(sub, "/file/") || strings.Contains(sub, "/lower/") {
		t.Errorf("opaque marker: want this layer's deep/sub/file and none of the lower layer's files: %s", sub)
	}
	if !strings.Contains(debugfs(t, path, "stat /usr/bin/alias"), "Fast link dest: \"tool\"") {
		t.Error("symlink")
	}
	if strings.Contains(debugfs(t, path, "ls -p /dev"), "/null/") {
		t.Error("device node unpacked")
	}
	// Cached: a second call returns the same file without fetching.
	again, err := s.Rootfs(context.Background(), ref)
	if err != nil || again != path {
		t.Fatalf("cache: %s %v", again, err)
	}
	// Prune keeps allowlisted images and drops the rest.
	allow, _ := NewAllowlist([]string{ref})
	if err := s.Prune(allow); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatal("pruned an allowlisted image")
	}
	if err := s.Prune(Allowlist{}); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(path); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("kept an image no longer allowlisted")
	}
	left, _ := os.ReadDir(s.Dir)
	for _, e := range left {
		if strings.HasPrefix(e.Name(), "build-") {
			t.Fatalf("build dir left behind: %s", e.Name())
		}
	}
}

func TestRootfsRefusals(t *testing.T) {
	s := testStore(t)
	srv := httptest.NewServer(registry.New(registry.Logger(log.New(io.Discard, "", 0))))
	defer srv.Close()
	u, _ := url.Parse(srv.URL)
	for name, l := range map[string]v1.Layer{
		"dotdot":           layerOf(t, reg("../escape", "x")),
		"whiteout of dot":  layerOf(t, dir("etc"), reg("etc/.wh..", "")),
		"whiteout of wh":   layerOf(t, dir("etc"), reg("etc/.wh..wh..x", "")),
		"hard link escape": layerOf(t, reg("a", "x"), entry{name: "b", typ: tar.TypeLink, link: "../../etc/passwd"}),
		"symlink parent escape": layerOf(t,
			entry{name: "evil", typ: tar.TypeSymlink, link: "/"}, reg("evil/etc/escaped", "x")),
	} {
		t.Run(name, func(t *testing.T) {
			ref, _ := pushImage(t, u.Host, l)
			if _, err := s.Rootfs(context.Background(), ref); err == nil {
				t.Fatal("accepted")
			}
			if _, err := os.Stat("/etc/escaped"); err == nil {
				t.Fatal("wrote outside the root")
			}
		})
	}
}

// tamperRegistry serves one blob with a byte flipped.
type tamperRegistry struct {
	h      http.Handler
	digest string
}

func (tr tamperRegistry) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if !strings.HasSuffix(r.URL.Path, "/blobs/"+tr.digest) || r.Method != http.MethodGet {
		tr.h.ServeHTTP(w, r)
		return
	}
	rec := httptest.NewRecorder()
	tr.h.ServeHTTP(rec, r)
	b := rec.Body.Bytes()
	if len(b) > 0 {
		b[len(b)-1] ^= 0xff
	}
	for k, v := range rec.Header() {
		w.Header()[k] = v
	}
	w.WriteHeader(rec.Code)
	_, _ = w.Write(b)
}

func TestRootfsTamperedBlob(t *testing.T) {
	s := testStore(t)
	inner := registry.New(registry.Logger(log.New(io.Discard, "", 0)))
	tr := &tamperRegistry{h: inner}
	srv := httptest.NewServer(tr)
	defer srv.Close()
	u, _ := url.Parse(srv.URL)
	l := layerOf(t, reg("file", strings.Repeat("payload", 100)))
	ref, _ := pushImage(t, u.Host, l)
	d, _ := l.Digest()
	tr.digest = d.String()
	_, err := s.Rootfs(context.Background(), ref)
	if err == nil || (!errors.Is(err, ErrSignature) && !errors.Is(err, ErrUnavailable)) {
		t.Fatalf("tampered blob: %v", err)
	}
	if entries, _ := os.ReadDir(filepath.Join(s.Dir, "rootfs")); len(entries) != 0 {
		t.Fatal("cached a tampered image")
	}
}
