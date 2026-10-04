// Package policy answers the proxy's one allowlist question — may this port reach this host in
// this phase? — and names the refusal reasons that appear in the request log (module README "Log
// format v1"). Hosts are compared exactly, after internal/hostname normalisation; in the none and
// closed phases nothing is allowed.
package policy

import (
	"github.com/kete-org/ketecode/packages/kete-egress/internal/config"
	"github.com/kete-org/ketecode/packages/kete-egress/internal/phase"
)

// Refusal reasons written to the request log's "reason" field. Registry reasons live in
// internal/registry.
const (
	ReasonNotAllowed     = "host_not_allowed"   // host not allowed for this phase and port
	ReasonBadConnect     = "bad_connect"        // malformed CONNECT head, or not CONNECT
	ReasonPort           = "port"               // CONNECT to a port other than 443
	ReasonBadHost        = "bad_host"           // CONNECT host isn't a plain DNS name
	ReasonPeerUID        = "peer_uid"           // the connecting socket's owner isn't the port's user
	ReasonConnLimit      = "conn_limit"         // too many open client connections
	ReasonSNIMismatch    = "sni_mismatch"       // TLS SNI missing or differing from the CONNECT host
	ReasonTLS            = "tls_handshake"      // any other client-side TLS failure
	ReasonHostMismatch   = "host_mismatch"      // a request's Host differs from the CONNECT host
	ReasonProtocol       = "protocol"           // not HTTP/1.1 (HTTP/1.0, an h2 preface)
	ReasonTarget         = "target"             // absolute-form or asterisk-form request target
	ReasonUpgrade        = "upgrade"            // Upgrade / Connection: upgrade (WebSocket, h2c)
	ReasonBodyTooLarge   = "body_too_large"     // request body over the limit
	ReasonLogFull        = "log_full"           // the request log is full
	ReasonResolvedBlock  = "resolved_blocked"   // every address of the host is in a blocked range
	ReasonUpstream       = "upstream_error"     // dial, TLS verification or upstream I/O failure
	ReasonIdle           = "idle_timeout"       // no bytes either way for the stream-idle limit
	ReasonResolveFailure = "resolve_failed"     // the proxy's own DNS lookup failed
	ReasonUnsupported    = "unsupported_method" // CONNECT tunnels only; plain-HTTP proxying refused
)

// Policy is the immutable allowlist.
type Policy struct {
	allow map[phase.Phase]map[config.Port]map[string]bool
}

// New builds the policy from a validated configuration.
func New(cfg *config.Config) *Policy {
	return &Policy{allow: cfg.Allow}
}

// Allowed reports whether port may reach host (normalised) in phase ph.
func (p *Policy) Allowed(ph phase.Phase, port config.Port, host string) bool {
	if ph == phase.None || ph == phase.Closed {
		return false
	}
	return p.allow[ph][port][host]
}
