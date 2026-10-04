package image

import (
	"bytes"
	"context"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/google/go-containerregistry/pkg/name"
	v1 "github.com/google/go-containerregistry/pkg/v1"
	"github.com/google/go-containerregistry/pkg/v1/remote"
	"github.com/sigstore/sigstore-go/pkg/bundle"
	"github.com/sigstore/sigstore-go/pkg/fulcio/certificate"
	"github.com/sigstore/sigstore-go/pkg/root"
	"github.com/sigstore/sigstore-go/pkg/tuf"
	"github.com/sigstore/sigstore-go/pkg/verify"
)

// Identity is the cosign keyless signer an image signature must name (ADR 0023 rule 17).
type Identity struct {
	// SANRegex matches the Fulcio certificate's subject alternative name (the workflow URI).
	SANRegex string
	// Issuer is the exact OIDC issuer.
	Issuer string
	// SourceRepository is the exact source repository URI extension.
	SourceRepository string
}

// ReleaseIdentity is Kete's: kete-release.yml on a kete-v<semver> tag of kete-org/ketecode,
// GitHub Actions' issuer (kete-release.yml "Push, index, sign and verify").
var ReleaseIdentity = Identity{
	SANRegex:         `^https://github\.com/kete-org/ketecode/\.github/workflows/kete-release\.yml@refs/tags/kete-v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$`,
	Issuer:           "https://token.actions.githubusercontent.com",
	SourceRepository: "https://github.com/kete-org/ketecode",
}

// Signature media types (cosign v3's Sigstore bundle referrer).
const (
	BundleArtifactType = "application/vnd.dev.sigstore.bundle.v0.3+json"
	cosignPredicate    = "https://sigstore.dev/cosign/sign/v1"
	maxBundle          = 1 << 20
	maxReferrers       = 16
)

// Errors a caller tells apart: an unreachable registry or signature store is image_unavailable;
// everything else image_signature_invalid.
var (
	ErrUnavailable = errors.New("image: registry unavailable")
	ErrSignature   = errors.New("image: signature does not verify")
)

// TrustedMaterialSource yields the Sigstore trusted root (Fulcio, Rekor, CT logs, TSAs).
type TrustedMaterialSource func(ctx context.Context) (root.TrustedMaterial, error)

// TUFTrustedRoot returns the public-good Sigstore trusted root through TUF, with the TUF metadata
// cached under dir (root-only, below the state directory). The parsed root is kept in memory for
// an hour; the TUF client then reuses its on-disk metadata without network for up to a day
// (CacheValidity) and refreshes it after that or once it expires (expired metadata is never
// trusted). A Sigstore key rotation therefore reaches the agent within about a day.
func TUFTrustedRoot(dir string) TrustedMaterialSource {
	var mu sync.Mutex
	var cached root.TrustedMaterial
	var at time.Time
	return func(ctx context.Context) (root.TrustedMaterial, error) {
		mu.Lock()
		defer mu.Unlock()
		if cached != nil && time.Since(at) < time.Hour {
			return cached, nil
		}
		if err := os.MkdirAll(dir, 0o700); err != nil {
			return nil, err
		}
		opts := tuf.DefaultOptions()
		opts.CachePath = dir
		opts.CacheValidity = 1
		opts.Context = ctx
		type result struct {
			tm  *root.TrustedRoot
			err error
		}
		ch := make(chan result, 1)
		go func() {
			c, err := tuf.New(opts)
			if err != nil {
				ch <- result{err: err}
				return
			}
			tm, err := root.GetTrustedRoot(c)
			ch <- result{tm, err}
		}()
		select {
		case <-ctx.Done():
			return nil, fmt.Errorf("%w: sigstore trusted root: %v", ErrUnavailable, ctx.Err())
		case r := <-ch:
			if r.err != nil {
				return nil, fmt.Errorf("%w: sigstore trusted root: %v", ErrUnavailable, r.err)
			}
			cached, at = r.tm, time.Now()
			return cached, nil
		}
	}
}

