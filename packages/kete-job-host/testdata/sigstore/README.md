Test data for `internal/image` (cosign keyless verification, offline):

- `trusted_root.json`: the Sigstore public-good trusted root, fetched through TUF on 2026-10-03.
- `github-mcp-server-v1.14.0.bundle.json`: a real cosign v3 Sigstore bundle (DSSE, in-toto
  statement, predicate `https://sigstore.dev/cosign/sign/v1`) from the `sha256-<digest>` referrer
  tag of `ghcr.io/github/github-mcp-server@sha256:7aaeeec9ae4fe9a736d100c1ff0798f3c219b5009e05f5d3945fcacb13cc196b`,
  signed by `https://github.com/github/github-mcp-server/.github/workflows/docker-publish.yml@refs/tags/v1.14.0`
  (issuer `https://token.actions.githubusercontent.com`). It is public data; Kete's own release has
  not been signed yet, so the tests run the production code path with this signer's identity and
  check that Kete's release identity refuses it.
