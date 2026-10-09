// Package gitproto is git smart HTTP spoken by the runner itself (enterprise runtime P3: the GitLab
// publisher and the controller's base-ref resolution), in pure Go because the runner image has no
// git binary. It is a port of kete-code-platform `apps/portal/lib/harness/code/{git,pack}.ts` and
// `apps/portal/lib/jobs/push/git-objects.ts` (ADR 0021 rule 7, ADR 0024 rule 4), with the same
// behaviour:
//   - FetchBase: protocol v2 `fetch` of one commit with `deepen 1` and `filter blob:none` (the
//     commit and its trees, no blobs), parsed by the bounded pack reader;
//   - LsRefs: protocol v2 `ls-refs` with a ref prefix;
//   - ReceivePackRefs + PushCreateRef: protocol v0 `receive-pack` with a single create-only command
//     (old id = zero), `report-status` and `side-band-64k`.
//
// Every request: HTTP basic auth (never logged or echoed), no redirects, a per-call timeout
// combined with the caller's context, a response cap. Hostile input throughout: pkt-line lengths,
// sections and side bands are checked; server messages are returned cut and never trusted.
package gitproto

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

// Endpoint is one repository over smart HTTP.
type Endpoint struct {
	// URL is the repository URL (`https://host/…/repo.git`, no trailing slash).
	URL                string
	Username, Password string
	// Client carries the proxy and TLS roots; nil: a client with no proxy and the system roots.
	// Redirects are refused whatever the client says.
	Client *http.Client
	// Timeout bounds each request (default 60 s).
	Timeout time.Duration
}

// Error codes.
const (
	CodeUnauthorized    = "unauthorized"
	CodeForbidden       = "forbidden"
	CodeNotFound        = "not_found"
	CodeUnavailable     = "unavailable"
	CodeInvalidResponse = "invalid_response"
	CodeUnsupported     = "unsupported" // no protocol v2 fetch with shallow and filter, or not SHA-1
	CodeBaseNotFound    = "base_not_found"
	CodeTooLarge        = "too_large"
)

// Error is a fixed code and a detail that never carries a credential or the URL.
type Error struct {
	Code   string
	Detail string
}

func (e *Error) Error() string {
	if e.Detail == "" {
		return "gitproto: " + e.Code
	}
	return "gitproto: " + e.Code + ": " + e.Detail
}

func gerr(code, detail string) *Error { return &Error{Code: code, Detail: detail} }

// transportDetail is a transport error without the request URL, cut short.
func transportDetail(err error) string {
	var ue *url.Error
	if errors.As(err, &ue) {
		err = ue.Err
	}
	return CutMessage(err.Error(), 200)
}

// scrub removes the endpoint's user name and password from a message.
func (ep Endpoint) scrub(s string) string {
	for _, v := range []string{ep.Password, ep.Username} {
		if len(v) >= 4 {
			s = strings.ReplaceAll(s, v, "[redacted]")
		}
	}
	return s
}

// ErrorCode is err's code, or "" when it isn't an *Error.
func ErrorCode(err error) string {
	var e *Error
	if errors.As(err, &e) {
		return e.Code
	}
	return ""
}

// ZeroID is the all-zero object id.
var ZeroID = strings.Repeat("0", 40)

const (
	userAgent = "git/2.45.0 (kete-runner)"
	agentName = "kete-runner"
	framing   = 1 << 20
)

var (
	hexID    = regexp.MustCompile(`^[0-9a-f]{40}$`)
	pktLenRe = regexp.MustCompile(`^[0-9a-f]{4}$`)
)

// ---------------------------------------------------------------- pkt-line

// Pkt encodes one pkt-line; it panics on a body over 65516 bytes (callers build only short lines).
func Pkt(line []byte) []byte {
	if len(line) > 65516 {
		panic("gitproto: pkt-line too long")
	}
	return append([]byte(fmt.Sprintf("%04x", len(line)+4)), line...)
}

func pkts(s string) []byte { return Pkt([]byte(s)) }

// Packet kinds.
const (
	PacketData = iota
	PacketFlush
	PacketDelim
	PacketEnd
)

// Packet is one pkt-line: data, or a flush (0000), delim (0001) or response-end (0002).
type Packet struct {
	Kind int
	Data []byte
}

