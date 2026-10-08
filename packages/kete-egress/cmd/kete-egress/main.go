// Command kete-egress is a cloud job's only network boundary (module README): `nft` prints the
// job's nftables ruleset, and `serve` runs the TLS-terminating egress proxy on the fds root hands
// it. Linux-only; it ships in the job container image, never with the `kete` CLI.
//
// Exit codes: 0 the control channel closed; 1 a runtime failure (log write, listener); 2 a
// start-up or configuration refusal, or a malformed control line.
package main

import (
	"crypto/x509"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"time"

	"github.com/kete-org/ketecode/packages/kete-egress/internal/ca"
	"github.com/kete-org/ketecode/packages/kete-egress/internal/config"
	"github.com/kete-org/ketecode/packages/kete-egress/internal/control"
	"github.com/kete-org/ketecode/packages/kete-egress/internal/netrules"
	"github.com/kete-org/ketecode/packages/kete-egress/internal/phase"
	"github.com/kete-org/ketecode/packages/kete-egress/internal/proxy"
	"github.com/kete-org/ketecode/packages/kete-egress/internal/reqlog"
)

const (
	exitClosed  = 0
	exitRuntime = 1
	exitRefused = 2
)

const usage = "usage: kete-egress nft --config <file|->\n       kete-egress serve --config <file|->"

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, usage)
		os.Exit(exitRefused)
	}
	switch os.Args[1] {
	case "serve":
		os.Exit(serve(os.Args[2:]))
	case "nft":
		os.Exit(nft(os.Args[2:]))
	default:
		fmt.Fprintln(os.Stderr, usage)
		os.Exit(exitRefused)
	}
}

func fail(code int, format string, args ...any) int {
	fmt.Fprintf(os.Stderr, "kete-egress: "+format+"\n", args...)
	return code
}

func configFlag(name string, args []string) (string, error) {
	fs := flag.NewFlagSet(name, flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	path := fs.String("config", "", "configuration file, or - for stdin")
	if err := fs.Parse(args); err != nil {
		return "", err
	}
	if *path == "" || fs.NArg() != 0 {
		return "", errors.New(usage)
	}
	return *path, nil
}

func loadConfig(path string) (*config.Config, error) {
	if path == "-" {
		return config.Load(os.Stdin)
	}
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	return config.Load(f)
}

func nft(args []string) int {
	path, err := configFlag("nft", args)
	if err != nil {
		return fail(exitRefused, "%v", err)
	}
	cfg, err := loadConfig(path)
	if err != nil {
		return fail(exitRefused, "%v", err)
	}
	if _, err := io.WriteString(os.Stdout, netrules.Generate(cfg)); err != nil {
		return fail(exitRuntime, "write ruleset: %v", err)
	}
	return exitClosed
}

func serve(args []string) int {
	// Before anything else opens a file.
	if err := proxy.CheckNoExtraFDs(); err != nil {
		return fail(exitRefused, "%v", err)
	}
	path, err := configFlag("serve", args)
	if err != nil {
		return fail(exitRefused, "%v", err)
	}
	cfg, err := loadConfig(path)
	if err != nil {
		return fail(exitRefused, "%v", err)
	}
	if err := proxy.CheckIdentity(cfg); err != nil {
		return fail(exitRefused, "%v", err)
	}
	inh, err := proxy.Inherit(cfg)
	if err != nil {
		return fail(exitRefused, "%v", err)
	}
	if err := proxy.SetNotDumpable(); err != nil {
		return fail(exitRefused, "PR_SET_DUMPABLE: %v", err)
	}
	// The upstream trust: the system roots, loaded before the job CA exists, so the job CA can
	// never verify an upstream even if it were later added to the system store.
	if err := proxy.CheckTrustEnv(os.Getenv); err != nil {
		return fail(exitRefused, "%v", err)
	}
	roots, err := x509.SystemCertPool()
	if err != nil {
		return fail(exitRefused, "system roots: %v", err)
	}
	if err := proxy.CheckRoots(roots); err != nil {
		return fail(exitRefused, "%v", err)
	}
	// Configuration v2: the enterprise CA bundle (upstream TLS only, in addition to the system
	// roots, checked like them) and the upstream proxy's credentials, both read once, here.
	proxyAuth := ""
	if up := cfg.Upstream; up != nil {
		if up.CABundleFile != "" {
			if roots, err = proxy.AddCABundle(roots, up.CABundleFile); err != nil {
				return fail(exitRefused, "%v", err)
			}
		}
		if up.ProxyAuthFile != "" {
			if proxyAuth, err = proxy.ReadProxyAuth(up.ProxyAuthFile); err != nil {
				return fail(exitRefused, "%v", err)
			}
		}
	}
	authority, err := ca.New(cfg.AllHosts(), time.Now())
	if err != nil {
		return fail(exitRefused, "%v", err)
	}
	lg := reqlog.New(inh.Log, inh.LogStart, cfg.Limits.LogMaxBytes, func(err error) {
		fmt.Fprintf(os.Stderr, "kete-egress: request log write failed: %v\n", err)
		os.Exit(exitRuntime)
	})
	p, err := proxy.New(proxy.Deps{
		Config:        cfg,
		Listeners:     inh.Listeners,
		Log:           lg,
		CA:            authority,
		Phase:         phase.NewState(),
		UpstreamRoots: roots,
		ProxyAuth:     proxyAuth,
		Fatal: func(err error) {
			fmt.Fprintf(os.Stderr, "kete-egress: %v\n", err)
			os.Exit(exitRuntime)
		},
	})
	if err != nil {
		return fail(exitRefused, "%v", err)
	}
	ctl := inh.Control
	p.Serve()
	if err := control.WriteReady(ctl, authority.CertPEM()); err != nil {
		return fail(exitRuntime, "control: %v", err)
	}

	rd := control.NewReader(ctl)
	for {
		cmd, err := rd.Read()
		if errors.Is(err, io.EOF) {
			p.Close()
			return exitClosed
		}
		if errors.Is(err, control.ErrMalformed) {
			return fail(exitRefused, "control: %v", err)
		}
		if err != nil {
			return fail(exitRuntime, "control: %v", err)
		}
		var werr error
		switch cmd.Type {
		case "phase":
			ph, err := phase.Parse(cmd.Phase)
			if err != nil {
				werr = control.WriteError(ctl, err.Error())
				break
			}
			n, err := p.SetPhase(ph)
			if err != nil {
				werr = control.WriteError(ctl, err.Error())
				break
			}
			werr = control.WritePhaseOK(ctl, string(ph), n)
		case "stats":
			werr = control.WriteStats(ctl, p.Stats())
		}
		if werr != nil {
			return fail(exitRuntime, "control: %v", werr)
		}
	}
}
