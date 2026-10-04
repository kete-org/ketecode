//go:build !linux

package main

import (
	"fmt"
	"os"
)

func main() {
	fmt.Fprintln(os.Stderr, "kete-job-entrypoint runs only on Linux")
	os.Exit(2)
}