// StaticTrustedRoot reads a trusted_root.json (tests; air-gapped operators can't use it: the
// production agent always uses TUF).
func StaticTrustedRoot(path string) TrustedMaterialSource {
	return func(context.Context) (root.TrustedMaterial, error) {
		tr, err := root.NewTrustedRootFromPath(path)
		if err != nil {
			return nil, err
		}
		return tr, nil
	}
}

// Sigstore verifies cosign keyless signatures on an image index digest.
type Sigstore struct {
	Identity Identity
	Trusted  TrustedMaterialSource
	// Remote are extra go-containerregistry options (tests: a plain-HTTP registry transport).
	Remote []remote.Option
	// Name are name parsing options (tests: name.Insecure for a local registry).
	Name []name.Option
}

// Verify implements Verifier: it fetches the Sigstore bundle referrers of ref's digest and accepts
// the image only if one verifies (certificate chain to Fulcio, SCT, transparency log, a timestamp,
// the identity, and a DSSE in-toto statement whose subject is exactly the digest).
func (s Sigstore) Verify(ctx context.Context, ref string) error {
	d, err := name.NewDigest(ref, s.Name...)
	if err != nil {
		return fmt.Errorf("%w: %v", ErrSignature, err)
	}
	h, err := v1.NewHash(d.DigestStr())
	if err != nil || h.Algorithm != "sha256" {
		return fmt.Errorf("%w: digest", ErrSignature)
	}
	bundles, err := s.fetchBundles(ctx, d)
	if err != nil {
		return err
	}
	if len(bundles) == 0 {
		return fmt.Errorf("%w: no signature found", ErrSignature)
	}
	tm, err := s.Trusted(ctx)
	if err != nil {
		return err
	}
	var last error
	for _, raw := range bundles {
		if err := s.VerifyBundle(tm, raw, h); err != nil {
			last = err
			continue
		}
		return nil
	}
	return last
}

// VerifyBundle checks one bundle against trusted material for digest h.
func (s Sigstore) VerifyBundle(tm root.TrustedMaterial, raw []byte, h v1.Hash) error {
	var b bundle.Bundle
	if err := b.UnmarshalJSON(raw); err != nil {
		return fmt.Errorf("%w: bundle: %v", ErrSignature, err)
	}
	sc, err := b.SignatureContent()
	if err != nil {
		return fmt.Errorf("%w: bundle: %v", ErrSignature, err)
	}
	env, ok := sc.(*bundle.Envelope)
	if !ok {
		return fmt.Errorf("%w: not a DSSE bundle", ErrSignature)
	}
	stmt, err := env.Statement()
	if err != nil || stmt.GetPredicateType() != cosignPredicate || len(stmt.GetSubject()) != 1 {
		return fmt.Errorf("%w: not a cosign signature statement", ErrSignature)
	}
	if stmt.GetSubject()[0].GetDigest()["sha256"] != h.Hex {
		return fmt.Errorf("%w: statement subject is another digest", ErrSignature)
	}
	v, err := verify.NewVerifier(tm, verify.WithSignedCertificateTimestamps(1), verify.WithTransparencyLog(1), verify.WithObserverTimestamps(1))
	if err != nil {
		return fmt.Errorf("%w: verifier: %v", ErrSignature, err)
	}
	san, err := verify.NewSANMatcher("", s.Identity.SANRegex)
	if err != nil {
		return err
	}
	iss, err := verify.NewIssuerMatcher(s.Identity.Issuer, "")
	if err != nil {
		return err
	}
	id, err := verify.NewCertificateIdentity(san, iss, certificate.Extensions{SourceRepositoryURI: s.Identity.SourceRepository})
	if err != nil {
		return err
	}
	digest, err := hex.DecodeString(h.Hex)
	if err != nil {
		return err
	}
	if _, err := v.Verify(&b, verify.NewPolicy(verify.WithArtifactDigest("sha256", digest), verify.WithCertificateIdentity(id))); err != nil {
		return fmt.Errorf("%w: %v", ErrSignature, err)
	}
	return nil
}

