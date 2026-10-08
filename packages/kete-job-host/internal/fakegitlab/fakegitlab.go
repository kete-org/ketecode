// Package fakegitlab is a fake GitLab self-managed instance for the runner's tests and kind e2e
// (enterprise runtime P3). TESTS ONLY. It serves the REST API v4 calls the runner makes (project,
// branches with protection and can_push, merge_base, merge requests, project access tokens) and
// git smart HTTP through the real `git http-backend` over bare repositories, with GitLab's token
// rules: the writer (a bot's personal access token) reads, pushes and calls the API; the minter
// (a Maintainer token) manages project access tokens; a minted token or a deploy token only reads
// (upload-pack), and a revoked one is refused. It records what happened for assertions.
package fakegitlab

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/cgi"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Token is a minted project access token as the fake records it.
type Token struct {
	ID        int64     `json:"id"`
	Project   string    `json:"project"`
	Name      string    `json:"name"`
	Scopes    []string  `json:"scopes"`
	Level     int       `json:"access_level"`
	ExpiresAt string    `json:"expires_at"`
	Created   time.Time `json:"created"`
	Revoked   bool      `json:"revoked"`
	RevokedAt time.Time `json:"revoked_at,omitzero"`
	// Clones counts upload-pack requests made with it.
	Clones int    `json:"clones"`
	token  string // the secret
}

// MergeRequest is a created merge request.
type MergeRequest struct {
	IID         int64  `json:"iid"`
	Project     string `json:"project"`
	Source      string `json:"source_branch"`
	Target      string `json:"target_branch"`
	Title       string `json:"title"`
	Description string `json:"description"`
	WebURL      string `json:"web_url"`
}

// Project is one repository.
type Project struct {
	ID            int64  `json:"id"`
	Path          string `json:"path"`
	DefaultBranch string `json:"default_branch"`
	// Protected branches and whether the writer may push to them directly.
	Protected map[string]bool `json:"protected"`
	CanPush   map[string]bool `json:"can_push"`
	dir       string
}

// Server is the fake.
type Server struct {
	Host    string // the public host (web_url, clone URLs)
	root    string
	backend string

	mu         sync.Mutex
	projects   map[string]*Project
	writer     string
	writerUser string
	minter     string
	deploy     map[string]string // username → token
	tokens     []*Token
	mrs        []MergeRequest
	nextID     int64
	Requests   []string // "METHOD path status" (never a credential)
	receives   int
}

var gitPathRe = regexp.MustCompile(`^/(.+)\.git/(info/refs|git-upload-pack|git-receive-pack)$`)

// New returns a fake whose repositories live under root. It needs git (git http-backend).
func New(host, root string) (*Server, error) {
	out, err := exec.Command("git", "--exec-path").Output()
	if err != nil {
		return nil, fmt.Errorf("fakegitlab: git --exec-path: %w", err)
	}
	backend := filepath.Join(strings.TrimSpace(string(out)), "git-http-backend")
	if _, err := os.Stat(backend); err != nil {
		return nil, fmt.Errorf("fakegitlab: %w", err)
	}
	return &Server{Host: host, root: root, backend: backend, projects: map[string]*Project{}, deploy: map[string]string{}, nextID: 100}, nil
}

func git(dir string, args ...string) (string, error) {
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	cmd.Env = []string{"PATH=" + os.Getenv("PATH"), "HOME=" + dir, "GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL=/dev/null",
		"GIT_AUTHOR_NAME=fake", "GIT_AUTHOR_EMAIL=fake@gitlab.test", "GIT_COMMITTER_NAME=fake", "GIT_COMMITTER_EMAIL=fake@gitlab.test"}
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil {
		return "", fmt.Errorf("git %v: %v: %s", args, err, stderr.String())
	}
	return strings.TrimSpace(string(out)), nil
}