// ParsePackets splits a pkt-line stream; false when a length is malformed or runs past the end.
func ParsePackets(b []byte) ([]Packet, bool) {
	var out []Packet
	i := 0
	for i < len(b) {
		if i+4 > len(b) {
			return nil, false
		}
		h := string(b[i : i+4])
		if !pktLenRe.MatchString(h) {
			return nil, false
		}
		var n int
		_, _ = fmt.Sscanf(h, "%04x", &n)
		switch {
		case n == 0:
			out = append(out, Packet{Kind: PacketFlush})
		case n == 1:
			out = append(out, Packet{Kind: PacketDelim})
		case n == 2:
			out = append(out, Packet{Kind: PacketEnd})
		case n < 4 || i+n > len(b):
			return nil, false
		default:
			out = append(out, Packet{Kind: PacketData, Data: b[i+4 : i+n]})
		}
		if n < 4 {
			i += 4
		} else {
			i += n
		}
	}
	return out, true
}

// text decodes a packet's data as UTF-8 (invalid bytes become U+FFFD) without one trailing LF.
func text(b []byte) string {
	return strings.TrimSuffix(strings.ToValidUTF8(string(b), "�"), "\n")
}

var spaceRun = regexp.MustCompile(`\s+`)

// tokenShapes are GitLab token prefixes (internal/repo/gitlab Redact; kept here so gitproto has no
// dependency on the REST client).
var tokenShapes = regexp.MustCompile(`(glpat|gldt|glptt|gloas|glrt|glcbt|glimt|glagent|glsoat|glffct|glft|glwt)-[A-Za-z0-9_.-]{8,}`)

// CutMessage strips control and format characters from a server message, collapses white space
// and cuts it to max characters.
func CutMessage(msg string, max int) string {
	var b strings.Builder
	prevSpace := false
	for _, r := range strings.ToValidUTF8(msg, "�") {
		if unicode.Is(unicode.Cc, r) || unicode.Is(unicode.Cf, r) {
			if !prevSpace {
				b.WriteByte(' ')
			}
			prevSpace = true
			continue
		}
		prevSpace = false
		b.WriteRune(r)
	}
	clean := strings.TrimSpace(spaceRun.ReplaceAllString(b.String(), " "))
	// A server message never echoes a credential further (GitLab token shapes, spec §9.3).
	clean = tokenShapes.ReplaceAllString(clean, "$1-[redacted]")
	if utf8.RuneCountInString(clean) > max {
		r := []rune(clean)
		return string(r[:max-1]) + "…"
	}
	return clean
}

// ---------------------------------------------------------------- HTTP

var errRedirect = errors.New("gitproto: redirects are refused")

func (ep Endpoint) client() *http.Client {
	var c http.Client
	if ep.Client != nil {
		c = *ep.Client
	} else {
		c.Transport = &http.Transport{
			Proxy:                 nil,
			DialContext:           (&net.Dialer{Timeout: 10 * time.Second}).DialContext,
			TLSHandshakeTimeout:   10 * time.Second,
			ResponseHeaderTimeout: 60 * time.Second,
		}
	}
	c.CheckRedirect = func(*http.Request, []*http.Request) error { return errRedirect }
	return &c
}

type response struct {
	status int
	body   []byte
}

func (ep Endpoint) request(ctx context.Context, method, path string, headers map[string]string, body []byte, cap int64) (response, error) {
	timeout := ep.Timeout
	if timeout <= 0 {
		timeout = 60 * time.Second
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	var rd io.Reader
	if body != nil {
		rd = bytes.NewReader(body)
	}
	req, err := http.NewRequestWithContext(ctx, method, ep.URL+path, rd)
	if err != nil {
		return response{}, gerr(CodeInvalidResponse, "bad request URL")
	}
	req.Header.Set("User-Agent", userAgent)
	req.SetBasicAuth(ep.Username, ep.Password)
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	resp, err := ep.client().Do(req)
	if err != nil {
		// The URL error's inner error only (never the URL, which could carry userinfo), with the
		// credentials scrubbed in case anything echoed them.
		return response{}, gerr(CodeUnavailable, ep.scrub(transportDetail(err)))
	}
	defer resp.Body.Close()
	switch s := resp.StatusCode; {
	case s == 401:
		return response{}, gerr(CodeUnauthorized, "")
	case s == 403:
		return response{}, gerr(CodeForbidden, "")
	case s == 404:
		return response{}, gerr(CodeNotFound, "")
	case s >= 500 || s == 429:
		return response{}, gerr(CodeUnavailable, fmt.Sprintf("HTTP %d", s))
	case s >= 300:
		return response{}, gerr(CodeInvalidResponse, fmt.Sprintf("HTTP %d", s))
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, cap+1))
	if err != nil {
		return response{}, gerr(CodeUnavailable, ep.scrub("reading the response: "+transportDetail(err)))
	}
	if int64(len(data)) > cap {
		return response{}, gerr(CodeTooLarge, "")
	}
	return response{status: resp.StatusCode, body: data}, nil
}

