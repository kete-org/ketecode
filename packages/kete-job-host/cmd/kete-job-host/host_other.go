//go:build !linux

package main

import (
	"errors"
	"log/slog"

	"github.com/kete-org/ketecode/packages/kete-job-host/internal/config"
	"github.com/kete-org/ketecode/packages/kete-job-host/internal/driver"
)

func hostKernel() (string, error) { return "", errors.New("kete-job-host runs on Linux only") }

func kvmPresent() bool { return false }

func newDriver(config.Config, *slog.Logger) (driver.Driver, error) {
	return nil, errors.New("kete-job-host runs on Linux only")
}

func driverChecks(config.Config, func(string, error), func(string, string)) {}

func hidden([]string) (int, bool) { return 0, false }