// AddProject creates a project at path (group/…/name): a bare repository holding files on its
// default branch main (protected, the writer can't push), or a mirror of an existing repository
// (from, a directory) when from isn't empty. The server allows filtered fetches (as Gitaly does).
func (s *Server) AddProject(path string, files map[string]string, from string) (*Project, error) {
	dir := filepath.Join(s.root, path+".git")
	if err := os.MkdirAll(filepath.Dir(dir), 0o755); err != nil {
		return nil, err
	}
	if from != "" {
		if _, err := git(s.root, "clone", "-q", "--bare", from, dir); err != nil {
			return nil, err
		}
	} else {
		work, err := os.MkdirTemp(s.root, "work-")
		if err != nil {
			return nil, err
		}
		defer os.RemoveAll(work)
		if _, err := git(work, "init", "-q", "-b", "main"); err != nil {
			return nil, err
		}
		names := make([]string, 0, len(files))
		for n := range files {
			names = append(names, n)
		}
		sort.Strings(names)
		for _, n := range names {
			p := filepath.Join(work, filepath.FromSlash(n))
			if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
				return nil, err
			}
			if err := os.WriteFile(p, []byte(files[n]), 0o644); err != nil {
				return nil, err
			}
		}
		if _, err := git(work, "add", "-A"); err != nil {
			return nil, err
		}
		if _, err := git(work, "commit", "-q", "-m", "base"); err != nil {
			return nil, err
		}
		if _, err := git(s.root, "clone", "-q", "--bare", work, dir); err != nil {
			return nil, err
		}
	}
	for _, kv := range [][2]string{{"uploadpack.allowFilter", "true"}, {"http.receivepack", "true"}, {"receive.denyNonFastForwards", "true"}} {
		if _, err := git(dir, "config", kv[0], kv[1]); err != nil {
			return nil, err
		}
	}
	head, err := git(dir, "symbolic-ref", "--short", "HEAD")
	if err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.nextID++
	p := &Project{ID: s.nextID, Path: path, DefaultBranch: head, Protected: map[string]bool{head: true}, CanPush: map[string]bool{head: false}, dir: dir}
	s.projects[path] = p
	return p, nil
}

// SetWriter, SetMinter and AddDeployToken register credentials.
func (s *Server) SetWriter(user, token string) {
	s.mu.Lock()
	s.writerUser, s.writer = user, token
	s.mu.Unlock()
}

// SetMinter registers the Maintainer token that manages project access tokens.
func (s *Server) SetMinter(token string) { s.mu.Lock(); s.minter = token; s.mu.Unlock() }

// AddDeployToken registers a read-only deploy token.
func (s *Server) AddDeployToken(user, token string) {
	s.mu.Lock()
	s.deploy[user] = token
	s.mu.Unlock()
}

// Protect sets a branch's protection and whether the writer may push to it directly.
func (s *Server) Protect(project, branch string, protected, canPush bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if p := s.projects[project]; p != nil {
		p.Protected[branch], p.CanPush[branch] = protected, canPush
	}
}

// CreateBranch creates branch at another branch's head (a pre-existing job branch, for tests).
func (s *Server) CreateBranch(project, branch, from string) error {
	s.mu.Lock()
	p := s.projects[project]
	s.mu.Unlock()
	if p == nil {
		return errors.New("no such project")
	}
	_, err := git(p.dir, "branch", branch, from)
	return err
}

// RejectPushes installs a pre-receive hook that refuses every push (a server-side rule).
func (s *Server) RejectPushes(project string, on bool) error {
	s.mu.Lock()
	p := s.projects[project]
	s.mu.Unlock()
	if p == nil {
		return errors.New("no such project")
	}
	hook := filepath.Join(p.dir, "hooks", "pre-receive")
	if !on {
		return os.RemoveAll(hook)
	}
	return os.WriteFile(hook, []byte("#!/bin/sh\necho 'GitLab: push rule violation: denied by the fake' >&2\nexit 1\n"), 0o755)
}

// Snapshot is the fake's record (the admin API's /state).
type Snapshot struct {
	Projects      map[string]Project  `json:"projects"`
	Tokens        []Token             `json:"tokens"`
	MergeRequests []MergeRequest      `json:"merge_requests"`
	Branches      map[string][]string `json:"branches"` // project → "name sha"
	Commits       map[string][]string `json:"commits"`  // project → `git log --all --format=%H %P %s` lines
	Receives      int                 `json:"receives"`
	Requests      []string            `json:"requests"`
}