// afterServiceLine strips the smart HTTP `# service=…` preamble (and its flush), if present.
func afterServiceLine(p []Packet, service string) ([]Packet, bool) {
	if len(p) > 0 && p[0].Kind == PacketData && text(p[0].Data) == "# service="+service {
		if len(p) < 2 || p[1].Kind != PacketFlush {
			return nil, false
		}
		return p[2:], true
	}
	return p, true
}

func dataLines(p []Packet) []string {
	var out []string
	for _, x := range p {
		if x.Kind == PacketData {
			out = append(out, text(x.Data))
		}
	}
	return out
}

// ---------------------------------------------------------------- upload-pack (protocol v2)

// v2Caps reads the protocol v2 capability advertisement.
func v2Caps(ctx context.Context, ep Endpoint) ([]string, error) {
	adv, err := ep.request(ctx, http.MethodGet, "/info/refs?service=git-upload-pack", map[string]string{"Git-Protocol": "version=2", "Accept": "*/*"}, nil, 256<<10)
	if err != nil {
		return nil, err
	}
	p, ok := ParsePackets(adv.body)
	if !ok {
		return nil, gerr(CodeUnsupported, "no protocol v2")
	}
	caps, ok := afterServiceLine(p, "git-upload-pack")
	if !ok || len(caps) == 0 || caps[0].Kind != PacketData || text(caps[0].Data) != "version 2" {
		return nil, gerr(CodeUnsupported, "no protocol v2")
	}
	return dataLines(caps), nil
}

func capPrefix(lines []string, prefix string) (string, bool) {
	for _, l := range lines {
		if strings.HasPrefix(l, prefix) {
			return l, true
		}
	}
	return "", false
}

// commandHead is a v2 command's capability section.
func commandHead(command string, lines []string, objectFormat string) []byte {
	var b bytes.Buffer
	b.Write(pkts("command=" + command + "\n"))
	if _, ok := capPrefix(lines, "agent="); ok {
		b.Write(pkts("agent=" + agentName + "\n"))
	}
	if objectFormat != "" {
		b.Write(pkts("object-format=sha1\n"))
	}
	b.WriteString("0001")
	return b.Bytes()
}

// BaseFetch is a fetched commit: its root tree, parents, and every object the pack carried (the
// commit and its trees).
type BaseFetch struct {
	Tree    string
	Parents []string
	Objects map[string]Object
}

var notOurRef = regexp.MustCompile(`(?i)not our ref|not found|unadvertised|no such`)

