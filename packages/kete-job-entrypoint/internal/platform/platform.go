// Package platform is root's client for the platform's container callbacks (kete-code-platform
// docs/jobs.md §2 "Container callbacks"; the in-repo mirror is docs/context/contracts.md §6d):
// claim, events, result, uploads, finish, the signed-URL uploads and the clone-token revoke. Every
// request goes through the proxy's port R and trusts only the proxy's CA. Nothing here logs a
// body, a header, a URL's query or a token.
package platform

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptrace"
	"net/url"
	"sync"
	"time"
)

// ErrGone is a 404 from a callback: the job was cancelled, timed out or is terminal (or the token
// is wrong). The entrypoint kills everything and stops calling back.
var ErrGone = errors.New("platform: job gone (404)")

// ErrReplayed is a 409 from claim: a second claim, which fails the job.
var ErrReplayed = errors.New("platform: claim replayed (409)")

// StatusError is any other unexpected status.
type StatusError struct{ Status int }

// ErrorClass is the fixed phase-log class ("http", the status).
func (e *StatusError) ErrorClass() (string, int) { return "http", e.Status }

func (e *StatusError) Error() string { return fmt.Sprintf("platform: unexpected status %d", e.Status) }

// Options configure the client.
type Options struct {
	BaseURL     string // https://host
	JobID       string
	StorageHost string // the only host upload URLs may name
	ProxyURL    string // http://127.0.0.1:<port R>
	Timeout     time.Duration
	ClaimTries  int
	ClaimWindow time.Duration
	Backoff     time.Duration
}

// Client is the callback client.
type Client struct {
	o        Options
	mu       sync.Mutex
	hc       *http.Client
	callback string
}

// New builds a client; SetCA must be called before any request.
func New(o Options) *Client { return &Client{o: o} }

// SetCA trusts only caPEM from now on (a new proxy instance has a new CA). Idle connections to
// the previous instance are dropped.
func (c *Client) SetCA(caPEM []byte) error {
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(caPEM) {
		return errors.New("platform: no CA certificate")
	}
	var proxyFn func(*http.Request) (*url.URL, error)
	if c.o.ProxyURL != "" { // always set in the entrypoint; empty only in unit tests
		proxy, err := url.Parse(c.o.ProxyURL)
		if err != nil {
			return err
		}
		proxyFn = http.ProxyURL(proxy)
	}
	tr := &http.Transport{
		Proxy:               proxyFn,
		TLSClientConfig:     &tls.Config{RootCAs: pool, MinVersion: tls.VersionTLS12},
		TLSNextProto:        map[string]func(string, *tls.Conn) http.RoundTripper{},
		ForceAttemptHTTP2:   false,
		MaxIdleConnsPerHost: 2,
		IdleConnTimeout:     30 * time.Second,
	}
	c.mu.Lock()
	old := c.hc
	c.hc = &http.Client{
		Transport: tr,
		Timeout:   c.o.Timeout,
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
	c.mu.Unlock()
	if old != nil {
		old.CloseIdleConnections()
	}
	return nil
}

// SetCallbackToken stores the callback token (the Bearer for every later callback).
func (c *Client) SetCallbackToken(t string) {
	c.mu.Lock()
	c.callback = t
	c.mu.Unlock()
}

func (c *Client) client() *http.Client {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.hc
}

func (c *Client) jobURL(op string) string {
	return c.o.BaseURL + "/api/v1/jobs/" + c.o.JobID + "/" + op
}

const maxResponse = 1 << 20

// do sends one request; wrote reports whether any of it reached the connection.
func (c *Client) do(ctx context.Context, method, u string, body []byte, auth string) (status int, resp []byte, wrote bool, err error) {
	hc := c.client()
	if hc == nil {
		return 0, nil, false, errors.New("platform: no CA")
	}
	var rd io.Reader
	if body != nil {
		rd = bytes.NewReader(body)
	}
	req, err := http.NewRequestWithContext(ctx, method, u, rd)
	if err != nil {
		return 0, nil, false, err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if auth != "" {
		req.Header.Set("Authorization", auth)
	}
	var wroteMu sync.Mutex
	trace := &httptrace.ClientTrace{
		WroteHeaderField: func(string, []string) { wroteMu.Lock(); wrote = true; wroteMu.Unlock() },
		WroteRequest:     func(httptrace.WroteRequestInfo) { wroteMu.Lock(); wrote = true; wroteMu.Unlock() },
	}
	req = req.WithContext(httptrace.WithClientTrace(req.Context(), trace))
	res, err := hc.Do(req)
	wroteMu.Lock()
	w := wrote
	wroteMu.Unlock()
	if err != nil {
		return 0, nil, w, err
	}
	defer res.Body.Close()
	data, err := io.ReadAll(io.LimitReader(res.Body, maxResponse+1))
	if err != nil {
		return res.StatusCode, nil, true, err
	}
	if len(data) > maxResponse {
		return res.StatusCode, nil, true, errors.New("platform: response too large")
	}
	return res.StatusCode, data, true, nil
}

func (c *Client) bearer() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return "Bearer " + c.callback
}

func sleepCtx(ctx context.Context, d time.Duration) error {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return nil
	}
}

