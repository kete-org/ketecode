// Package config turns the helper's command-line flags into a validated Config. Every field here
// is fixed for the life of the process: nothing in a request can change identity, the worktree
// root, the cgroup, the env allowlist or any limit (see the module README, "Start-up
// configuration"). This package does no I/O — every check here is a syntactic one on the flag
// values themselves; filesystem, kernel and cgroup checks run at start-up in cmd/kete-root-helper
// and internal/cgroup.
package config

import (
	"flag"
	"fmt"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

const (
	KiB = 1024
	MiB = 1024 * KiB

	DefaultMaxFrame     = 1 * MiB
	MinMaxFrame         = 64 * KiB
	MaxMaxFrame         = 16 * MiB
	DefaultMaxProcesses = 32
	MinMaxProcesses     = 1
	MaxMaxProcesses     = 1024
	DefaultSpawnRate    = 20.0
	DefaultSpawnBurst   = 40
)

var envNamePattern = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)

// Config is the helper's fixed start-up configuration, parsed once from flags.
type Config struct {
	Socket       string
	KeteUID      uint32
	ToolUID      uint32
	ToolGID      uint32
	WorktreeRoot string
	ToolCgroup   string
	EnvAllow     []string
	EnvSet       map[string]string
	MaxFrame     uint32
	MaxProcesses int
	SpawnRate    float64
	SpawnBurst   int
}

// envSetFlag collects repeated `--env-set NAME=VALUE` flags in order.
type envSetFlag struct {
	values *[]string
}

func (f envSetFlag) String() string {
	if f.values == nil {
		return ""
	}
	return strings.Join(*f.values, ",")
}

func (f envSetFlag) Set(value string) error {
	*f.values = append(*f.values, value)
	return nil
}