// FetchBase fetches the commit sha with its trees, no blobs (`deepen 1`, `filter blob:none`).
func FetchBase(ctx context.Context, ep Endpoint, sha string, lim PackLimits) (BaseFetch, error) {
	if !hexID.MatchString(sha) {
		return BaseFetch{}, gerr(CodeInvalidResponse, "not a commit id")
	}
	lines, err := v2Caps(ctx, ep)
	if err != nil {
		return BaseFetch{}, err
	}
	var features []string
	fetchCap := ""
	for _, l := range lines {
		if l == "fetch" || strings.HasPrefix(l, "fetch=") {
			fetchCap = l
			break
		}
	}
	if strings.HasPrefix(fetchCap, "fetch=") {
		features = strings.Split(fetchCap[len("fetch="):], " ")
	}
	has := func(f string) bool {
		for _, x := range features {
			if x == f {
				return true
			}
		}
		return false
	}
	if fetchCap == "" || !has("shallow") || !has("filter") {
		return BaseFetch{}, gerr(CodeUnsupported, "fetch without shallow and filter")
	}
	of, _ := capPrefix(lines, "object-format=")
	if of != "" && of != "object-format=sha1" {
		return BaseFetch{}, gerr(CodeUnsupported, "not sha1")
	}
	var body bytes.Buffer
	body.Write(commandHead("fetch", lines, of))
	for _, l := range []string{"no-progress\n", "ofs-delta\n", "deepen 1\n", "filter blob:none\n", "want " + sha + "\n", "done\n"} {
		body.Write(pkts(l))
	}
	body.WriteString("0000")
	res, err := ep.request(ctx, http.MethodPost, "/git-upload-pack", map[string]string{
		"Content-Type": "application/x-git-upload-pack-request", "Accept": "application/x-git-upload-pack-result", "Git-Protocol": "version=2",
	}, body.Bytes(), lim.MaxPackBytes+framing)
	if err != nil {
		return BaseFetch{}, err
	}
	reply, ok := ParsePackets(res.body)
	if !ok {
		return BaseFetch{}, gerr(CodeInvalidResponse, "bad pkt-line")
	}
	var pack bytes.Buffer
	section := ""
	inSection := false
	for _, p := range reply {
		if p.Kind != PacketData {
			if p.Kind == PacketFlush {
				break
			}
			inSection = false
			continue
		}
		if !inSection {
			name := text(p.Data)
			if strings.HasPrefix(name, "ERR ") {
				msg := CutMessage(name[4:], 300)
				if notOurRef.MatchString(msg) {
					return BaseFetch{}, gerr(CodeBaseNotFound, msg)
				}
				return BaseFetch{}, gerr(CodeInvalidResponse, msg)
			}
			switch name {
			case "shallow-info", "wanted-refs", "packfile", "acknowledgments", "packfile-uris":
			default:
				return BaseFetch{}, gerr(CodeInvalidResponse, "unknown section")
			}
			section, inSection = name, true
			continue
		}
		switch section {
		case "packfile":
			if len(p.Data) == 0 {
				return BaseFetch{}, gerr(CodeInvalidResponse, "bad side band")
			}
			switch p.Data[0] {
			case 1:
				if int64(pack.Len()+len(p.Data)-1) > lim.MaxPackBytes {
					return BaseFetch{}, gerr(CodeTooLarge, "")
				}
				pack.Write(p.Data[1:])
			case 2:
			case 3:
				return BaseFetch{}, gerr(CodeInvalidResponse, CutMessage(text(p.Data[1:]), 300))
			default:
				return BaseFetch{}, gerr(CodeInvalidResponse, "bad side band")
			}
		case "packfile-uris":
			return BaseFetch{}, gerr(CodeInvalidResponse, "packfile URIs are not accepted")
		}
	}
	if pack.Len() == 0 {
		return BaseFetch{}, gerr(CodeInvalidResponse, "no packfile")
	}
	objs, err := ReadPack(pack.Bytes(), lim)
	if err != nil {
		var pe *PackError
		if errors.As(err, &pe) && pe.Reason == "too_large" {
			return BaseFetch{}, gerr(CodeTooLarge, pe.Detail)
		}
		return BaseFetch{}, gerr(CodeInvalidResponse, err.Error())
	}
	c, ok := objs[sha]
	if !ok || c.Type != "commit" {
		return BaseFetch{}, gerr(CodeBaseNotFound, "the pack lacks the commit")
	}
	tree, parents, ok := ParseCommit(c.Data)
	if !ok {
		return BaseFetch{}, gerr(CodeInvalidResponse, "unreadable commit")
	}
	return BaseFetch{Tree: tree, Parents: parents, Objects: objs}, nil
}

var refNameRe = regexp.MustCompile(`^refs/[\x21-\x7E]+$`)

