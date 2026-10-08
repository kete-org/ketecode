// Command kete-fake-platform serves internal/fakeplatform (job-host-v2) over TLS for the
// Kubernetes runner's kind e2e (.github/workflows/kete-runner.yml,
// packages/kete-runner-chart/ci/e2e.sh). TESTS ONLY: it has an unauthenticated admin API and
// mints a throwaway CA at start. Never deploy it anywhere but a disposable test cluster.
//
//	-authority  the platform host name the leaf certificate names (the runner's platform URL)
//	-listen     the job-host routes over TLS (default :8443)
//	-admin      plain-HTTP admin API (default :8080):
//	              GET  /ca.pem                         the CA to trust
//	              POST /token     {token}              register an enrollment token
//	              GET  /hosts                          hosts with status, facts, report count, machines
//	              POST /approve   {host_id}            set a host active
//	              POST /assign    {host_id, machine_id, job_id, image, deadline_seconds, repository[, base_ref, claim_token, publish {branch, open_mr}]}
//	              POST /authorize {host_id, machine_id}            the platform's publish go-ahead
//	              POST /withdraw  {host_id, machine_id}
//	              GET  /proxy                          CONNECTs seen by the proxy
//	-proxy      an HTTP CONNECT proxy (default :3128; "" off) that counts tunnels, so the e2e can
//	            prove the runner reached the platform through its configured proxy
package main

import (
	"crypto/rand"
	"crypto/tls"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"flag"
	"io"
	"log"
	"net"
	"net/http"
	"sync"
	"sync/atomic"
	"time"

	"github.com/kete-org/ketecode/packages/kete-job-host/internal/contract"
	"github.com/kete-org/ketecode/packages/kete-job-host/internal/fakeplatform"
	"github.com/kete-org/ketecode/packages/kete-job-host/internal/seal"
)

func main() {
	authority := flag.String("authority", "", "platform host name")
	listen := flag.String("listen", ":8443", "TLS listen address")
	admin := flag.String("admin", ":8080", "admin listen address")
	proxy := flag.String("proxy", ":3128", "CONNECT proxy listen address (empty: off)")
	flag.Parse()
	if *authority == "" {
		log.Fatal("-authority is required")
	}
	p := fakeplatform.New(*authority, time.Now)
	p.V2 = true
	cert, ca, err := fakeplatform.NewCert(*authority, 7*24*time.Hour)
	if err != nil {
		log.Fatal(err)
	}
	caPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: ca.Raw})
	srv := &http.Server{Addr: *listen, Handler: logged(p), TLSConfig: &tls.Config{Certificates: []tls.Certificate{cert}, MinVersion: tls.VersionTLS12}, ReadHeaderTimeout: 10 * time.Second}
	go func() { log.Fatal(srv.ListenAndServeTLS("", "")) }()
	var connects atomic.Int64
	if *proxy != "" {
		go func() {
			log.Fatal((&http.Server{Addr: *proxy, Handler: connectProxy(&connects), ReadHeaderTimeout: 10 * time.Second}).ListenAndServe())
		}()
	}
	log.Fatal((&http.Server{Addr: *admin, Handler: adminAPI(p, caPEM, &connects), ReadHeaderTimeout: 10 * time.Second}).ListenAndServe())
}

func logged(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		log.Printf("platform %s %s", r.Method, r.URL.Path)
		h.ServeHTTP(w, r)
	})
}

