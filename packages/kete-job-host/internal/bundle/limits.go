// Package bundle validates a job's change bundle as hostile (ADR 0011 decision 3; the publisher of
// the Kubernetes runner): a Go port of kete-code-platform `apps/portal/lib/jobs/bundle/` (gzip.ts,
// tar.ts, paths.ts, secrets.ts, limits.ts, validate.ts — platform ADR 0021 rule 6), held to the
// platform validator's own results by the vectors in `testdata/bundle-v1/` (generated from it).
// The bundle is parsed in memory while streaming and never extracted; the first refusal wins and
// is one of the platform's fixed codes. A change here is a change to a shared contract: change the
// platform's validator and regenerate the vectors first.
package bundle

// Limits (ADR 0021 rule 6; platform limits.ts), identical to the entrypoint's
// (`internal/layout`, `BundleMax*`).
const (
	// MaxCompressed is the compressed bundle's size cap.
	MaxCompressed = 10_000_000
	// MaxDecompressed counts every tar byte (headers, extension records, padding).
	MaxDecompressed = 20_000_000
	// MaxEntries is the manifest's entry cap.
	MaxEntries = 1000
	// MaxFile is a text file's cap.
	MaxFile = 1_000_000
	// MaxBinaryFile is a binary file's cap (a NUL in its first BinarySniffBytes bytes).
	MaxBinaryFile = 256_000
	// MaxBinaries is the binary files' count cap.
	MaxBinaries = 50
	// MaxManifest is manifest.json's cap.
	MaxManifest = 5_000_000
	// BinarySniffBytes is git's binary heuristic window.
	BinarySniffBytes = 8000
)