func (s Sigstore) remote(ctx context.Context) []remote.Option {
	return append([]remote.Option{remote.WithContext(ctx), remote.WithTransport(defaultTransport())}, s.Remote...)
}

// fetchBundles lists the digest's Sigstore bundle referrers (the referrers API, or the
// `sha256-<hex>` fallback tag) and downloads each bundle layer, digest-checked.
func (s Sigstore) fetchBundles(ctx context.Context, d name.Digest) ([][]byte, error) {
	idx, err := remote.Referrers(d, append(s.remote(ctx), remote.WithFilter("artifactType", BundleArtifactType))...)
	if err != nil {
		return nil, fmt.Errorf("%w: referrers: %v", ErrUnavailable, err)
	}
	im, err := idx.IndexManifest()
	if err != nil {
		return nil, fmt.Errorf("%w: referrers: %v", ErrUnavailable, err)
	}
	var out [][]byte
	for i, m := range im.Manifests {
		if i >= maxReferrers {
			break
		}
		if m.ArtifactType != BundleArtifactType {
			continue
		}
		img, err := remote.Image(d.Context().Digest(m.Digest.String()), s.remote(ctx)...)
		if err != nil {
			return nil, fmt.Errorf("%w: signature manifest: %v", ErrUnavailable, err)
		}
		mf, err := img.Manifest()
		if err != nil {
			return nil, fmt.Errorf("%w: signature manifest: %v", ErrUnavailable, err)
		}
		if mf.Subject == nil || mf.Subject.Digest.String() != d.DigestStr() {
			continue // a referrer for another digest (a broken fallback tag)
		}
		for _, l := range mf.Layers {
			if l.MediaType != BundleArtifactType || l.Size <= 0 || l.Size > maxBundle {
				continue
			}
			b, err := readBlob(ctx, d.Context(), l, s.remote(ctx))
			if err != nil {
				return nil, err
			}
			out = append(out, b)
		}
	}
	return out, nil
}

// readBlob downloads a small blob whole and checks its size and digest.
func readBlob(ctx context.Context, repo name.Repository, desc v1.Descriptor, opts []remote.Option) ([]byte, error) {
	l, err := remote.Layer(repo.Digest(desc.Digest.String()), opts...)
	if err != nil {
		return nil, fmt.Errorf("%w: blob: %v", ErrUnavailable, err)
	}
	rc, err := l.Compressed()
	if err != nil {
		return nil, fmt.Errorf("%w: blob: %v", ErrUnavailable, err)
	}
	defer rc.Close()
	var buf bytes.Buffer
	n, err := io.Copy(&buf, io.LimitReader(rc, desc.Size+1))
	if err != nil {
		if ctx.Err() != nil || !strings.Contains(err.Error(), "digest") {
			return nil, fmt.Errorf("%w: blob: %v", ErrUnavailable, err)
		}
		return nil, fmt.Errorf("%w: blob digest: %v", ErrSignature, err)
	}
	if n != desc.Size {
		return nil, fmt.Errorf("%w: blob size", ErrSignature)
	}
	got, _, err := v1.SHA256(bytes.NewReader(buf.Bytes()))
	if err != nil || got != desc.Digest {
		return nil, fmt.Errorf("%w: blob digest", ErrSignature)
	}
	return buf.Bytes(), nil
}

// defaultTransport: TLS verification always on, no environment proxy, bounded dials.
func defaultTransport() http.RoundTripper {
	t := http.DefaultTransport.(*http.Transport).Clone()
	t.Proxy = nil
	t.ResponseHeaderTimeout = 30 * time.Second
	return t
}

// cacheDirName is the TUF cache's directory under the state directory.
const cacheDirName = "sigstore-tuf"

// TUFDir is the TUF cache directory for a state directory.
func TUFDir(stateDir string) string { return filepath.Join(stateDir, cacheDirName) }
