// Package gitlab is the runner's GitLab self-managed REST client (enterprise runtime spec §5, P3):
// exactly the calls the controller and the publisher make, with the credential each holds.
//
//   - the controller (minted clone credentials, a Maintainer token with scope `api`): create, list
//     and revoke project access tokens named `kete-job-<machine-id>`, scope `read_repository`,
//     Reporter, expiring the next day;
//   - the publisher (the writer, a bot's token with `api` and `write_repository`): the project, a
//     branch (protection and whether the writer may push to it directly), the merge base, and one
//     draft merge request.
//
// Every request sends the token in `PRIVATE-TOKEN` (never logged, never in an error), refuses
// redirects, has a timeout and a response cap, and decodes only the fields it needs. Errors are
// *Error with a fixed code; a GitLab message is never trusted or echoed beyond a cut, redacted
// excerpt. No retries here: callers decide (the publisher retries `unavailable` reads).
package gitlab

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// Error codes.
const (
	CodeUnauthorized    = "unauthorized"
	CodeForbidden       = "forbidden"
	CodeNotFound        = "not_found"
	CodeConflict        = "conflict"
	CodeUnavailable     = "unavailable" // network, timeout, 429 or 5xx
	CodeInvalidResponse = "invalid_response"
	CodeRefused         = "refused" // another 4xx (validation)
)

// Error is a failed call: a fixed code and the HTTP status (0 for a transport failure).
type Error struct {
	Code   string
	Status int
	Op     string
}

func (e *Error) Error() string {
	if e.Status != 0 {
		return fmt.Sprintf("gitlab: %s: %s (HTTP %d)", e.Op, e.Code, e.Status)
	}
	return fmt.Sprintf("gitlab: %s: %s", e.Op, e.Code)
}

// IsCode reports an *Error with code.
func IsCode(err error, code string) bool {
	var e *Error
	return errors.As(err, &e) && e.Code == code
}

const (
	maxResponse    = 1 << 20
	defaultTimeout = 30 * time.Second
	userAgent      = "kete-runner"
)

// Client calls one GitLab instance's REST API v4 for one project.
type Client struct {
	// Base is the instance URL (https://gitlab.corp or https://corp.example/gitlab), no trailing slash.
	Base string
	// Project is the project's full path (group/subgroup/project).
	Project string
	Token   string
	HTTP    *http.Client
	Timeout time.Duration
}

// New returns a client. hc must not follow redirects (NewHTTPClient's don't); nil uses a default
// without a proxy.
func New(base, project, token string, hc *http.Client) *Client {
	if hc == nil {
		hc = NewHTTPClient(nil)
	}
	return &Client{Base: strings.TrimRight(base, "/"), Project: project, Token: token, HTTP: hc, Timeout: defaultTimeout}
}

// NewHTTPClient returns an HTTP client that never follows redirects, with the given transport
// (nil: Go's default transport without the environment's proxy).
func NewHTTPClient(rt http.RoundTripper) *http.Client {
	if rt == nil {
		t := http.DefaultTransport.(*http.Transport).Clone()
		t.Proxy = nil
		rt = t
	}
	return &http.Client{
		Transport:     rt,
		CheckRedirect: func(*http.Request, []*http.Request) error { return errors.New("redirects are not followed") },
	}
}

func (c *Client) projectPath() string { return "/api/v4/projects/" + url.PathEscape(c.Project) }

// do sends one request; out (if not nil) receives the JSON answer. ok lists the accepted statuses.
func (c *Client) do(ctx context.Context, op, method, path string, query url.Values, body, out any, ok ...int) (int, error) {
	t := c.Timeout
	if t <= 0 {
		t = defaultTimeout
	}
	ctx, cancel := context.WithTimeout(ctx, t)
	defer cancel()
	var rd io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return 0, err
		}
		rd = bytes.NewReader(b)
	}
	raw := c.Base + path
	if len(query) > 0 {
		raw += "?" + query.Encode()
	}
	u, err := url.Parse(raw)
	if err != nil {
		return 0, &Error{Code: CodeInvalidResponse, Op: op}
	}
	req, err := http.NewRequestWithContext(ctx, method, u.String(), rd)
	if err != nil {
		return 0, &Error{Code: CodeInvalidResponse, Op: op}
	}
	req.Header.Set("PRIVATE-TOKEN", c.Token)
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", userAgent)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := c.HTTP.Do(req)
	if err != nil {
		// The transport error isn't wrapped: it may carry the URL (never the token, which is a header).
		return 0, &Error{Code: CodeUnavailable, Op: op}
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, maxResponse+1))
	if err != nil {
		return resp.StatusCode, &Error{Code: CodeUnavailable, Status: resp.StatusCode, Op: op}
	}
	if len(data) > maxResponse {
		return resp.StatusCode, &Error{Code: CodeInvalidResponse, Status: resp.StatusCode, Op: op}
	}
	accepted := len(ok) == 0 && resp.StatusCode >= 200 && resp.StatusCode < 300
	for _, s := range ok {
		accepted = accepted || resp.StatusCode == s
	}
	if !accepted {
		return resp.StatusCode, &Error{Code: statusCode(resp.StatusCode), Status: resp.StatusCode, Op: op}
	}
	if out != nil && len(data) > 0 {
		if err := json.Unmarshal(data, out); err != nil {
			return resp.StatusCode, &Error{Code: CodeInvalidResponse, Status: resp.StatusCode, Op: op}
		}
	}
	return resp.StatusCode, nil
}

