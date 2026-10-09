// Command kete-fake-gitlab serves internal/fakegitlab over TLS for the runner's kind e2e
// (packages/kete-runner-chart/ci/e2e-publish.sh). TESTS ONLY: an unauthenticated admin API and a
// throwaway CA minted at start. It needs git (git http-backend).
//
//	-host    the public host name (the leaf certificate, clone and merge request URLs)
//	-root    where the bare repositories live
//	-listen  the API and git over TLS (default :443)
//	-admin   plain-HTTP admin API (default :8080):
//	           GET  /ca.pem                                     the CA to trust
//	           POST /projects {path, files?, from?}             create a project (files on main, or a mirror of a directory)
//	           POST /writer   {user, token}                     the writer bot's token (API, read, push)
//	           POST /minter   {token}                           the Maintainer token that mints project access tokens
//	           POST /deploy   {user, token}                     a read-only deploy token
//	           POST /protect  {project, branch, protected, can_push}
//	           POST /branch   {project, branch, from}           create a branch
//	           POST /reject   {project, on}                     a pre-receive hook refusing every push
//	           GET  /state                                      projects, tokens, merge requests, branches, commits, requests
//	           GET  /file?project=&ref=&path=                   a file's content at a ref
package main

import (
	"crypto/tls"
	"encoding/json"
	"encoding/pem"
	"flag"
	"io"
	"log"
	"net/http"
	"time"

	"github.com/kete-org/ketecode/packages/kete-job-host/internal/fakegitlab"
	"github.com/kete-org/ketecode/packages/kete-job-host/internal/fakeplatform"
)

func main() {
	host := flag.String("host", "", "public host name")
	root := flag.String("root", "/tmp/fake-gitlab", "repository root")
	listen := flag.String("listen", ":443", "TLS listen address")
	admin := flag.String("admin", ":8080", "admin listen address")
	flag.Parse()
	if *host == "" {
		log.Fatal("-host is required")
	}
	s, err := fakegitlab.New(*host, *root)
	if err != nil {
		log.Fatal(err)
	}
	cert, ca, err := fakeplatform.NewCert(*host, 7*24*time.Hour)
	if err != nil {
		log.Fatal(err)
	}
	caPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: ca.Raw})
	srv := &http.Server{Addr: *listen, Handler: logged(s), TLSConfig: &tls.Config{Certificates: []tls.Certificate{cert}, MinVersion: tls.VersionTLS12}, ReadHeaderTimeout: 10 * time.Second}
	go func() { log.Fatal(srv.ListenAndServeTLS("", "")) }()
	log.Fatal((&http.Server{Addr: *admin, Handler: adminAPI(s, caPEM), ReadHeaderTimeout: 10 * time.Second}).ListenAndServe())
}

func logged(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		log.Printf("gitlab %s %s", r.Method, r.URL.Path)
		h.ServeHTTP(w, r)
	})
}

func adminAPI(s *fakegitlab.Server, caPEM []byte) http.Handler {
	mux := http.NewServeMux()
	body := func(r *http.Request, v any) bool {
		return json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(v) == nil
	}
	reply := func(w http.ResponseWriter, v any, err error) {
		w.Header().Set("Content-Type", "application/json")
		if err != nil {
			w.WriteHeader(http.StatusBadRequest)
			_ = json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
			return
		}
		_ = json.NewEncoder(w).Encode(v)
	}
	ok := map[string]bool{"ok": true}
	mux.HandleFunc("GET /ca.pem", func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write(caPEM) })
	mux.HandleFunc("POST /projects", func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			Path  string            `json:"path"`
			Files map[string]string `json:"files"`
			From  string            `json:"from"`
		}
		if !body(r, &in) {
			http.Error(w, "bad body", 400)
			return
		}
		p, err := s.AddProject(in.Path, in.Files, in.From)
		reply(w, p, err)
	})
	mux.HandleFunc("POST /writer", func(w http.ResponseWriter, r *http.Request) {
		var in struct{ User, Token string }
		if !body(r, &in) {
			http.Error(w, "bad body", 400)
			return
		}
		s.SetWriter(in.User, in.Token)
		reply(w, ok, nil)
	})
	mux.HandleFunc("POST /minter", func(w http.ResponseWriter, r *http.Request) {
		var in struct{ Token string }
		if !body(r, &in) {
			http.Error(w, "bad body", 400)
			return
		}
		s.SetMinter(in.Token)
		reply(w, ok, nil)
	})
	mux.HandleFunc("POST /deploy", func(w http.ResponseWriter, r *http.Request) {
		var in struct{ User, Token string }
		if !body(r, &in) {
			http.Error(w, "bad body", 400)
			return
		}
		s.AddDeployToken(in.User, in.Token)
		reply(w, ok, nil)
	})
	mux.HandleFunc("POST /protect", func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			Project, Branch string
			Protected       bool `json:"protected"`
			CanPush         bool `json:"can_push"`
		}
		if !body(r, &in) {
			http.Error(w, "bad body", 400)
			return
		}
		s.Protect(in.Project, in.Branch, in.Protected, in.CanPush)
		reply(w, ok, nil)
	})
	mux.HandleFunc("POST /branch", func(w http.ResponseWriter, r *http.Request) {
		var in struct{ Project, Branch, From string }
		if !body(r, &in) {
			http.Error(w, "bad body", 400)
			return
		}
		reply(w, ok, s.CreateBranch(in.Project, in.Branch, in.From))
	})
	mux.HandleFunc("POST /reject", func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			Project string
			On      bool `json:"on"`
		}
		if !body(r, &in) {
			http.Error(w, "bad body", 400)
			return
		}
		reply(w, ok, s.RejectPushes(in.Project, in.On))
	})
	mux.HandleFunc("GET /state", func(w http.ResponseWriter, _ *http.Request) { reply(w, s.State(), nil) })
	mux.HandleFunc("GET /file", func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		v, err := s.File(q.Get("project"), q.Get("ref"), q.Get("path"))
		reply(w, map[string]string{"content": v}, err)
	})
	return mux
}
