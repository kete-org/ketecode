// Package client is the agent's HTTPS client for the two job-host routes (v1, or v2 with
// Options.V2). Every request is a signed `POST` (package sig) to the configured platform origin;
// responses are authenticated only by TLS to that origin, so certificate verification is always
// on and redirects are never followed (`docs/platform/job-host-v1.md` "Responses are not signed").
// Each request has a 15 s timeout and reads at most 1 MiB (v2: 2 MiB) of response. The only proxy
// is an explicitly configured one (Options.Proxy, the Kubernetes runner's enterprise proxy, HTTP
// CONNECT); the environment's proxy variables are never read.
package client

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/rand/v2"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"time"

	"github.com/kete-org/ketecode/packages/kete-job-host/internal/contract"
	"github.com/kete-org/ketecode/packages/kete-job-host/internal/sig"
)

// RequestTimeout is each request's budget.
const RequestTimeout = 15 * time.Second

// Options configure the client. A VM host leaves them zero: v1, the system roots, the normal
// dialer, no proxy. RootCAs and DialContext are also test seams.
type Options struct {
	RootCAs     *x509.CertPool
	DialContext func(ctx context.Context, network, addr string) (net.Conn, error)
	// V2 signs under job-host-v2's profile (sig.V2) with its body and response limits and error
	// reasons.
	V2 bool
	// Proxy is the upstream HTTP proxy the platform connection goes through (CONNECT; TLS to the
	// platform stays end to end and verified). nil: direct.
	Proxy *url.URL
}

// Client signs and sends requests.
type Client struct {
	origin    string
	authority string
	http      *http.Client
	now       func() time.Time
	v2        bool
}

// New returns a client for origin (`https://host`) whose `@authority` is authority; now is the
// clock for signature times (nil: time.Now).
func New(origin, authority string, now func() time.Time, o Options) *Client {
	var proxy func(*http.Request) (*url.URL, error) // never an environment proxy
	if o.Proxy != nil {
		proxy = http.ProxyURL(o.Proxy)
	}
	tr := &http.Transport{
		Proxy:                 proxy,
		DialContext:           o.DialContext,
		TLSClientConfig:       &tls.Config{MinVersion: tls.VersionTLS12, RootCAs: o.RootCAs},
		TLSHandshakeTimeout:   10 * time.Second,
		ResponseHeaderTimeout: RequestTimeout,
		MaxIdleConns:          2,
		IdleConnTimeout:       90 * time.Second,
		ForceAttemptHTTP2:     true,
	}
	if now == nil {
		now = time.Now
	}
	if tr.DialContext == nil {
		tr.DialContext = (&net.Dialer{Timeout: 10 * time.Second, KeepAlive: 30 * time.Second}).DialContext
	}
	return &Client{
		origin: origin, authority: authority, now: now, v2: o.V2,
		http: &http.Client{
			Transport:     tr,
			CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
		},
	}
}

// Response is a successful response.
type Response struct {
	Status    int
	Body      []byte
	Nonce     string // the request's signature nonce (a poll response must echo it)
	RequestID string
}

// APIError is a non-success response. Reason is the contract reason when the body carried a
// known one, else "" (decide by Status).
type APIError struct {
	Status     int
	Reason     string
	RequestID  string
	RetryAfter time.Duration
}

func (e *APIError) Error() string {
	if e.Reason != "" {
		return fmt.Sprintf("platform answered %d %s", e.Status, e.Reason)
	}
	return fmt.Sprintf("platform answered %d", e.Status)
}

var requestIDRe = regexp.MustCompile(`^[A-Za-z0-9_.:-]{1,64}$`)

// SafeRequestID keeps a request id only if it is a short token (it is logged).
func SafeRequestID(s string) string {
	if requestIDRe.MatchString(s) {
		return s
	}
	return ""
}

