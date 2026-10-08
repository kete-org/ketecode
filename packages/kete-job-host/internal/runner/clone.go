package runner

// Clone credentials (enterprise runtime P3, spec §5): for each job the controller obtains the read
// credential its repository source names — a static deploy token from a Secret, or a GitLab
// project access token minted for this machine with the source's Maintainer token — and checks it
// by resolving the run's base_ref over git smart HTTP before the pod gets it (so a wrong token, a
// missing branch or an unreachable GitLab fails the machine repository_unavailable instead of a
// clone inside the job). A minted token is revoked when the job reports clone_done, again when its
// pod ends, and by a periodic sweep of tokens named kete-job-<machine> whose job pod is gone
// (a controller restart loses nothing).

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/kete-org/ketecode/packages/kete-job-host/internal/config"
	"github.com/kete-org/ketecode/packages/kete-job-host/internal/contract"
	"github.com/kete-org/ketecode/packages/kete-job-host/internal/driver"
	kdriver "github.com/kete-org/ketecode/packages/kete-job-host/internal/driver/kubernetes"
	"github.com/kete-org/ketecode/packages/kete-job-host/internal/gitproto"
	"github.com/kete-org/ketecode/packages/kete-job-host/internal/kube"
	"github.com/kete-org/ketecode/packages/kete-job-host/internal/repo/gitlab"
)

// MintedUsername is the git user name sent with a minted project access token (GitLab accepts any
// non-empty name with an access token).
const MintedUsername = "kete-job"

type minted struct {
	repo string
	id   int64
}

// cloneCreds hands out and revokes the jobs' read credentials.
type cloneCreds struct {
	kube      *kube.Client
	namespace string // the controller's: static and minter Secrets live there
	jobsNS    string
	sources   map[string]config.RepositorySourceFile
	http      *http.Client
	now       func() time.Time
	log       *slog.Logger

	mu     sync.Mutex
	minted map[string]minted // machine → its token, until revoked
	done   map[string]bool   // machines whose revocation is in flight
	wg     sync.WaitGroup
}

// repoHTTPClient is the controller's client for repository hosts: the enterprise proxy (with its
// credential) unless the host is in no_proxy, the system roots plus the CA bundle, no redirects.
func repoHTTPClient(proxy *url.URL, noProxy []string, roots *x509.CertPool) *http.Client {
	t := http.DefaultTransport.(*http.Transport).Clone()
	t.Proxy = nil
	if proxy != nil {
		p := *proxy
		t.Proxy = func(r *http.Request) (*url.URL, error) {
			if config.MatchNoProxy(r.URL.Hostname(), noProxy) {
				return nil, nil
			}
			return &p, nil
		}
	}
	t.TLSClientConfig = &tls.Config{MinVersion: tls.VersionTLS12, RootCAs: roots}
	return gitlab.NewHTTPClient(t)
}

func (c *cloneCreds) secret(ctx context.Context, name string) (map[string][]byte, error) {
	s, err := c.kube.GetSecret(ctx, c.namespace, name)
	return s.Data, err
}

// credential implements kdriver.KubeVMOptions.Credential.
func (c *cloneCreds) credential(ctx context.Context, s driver.Spec, src config.RepositorySourceFile) (string, string, error) {
	var user, token string
	switch src.CloneMode {
	case config.CloneMinted:
		data, err := c.secret(ctx, src.MinterSecret)
		if err != nil {
			return "", "", unavailable("minter credential", err)
		}
		admin := strings.TrimSpace(string(data["token"]))
		clear(data["token"])
		if admin == "" {
			return "", "", unavailable("minter credential", errors.New("the minter Secret needs key token"))
		}
		base, project, err := config.GitLabProject(src.CloneURL, src.APIURL)
		if err != nil {
			return "", "", unavailable("project", err)
		}
		t, err := gitlab.New(base, project, admin, c.http).CreateCloneToken(ctx, s.MachineID, c.now())
		if err != nil {
			return "", "", unavailable("minting a clone token", err)
		}
		c.mu.Lock()
		c.minted[s.MachineID] = minted{repo: src.Name, id: t.ID}
		c.mu.Unlock()
		c.log.Info("clone_token_minted", "machine_id", s.MachineID, "job_id", s.JobID, "repository", src.Name, "token_id", t.ID)
		user, token = MintedUsername, t.Token
	default:
		data, err := c.secret(ctx, src.CloneSecret)
		if err != nil {
			return "", "", unavailable("clone credential", err)
		}
		user, token = strings.TrimSpace(string(data["username"])), strings.TrimSpace(string(data["token"]))
		clear(data["token"])
		if user == "" || token == "" {
			return "", "", unavailable("clone credential", errors.New("the clone Secret needs keys username and token"))
		}
	}
	// The base ref must exist and the credential must read it (spec §4.5 step 2).
	refs, err := gitproto.LsRefs(ctx, gitproto.Endpoint{URL: src.CloneURL, Username: user, Password: token, Client: c.http}, "refs/heads/"+s.Repository.BaseRef)
	if err == nil && refs["refs/heads/"+s.Repository.BaseRef] == "" {
		err = errors.New("the base ref doesn't exist")
	}
	if err != nil {
		c.revoke(s.MachineID)
		return "", "", unavailable("resolving the base ref", err)
	}
	return user, token, nil
}