func statusCode(s int) string {
	switch {
	case s == http.StatusUnauthorized:
		return CodeUnauthorized
	case s == http.StatusForbidden:
		return CodeForbidden
	case s == http.StatusNotFound:
		return CodeNotFound
	case s == http.StatusConflict:
		return CodeConflict
	case s == http.StatusTooManyRequests || s >= 500:
		return CodeUnavailable
	case s >= 400:
		return CodeRefused
	}
	return CodeInvalidResponse
}

// ---------------------------------------------------------------- project and branches

// Project is what the publisher reads of the project.
type Project struct {
	ID                int64  `json:"id"`
	PathWithNamespace string `json:"path_with_namespace"`
	DefaultBranch     string `json:"default_branch"`
}

// GetProject reads the project. Its path must be the configured one (a renamed or transferred
// project is refused: invalid_response).
func (c *Client) GetProject(ctx context.Context) (Project, error) {
	var p Project
	if _, err := c.do(ctx, "project", http.MethodGet, c.projectPath(), nil, nil, &p); err != nil {
		return Project{}, err
	}
	if p.ID <= 0 || !strings.EqualFold(p.PathWithNamespace, c.Project) || p.DefaultBranch == "" {
		return Project{}, &Error{Code: CodeInvalidResponse, Op: "project"}
	}
	return p, nil
}

// Branch is what the publisher reads of a branch. CanPush is whether the token's user may push to
// it directly (GitLab computes it from the protection rules and the user's role).
type Branch struct {
	Name      string `json:"name"`
	Protected *bool  `json:"protected"`
	CanPush   *bool  `json:"can_push"`
	Commit    struct {
		ID string `json:"id"`
	} `json:"commit"`
}

var shaRe = regexp.MustCompile(`^[0-9a-f]{40}$`)

// GetBranch reads a branch (a missing one is a not_found *Error).
func (c *Client) GetBranch(ctx context.Context, name string) (Branch, error) {
	var b Branch
	if _, err := c.do(ctx, "branch", http.MethodGet, c.projectPath()+"/repository/branches/"+url.PathEscape(name), nil, nil, &b); err != nil {
		return Branch{}, err
	}
	if b.Name != name || !shaRe.MatchString(b.Commit.ID) {
		return Branch{}, &Error{Code: CodeInvalidResponse, Op: "branch"}
	}
	return b, nil
}

// Protection is a branch's protection against the writer.
type Protection string

// Protections.
const (
	Protected   Protection = "protected"
	Unprotected Protection = "unprotected"
	Unknown     Protection = "unknown"
)

// BranchProtection decides whether the writer could update a branch directly (ADR 0021 rule 8,
// GitLab form): protected and the writer can't push → protected; unprotected, or protected but the
// writer may push (a Maintainer bot where Maintainers are allowed to push) → unprotected; fields
// missing → unknown (fail closed).
func BranchProtection(b Branch) Protection {
	if b.Protected == nil || b.CanPush == nil {
		return Unknown
	}
	if *b.Protected && !*b.CanPush {
		return Protected
	}
	return Unprotected
}

// MergeBase returns the merge base of two refs or commits.
func (c *Client) MergeBase(ctx context.Context, a, b string) (string, error) {
	var out struct {
		ID string `json:"id"`
	}
	q := url.Values{"refs[]": {a, b}}
	if _, err := c.do(ctx, "merge_base", http.MethodGet, c.projectPath()+"/repository/merge_base", q, nil, &out); err != nil {
		return "", err
	}
	if !shaRe.MatchString(out.ID) {
		return "", &Error{Code: CodeInvalidResponse, Op: "merge_base"}
	}
	return out.ID, nil
}

// ---------------------------------------------------------------- merge requests

// MergeRequest is a created or found merge request.
type MergeRequest struct {
	IID    int64  `json:"iid"`
	WebURL string `json:"web_url"`
}