func adminAPI(p *fakeplatform.Platform, caPEM []byte, connects *atomic.Int64) http.Handler {
	mux := http.NewServeMux()
	body := func(r *http.Request, v any) bool {
		return json.NewDecoder(io.LimitReader(r.Body, 1<<16)).Decode(v) == nil
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
	mux.HandleFunc("GET /ca.pem", func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write(caPEM) })
	mux.HandleFunc("POST /token", func(w http.ResponseWriter, r *http.Request) {
		var in struct{ Token string }
		if !body(r, &in) || !contract.ValidEnrollmentToken(in.Token) {
			http.Error(w, "bad token", 400)
			return
		}
		p.AddToken(in.Token)
		reply(w, map[string]bool{"ok": true}, nil)
	})
	mux.HandleFunc("GET /hosts", func(w http.ResponseWriter, _ *http.Request) {
		type machine struct {
			State, Reason string
			Terminal      bool
			Publish       *contract.PublishOutcome `json:",omitempty"`
			PhaseLines    []contract.PhaseLine     `json:",omitempty"`
		}
		type host struct {
			ID, Status   string
			Facts        contract.FactsV2
			Reports      int
			LastReport   *contract.ReportV2
			Machines     map[string]machine
			Unattributed map[string]machine
		}
		var out []host
		for _, id := range p.Hosts() {
			h := p.HostSnapshot(id)
			o := host{ID: id, Status: h.Status, Facts: h.FactsV2, Reports: len(h.ReportsV2), Machines: map[string]machine{}, Unattributed: map[string]machine{}}
			if n := len(h.ReportsV2); n > 0 {
				o.LastReport = &h.ReportsV2[n-1]
			}
			for mid, m := range h.Machines {
				o.Machines[mid] = machine{State: m.Observed, Reason: m.ObservedReason, Terminal: m.Terminal, Publish: m.Publish, PhaseLines: m.PhaseLines}
			}
			for mid, m := range h.Unknown {
				o.Unattributed[mid] = machine{State: m.State, Reason: m.Reason, Terminal: contract.Terminal(m.State)}
			}
			out = append(out, o)
		}
		reply(w, out, nil)
	})
	mux.HandleFunc("POST /approve", func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			HostID string `json:"host_id"`
		}
		if !body(r, &in) {
			http.Error(w, "bad body", 400)
			return
		}
		p.SetStatus(in.HostID, "active")
		reply(w, map[string]bool{"ok": true}, nil)
	})
	mux.HandleFunc("POST /assign", func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			HostID          string `json:"host_id"`
			MachineID       string `json:"machine_id"`
			JobID           string `json:"job_id"`
			Image           string `json:"image"`
			DeadlineSeconds int    `json:"deadline_seconds"`
			Repository      string `json:"repository"`
			BaseRef         string `json:"base_ref"`
			// ClaimToken is the job's claim token on the jobs-v1 side (the entrypoint fake's
			// job, kubevm e2e); random when absent.
			ClaimToken string `json:"claim_token"`
			// Publish asks for a push (not yet authorized: POST /authorize).
			Publish *struct {
				Branch string `json:"branch"`
				OpenMR bool   `json:"open_mr"`
			} `json:"publish"`
		}
		if !body(r, &in) {
			http.Error(w, "bad body", 400)
			return
		}
		var tok [32]byte
		_, _ = rand.Read(tok[:])
		run := contract.RunMachineV2{
			MachineID: in.MachineID, JobID: in.JobID, Image: in.Image,
			Deadline:  contract.FormatTime(time.Now().Add(time.Duration(in.DeadlineSeconds) * time.Second)),
			Resources: contract.Resources{VCPUs: 1, MemoryMiB: 1024, ScratchGiB: 1},
		}
		if in.Repository != "" {
			ref := in.BaseRef
			if ref == "" {
				ref = "main"
			}
			run.Repository = &contract.RunRepository{Name: in.Repository, BaseRef: ref}
		}
		if in.Publish != nil {
			run.Publish = &contract.RunPublish{Branch: in.Publish.Branch, OpenMR: in.Publish.OpenMR}
		}
		claim := hex.EncodeToString(tok[:])
		if in.ClaimToken != "" {
			claim = in.ClaimToken
		}
		cfg := seal.MachineConfig{
			JobID: in.JobID, PlatformURL: "https://" + p.Authority, ClaimToken: claim,
			StorageHost: "storage.invalid.example", HostProfile: seal.ProfileKubeVM,
		}
		reply(w, map[string]bool{"ok": true}, p.AssignV2(in.HostID, run, cfg))
	})
	mux.HandleFunc("POST /authorize", func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			HostID    string `json:"host_id"`
			MachineID string `json:"machine_id"`
		}
		if !body(r, &in) {
			http.Error(w, "bad body", 400)
			return
		}
		reply(w, map[string]bool{"ok": true}, p.Authorize(in.HostID, in.MachineID))
	})
	mux.HandleFunc("POST /withdraw", func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			HostID    string `json:"host_id"`
			MachineID string `json:"machine_id"`
		}
		if !body(r, &in) {
			http.Error(w, "bad body", 400)
			return
		}
		p.Withdraw(in.HostID, in.MachineID)
		reply(w, map[string]bool{"ok": true}, nil)
	})
	mux.HandleFunc("GET /proxy", func(w http.ResponseWriter, _ *http.Request) {
		reply(w, map[string]int64{"connects": connects.Load()}, nil)
	})
	return mux
}

// connectProxy is a minimal HTTP CONNECT proxy (tunnels only).
func connectProxy(connects *atomic.Int64) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodConnect {
			http.Error(w, "CONNECT only", http.StatusMethodNotAllowed)
			return
		}
		up, err := net.DialTimeout("tcp", r.Host, 10*time.Second)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadGateway)
			return
		}
		hj, ok := w.(http.Hijacker)
		if !ok {
			up.Close()
			return
		}
		w.WriteHeader(http.StatusOK)
		down, _, err := hj.Hijack()
		if err != nil {
			up.Close()
			return
		}
		connects.Add(1)
		log.Printf("proxy CONNECT %s", r.Host)
		var wg sync.WaitGroup
		wg.Add(2)
		go func() { defer wg.Done(); _, _ = io.Copy(up, down); _ = up.Close() }()
		go func() { defer wg.Done(); _, _ = io.Copy(down, up); _ = down.Close() }()
		wg.Wait()
	})
}
