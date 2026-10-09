package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/kete-org/ketecode/packages/kete-job-host/internal/contract"
	"github.com/kete-org/ketecode/packages/kete-job-host/internal/publish"
)

// cmdPublish is `kete-job-host publish`: the publisher pod's only command (enterprise runtime P3).
// Its configuration, outbox, writer and CA paths are fixed (the admission policy pins the pod's
// mounts); the flags carry only the platform's run-machine values, each given exactly once. The
// outcome is written as JSON to the termination message file; exit 0 once it is written.
func cmdPublish(args []string, stderr io.Writer) int {
	log := slog.New(slog.NewJSONHandler(stderr, nil)).With("agent_version", version, "component", "publisher")
	seen := map[string]bool{}
	for _, a := range args {
		name, _, _ := strings.Cut(strings.TrimLeft(a, "-"), "=")
		if strings.HasPrefix(a, "-") {
			if seen[name] {
				fmt.Fprintf(stderr, "kete-job-host publish: flag %s given twice\n", name)
				return 2
			}
			seen[name] = true
		}
	}
	fs := flag.NewFlagSet("publish", flag.ContinueOnError)
	fs.SetOutput(stderr)
	var req publish.Request
	fs.StringVar(&req.MachineID, "machine", "", "machine id")
	fs.StringVar(&req.JobID, "job", "", "job id")
	fs.StringVar(&req.Repository, "repository", "", "runtime repository name")
	fs.StringVar(&req.BaseRef, "base-ref", "", "base branch")
	fs.StringVar(&req.Branch, "branch", "", "job branch (kete/job/…)")
	fs.StringVar(&req.BaseSHA, "base-sha", "", "the commit the controller resolved base_ref to (none: unknown)")
	fs.BoolVar(&req.OpenMR, "open-mr", false, "open a draft merge request")
	outFile := fs.String("outcome-file", "/dev/termination-log", "where the outcome JSON is written")
	if err := fs.Parse(args); err != nil || fs.NArg() != 0 || !contract.ValidUUID(req.MachineID) {
		fmt.Fprintln(stderr, "usage: kete-job-host publish --machine ID --job ID --repository NAME --base-ref REF --branch BRANCH --base-sha SHA|none [--open-mr]")
		return 2
	}
	if req.BaseSHA == "none" {
		req.BaseSHA = ""
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, os.Interrupt)
	defer stop()
	ctx, cancel := context.WithTimeout(ctx, 10*time.Minute)
	defer cancel()

	out := contract.PublishOutcome{Status: contract.PublishFailed, Reason: "publisher_failed"}
	cfg, err := publish.LoadConfig(publish.ConfigFile)
	if err != nil {
		log.Error("publish_config_invalid", "error", err.Error())
	} else if hc, err := publish.HTTPClient(cfg, publish.CAFile, publish.ProxyAuthFile); err != nil {
		log.Error("publish_transport_invalid", "error", err.Error())
	} else {
		out = publish.Run(ctx, publish.Options{Config: cfg, OutboxDir: publish.OutboxDir, WriterDir: publish.WriterDir, HTTP: hc, Log: log}, req)
	}
	b, err := json.Marshal(out)
	if err == nil {
		err = os.WriteFile(*outFile, b, 0o644)
	}
	if err != nil {
		log.Error("publish_outcome_not_written", "error", err.Error())
		return 1
	}
	return 0
}