// Post signs body with key under keyID and sends it to path. want is the success status
// (201 enroll, 200 poll).
func (c *Client) Post(ctx context.Context, path, keyID string, key ed25519.PrivateKey, body []byte, want int) (Response, error) {
	limit, readMax, profile, knownReason := contract.PollMaxBytes, contract.ResponseMaxBytes, sig.V1, contract.ValidErrorReason
	if c.v2 {
		limit, readMax, profile, knownReason = contract.V2PollMaxBytes, contract.V2ResponseMaxBytes, sig.V2, contract.ValidErrorReasonV2
	}
	if path == contract.EnrollPath {
		limit = contract.EnrollMaxBytes
	}
	if len(body) > limit {
		return Response{}, fmt.Errorf("client: %s body is %d bytes, over %d", path, len(body), limit)
	}
	nonce, err := sig.RandomNonce()
	if err != nil {
		return Response{}, err
	}
	created := c.now().Unix()
	h, _, err := profile.Sign(key, c.authority, path, body, sig.Params{Created: created, Expires: created + contract.SignatureWindow, Nonce: nonce, KeyID: keyID})
	if err != nil {
		return Response{}, err
	}
	ctx, cancel := context.WithTimeout(ctx, RequestTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.origin+path, bytes.NewReader(body))
	if err != nil {
		return Response{}, err
	}
	req.Header.Set("Content-Type", h.ContentType)
	req.Header.Set("Content-Digest", h.ContentDigest)
	req.Header.Set("Signature-Input", h.SignatureInput)
	req.Header.Set("Signature", h.Signature)
	resp, err := c.http.Do(req)
	if err != nil {
		return Response{}, fmt.Errorf("client: %s: %w", path, scrub(err))
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, int64(readMax)+1))
	if err != nil {
		return Response{}, fmt.Errorf("client: reading %s response: %w", path, scrub(err))
	}
	if len(data) > readMax {
		return Response{}, fmt.Errorf("client: %s response over %d bytes", path, readMax)
	}
	rid := SafeRequestID(resp.Header.Get("x-kete-request-id"))
	if resp.StatusCode == want {
		return Response{Status: resp.StatusCode, Body: data, Nonce: nonce, RequestID: rid}, nil
	}
	e := &APIError{Status: resp.StatusCode, RequestID: rid, RetryAfter: retryAfter(resp.Header.Get("Retry-After"), c.now())}
	var body2 contract.ErrorResponse
	if json.Unmarshal(data, &body2) == nil && knownReason(body2.Error.Reason) {
		e.Reason = body2.Error.Reason
		if e.RequestID == "" {
			e.RequestID = SafeRequestID(body2.Error.RequestID)
		}
	}
	return Response{}, e
}

// retryAfter parses Retry-After (seconds or an HTTP date), bounded to MaxBackoff.
func retryAfter(v string, now time.Time) time.Duration {
	if v == "" {
		return 0
	}
	var d time.Duration
	if s, err := strconv.Atoi(v); err == nil && s >= 0 {
		d = time.Duration(s) * time.Second
	} else if t, err := http.ParseTime(v); err == nil {
		d = t.Sub(now)
	}
	return max(0, min(d, MaxBackoff))
}

// scrub keeps a transport error's kind without the URL (the URL holds nothing secret, but the
// error text of a url.Error is long and repeats the origin in every log line).
func scrub(err error) error {
	var ue interface{ Unwrap() error }
	if errors.As(err, &ue) {
		if inner := ue.Unwrap(); inner != nil {
			return inner
		}
	}
	return err
}

// Backoff is the contract's retry schedule: exponential from 10 s to at most 5 min, with jitter.
type Backoff struct{ n int }

// Backoff bounds.
const (
	MinBackoff = 10 * time.Second
	MaxBackoff = 5 * time.Minute
)

// Next returns the next delay: d = 10 s · 2^n plus up to d/2 of jitter, at most 5 min.
func (b *Backoff) Next() time.Duration {
	d := MinBackoff << min(b.n, 6)
	b.n++
	d += time.Duration(rand.Int64N(int64(d/2) + 1))
	return min(d, MaxBackoff)
}

// Reset starts over after a success.
func (b *Backoff) Reset() { b.n = 0 }
