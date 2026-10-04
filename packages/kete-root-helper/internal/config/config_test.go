package config

import (
	"testing"
)

func valid() []string {
	return []string{
		"--socket", "/run/kete/tool.sock",
		"--kete-uid", "1000",
		"--tool-uid", "2000",
		"--tool-gid", "2000",
		"--worktree-root", "/srv/worktree",
		"--tool-cgroup", "/sys/fs/cgroup/kete/tool",
		"--env-allow", "PATH,HOME",
	}
}

func TestParseValid(t *testing.T) {
	cfg, err := Parse(valid())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cfg.Socket != "/run/kete/tool.sock" {
		t.Errorf("socket = %q", cfg.Socket)
	}
	if cfg.KeteUID != 1000 || cfg.ToolUID != 2000 || cfg.ToolGID != 2000 {
		t.Errorf("ids = %d/%d/%d", cfg.KeteUID, cfg.ToolUID, cfg.ToolGID)
	}
	if len(cfg.EnvAllow) != 2 {
		t.Errorf("env-allow = %v", cfg.EnvAllow)
	}
	if cfg.MaxFrame != DefaultMaxFrame {
		t.Errorf("max-frame default = %d", cfg.MaxFrame)
	}
	if cfg.MaxProcesses != DefaultMaxProcesses {
		t.Errorf("max-processes default = %d", cfg.MaxProcesses)
	}
	if cfg.SpawnRate != DefaultSpawnRate || cfg.SpawnBurst != DefaultSpawnBurst {
		t.Errorf("spawn rate/burst defaults = %v/%d", cfg.SpawnRate, cfg.SpawnBurst)
	}
}

func replaceArg(args []string, flag, value string) []string {
	out := make([]string, 0, len(args))
	for i := 0; i < len(args); i += 2 {
		if args[i] == flag {
			out = append(out, flag, value)
			continue
		}
		out = append(out, args[i], args[i+1])
	}
	return out
}

func removeArg(args []string, flag string) []string {
	out := make([]string, 0, len(args))
	for i := 0; i < len(args); i += 2 {
		if args[i] == flag {
			continue
		}
		out = append(out, args[i], args[i+1])
	}
	return out
}

func TestParseSocketRelative(t *testing.T) {
	if _, err := Parse(replaceArg(valid(), "--socket", "relative/tool.sock")); err == nil {
		t.Fatal("expected error for relative socket path")
	}
}

func TestParseKeteUIDZero(t *testing.T) {
	if _, err := Parse(replaceArg(valid(), "--kete-uid", "0")); err == nil {
		t.Fatal("expected error for kete-uid 0")
	}
}

func TestParseKeteUIDMissing(t *testing.T) {
	if _, err := Parse(removeArg(valid(), "--kete-uid")); err == nil {
		t.Fatal("expected error for missing kete-uid")
	}
}

func TestParseToolUIDZero(t *testing.T) {
	if _, err := Parse(replaceArg(valid(), "--tool-uid", "0")); err == nil {
		t.Fatal("expected error for tool-uid 0")
	}
}

func TestParseToolGIDZero(t *testing.T) {
	if _, err := Parse(replaceArg(valid(), "--tool-gid", "0")); err == nil {
		t.Fatal("expected error for tool-gid 0")
	}
}

func TestParseToolUIDEqualsKeteUID(t *testing.T) {
	args := replaceArg(valid(), "--tool-uid", "1000")
	if _, err := Parse(args); err == nil {
		t.Fatal("expected error when tool-uid == kete-uid")
	}
}

func TestParseWorktreeRootRelative(t *testing.T) {
	if _, err := Parse(replaceArg(valid(), "--worktree-root", "srv/worktree")); err == nil {
		t.Fatal("expected error for relative worktree-root")
	}
}

