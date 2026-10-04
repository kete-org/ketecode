// Package ratelimit implements a token bucket used to bound SPAWN requests and accepted
// connections (module README "Limits"). The clock is injected so tests run without real time.
package ratelimit

import (
	"sync"
	"time"
)

// Clock returns the current time. time.Now satisfies it.
type Clock func() time.Time

// Bucket is a token bucket: Allow consumes one token if available, refilling continuously at
// rate tokens/second up to burst. Safe for concurrent use.
type Bucket struct {
	mu     sync.Mutex
	rate   float64
	burst  float64
	tokens float64
	last   time.Time
	clock  Clock
}

// New creates a bucket starting full (burst tokens available), refilling at rate tokens/second.
func New(rate float64, burst int, clock Clock) *Bucket {
	if clock == nil {
		clock = time.Now
	}
	return &Bucket{
		rate:   rate,
		burst:  float64(burst),
		tokens: float64(burst),
		last:   clock(),
		clock:  clock,
	}
}

// Allow reports whether a token is available and, if so, consumes it.
func (b *Bucket) Allow() bool {
	b.mu.Lock()
	defer b.mu.Unlock()

	now := b.clock()
	if elapsed := now.Sub(b.last); elapsed > 0 {
		b.tokens += elapsed.Seconds() * b.rate
		if b.tokens > b.burst {
			b.tokens = b.burst
		}
		b.last = now
	}

	if b.tokens < 1 {
		return false
	}
	b.tokens--
	return true
}