func unavailable(what string, err error) error {
	return &driver.FailedError{Reason: contract.ReasonRepositoryUnavailable, Err: fmt.Errorf("%s: %w", what, err)}
}

// revoke revokes a machine's minted token in the background (idempotent; a no-op for static
// credentials). It is called from the driver with its lock-free hooks.
func (c *cloneCreds) revoke(machineID string) {
	c.mu.Lock()
	t, ok := c.minted[machineID]
	if !ok || c.done[machineID] {
		c.mu.Unlock()
		return // a static credential, already revoked, or a revocation in flight
	}
	c.done[machineID] = true
	c.mu.Unlock()
	c.wg.Add(1)
	go func() {
		defer c.wg.Done()
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		if err := c.revokeToken(ctx, t.repo, t.id); err != nil {
			// The sweep retries it (its pod is gone by then, or will be).
			c.log.Warn("clone_token_revoke_failed", "machine_id", machineID, "token_id", t.id, "error", err.Error())
			c.mu.Lock()
			delete(c.done, machineID)
			c.mu.Unlock()
			return
		}
		c.mu.Lock()
		delete(c.minted, machineID)
		delete(c.done, machineID)
		c.mu.Unlock()
		c.log.Info("clone_token_revoked", "machine_id", machineID, "token_id", t.id)
	}()
}

func (c *cloneCreds) client(ctx context.Context, repo string) (*gitlab.Client, error) {
	src, ok := c.sources[repo]
	if !ok || src.CloneMode != config.CloneMinted {
		return nil, errors.New("not a minted source")
	}
	data, err := c.secret(ctx, src.MinterSecret)
	if err != nil {
		return nil, err
	}
	admin := strings.TrimSpace(string(data["token"]))
	clear(data["token"])
	base, project, err := config.GitLabProject(src.CloneURL, src.APIURL)
	if err != nil {
		return nil, err
	}
	return gitlab.New(base, project, admin, c.http), nil
}

func (c *cloneCreds) revokeToken(ctx context.Context, repo string, id int64) error {
	gl, err := c.client(ctx, repo)
	if err != nil {
		return err
	}
	return gl.RevokeToken(ctx, id)
}

// sweep revokes every active kete-job-<machine> token of the minted sources whose machine has no
// job pod any more or whose clone is done: tokens a restart or a failed revoke left behind.
func (c *cloneCreds) sweep(ctx context.Context) {
	for name, src := range c.sources {
		if src.CloneMode != config.CloneMinted {
			continue
		}
		gl, err := c.client(ctx, name)
		if err != nil {
			c.log.Warn("clone_token_sweep_failed", "repository", name, "error", err.Error())
			continue
		}
		tokens, err := gl.ListCloneTokens(ctx)
		if err != nil {
			c.log.Warn("clone_token_sweep_failed", "repository", name, "error", err.Error())
			continue
		}
		for _, t := range tokens {
			id := strings.TrimPrefix(t.Name, gitlab.TokenPrefix)
			if !contract.ValidUUID(id) {
				continue // not one of ours as written
			}
			c.mu.Lock()
			_, tracked := c.minted[id]
			c.mu.Unlock()
			if _, err := c.kube.GetPod(ctx, c.jobsNS, kdriver.PodName(id)); !kube.IsNotFound(err) {
				continue // its job still runs (or can't be read): its own hooks revoke it
			}
			if tracked {
				c.revoke(id) // its hooks' revocation failed: again, the same way
				continue
			}
			if err := gl.RevokeToken(ctx, t.ID); err != nil {
				c.log.Warn("clone_token_revoke_failed", "machine_id", id, "token_id", t.ID, "error", err.Error())
				continue
			}
			c.log.Info("clone_token_revoked", "machine_id", id, "token_id", t.ID, "by", "sweep")
		}
	}
}

// run sweeps at start and every five minutes until ctx ends, then waits for revocations in flight.
func (c *cloneCreds) run(ctx context.Context) {
	defer c.wg.Wait()
	for {
		c.sweep(ctx)
		if sleep(ctx, 5*time.Minute) != nil {
			return
		}
	}
}

// hasMinted reports whether any source mints tokens.
func hasMinted(sources map[string]config.RepositorySourceFile) bool {
	for _, s := range sources {
		if s.CloneMode == config.CloneMinted {
			return true
		}
	}
	return false
}
