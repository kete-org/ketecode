// Command kete-job-fake-platform runs internal/fakeplatform as a container for the job image's
// end-to-end test (packages/kete-job-image/scripts/e2e.sh). It serves one job, then exits:
//
//  1. starts the fake (HTTPS on <addr>:443, DNS on <addr>:53, forwarding other names to the first
//     nameserver of its own /etc/resolv.conf: Docker's embedded resolver on a user network);
//  2. creates the job for -scenario and writes <state>/ca.pem (the fake's test CA) and
//     <state>/config.json (the config pipe's payload for the dedicated host profile, which e2e.sh
//     hands the entrypoint on stdin: --config-fd 0) and <state>/job.env (the same values as Fly's
//     environment, for `docker run --env-file`), so no token is in the host's argv;
//  3. serves until the job's finish is accepted, the deadline passes or SIGTERM, then writes its
//     records (internal/fakeplatform WriteState) and <state>/done.
//
// For the Kubernetes runner's kind e2e (packages/kete-runner-chart/ci/e2e.sh) it also takes
// -runtime-repo (a runtime repository's job: no clone in the claim, the outbox finish; -claim-repo
// makes the claim name another repository), -listen (HTTPS on another address than the DNS
// answers) and -job-hosts/-job-hosts-ca (the job-host fake behind the same platform origin), and
// writes <state>/runtime-job.json (the job id, the claim token, the clone token and the git URL the runner
// configures as the repository's source).
//
// Test support only: it holds a test CA and test credentials, never real ones.
package main

import (
	"bufio"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"flag"
	"fmt"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/kete-org/ketecode/packages/kete-job-entrypoint/internal/bootenv"
	"github.com/kete-org/ketecode/packages/kete-job-entrypoint/internal/fakeplatform"
)

func main() {
	addr := flag.String("addr", "198.51.100.10", "the IPv4 address to serve HTTPS (:443) and DNS (:53) on")
	state := flag.String("state", "/state", "the state directory")
	scenario := flag.String("scenario", "lifecycle", "lifecycle, ac5 or no-agent")
	backend := flag.String("git-http-backend", "/usr/lib/git-core/git-http-backend", "git http-backend")
	deadline := flag.Duration("deadline", 25*time.Minute, "the job's deadline, from now")
	timeout := flag.Int("policy-timeout", 15, "the spec's policy.timeout in minutes")
	listen := flag.String("listen", "", "the IPv4 address HTTPS listens on (default: -addr)")
	runtimeRepo := flag.String("runtime-repo", "", "serve a runtime repository's job with this name (kubevm)")
	claimRepo := flag.String("claim-repo", "", "with -runtime-repo: the repository name the claim answers instead")
	jobHosts := flag.String("job-hosts", "", "https://ip:port of the job-host fake that serves /api/v1/job-hosts/ on the platform host")
	jobHostsCA := flag.String("job-hosts-ca", "", "the job-host fake's CA (PEM file)")
	caDir := flag.String("ca-dir", "", "keep the fake's CA in this directory across runs")
	linger := flag.Bool("linger", false, "keep serving after the finish until SIGTERM (the runner keeps polling through this origin)")
	flag.Parse()

	knobs := fakeplatform.Knobs{Prompt: "Run the end-to-end test's scripted task.", PolicyTimeout: *timeout, Deadline: *deadline}
	switch *scenario {
	case "lifecycle":
		knobs.Scenario = fakeplatform.ScenarioLifecycle
	case "ac5":
		knobs.Scenario = fakeplatform.ScenarioAC5
	case "no-agent":
		knobs.Scenario = fakeplatform.ScenarioLifecycle
		knobs.OmitAgent = true
	default:
		fail("unknown scenario %q", *scenario)
	}
	knobs.RuntimeRepo, knobs.ClaimRepo = *runtimeRepo, *claimRepo
	if err := os.MkdirAll(*state, 0o755); err != nil {
		fail("state: %v", err)
	}
	forward, err := resolver("/etc/resolv.conf")
	if err != nil {
		fail("resolver: %v", err)
	}
	dnsListen := *addr
	if *listen != "" {
		dnsListen = *listen
	}
	var jh http.Handler
	if *jobHosts != "" {
		if jh, err = jobHostsProxy(*jobHosts, *jobHostsCA); err != nil {
			fail("job-hosts: %v", err)
		}
	}
	s, err := fakeplatform.Start(fakeplatform.Config{
		Addr: *addr, DNSAddr: net.JoinHostPort(dnsListen, "53"), StateDir: filepath.Join(*state, "fake"),
		GitHTTPBackend: *backend, Forward: forward, ListenAddr: *listen, JobHosts: jh, CADir: *caDir,
	})
	if err != nil {
		fail("start: %v", err)
	}
	defer s.Close()
	j := s.NewJob(knobs)
	if err := write(filepath.Join(*state, "ca.pem"), s.CAPEM, 0o644); err != nil {
		fail("ca.pem: %v", err)
	}
	cfg, err := json.Marshal(bootenv.Config{
		JobID: j.ID, PlatformURL: "https://" + fakeplatform.PlatformHost, ClaimToken: j.ClaimToken,
		StorageHost: fakeplatform.StorageHost, HostProfile: "dedicated", HostGeneration: "e2e-1",
	})
	if err != nil {
		fail("config.json: %v", err)
	}
	if err := write(filepath.Join(*state, "config.json"), cfg, 0o644); err != nil {
		fail("config.json: %v", err)
	}
	env := strings.Join([]string{
		"KETE_JOB_ID=" + j.ID,
		"KETE_JOB_PLATFORM_URL=https://" + fakeplatform.PlatformHost,
		"KETE_JOB_CLAIM_TOKEN=" + j.ClaimToken,
		"KETE_JOB_STORAGE_HOST=" + fakeplatform.StorageHost,
	}, "\n") + "\n"
	// 0644: the docker CLI on the host reads it (in CI as a non-root user); test credentials only.
	if err := write(filepath.Join(*state, "job.env"), []byte(env), 0o644); err != nil {
		fail("job.env: %v", err)
	}
	jobJSON, err := json.Marshal(map[string]string{
		"job_id": j.ID, "claim_token": j.ClaimToken, "clone_token": j.CloneToken, "base_sha": j.BaseSHA,
		"clone_url": "https://" + fakeplatform.GitHost + "/org/repo.git", "clone_username": "x-access-token",
		"platform_url": "https://" + fakeplatform.PlatformHost,
	})
	if err != nil {
		fail("runtime-job.json: %v", err)
	}
	if err := write(filepath.Join(*state, "runtime-job.json"), jobJSON, 0o644); err != nil {
		fail("runtime-job.json: %v", err)
	}
	fmt.Printf("fake platform: job %s, scenario %s, ready\n", j.ID, *scenario)

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()
	timer := time.NewTimer(time.Until(j.Deadline) + time.Minute)
	defer timer.Stop()
	select {
	case <-j.Done():
		fmt.Println("fake platform: finish accepted")
		time.Sleep(time.Second) // let the entrypoint's last proxy log lines settle; nothing else is expected
		if *linger {
			if err := write(filepath.Join(*state, "finished"), []byte("ok\n"), 0o644); err != nil {
				fail("finished: %v", err)
			}
			<-ctx.Done()
		}
	case <-timer.C:
		fmt.Println("fake platform: deadline passed without a finish")
	case <-ctx.Done():
		fmt.Println("fake platform: stopped before a finish")
	}
	if err := s.WriteState(*state); err != nil {
		fail("write state: %v", err)
	}
	if err := write(filepath.Join(*state, "done"), []byte("ok\n"), 0o644); err != nil {
		fail("done: %v", err)
	}
}