// Parse parses and validates args (excluding the program name). It never touches the filesystem.
func Parse(args []string) (Config, error) {
	fs := flag.NewFlagSet("kete-root-helper", flag.ContinueOnError)
	fs.Usage = func() {}

	socket := fs.String("socket", "", "unix socket path to listen on")
	keteUID := fs.Int64("kete-uid", -1, "the only peer uid accepted on the socket")
	toolUID := fs.Int64("tool-uid", -1, "the fixed uid every spawned process runs as")
	toolGID := fs.Int64("tool-gid", -1, "the fixed gid every spawned process runs as")
	worktreeRoot := fs.String("worktree-root", "", "absolute path every spawn's cwd must resolve beneath")
	toolCgroup := fs.String("tool-cgroup", "", "the cgroup v2 directory every spawn's leaf is created under")
	envAllow := fs.String("env-allow", "", "comma-separated allowed env variable names")
	maxFrame := fs.Uint("max-frame", DefaultMaxFrame, "max frame body size in bytes")
	maxProcesses := fs.Uint("max-processes", DefaultMaxProcesses, "max live spawns")
	spawnRate := fs.Float64("spawn-rate", DefaultSpawnRate, "spawn/connection token bucket refill rate per second")
	spawnBurst := fs.Uint("spawn-burst", DefaultSpawnBurst, "spawn/connection token bucket burst size")
	var envSetValues []string
	fs.Var(envSetFlag{&envSetValues}, "env-set", "NAME=VALUE, repeatable; overrides a request's value for NAME")

	if err := fs.Parse(args); err != nil {
		return Config{}, err
	}

	cfg := Config{
		Socket:       *socket,
		WorktreeRoot: *worktreeRoot,
		ToolCgroup:   *toolCgroup,
		MaxFrame:     uint32(*maxFrame),
		MaxProcesses: int(*maxProcesses),
		SpawnRate:    *spawnRate,
		SpawnBurst:   int(*spawnBurst),
	}

	if !filepath.IsAbs(cfg.Socket) {
		return Config{}, fmt.Errorf("--socket must be an absolute path (got %q)", cfg.Socket)
	}

	if *keteUID < 0 {
		return Config{}, fmt.Errorf("--kete-uid is required")
	}
	if *keteUID == 0 {
		return Config{}, fmt.Errorf("--kete-uid must not be 0")
	}
	cfg.KeteUID = uint32(*keteUID)

	if *toolUID < 0 {
		return Config{}, fmt.Errorf("--tool-uid is required")
	}
	if *toolUID == 0 {
		return Config{}, fmt.Errorf("--tool-uid must not be 0")
	}
	cfg.ToolUID = uint32(*toolUID)

	if *toolGID < 0 {
		return Config{}, fmt.Errorf("--tool-gid is required")
	}
	if *toolGID == 0 {
		return Config{}, fmt.Errorf("--tool-gid must not be 0")
	}
	cfg.ToolGID = uint32(*toolGID)

	if cfg.ToolUID == cfg.KeteUID {
		return Config{}, fmt.Errorf("--tool-uid must differ from --kete-uid")
	}

	if !filepath.IsAbs(*worktreeRoot) || filepath.Clean(*worktreeRoot) != *worktreeRoot {
		return Config{}, fmt.Errorf("--worktree-root must be an absolute, clean path (got %q)", *worktreeRoot)
	}

	if !filepath.IsAbs(*toolCgroup) {
		return Config{}, fmt.Errorf("--tool-cgroup must be an absolute path (got %q)", *toolCgroup)
	}

	allow, err := parseEnvAllow(*envAllow)
	if err != nil {
		return Config{}, err
	}
	cfg.EnvAllow = allow

	envSet, err := parseEnvSet(envSetValues)
	if err != nil {
		return Config{}, err
	}
	cfg.EnvSet = envSet

	if cfg.MaxFrame < MinMaxFrame || cfg.MaxFrame > MaxMaxFrame {
		return Config{}, fmt.Errorf("--max-frame must be between %d and %d (got %d)", MinMaxFrame, MaxMaxFrame, cfg.MaxFrame)
	}

	if cfg.MaxProcesses < MinMaxProcesses || cfg.MaxProcesses > MaxMaxProcesses {
		return Config{}, fmt.Errorf("--max-processes must be between %d and %d (got %d)", MinMaxProcesses, MaxMaxProcesses, cfg.MaxProcesses)
	}

	if cfg.SpawnRate <= 0 {
		return Config{}, fmt.Errorf("--spawn-rate must be > 0 (got %v)", cfg.SpawnRate)
	}
	if cfg.SpawnBurst <= 0 {
		return Config{}, fmt.Errorf("--spawn-burst must be > 0 (got %d)", cfg.SpawnBurst)
	}

	return cfg, nil
}

func parseEnvAllow(raw string) ([]string, error) {
	if raw == "" {
		return nil, nil
	}
	parts := strings.Split(raw, ",")
	seen := make(map[string]bool, len(parts))
	names := make([]string, 0, len(parts))
	for _, part := range parts {
		if !envNamePattern.MatchString(part) {
			return nil, fmt.Errorf("--env-allow: invalid env variable name %q", part)
		}
		if seen[part] {
			return nil, fmt.Errorf("--env-allow: duplicate env variable name %q", part)
		}
		seen[part] = true
		names = append(names, part)
	}
	sort.Strings(names)
	return names, nil
}

func parseEnvSet(values []string) (map[string]string, error) {
	if len(values) == 0 {
		return nil, nil
	}
	out := make(map[string]string, len(values))
	for _, value := range values {
		name, val, ok := strings.Cut(value, "=")
		if !ok {
			return nil, fmt.Errorf("--env-set: expected NAME=VALUE (got %q)", value)
		}
		if !envNamePattern.MatchString(name) {
			return nil, fmt.Errorf("--env-set: invalid env variable name %q", name)
		}
		if strings.ContainsRune(val, 0) {
			return nil, fmt.Errorf("--env-set: value for %q contains a NUL byte", name)
		}
		out[name] = val
	}
	return out, nil
}