// Claim posts the claim token. It is retried only while no byte of a request was written
// (dial, TLS and proxy errors): a second claim fails the job (claim_replayed).
func (c *Client) Claim(ctx context.Context, token string) (*ClaimResponse, error) {
	body, err := json.Marshal(map[string]string{"claim_token": token})
	if err != nil {
		return nil, err
	}
	stop := time.Now().Add(c.o.ClaimWindow)
	backoff := c.o.Backoff
	for try := 1; ; try++ {
		status, data, wrote, err := c.do(ctx, http.MethodPost, c.jobURL("claim"), body, "")
		if err == nil {
			switch status {
			case http.StatusOK:
				return ParseClaim(data)
			case http.StatusNotFound:
				return nil, ErrGone
			case http.StatusConflict:
				return nil, ErrReplayed
			default:
				return nil, &StatusError{Status: status}
			}
		}
		if wrote || try >= c.o.ClaimTries || time.Now().Add(backoff).After(stop) || ctx.Err() != nil {
			return nil, fmt.Errorf("platform: claim: %w", err)
		}
		if err := sleepCtx(ctx, backoff); err != nil {
			return nil, err
		}
		backoff *= 2
	}
}

// Event is one events body.
type Event struct {
	Phase                   string `json:"phase"`
	Message                 string `json:"message,omitempty"`
	EffectiveTimeoutMinutes *int   `json:"effective_timeout_minutes,omitempty"`
	KeteCgroupExtra         *int   `json:"kete_cgroup_extra,omitempty"`
}

// Events sends one heartbeat or message (no internal retry: the next tick retries).
func (c *Client) Events(ctx context.Context, e Event) error {
	if len(e.Message) > 500 {
		e.Message = e.Message[:500]
	}
	body, err := json.Marshal(e)
	if err != nil {
		return err
	}
	return c.expect(ctx, "events", body, http.StatusNoContent, 1)
}

func (c *Client) expect(ctx context.Context, op string, body []byte, want int, tries int) error {
	var last error
	backoff := c.o.Backoff
	for try := 1; try <= tries; try++ {
		status, _, _, err := c.do(ctx, http.MethodPost, c.jobURL(op), body, c.bearer())
		switch {
		case err == nil && status == want:
			return nil
		case err == nil && status == http.StatusNotFound:
			return ErrGone
		case err == nil && status < 500:
			return &StatusError{Status: status}
		case err == nil:
			last = &StatusError{Status: status}
		default:
			last = err
		}
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if try < tries {
			if err := sleepCtx(ctx, backoff); err != nil {
				return err
			}
			backoff *= 2
		}
	}
	return fmt.Errorf("platform: %s: %w", op, last)
}

// Result posts the `kete job run --json` object, verbatim (retried ≤ 3 on network errors and 5xx).
func (c *Client) Result(ctx context.Context, raw []byte) error {
	return c.expect(ctx, "result", raw, http.StatusNoContent, 3)
}

// Finish posts finish (with push_error when the bundle was refused).
func (c *Client) Finish(ctx context.Context, pushError string) error {
	body := []byte(`{}`)
	if pushError != "" {
		var err error
		if body, err = json.Marshal(map[string]string{"push_error": pushError}); err != nil {
			return err
		}
	}
	return c.expect(ctx, "finish", body, http.StatusAccepted, 3)
}

// Uploads asks for the signed upload URLs.
func (c *Client) Uploads(ctx context.Context, bundle bool) (*UploadURLs, error) {
	body, err := json.Marshal(map[string]bool{"bundle": bundle})
	if err != nil {
		return nil, err
	}
	status, data, _, err := c.do(ctx, http.MethodPost, c.jobURL("uploads"), body, c.bearer())
	if err != nil {
		return nil, fmt.Errorf("platform: uploads: %w", err)
	}
	switch status {
	case http.StatusOK:
		return ParseUploads(data, bundle, c.o.StorageHost)
	case http.StatusNotFound:
		return nil, ErrGone
	}
	return nil, &StatusError{Status: status}
}

// Put streams size bytes of r to a signed URL.
func (c *Client) Put(ctx context.Context, u, contentType string, r io.Reader, size int64) error {
	hc := c.client()
	if hc == nil {
		return errors.New("platform: no CA")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPut, u, io.LimitReader(r, size))
	if err != nil {
		return errors.New("platform: bad upload URL")
	}
	req.ContentLength = size
	req.Header.Set("Content-Type", contentType)
	res, err := hc.Do(req)
	if err != nil {
		// The error text would carry the URL (and its token query); never pass it on.
		return errors.New("platform: upload failed")
	}
	_, _ = io.Copy(io.Discard, io.LimitReader(res.Body, maxResponse))
	res.Body.Close()
	if res.StatusCode/100 != 2 {
		return &StatusError{Status: res.StatusCode}
	}
	return nil
}

// RevokeURL is the installation-token revoke endpoint for a clone host: api.github.com for
// github.com, else the GHES convention https://<host>/api/v3/installation/token.
func RevokeURL(cloneHost string) (host, u string) {
	if cloneHost == "github.com" {
		return "api.github.com", "https://api.github.com/installation/token"
	}
	return cloneHost, "https://" + cloneHost + "/api/v3/installation/token"
}

// Revoke deletes the clone token (≤ 3 tries; 204 expected).
func (c *Client) Revoke(ctx context.Context, cloneHost, token string) error {
	_, u := RevokeURL(cloneHost)
	var last error
	backoff := c.o.Backoff
	for try := 1; try <= 3; try++ {
		status, _, _, err := c.do(ctx, http.MethodDelete, u, nil, "token "+token)
		if err == nil && status == http.StatusNoContent {
			return nil
		}
		if err == nil {
			last = &StatusError{Status: status}
		} else {
			last = errors.New("platform: revoke request failed")
		}
		if try < 3 {
			if err := sleepCtx(ctx, backoff); err != nil {
				return err
			}
			backoff *= 2
		}
	}
	return last
}