// State returns the record.
func (s *Server) State() Snapshot {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := Snapshot{Projects: map[string]Project{}, Branches: map[string][]string{}, Commits: map[string][]string{}, Receives: s.receives, Requests: append([]string(nil), s.Requests...)}
	for k, p := range s.projects {
		out.Projects[k] = *p
		if refs, err := git(p.dir, "for-each-ref", "--format=%(refname:short) %(objectname)", "refs/heads"); err == nil && refs != "" {
			out.Branches[k] = strings.Split(refs, "\n")
		}
		if log, err := git(p.dir, "log", "--all", "--format=%H %P %s"); err == nil && log != "" {
			out.Commits[k] = strings.Split(log, "\n")
		}
	}
	for _, t := range s.tokens {
		out.Tokens = append(out.Tokens, *t)
	}
	out.MergeRequests = append(out.MergeRequests, s.mrs...)
	return out
}

// File reads a file at a ref of a project (assertions).
func (s *Server) File(project, ref, path string) (string, error) {
	s.mu.Lock()
	p := s.projects[project]
	s.mu.Unlock()
	if p == nil {
		return "", errors.New("no such project")
	}
	return git(p.dir, "show", ref+":"+path)
}

func randToken(prefix string) string {
	var b [20]byte
	_, _ = rand.Read(b[:])
	return prefix + hex.EncodeToString(b[:])
}

// ---------------------------------------------------------------- HTTP

type role int

const (
	roleNone role = iota
	roleWriter
	roleMinter
	roleRead // a minted or deploy token
)

// ServeHTTP serves the API and git.
func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	rec := &statusRecorder{ResponseWriter: w, status: 200}
	if strings.HasPrefix(r.URL.Path, "/api/v4/") {
		s.api(rec, r)
	} else {
		s.git(rec, r)
	}
	s.mu.Lock()
	s.Requests = append(s.Requests, fmt.Sprintf("%s %s %d", r.Method, r.URL.Path, rec.status))
	s.mu.Unlock()
}

type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (r *statusRecorder) WriteHeader(code int) { r.status = code; r.ResponseWriter.WriteHeader(code) }

// apiRole maps PRIVATE-TOKEN (a.mu held).
func (s *Server) apiRole(r *http.Request) role {
	t := r.Header.Get("PRIVATE-TOKEN")
	switch {
	case t == "":
		return roleNone
	case t == s.writer:
		return roleWriter
	case t == s.minter:
		return roleMinter
	}
	return roleNone
}

func reply(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if v != nil {
		_ = json.NewEncoder(w).Encode(v)
	}
}

