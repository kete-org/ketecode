package image

import (
	"bytes"
	"context"
	"errors"
	"io"
	"log"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"testing"

	"github.com/google/go-containerregistry/pkg/name"
	"github.com/google/go-containerregistry/pkg/registry"
	v1 "github.com/google/go-containerregistry/pkg/v1"
	"github.com/google/go-containerregistry/pkg/v1/empty"
	"github.com/google/go-containerregistry/pkg/v1/mutate"
	"github.com/google/go-containerregistry/pkg/v1/random"
	"github.com/google/go-containerregistry/pkg/v1/remote"
	"github.com/google/go-containerregistry/pkg/v1/static"
	"github.com/google/go-containerregistry/pkg/v1/types"
)

// The signed digest and signer of testdata/sigstore (see its README).
const (
	mcpDigest = "sha256:7aaeeec9ae4fe9a736d100c1ff0798f3c219b5009e05f5d3945fcacb13cc196b"
	mcpSAN    = `^https://github\.com/github/github-mcp-server/\.github/workflows/docker-publish\.yml@refs/tags/v[0-9.]+$`
)

var mcpIdentity = Identity{
	SANRegex:         mcpSAN,
	Issuer:           "https://token.actions.githubusercontent.com",
	SourceRepository: "https://github.com/github/github-mcp-server",
}

func testBundle(t *testing.T) []byte {
	t.Helper()
	b, err := os.ReadFile("../../testdata/sigstore/github-mcp-server-v1.14.0.bundle.json")
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func trusted() TrustedMaterialSource {
	return StaticTrustedRoot("../../testdata/sigstore/trusted_root.json")
}

func TestVerifyBundle(t *testing.T) {
	tm, err := trusted()(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	raw := testBundle(t)
	good, _ := v1.NewHash(mcpDigest)
	other, _ := v1.NewHash("sha256:" + strings.Repeat("ab", 32))

	if err := (Sigstore{Identity: mcpIdentity}).VerifyBundle(tm, raw, good); err != nil {
		t.Fatalf("the real bundle must verify for its signer: %v", err)
	}
	cases := map[string]struct {
		id  Identity
		h   v1.Hash
		raw []byte
	}{
		"kete release identity": {ReleaseIdentity, good, raw},
		"wrong issuer":          {Identity{SANRegex: mcpSAN, Issuer: "https://accounts.google.com", SourceRepository: mcpIdentity.SourceRepository}, good, raw},
		"wrong repository":      {Identity{SANRegex: mcpSAN, Issuer: mcpIdentity.Issuer, SourceRepository: "https://github.com/kete-org/ketecode"}, good, raw},
		"wrong digest":          {mcpIdentity, other, raw},
		"tampered signature":    {mcpIdentity, good, tamper(t, raw)},
		"not json":              {mcpIdentity, good, []byte("{")},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			err := (Sigstore{Identity: c.id}).VerifyBundle(tm, c.raw, c.h)
			if err == nil || !errors.Is(err, ErrSignature) {
				t.Fatalf("want ErrSignature, got %v", err)
			}
		})
	}
}

// tamper flips one character of the DSSE signature.
func tamper(t *testing.T, raw []byte) []byte {
	t.Helper()
	i := bytes.Index(raw, []byte(`"sig":"`))
	if i < 0 {
		i = bytes.Index(raw, []byte(`"sig": "`))
	}
	if i < 0 {
		t.Fatal("no sig in bundle")
	}
	out := append([]byte(nil), raw...)
	j := i + 12
	if out[j] == 'A' {
		out[j] = 'B'
	} else {
		out[j] = 'A'
	}
	return out
}

// TestVerifyFromRegistry stores the bundle the way cosign v3 does on a registry without the
// referrers API (GHCR): an index at the tag sha256-<hex> listing a bundle manifest whose subject
// is the signed digest, and checks Verify finds and verifies it.
func TestVerifyFromRegistry(t *testing.T) {
	srv := httptest.NewServer(registry.New(registry.Logger(log.New(io.Discard, "", 0))))
	defer srv.Close()
	u, _ := url.Parse(srv.URL)
	repo := u.Host + "/github/github-mcp-server"
	h, _ := v1.NewHash(mcpDigest)

	// The signed digest itself needn't exist for verification; the referrer's subject names it.
	bundleLayer := static.NewLayer(testBundle(t), types.MediaType(BundleArtifactType))
	img, err := mutate.Append(empty.Image, mutate.Addendum{Layer: bundleLayer})
	if err != nil {
		t.Fatal(err)
	}
	img = mutate.MediaType(img, types.OCIManifestSchema1)
	img = mutate.ConfigMediaType(img, types.MediaType("application/vnd.oci.empty.v1+json"))
	img = mutate.Subject(img, v1.Descriptor{MediaType: types.OCIImageIndex, Size: 1609, Digest: h}).(v1.Image)
	ref, err := name.ParseReference(repo+":sha256-"+h.Hex, name.Insecure)
	if err != nil {
		t.Fatal(err)
	}
	d, _ := img.Digest()
	if err := remote.Write(ref.Context().Digest(d.String()), img); err != nil {
		t.Fatal(err)
	}

	sz, _ := img.Size()
	idx := mutate.AppendManifests(mutate.IndexMediaType(empty.Index, types.OCIImageIndex), mutate.IndexAddendum{
		Add: img, Descriptor: v1.Descriptor{MediaType: types.OCIManifestSchema1, Size: sz, Digest: d, ArtifactType: BundleArtifactType},
	})
	if err := remote.WriteIndex(ref, idx); err != nil {
		t.Fatal(err)
	}

	s := Sigstore{Identity: mcpIdentity, Trusted: trusted(), Name: []name.Option{name.Insecure}}
	if err := s.Verify(context.Background(), repo+"@"+mcpDigest); err != nil {
		t.Fatalf("verify: %v", err)
	}
	s.Identity = ReleaseIdentity
	if err := s.Verify(context.Background(), repo+"@"+mcpDigest); !errors.Is(err, ErrSignature) {
		t.Fatalf("kete identity: want ErrSignature, got %v", err)
	}
	// Another digest has no referrers: no signature.
	unsigned, _ := random.Image(64, 1)
	ud, _ := unsigned.Digest()
	s.Identity = mcpIdentity
	if err := s.Verify(context.Background(), repo+"@"+ud.String()); !errors.Is(err, ErrSignature) {
		t.Fatalf("unsigned: want ErrSignature, got %v", err)
	}
	// An unreachable registry is unavailable, not a bad signature.
	srv.Close()
	if err := s.Verify(context.Background(), repo+"@"+mcpDigest); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("unreachable: want ErrUnavailable, got %v", err)
	}
}