func TestParseWorktreeRootNotClean(t *testing.T) {
	if _, err := Parse(replaceArg(valid(), "--worktree-root", "/srv/../srv/worktree")); err == nil {
		t.Fatal("expected error for unclean worktree-root")
	}
	if _, err := Parse(replaceArg(valid(), "--worktree-root", "/srv/worktree/")); err == nil {
		t.Fatal("expected error for trailing slash worktree-root")
	}
}

func TestParseToolCgroupRelative(t *testing.T) {
	if _, err := Parse(replaceArg(valid(), "--tool-cgroup", "sys/fs/cgroup")); err == nil {
		t.Fatal("expected error for relative tool-cgroup")
	}
}

func TestParseEnvAllowInvalidName(t *testing.T) {
	if _, err := Parse(replaceArg(valid(), "--env-allow", "PATH,1BAD")); err == nil {
		t.Fatal("expected error for invalid env-allow name")
	}
}

func TestParseEnvAllowDuplicate(t *testing.T) {
	if _, err := Parse(replaceArg(valid(), "--env-allow", "PATH,PATH")); err == nil {
		t.Fatal("expected error for duplicate env-allow name")
	}
}

func TestParseEnvAllowEmpty(t *testing.T) {
	cfg, err := Parse(replaceArg(valid(), "--env-allow", ""))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(cfg.EnvAllow) != 0 {
		t.Errorf("expected empty env-allow, got %v", cfg.EnvAllow)
	}
}

func TestParseEnvSet(t *testing.T) {
	args := append(valid(), "--env-set", "HOME=/srv/worktree", "--env-set", "TMPDIR=/tmp")
	cfg, err := Parse(args)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cfg.EnvSet["HOME"] != "/srv/worktree" || cfg.EnvSet["TMPDIR"] != "/tmp" {
		t.Errorf("env-set = %v", cfg.EnvSet)
	}
}

func TestParseEnvSetInvalidName(t *testing.T) {
	args := append(valid(), "--env-set", "1BAD=x")
	if _, err := Parse(args); err == nil {
		t.Fatal("expected error for invalid env-set name")
	}
}

func TestParseEnvSetNoEquals(t *testing.T) {
	args := append(valid(), "--env-set", "HOME")
	if _, err := Parse(args); err == nil {
		t.Fatal("expected error for env-set with no '='")
	}
}

func TestParseEnvSetNulValue(t *testing.T) {
	args := append(valid(), "--env-set", "HOME=/tmp/\x00x")
	if _, err := Parse(args); err == nil {
		t.Fatal("expected error for env-set value containing NUL")
	}
}

func TestParseMaxFrameBounds(t *testing.T) {
	if _, err := Parse(replaceArg(valid(), "--socket", "/run/kete/tool.sock")); err != nil {
		t.Fatalf("sanity check failed: %v", err)
	}
	tooSmall := append(valid(), "--max-frame", "1024")
	if _, err := Parse(tooSmall); err == nil {
		t.Fatal("expected error for max-frame below minimum")
	}
	tooBig := append(valid(), "--max-frame", "33554432")
	if _, err := Parse(tooBig); err == nil {
		t.Fatal("expected error for max-frame above maximum")
	}
}

func TestParseMaxProcessesBounds(t *testing.T) {
	tooSmall := append(valid(), "--max-processes", "0")
	if _, err := Parse(tooSmall); err == nil {
		t.Fatal("expected error for max-processes 0")
	}
	tooBig := append(valid(), "--max-processes", "2000")
	if _, err := Parse(tooBig); err == nil {
		t.Fatal("expected error for max-processes above maximum")
	}
}

func TestParseSpawnRateAndBurst(t *testing.T) {
	if _, err := Parse(append(valid(), "--spawn-rate", "0")); err == nil {
		t.Fatal("expected error for spawn-rate 0")
	}
	if _, err := Parse(append(valid(), "--spawn-burst", "0")); err == nil {
		t.Fatal("expected error for spawn-burst 0")
	}
}