func (s *Server) api(w http.ResponseWriter, r *http.Request) {
	rest := strings.TrimPrefix(r.URL.EscapedPath(), "/api/v4/projects/")
	if rest == r.URL.EscapedPath() {
		reply(w, 404, map[string]string{"message": "404 Not Found"})
		return
	}
	id, sub, _ := strings.Cut(rest, "/")
	pid, err := url.PathUnescape(id)
	if err != nil {
		reply(w, 404, nil)
		return
	}
	s.mu.Lock()
	rl := s.apiRole(r)
	p := s.projects[pid]
	if p == nil {
		for _, q := range s.projects {
			if strconv.FormatInt(q.ID, 10) == pid {
				p = q
			}
		}
	}
	s.mu.Unlock()
	if rl == roleNone {
		reply(w, 401, map[string]string{"message": "401 Unauthorized"})
		return
	}
	if p == nil {
		reply(w, 404, map[string]string{"message": "404 Project Not Found"})
		return
	}
	switch {
	case sub == "" && r.Method == http.MethodGet:
		reply(w, 200, map[string]any{"id": p.ID, "path_with_namespace": p.Path, "default_branch": p.DefaultBranch,
			"http_url_to_repo": "https://" + s.Host + "/" + p.Path + ".git"})
	case strings.HasPrefix(sub, "repository/branches/") && r.Method == http.MethodGet && rl == roleWriter:
		name, err := url.PathUnescape(strings.TrimPrefix(sub, "repository/branches/"))
		if err != nil {
			reply(w, 404, nil)
			return
		}
		sha, err := git(p.dir, "rev-parse", "--verify", "-q", "refs/heads/"+name)
		if err != nil || sha == "" {
			reply(w, 404, map[string]string{"message": "404 Branch Not Found"})
			return
		}
		s.mu.Lock()
		prot, can := p.Protected[name], p.CanPush[name]
		if !prot {
			can = true
		}
		s.mu.Unlock()
		reply(w, 200, map[string]any{"name": name, "protected": prot, "can_push": can, "developers_can_push": false, "commit": map[string]string{"id": sha}})
	case sub == "repository/merge_base" && r.Method == http.MethodGet && rl == roleWriter:
		refs := r.URL.Query()["refs[]"]
		if len(refs) != 2 {
			reply(w, 400, map[string]string{"message": "Provide exactly two refs"})
			return
		}
		mb, err := git(p.dir, "merge-base", refs[0], refs[1])
		if err != nil {
			reply(w, 404, map[string]string{"message": "Could not find merge base"})
			return
		}
		reply(w, 200, map[string]string{"id": mb})
	case sub == "merge_requests" && r.Method == http.MethodPost && rl == roleWriter:
		var in struct {
			Source      string `json:"source_branch"`
			Target      string `json:"target_branch"`
			Title       string `json:"title"`
			Description string `json:"description"`
		}
		if json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&in) != nil {
			reply(w, 400, nil)
			return
		}
		if _, err := git(p.dir, "rev-parse", "--verify", "-q", "refs/heads/"+in.Source); err != nil {
			reply(w, 422, map[string]any{"message": []string{"Source branch does not exist"}})
			return
		}
		s.mu.Lock()
		iid := int64(len(s.mrs) + 1)
		mr := MergeRequest{IID: iid, Project: p.Path, Source: in.Source, Target: in.Target, Title: in.Title, Description: in.Description,
			WebURL: "https://" + s.Host + "/" + p.Path + "/-/merge_requests/" + strconv.FormatInt(iid, 10)}
		s.mrs = append(s.mrs, mr)
		s.mu.Unlock()
		reply(w, 201, map[string]any{"iid": iid, "web_url": mr.WebURL, "draft": strings.HasPrefix(in.Title, "Draft:")})
	case sub == "merge_requests" && r.Method == http.MethodGet && rl == roleWriter:
		src := r.URL.Query().Get("source_branch")
		var out []map[string]any
		s.mu.Lock()
		for _, mr := range s.mrs {
			if mr.Project == p.Path && mr.Source == src {
				out = append(out, map[string]any{"iid": mr.IID, "web_url": mr.WebURL})
			}
		}
		s.mu.Unlock()
		reply(w, 200, out)
	case sub == "access_tokens" && r.Method == http.MethodPost && rl == roleMinter:
		var in struct {
			Name      string   `json:"name"`
			Scopes    []string `json:"scopes"`
			Level     int      `json:"access_level"`
			ExpiresAt string   `json:"expires_at"`
		}
		if json.NewDecoder(io.LimitReader(r.Body, 1<<16)).Decode(&in) != nil || in.Name == "" || len(in.Scopes) == 0 {
			reply(w, 400, nil)
			return
		}
		if exp, err := time.Parse("2006-01-02", in.ExpiresAt); err != nil || !exp.After(time.Now().UTC().Add(-24*time.Hour)) {
			reply(w, 400, map[string]string{"message": "expires_at must be in the future"})
			return
		}
		s.mu.Lock()
		s.nextID++
		t := &Token{ID: s.nextID, Project: p.Path, Name: in.Name, Scopes: in.Scopes, Level: in.Level, ExpiresAt: in.ExpiresAt, Created: time.Now(), token: randToken("glpat-")}
		s.tokens = append(s.tokens, t)
		s.mu.Unlock()
		reply(w, 201, map[string]any{"id": t.ID, "name": t.Name, "token": t.token, "active": true, "revoked": false, "scopes": t.Scopes})
	case sub == "access_tokens" && r.Method == http.MethodGet && rl == roleMinter:
		var out []map[string]any
		s.mu.Lock()
		for _, t := range s.tokens {
			if t.Project == p.Path && !t.Revoked {
				out = append(out, map[string]any{"id": t.ID, "name": t.Name, "active": true, "revoked": false})
			}
		}
		s.mu.Unlock()
		reply(w, 200, out)
	case strings.HasPrefix(sub, "access_tokens/") && r.Method == http.MethodDelete && rl == roleMinter:
		id, _ := strconv.ParseInt(strings.TrimPrefix(sub, "access_tokens/"), 10, 64)
		s.mu.Lock()
		defer s.mu.Unlock()
		for _, t := range s.tokens {
			if t.ID == id && t.Project == p.Path && !t.Revoked {
				t.Revoked, t.RevokedAt = true, time.Now()
				w.WriteHeader(204)
				return
			}
		}
		reply(w, 404, nil)
	default:
		reply(w, 403, map[string]string{"message": "403 Forbidden"})
	}
}

