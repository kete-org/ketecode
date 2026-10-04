package guestinit

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"time"

	"github.com/kete-org/ketecode/packages/kete-job-entrypoint/internal/bootenv"
)

// MetadataBase is every supported provider's metadata service (link-local, reached only before
// the metadata drop).
const MetadataBase = "http://169.254.169.254"

// UserDataRequest is how one provider serves the VM's user data.
type UserDataRequest struct {
	Path    string
	Header  map[string]string
	Base64  bool   // the body is the user data base64-encoded (OCI)
	RespHdr string // a response header that must carry the request header's value (GCP's flavor)
}

// UserDataRequests are the providers' user-data endpoints (provider documentation; to verify on
// real VMs in P6).
var UserDataRequests = map[string]UserDataRequest{
	"gcp": {
		Path:    "/computeMetadata/v1/instance/attributes/user-data",
		Header:  map[string]string{"Metadata-Flavor": "Google"},
		RespHdr: "Metadata-Flavor",
	},
	"digitalocean": {Path: "/metadata/v1/user-data"},
	"hetzner":      {Path: "/hetzner/v1/userdata"},
	"oci": {
		Path:   "/opc/v2/instance/metadata/user_data",
		Header: map[string]string{"Authorization": "Bearer Oracle"},
		Base64: true,
	},
}

// UserDataClient fetches user data: no proxy, no redirect, bounded attempts, timeouts and size.
type UserDataClient struct {
	Base     string        // MetadataBase in production; a fake server in tests
	Timeout  time.Duration // per attempt
	Attempts int
	Backoff  time.Duration
}

// DefaultUserDataClient is the production client.
func DefaultUserDataClient() UserDataClient {
	return UserDataClient{Base: MetadataBase, Timeout: 5 * time.Second, Attempts: 3, Backoff: time.Second}
}

// errPermanent marks a response that a retry won't change.
var errPermanent = errors.New("permanent")

// Fetch returns the provider's user data (decoded for OCI), at most bootenv.MaxConfig bytes.
func (c UserDataClient) Fetch(ctx context.Context, provider string) ([]byte, error) {
	req, ok := UserDataRequests[provider]
	if !ok {
		return nil, fmt.Errorf("unknown provider")
	}
	client := &http.Client{
		Transport: &http.Transport{
			Proxy:                 nil,
			DialContext:           (&net.Dialer{Timeout: c.Timeout}).DialContext,
			ResponseHeaderTimeout: c.Timeout,
			DisableKeepAlives:     true,
		},
		Timeout:       c.Timeout,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
	attempts := max(c.Attempts, 1)
	var last error
	for i := 0; i < attempts; i++ {
		if i > 0 {
			select {
			case <-ctx.Done():
				return nil, ctx.Err()
			case <-time.After(c.Backoff):
			}
		}
		b, err := c.once(ctx, client, req)
		if err == nil {
			return b, nil
		}
		last = err
		if errors.Is(err, errPermanent) || ctx.Err() != nil {
			break
		}
	}
	return nil, last
}

func (c UserDataClient) once(ctx context.Context, client *http.Client, u UserDataRequest) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimSuffix(c.Base, "/")+u.Path, nil)
	if err != nil {
		return nil, err
	}
	for k, v := range u.Header {
		req.Header.Set(k, v)
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
		if resp.StatusCode >= 500 {
			return nil, fmt.Errorf("user data: status %d", resp.StatusCode)
		}
		return nil, fmt.Errorf("user data: status %d: %w", resp.StatusCode, errPermanent)
	}
	if u.RespHdr != "" && resp.Header.Get(u.RespHdr) != u.Header[u.RespHdr] {
		return nil, fmt.Errorf("user data: missing %s response header: %w", u.RespHdr, errPermanent)
	}
	limit := int64(bootenv.MaxConfig)
	if u.Base64 {
		limit = int64(base64.StdEncoding.EncodedLen(bootenv.MaxConfig)) + 2
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(body)) > limit {
		clear(body)
		return nil, fmt.Errorf("user data: oversize: %w", errPermanent)
	}
	if !u.Base64 {
		return body, nil
	}
	defer clear(body)
	dec, err := base64.StdEncoding.DecodeString(strings.TrimSpace(string(body)))
	if err != nil {
		return nil, fmt.Errorf("user data: not base64: %w", errPermanent)
	}
	return dec, nil
}
