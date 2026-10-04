package proxy

import (
	"net"
	"sync"
	"sync/atomic"
	"time"

	"github.com/kete-org/ketecode/packages/kete-egress/internal/config"
)

// Limits (module README "Limits"). The configuration can lower the registry cap and the log
// size; these are fixed.
const (
	MaxConnsTotal = 512

	ConnectTimeout       = 10 * time.Second // CONNECT head read
	ClientTLSTimeout     = 10 * time.Second
	ConnectHeaderBytes   = 8 << 10
	RequestHeaderBytes   = 32 << 10
	ClientIdle           = 90 * time.Second // keep-alive between requests
	RequestHeaderTime    = 10 * time.Second
	UpstreamDialTimeout  = 10 * time.Second
	UpstreamTLSTimeout   = 10 * time.Second
	UpstreamHeaderTime   = 300 * time.Second // model streams can be slow to start
	UpstreamIdle         = 90 * time.Second
	UpstreamConnsPerHost = 64
	StreamIdle           = 300 * time.Second // no bytes either way, then close
	MaxRequestBody       = 64 << 20
	ResolveTimeout       = 5 * time.Second

	acceptBackoffMin = 50 * time.Millisecond
	acceptBackoffMax = time.Second
)

// MaxConnsPerPort bounds open client connections per port.
var MaxConnsPerPort = map[config.Port]int{
	config.PortKete: 64,
	config.PortTool: 256,
	config.PortRoot: 32,
}

// idleConn records the last time bytes moved either way, for the stream-idle watchdog.
type idleConn struct {
	net.Conn
	last atomic.Int64
}

func newIdleConn(c net.Conn) *idleConn {
	ic := &idleConn{Conn: c}
	ic.touch()
	return ic
}

func (c *idleConn) touch() { c.last.Store(time.Now().UnixNano()) }

func (c *idleConn) Read(b []byte) (int, error) {
	n, err := c.Conn.Read(b)
	if n > 0 {
		c.touch()
	}
	return n, err
}

func (c *idleConn) Write(b []byte) (int, error) {
	n, err := c.Conn.Write(b)
	if n > 0 {
		c.touch()
	}
	return n, err
}

// watch closes the connection once no bytes have moved for idle, and returns a stop function.
func (c *idleConn) watch(idle time.Duration, onIdle func()) (stop func()) {
	var mu sync.Mutex
	var t *time.Timer
	stopped := false
	check := func() {
		mu.Lock()
		defer mu.Unlock()
		if stopped {
			return
		}
		since := time.Since(time.Unix(0, c.last.Load()))
		if since >= idle {
			onIdle()
			_ = c.Conn.Close()
			return
		}
		t.Reset(idle - since)
	}
	mu.Lock()
	t = time.AfterFunc(idle, check)
	mu.Unlock()
	return func() {
		mu.Lock()
		defer mu.Unlock()
		stopped = true
		t.Stop()
	}
}