// gitRole maps basic auth for git (a.mu held): the writer, a minted token or a deploy token.
func (s *Server) gitRole(r *http.Request, project string) (role, *Token) {
	user, pass, ok := r.BasicAuth()
	if !ok || pass == "" {
		return roleNone, nil
	}
	switch {
	case pass == s.writer && s.writer != "":
		return roleWriter, nil
	case s.deploy[user] == pass:
		return roleRead, nil
	}
	for _, t := range s.tokens {
		if t.token == pass && !t.Revoked && t.Project == project && user != "" {
			return roleRead, t
		}
	}
	return roleNone, nil
}

func (s *Server) git(w http.ResponseWriter, r *http.Request) {
	m := gitPathRe.FindStringSubmatch(r.URL.Path)
	if m == nil {
		http.NotFound(w, r)
		return
	}
	s.mu.Lock()
	p := s.projects[m[1]]
	rl, tok := s.gitRole(r, m[1])
	s.mu.Unlock()
	if rl == roleNone {
		w.Header().Set("WWW-Authenticate", `Basic realm="GitLab"`)
		w.WriteHeader(401)
		return
	}
	if p == nil {
		http.NotFound(w, r)
		return
	}
	receive := m[2] == "git-receive-pack" || r.URL.Query().Get("service") == "git-receive-pack"
	if receive && rl != roleWriter {
		w.WriteHeader(403)
		return
	}
	s.mu.Lock()
	if tok != nil && m[2] == "git-upload-pack" {
		tok.Clones++
	}
	if m[2] == "git-receive-pack" {
		s.receives++
	}
	s.mu.Unlock()
	r.Header.Del("Authorization")
	h := &cgi.Handler{
		Path: s.backend,
		Env: []string{"GIT_PROJECT_ROOT=" + s.root, "GIT_HTTP_EXPORT_ALL=1", "GIT_CONFIG_NOSYSTEM=1", "HOME=" + s.root,
			"REMOTE_USER=fake"},
	}
	h.ServeHTTP(w, r)
}

// CommitFile commits one file onto a branch of a project directly (a branch moving on, for tests)
// and returns the new commit.
func (s *Server) CommitFile(project, branch, path, content string) (string, error) {
	s.mu.Lock()
	p := s.projects[project]
	s.mu.Unlock()
	if p == nil {
		return "", errors.New("no such project")
	}
	work, err := os.MkdirTemp(s.root, "work-")
	if err != nil {
		return "", err
	}
	defer os.RemoveAll(work)
	if _, err := git(work, "clone", "-q", "-b", branch, p.dir, "w"); err != nil {
		return "", err
	}
	w := filepath.Join(work, "w")
	if err := os.WriteFile(filepath.Join(w, filepath.FromSlash(path)), []byte(content), 0o644); err != nil {
		return "", err
	}
	if _, err := git(w, "add", "-A"); err != nil {
		return "", err
	}
	if _, err := git(w, "commit", "-q", "-m", "moved on"); err != nil {
		return "", err
	}
	if _, err := git(w, "push", "-q", "origin", "HEAD:refs/heads/"+branch); err != nil {
		return "", err
	}
	return git(w, "rev-parse", "HEAD")
}
