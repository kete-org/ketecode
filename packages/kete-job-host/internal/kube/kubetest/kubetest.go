// Package kubetest is an in-memory Kubernetes API server for the runner's tests: the routes
// internal/kube calls (pods, secrets, events, leases, a node, /version), resourceVersions with
// conflicts on stale writes, label-selector lists, a scheduler that binds every new pod to one
// node, owner-reference garbage collection of Secrets, and the caller identity of every write
// (bearer token = username), so tests can play the admission policy's creator rule. Tests only.
package kubetest

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/kete-org/ketecode/packages/kete-job-host/internal/kube"
)

// Node and BootID are the fake cluster's only node.
const (
	Node   = "kind-worker"
	BootID = "26ab45b9-0000-4000-8000-000000000001"
)

type key struct{ res, ns, name string }

// Server is the fake API server.
type Server struct {
	*httptest.Server
	mu      sync.Mutex
	objs    map[key]map[string]any
	rv      int
	uid     int
	Version string
	// Unschedulable leaves new pods without a node.
	Unschedulable bool
	// Fail makes every request answer 503 while set.
	Fail bool
	// Writes records "<user> <method> <resource>/<name>" for every write.
	Writes []string
}

// New starts the server.
func New() *Server {
	s := &Server{objs: map[key]map[string]any{}, Version: "v1.31.2"}
	s.Server = httptest.NewTLSServer(http.HandlerFunc(s.serve))
	return s
}

// Client returns a kube client for user (the bearer token).
func (s *Server) Client(user string) *kube.Client {
	return kube.New(s.URL, s.Server.Client(), func() (string, error) { return user, nil })
}

func (s *Server) nextRV() string { s.rv++; return strconv.Itoa(s.rv) }

func meta(o map[string]any) map[string]any {
	m, _ := o["metadata"].(map[string]any)
	if m == nil {
		m = map[string]any{}
		o["metadata"] = m
	}
	return m
}

func (s *Server) serve(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.Fail {
		status(w, 503, "ServiceUnavailable")
		return
	}
	user := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	p := r.URL.Path
	switch {
	case p == "/version":
		_ = json.NewEncoder(w).Encode(map[string]string{"gitVersion": s.Version})
		return
	case strings.HasPrefix(p, "/api/v1/nodes/"):
		if strings.TrimPrefix(p, "/api/v1/nodes/") != Node {
			status(w, 404, "NotFound")
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"metadata": map[string]any{"name": Node}, "status": map[string]any{"nodeInfo": map[string]any{"bootID": BootID}}})
		return
	}
	p = strings.TrimPrefix(strings.TrimPrefix(p, "/api/v1"), "/apis/coordination.k8s.io/v1")
	parts := strings.Split(strings.Trim(p, "/"), "/")
	if len(parts) < 3 || parts[0] != "namespaces" {
		status(w, 404, "NotFound")
		return
	}
	ns, res, name := parts[1], parts[2], ""
	if len(parts) > 3 {
		name = parts[3]
	}
	var body map[string]any
	if r.Method == http.MethodPost || r.Method == http.MethodPut {
		b, _ := io.ReadAll(r.Body)
		if json.Unmarshal(b, &body) != nil {
			status(w, 400, "BadRequest")
			return
		}
	}
	k := key{res, ns, name}
	switch r.Method {
	case http.MethodGet:
		if name == "" {
			s.list(w, res, ns, r.URL.Query().Get("labelSelector"))
			return
		}
		o, ok := s.objs[k]
		if !ok {
			status(w, 404, "NotFound")
			return
		}
		_ = json.NewEncoder(w).Encode(o)
	case http.MethodPost:
		m := meta(body)
		name, _ = m["name"].(string)
		if name == "" {
			if g, _ := m["generateName"].(string); g != "" {
				s.uid++
				name = g + strconv.Itoa(s.uid)
				m["name"] = name
			}
		}
		k.name = name
		if _, ok := s.objs[k]; ok {
			status(w, 409, "AlreadyExists")
			return
		}
		s.uid++
		m["uid"] = fmt.Sprintf("uid-%d", s.uid)
		m["namespace"] = ns
		m["resourceVersion"] = s.nextRV()
		m["creationTimestamp"] = time.Now().UTC().Format(time.RFC3339)
		if res == "pods" {
			spec, _ := body["spec"].(map[string]any)
			if !s.Unschedulable && spec != nil {
				spec["nodeName"] = Node
			}
			body["status"] = map[string]any{"phase": "Pending"}
		}
		s.objs[k] = body
		s.Writes = append(s.Writes, fmt.Sprintf("%s POST %s/%s", user, res, name))
		_ = json.NewEncoder(w).Encode(body)
	case http.MethodPut:
		cur, ok := s.objs[k]
		if !ok {
			status(w, 404, "NotFound")
			return
		}
		m := meta(body)
		if rv, _ := m["resourceVersion"].(string); rv != "" && rv != meta(cur)["resourceVersion"] {
			status(w, 409, "Conflict")
			return
		}
		for _, f := range []string{"uid", "creationTimestamp", "namespace"} {
			m[f] = meta(cur)[f]
		}
		m["resourceVersion"] = s.nextRV()
		s.objs[k] = body
		s.Writes = append(s.Writes, fmt.Sprintf("%s PUT %s/%s", user, res, name))
		_ = json.NewEncoder(w).Encode(body)
	case http.MethodDelete:
		o, ok := s.objs[k]
		if !ok {
			status(w, 404, "NotFound")
			return
		}
		s.Writes = append(s.Writes, fmt.Sprintf("%s DELETE %s/%s", user, res, name))
		delete(s.objs, k)
		if res == "pods" {
			uid := meta(o)["uid"]
			for kk, oo := range s.objs {
				refs, _ := meta(oo)["ownerReferences"].([]any)
				for _, ref := range refs {
					if rm, _ := ref.(map[string]any); rm != nil && rm["uid"] == uid {
						delete(s.objs, kk)
					}
				}
			}
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"kind": "Status", "status": "Success"})
	default:
		status(w, 405, "MethodNotAllowed")
	}
}