// jobHostsProxy forwards the runner's job-host-v2 requests to the job-host fake over TLS (its own
// CA), keeping the Host the request named (the signature covers the authority).
func jobHostsProxy(target, caFile string) (http.Handler, error) {
	u, err := url.Parse(target)
	if err != nil || u.Scheme != "https" {
		return nil, fmt.Errorf("bad -job-hosts %q", target)
	}
	pemData, err := os.ReadFile(caFile)
	if err != nil {
		return nil, err
	}
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(pemData) {
		return nil, fmt.Errorf("%s holds no certificate", caFile)
	}
	rp := httputil.NewSingleHostReverseProxy(u)
	rp.Transport = &http.Transport{TLSClientConfig: &tls.Config{RootCAs: pool, ServerName: fakeplatform.PlatformHost, MinVersion: tls.VersionTLS12}}
	inner := rp.Director
	rp.Director = func(r *http.Request) {
		host := r.Host
		inner(r)
		r.Host = host
	}
	return rp, nil
}

// resolver is the first nameserver of a resolv.conf, as ip:53.
func resolver(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		fields := strings.Fields(sc.Text())
		if len(fields) >= 2 && fields[0] == "nameserver" && net.ParseIP(fields[1]) != nil {
			return net.JoinHostPort(fields[1], "53"), nil
		}
	}
	if err := sc.Err(); err != nil {
		return "", err
	}
	return "", fmt.Errorf("no nameserver in %s", path)
}

// write writes a file atomically (temp + rename), so a poller never reads half of it.
func write(path string, data []byte, mode os.FileMode) error {
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, mode); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

func fail(format string, args ...any) {
	fmt.Fprintf(os.Stderr, "kete-job-fake-platform: "+format+"\n", args...)
	os.Exit(1)
}
