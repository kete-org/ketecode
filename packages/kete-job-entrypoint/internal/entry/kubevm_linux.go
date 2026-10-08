//go:build linux

package entry

// The kubevm profile's machine side (module README "kubevm"; spec "S0 findings"): the per-job
// Secret's volume unmounted and /proc/sys and the cgroup mount made writable (setup_kubevm), the
// enterprise proxy's files and the outbox prepared (setup_dirs), kete-egress configuration v2, and
// the job's runtime-repository dependencies.

import (
	"bufio"
	"errors"
	"fmt"
	"os"
	"strings"

	"golang.org/x/sys/unix"

	"github.com/kete-org/ketecode/packages/kete-job-entrypoint/internal/bootenv"
	"github.com/kete-org/ketecode/packages/kete-job-entrypoint/internal/egress"
	"github.com/kete-org/ketecode/packages/kete-job-entrypoint/internal/gitops"
	"github.com/kete-org/ketecode/packages/kete-job-entrypoint/internal/job"
	"github.com/kete-org/ketecode/packages/kete-job-entrypoint/internal/layout"
	"github.com/kete-org/ketecode/packages/kete-job-entrypoint/internal/outbox"
	pl "github.com/kete-org/ketecode/packages/kete-job-entrypoint/internal/phaselog"
	"github.com/kete-org/ketecode/packages/kete-job-entrypoint/internal/platform"
	"github.com/kete-org/ketecode/packages/kete-job-entrypoint/internal/setup"
	"github.com/kete-org/ketecode/packages/kete-job-entrypoint/internal/sysusers"
)

func sharedKernelTest(boot bootenv.Values) bool {
	return boot.Local != nil && boot.Local.SharedKernelTest
}

// kubeVMSetup is step setup_kubevm, right after the shared-kernel check: unmount the config
// Secret's volume and prove it gone (no mount point there any more and nothing left in the
// directory), then remount /proc/sys and /sys/fs/cgroup read-write (CRI mounts both read-only in a
// non-privileged container; in a VM-isolated pod both are the guest's own).
func kubeVMSetup(log *pl.Logger, cfg layout.Config) bool {
	log.Start(pl.StepKubeVM)
	if err := unix.Unmount(cfg.ConfigDir, 0); err != nil {
		log.FailErr(pl.StepKubeVM, pl.CodeConfigSecret, err)
		return false
	}
	mounted, err := mountedAt(cfg.MountInfo, cfg.ConfigDir)
	if err == nil && mounted {
		err = errors.New("still mounted")
	}
	if err == nil {
		var ents []os.DirEntry
		if ents, err = os.ReadDir(cfg.ConfigDir); err == nil && len(ents) > 0 {
			err = errors.New("not empty after the unmount")
		}
	}
	if err != nil {
		log.FailErr(pl.StepKubeVM, pl.CodeConfigSecret, err)
		return false
	}
	if err := unix.Mount("", cfg.ProcMount+"/sys", "", unix.MS_REMOUNT|unix.MS_BIND, ""); err != nil {
		log.FailErr(pl.StepKubeVM, pl.CodeFailed, fmt.Errorf("remount %s/sys rw: %w", cfg.ProcMount, err))
		return false
	}
	if err := unix.Mount("", "/sys/fs/cgroup", "", unix.MS_REMOUNT|unix.MS_BIND|unix.MS_NOSUID|unix.MS_NODEV|unix.MS_NOEXEC, ""); err != nil {
		log.FailErr(pl.StepKubeVM, pl.CodeFailed, fmt.Errorf("remount /sys/fs/cgroup rw: %w", err))
		return false
	}
	log.OK(pl.StepKubeVM)
	return true
}

// mountedAt reports whether mountinfo lists dir as a mount point.
func mountedAt(mountinfo, dir string) (bool, error) {
	f, err := os.Open(mountinfo)
	if err != nil {
		return false, err
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 64<<10), 1<<20)
	for sc.Scan() {
		if fields := strings.Fields(sc.Text()); len(fields) >= 5 && fields[4] == dir {
			return true, nil
		}
	}
	return false, sc.Err()
}

// kubeVMDirs prepares, before any job user exists: the enterprise proxy's credentials and CA
// bundle for kete-egress (root, group kete-proxy, 0440, in a 0750 directory: only the proxy user
// reads them), and the outbox volume (empty, root, group layout.OutboxGID, 0750).
func kubeVMDirs(cfg layout.Config, ids sysusers.IDs, boot bootenv.Values) error {
	if err := setup.MakeDirs([]setup.Dir{{Path: cfg.UpstreamDir, GID: ids.Proxy.GID, Mode: 0o750}}); err != nil {
		return err
	}
	if e := boot.Local.Egress; e != nil {
		if e.CABundle != "" {
			if err := setup.CreateExclusive(cfg.UpstreamCA(), []byte(e.CABundle), 0, ids.Proxy.GID, 0o440); err != nil {
				return err
			}
		}
		if e.ProxyAuth != "" {
			if err := setup.CreateExclusive(cfg.UpstreamAuth(), []byte(e.ProxyAuth), 0, ids.Proxy.GID, 0o440); err != nil {
				return err
			}
		}
	}
	mounted, err := mountedAt(cfg.MountInfo, cfg.OutboxDir)
	if err != nil {
		return err
	}
	if !mounted {
		return errors.New("the outbox is not a mounted volume")
	}
	return outbox.Prepare(cfg.OutboxDir, 0, layout.OutboxGID)
}

// egressV2 is kete-egress configuration v2's enterprise network from the local section.
func egressV2(cfg layout.Config, boot bootenv.Values) *egress.V2 {
	v := &egress.V2{}
	if e := boot.Local.Egress; e != nil {
		v.Proxy, v.Internal = e.Proxy, e.Internal
		if e.Proxy != "" && e.ProxyAuth != "" {
			v.ProxyAuthFile = cfg.UpstreamAuth()
		}
		if e.Proxy != "" && e.CABundle != "" {
			v.CABundleFile = cfg.UpstreamCA()
		}
	}
	return v
}

// runtimeDeps builds the job's runtime-repository path from the local section.
func runtimeDeps(cfg layout.Config, boot bootenv.Values, pc *platform.Client, git gitops.Runner) (*job.Runtime, error) {
	l := boot.Local
	cloneURL, entry, err := bootenv.CloneTarget(l.Repository.CloneURL)
	if err != nil {
		return nil, err
	}
	return &job.Runtime{
		Platform: pc, Repo: l.Repository, CloneURL: cloneURL, CloneEntry: entry,
		Boundary: platform.DataBoundary{Summary: l.Boundary.Summary, Denials: l.Boundary.Denials, PublishRefs: l.Boundary.PublishRefs},
		Outbox:   outbox.Dir{Path: cfg.OutboxDir, UID: 0, GID: layout.OutboxGID},
		Head:     git.Head,
	}, nil
}
