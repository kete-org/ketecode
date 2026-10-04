# Kete Code

`kete`, the Kete Code AI coding agent, for macOS, Linux and Windows.

```sh
npm install -g @ketecode/cli
kete
```

This package is a small launcher. npm installs the binary for your platform from one optional
dependency (`@ketecode/cli-darwin-arm64`, `@ketecode/cli-linux-x64`, …); x64 packages carry the
baseline build, which runs on CPUs without AVX2. Update with `npm install -g @ketecode/cli@latest`
(`kete upgrade` tells you the same: it never replaces a package manager's files).

Other ways to install, and how to verify a release's signature: <https://github.com/kete-org/kete-releases>.

Kete Code is built on [OpenCode](https://github.com/anomalyco/opencode) (MIT); see `LICENSE` and `NOTICE`.
