# Request to kete-code-platform: CLI login without a local listener

Status: proposed, not implemented on either side. The client will not build this until the
platform agrees on the contract.

## Problem

`kete login` (`docs/platform/cli-login-v1.md`) needs the browser to reach
`http://127.0.0.1:<port>` on the machine running the CLI. That fails when:

- the CLI runs over SSH and the browser is on another machine, and the user can't or won't
  forward a port (`kete login --port <n>` plus `ssh -L <n>:127.0.0.1:<n>` covers the rest);
- the CLI runs in a container or cloud dev environment without port forwarding.

VS Code Remote-SSH forwards ports automatically, so it is expected to work with the current
flow (still to be confirmed by hand).

## Proposal

A copy-paste variant of the same PKCE flow, modelled on OAuth's out-of-band pattern and the
login flows of other CLIs:

1. The CLI opens or prints `/cli/authorize?mode=manual&state=…&code_challenge=…&code_challenge_method=S256&device_name=…`,
   with no `port`.
2. On approve, instead of redirecting, the portal shows the one-time code on the page, with a
   copy button and a warning to paste it only into the terminal that started the login.
3. The user pastes the code into the CLI's prompt.
4. The CLI calls the existing `POST /api/v1/cli/token` with `{code, code_verifier, device_name}`.
   PKCE still binds the code to the terminal that holds the verifier, so a leaked code alone is
   useless.

## Platform changes

- `AuthorizeParams`: accept `mode=manual` with `port` absent (exactly one of the two).
- The authorize page: in manual mode, render the code instead of redirecting; on deny, say so on
  the page.
- Consider a shorter code lifetime for manual mode, and a code format that is easy to type
  (for example base32 groups) if copy-paste is unavailable.
- No change to `/api/v1/cli/token`.

## Client changes, once agreed

`kete login --manual`: skip the listener, print the URL, and prompt for the code on stdin.
In an SSH session without `--port`, suggest it.