func (s *Server) list(w http.ResponseWriter, res, ns, selector string) {
	want := map[string]string{}
	for _, kv := range strings.Split(selector, ",") {
		if a, b, ok := strings.Cut(kv, "="); ok {
			want[a] = b
		}
	}
	items := []map[string]any{}
	var names []key
	for k := range s.objs {
		if k.res == res && k.ns == ns {
			names = append(names, k)
		}
	}
	sort.Slice(names, func(i, j int) bool { return names[i].name < names[j].name })
	for _, k := range names {
		o := s.objs[k]
		labels, _ := meta(o)["labels"].(map[string]any)
		ok := true
		for a, b := range want {
			if labels[a] != b {
				ok = false
			}
		}
		if ok {
			items = append(items, o)
		}
	}
	_ = json.NewEncoder(w).Encode(map[string]any{"items": items})
}

func status(w http.ResponseWriter, code int, reason string) {
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(map[string]any{"kind": "Status", "reason": reason, "message": reason, "code": code})
}

// --- test controls

// Get returns a copy of an object (nil if missing).
func (s *Server) Get(res, ns, name string) map[string]any {
	s.mu.Lock()
	defer s.mu.Unlock()
	o, ok := s.objs[key{res, ns, name}]
	if !ok {
		return nil
	}
	b, _ := json.Marshal(o)
	var c map[string]any
	_ = json.Unmarshal(b, &c)
	return c
}

// Names lists the names of a resource in a namespace.
func (s *Server) Names(res, ns string) []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	var out []string
	for k := range s.objs {
		if k.res == res && k.ns == ns {
			out = append(out, k.name)
		}
	}
	sort.Strings(out)
	return out
}

// Put stores an object as given (an operator's or another component's write).
func (s *Server) Put(res, ns string, o map[string]any) {
	s.mu.Lock()
	defer s.mu.Unlock()
	m := meta(o)
	m["namespace"] = ns
	m["resourceVersion"] = s.nextRV()
	if m["uid"] == nil {
		s.uid++
		m["uid"] = fmt.Sprintf("uid-%d", s.uid)
	}
	if m["creationTimestamp"] == nil {
		m["creationTimestamp"] = time.Now().UTC().Format(time.RFC3339)
	}
	s.objs[key{res, ns, m["name"].(string)}] = o
}

// SetPodPhase sets a pod's status.phase (and reason).
func (s *Server) SetPodPhase(ns, name, phase, reason string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	o, ok := s.objs[key{"pods", ns, name}]
	if !ok {
		return false
	}
	o["status"] = map[string]any{"phase": phase, "reason": reason}
	meta(o)["resourceVersion"] = s.nextRV()
	return true
}

// Set toggles Fail or Unschedulable under the lock.
func (s *Server) Set(f func(*Server)) {
	s.mu.Lock()
	defer s.mu.Unlock()
	f(s)
}

// WritesBy returns the writes made by user.
func (s *Server) WritesBy(user string) []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	var out []string
	for _, w := range s.Writes {
		if strings.HasPrefix(w, user+" ") {
			out = append(out, w)
		}
	}
	return out
}