// LsRefs lists the refs under prefix (protocol v2 `ls-refs`, `ref-prefix`): ref name → id.
// Peeled and symref attributes are ignored.
func LsRefs(ctx context.Context, ep Endpoint, prefix string) (map[string]string, error) {
	if !strings.HasPrefix(prefix, "refs/") || strings.ContainsAny(prefix, " \n\x00") {
		return nil, gerr(CodeInvalidResponse, "bad ref prefix")
	}
	lines, err := v2Caps(ctx, ep)
	if err != nil {
		return nil, err
	}
	if _, ok := capPrefix(lines, "ls-refs"); !ok {
		return nil, gerr(CodeUnsupported, "no ls-refs")
	}
	of, _ := capPrefix(lines, "object-format=")
	if of != "" && of != "object-format=sha1" {
		return nil, gerr(CodeUnsupported, "not sha1")
	}
	var body bytes.Buffer
	body.Write(commandHead("ls-refs", lines, of))
	body.Write(pkts("ref-prefix " + prefix + "\n"))
	body.WriteString("0000")
	res, err := ep.request(ctx, http.MethodPost, "/git-upload-pack", map[string]string{
		"Content-Type": "application/x-git-upload-pack-request", "Accept": "application/x-git-upload-pack-result", "Git-Protocol": "version=2",
	}, body.Bytes(), 4<<20)
	if err != nil {
		return nil, err
	}
	reply, ok := ParsePackets(res.body)
	if !ok {
		return nil, gerr(CodeInvalidResponse, "bad pkt-line")
	}
	out := map[string]string{}
	ended := false
	for _, p := range reply {
		if p.Kind == PacketFlush {
			ended = true
			break
		}
		if p.Kind != PacketData {
			return nil, gerr(CodeInvalidResponse, "bad ls-refs reply")
		}
		line := text(p.Data)
		if strings.HasPrefix(line, "ERR ") {
			return nil, gerr(CodeInvalidResponse, CutMessage(line[4:], 300))
		}
		f := strings.Split(line, " ")
		if len(f) < 2 || !hexID.MatchString(f[0]) || !refNameRe.MatchString(f[1]) {
			return nil, gerr(CodeInvalidResponse, "bad ref line")
		}
		if strings.HasPrefix(f[1], prefix) {
			out[f[1]] = f[0]
		}
	}
	if !ended {
		return nil, gerr(CodeInvalidResponse, "unterminated ls-refs reply")
	}
	return out, nil
}

// ---------------------------------------------------------------- receive-pack (protocol v0)

// Refs is the receive-pack advertisement: refs and capabilities.
type Refs struct {
	Refs         map[string]string
	Capabilities []string
}

var refLineRe = regexp.MustCompile(`^([0-9a-f]{40}) (\S+)$`)

// ReceivePackRefs reads the receive-pack advertisement. 401/403 mean this credential can't push.
func ReceivePackRefs(ctx context.Context, ep Endpoint) (Refs, error) {
	adv, err := ep.request(ctx, http.MethodGet, "/info/refs?service=git-receive-pack", map[string]string{"Accept": "*/*"}, nil, 4<<20)
	if err != nil {
		return Refs{}, err
	}
	p, ok := ParsePackets(adv.body)
	var lines []Packet
	if ok {
		lines, ok = afterServiceLine(p, "git-receive-pack")
	}
	if !ok {
		return Refs{}, gerr(CodeInvalidResponse, "bad advertisement")
	}
	out := Refs{Refs: map[string]string{}}
	for n, pk := range lines {
		if pk.Kind == PacketFlush {
			break
		}
		if pk.Kind != PacketData {
			return Refs{}, gerr(CodeInvalidResponse, "bad advertisement")
		}
		line := text(pk.Data)
		refPart := line
		if n == 0 {
			if i := strings.IndexByte(line, 0); i >= 0 {
				refPart = line[:i]
				out.Capabilities = strings.Fields(line[i+1:])
			}
		}
		m := refLineRe.FindStringSubmatch(refPart)
		if m == nil {
			return Refs{}, gerr(CodeInvalidResponse, "bad ref line")
		}
		if m[2] != "capabilities^{}" {
			out.Refs[m[2]] = m[1]
		}
	}
	return out, nil
}

// PushStatus is a create-only push's outcome.
type PushStatus string

// Push outcomes.
const (
	// PushCreated: the ref was created at the new id.
	PushCreated PushStatus = "created"
	// PushBranchExists: the ref exists (seen in the advertisement, or refused as such): never overwritten.
	PushBranchExists PushStatus = "branch_exists"
	// PushRuleViolation: a hook or rule refused it; Message is the server's text, cut.
	PushRuleViolation PushStatus = "rule_violation"
	// PushFailed: Code says why.
	PushFailed PushStatus = "failed"
	// PushUnknown: no report came back, or git's ambiguous "failed to update ref": read the ref back.
	PushUnknown PushStatus = "unknown"
)

// PushOutcome is PushCreateRef's answer.
type PushOutcome struct {
	Status  PushStatus
	Code    string // with failed: invalid_request, unsupported, push_refused or an Error code
	Message string // a server message, cut (rule_violation, failed)
}