// CreateDraftMergeRequest opens a draft merge request (the `Draft:` title prefix, which every
// supported GitLab version honours).
func (c *Client) CreateDraftMergeRequest(ctx context.Context, source, target, title, description string) (MergeRequest, error) {
	body := map[string]any{
		"source_branch": source, "target_branch": target, "title": "Draft: " + title,
		"description": description, "remove_source_branch": false, "squash": false,
	}
	var mr MergeRequest
	if _, err := c.do(ctx, "merge_request", http.MethodPost, c.projectPath()+"/merge_requests", nil, body, &mr, http.StatusCreated); err != nil {
		return MergeRequest{}, err
	}
	if mr.IID < 1 {
		return MergeRequest{}, &Error{Code: CodeInvalidResponse, Op: "merge_request"}
	}
	return mr, nil
}

// FindOpenMergeRequest returns the open merge request from source, if any (an unknown create
// outcome is read back once).
func (c *Client) FindOpenMergeRequest(ctx context.Context, source string) (*MergeRequest, error) {
	var list []MergeRequest
	q := url.Values{"source_branch": {source}, "state": {"opened"}, "per_page": {"5"}}
	if _, err := c.do(ctx, "merge_requests", http.MethodGet, c.projectPath()+"/merge_requests", q, nil, &list); err != nil {
		return nil, err
	}
	if len(list) == 0 || list[0].IID < 1 {
		return nil, nil
	}
	return &list[0], nil
}

// ---------------------------------------------------------------- project access tokens

// TokenPrefix names every clone token the runner mints: kete-job-<machine-id>.
const TokenPrefix = "kete-job-"

// AccessToken is a project access token as listed or created (Token only on create).
type AccessToken struct {
	ID      int64  `json:"id"`
	Name    string `json:"name"`
	Active  bool   `json:"active"`
	Revoked bool   `json:"revoked"`
	Token   string `json:"token,omitempty"`
}

// CloneTokenName is a machine's clone token name: kete-job-<runner instance>-<machine-id>, so
// runners sharing a project only ever sweep their own.
func CloneTokenName(instance, machineID string) string {
	return TokenPrefix + instance + "-" + machineID
}

// CreateCloneToken mints a project access token named name for one machine: scope
// read_repository, role Reporter, expiring the day after now (GitLab's granularity; it is revoked
// long before).
func (c *Client) CreateCloneToken(ctx context.Context, name string, now time.Time) (AccessToken, error) {
	body := map[string]any{
		"name": name, "scopes": []string{"read_repository"}, "access_level": 20,
		"expires_at": now.UTC().AddDate(0, 0, 1).Format("2006-01-02"),
	}
	var t AccessToken
	if _, err := c.do(ctx, "access_token_create", http.MethodPost, c.projectPath()+"/access_tokens", nil, body, &t, http.StatusCreated); err != nil {
		return AccessToken{}, err
	}
	if t.ID < 1 || t.Token == "" || t.Name != name {
		clear([]byte(t.Token))
		return AccessToken{}, &Error{Code: CodeInvalidResponse, Op: "access_token_create"}
	}
	return t, nil
}

// RevokeToken revokes a project access token; one already gone is not an error.
func (c *Client) RevokeToken(ctx context.Context, id int64) error {
	_, err := c.do(ctx, "access_token_revoke", http.MethodDelete, c.projectPath()+"/access_tokens/"+strconv.FormatInt(id, 10), nil, nil, nil, http.StatusNoContent, http.StatusOK)
	if IsCode(err, CodeNotFound) {
		return nil
	}
	return err
}

// ListCloneTokens lists the project's active access tokens named kete-job-… (at most 20 pages of
// 100: the sweeper runs again).
func (c *Client) ListCloneTokens(ctx context.Context) ([]AccessToken, error) {
	var out []AccessToken
	for page := 1; page <= 20; page++ {
		var list []AccessToken
		q := url.Values{"state": {"active"}, "per_page": {"100"}, "page": {strconv.Itoa(page)}}
		if _, err := c.do(ctx, "access_tokens", http.MethodGet, c.projectPath()+"/access_tokens", q, nil, &list); err != nil {
			return nil, err
		}
		for _, t := range list {
			if strings.HasPrefix(t.Name, TokenPrefix) && t.Active && !t.Revoked {
				out = append(out, t)
			}
		}
		if len(list) < 100 {
			break
		}
	}
	return out, nil
}

// ---------------------------------------------------------------- redaction

var tokenShapes = regexp.MustCompile(`(glpat|gldt|glptt|gloas|glrt|glcbt|glimt|glagent|glsoat|glffct|glft|glwt)-[A-Za-z0-9_.-]{8,}`)

// Redact masks GitLab token shapes (spec §9.3) in s.
func Redact(s string) string { return tokenShapes.ReplaceAllString(s, "$1-[redacted]") }
