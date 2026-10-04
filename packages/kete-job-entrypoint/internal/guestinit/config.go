package guestinit

import (
	"bytes"
	"errors"
	"io"

	"github.com/kete-org/ketecode/packages/kete-job-entrypoint/internal/bootenv"
	"github.com/kete-org/ketecode/packages/kete-job-entrypoint/internal/hostprofile"
)

// MaxDiskRead bounds how much of the config disk is read: the header, the JSON (at most
// bootenv.MaxConfig) and NUL padding are all inside it.
const MaxDiskRead = 64 << 10

// ParseConfigDisk reads the microvm config disk (ADR 0023 rule 13): exactly
// hostprofile.ConfigDiskHeader, then one JSON object (bootenv.Config, profile microvm), then only
// NUL bytes up to the end of what was read (the disk's padding). The JSON ends at the first NUL
// byte or at the end of the device; a disk whose JSON doesn't end within MaxDiskRead is oversize.
func ParseConfigDisk(r io.Reader) (bootenv.Config, error) {
	data, err := io.ReadAll(io.LimitReader(r, MaxDiskRead+1))
	if err != nil {
		return bootenv.Config{}, err
	}
	defer clear(data)
	if !bytes.HasPrefix(data, []byte(hostprofile.ConfigDiskHeader)) {
		return bootenv.Config{}, errors.New("config disk: bad header")
	}
	body := data[len(hostprofile.ConfigDiskHeader):]
	end := bytes.IndexByte(body, 0)
	if end < 0 {
		if len(data) > MaxDiskRead {
			return bootenv.Config{}, errors.New("config disk: oversize")
		}
		end = len(body)
	}
	for _, b := range body[end:] {
		if b != 0 {
			return bootenv.Config{}, errors.New("config disk: data after the config")
		}
	}
	js := bytes.TrimRight(body[:end], " \t\r\n")
	if len(js) > bootenv.MaxConfig {
		return bootenv.Config{}, errors.New("config disk: oversize")
	}
	cfg, err := bootenv.ParseConfig(js)
	if err != nil {
		return bootenv.Config{}, err
	}
	if cfg.HostProfile != string(hostprofile.MicroVM) {
		return bootenv.Config{}, errors.New("config disk: host_profile must be microvm")
	}
	return cfg, nil
}