var (
	branchRefRe  = regexp.MustCompile(`^refs/heads/[\x21-\x7E]+$`)
	ruleRe       = regexp.MustCompile(`(?i)hook|rule|protect|denied|declined|violat`)
	existsRe     = regexp.MustCompile(`(?i)already exists|failed to lock|stale info|reference already|cannot lock`)
	updateFailRe = regexp.MustCompile(`(?i)failed to update ref`)
)

func has(xs []string, x string) bool {
	for _, v := range xs {
		if v == x {
			return true
		}
	}
	return false
}

// PushCreateRef pushes pack with the single command `<zero> <newSHA> <ref>`: git refuses it when
// ref exists. refs is the advertisement just read (ref must be absent from it).
func PushCreateRef(ctx context.Context, ep Endpoint, ref, newSHA string, pack []byte, refs Refs) PushOutcome {
	if !branchRefRe.MatchString(ref) || !hexID.MatchString(newSHA) {
		return PushOutcome{Status: PushFailed, Code: "invalid_request"}
	}
	if _, ok := refs.Refs[ref]; ok {
		return PushOutcome{Status: PushBranchExists}
	}
	caps := refs.Capabilities
	if !has(caps, "report-status") {
		return PushOutcome{Status: PushFailed, Code: CodeUnsupported}
	}
	sideband := has(caps, "side-band-64k")
	wanted := " report-status"
	if sideband {
		wanted += " side-band-64k"
	}
	if _, ok := capPrefix(caps, "object-format="); ok {
		wanted += " object-format=sha1"
	}
	wanted += " agent=" + agentName
	var body bytes.Buffer
	body.Write(pkts(ZeroID + " " + newSHA + " " + ref + "\x00" + wanted + "\n"))
	body.WriteString("0000")
	body.Write(pack)
	res, err := ep.request(ctx, http.MethodPost, "/git-receive-pack", map[string]string{
		"Content-Type": "application/x-git-receive-pack-request", "Accept": "application/x-git-receive-pack-result",
	}, body.Bytes(), 1<<20)
	if err != nil {
		code := ErrorCode(err)
		if code == CodeUnavailable {
			return PushOutcome{Status: PushUnknown}
		}
		return PushOutcome{Status: PushFailed, Code: code}
	}
	outer, ok := ParsePackets(res.body)
	if !ok {
		return PushOutcome{Status: PushUnknown}
	}
	var reportBytes []byte
	var remote []string
	if sideband {
		for _, p := range outer {
			if p.Kind == PacketFlush {
				break
			}
			if p.Kind != PacketData || len(p.Data) == 0 {
				continue
			}
			switch p.Data[0] {
			case 1:
				reportBytes = append(reportBytes, p.Data[1:]...)
			case 2, 3:
				remote = append(remote, text(p.Data[1:]))
			}
		}
	} else {
		reportBytes = res.body
	}
	report, ok := ParsePackets(reportBytes)
	if !ok {
		return PushOutcome{Status: PushUnknown}
	}
	lines := dataLines(report)
	remoteText := CutMessage(strings.Join(remote, " "), 300)
	unpack := ""
	for _, l := range lines {
		if strings.HasPrefix(l, "unpack ") {
			unpack = l
			break
		}
	}
	if unpack == "" {
		if len(remote) > 0 && ruleRe.MatchString(remoteText) {
			return PushOutcome{Status: PushRuleViolation, Message: remoteText}
		}
		return PushOutcome{Status: PushUnknown}
	}
	refLine := ""
	for _, l := range lines {
		if strings.HasPrefix(l, "ok "+ref) || strings.HasPrefix(l, "ng "+ref) {
			refLine = l
			break
		}
	}
	if refLine == "ok "+ref && unpack == "unpack ok" {
		return PushOutcome{Status: PushCreated}
	}
	reason := strings.TrimPrefix(unpack, "unpack ")
	if strings.HasPrefix(refLine, "ng ") {
		reason = strings.TrimPrefix(refLine, "ng "+ref+" ")
	}
	switch {
	case existsRe.MatchString(reason):
		return PushOutcome{Status: PushBranchExists}
	case updateFailRe.MatchString(reason) && unpack == "unpack ok":
		return PushOutcome{Status: PushUnknown}
	case ruleRe.MatchString(reason + " " + remoteText):
		msg := reason
		if remoteText != "" {
			msg += ": " + remoteText
		}
		return PushOutcome{Status: PushRuleViolation, Message: CutMessage(msg, 300)}
	}
	return PushOutcome{Status: PushFailed, Code: "push_refused", Message: CutMessage(reason, 300)}
}
