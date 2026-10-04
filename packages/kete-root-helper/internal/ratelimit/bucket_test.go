package ratelimit

import (
	"testing"
	"time"
)

type fakeClock struct{ now time.Time }

func (c *fakeClock) tick(d time.Duration) { c.now = c.now.Add(d) }
func (c *fakeClock) Now() time.Time       { return c.now }

func TestBucketStartsFull(t *testing.T) {
	clock := &fakeClock{now: time.Unix(0, 0)}
	b := New(1, 3, clock.Now)
	for i := 0; i < 3; i++ {
		if !b.Allow() {
			t.Fatalf("token %d should be available", i)
		}
	}
	if b.Allow() {
		t.Fatal("bucket should be exhausted after burst tokens")
	}
}

func TestBucketRefillsOverTime(t *testing.T) {
	clock := &fakeClock{now: time.Unix(0, 0)}
	b := New(2, 2, clock.Now) // 2 tokens/sec, burst 2
	if !b.Allow() || !b.Allow() {
		t.Fatal("expected the initial burst to be available")
	}
	if b.Allow() {
		t.Fatal("expected the bucket to be empty")
	}
	clock.tick(500 * time.Millisecond) // 0.5s * 2/s = 1 token
	if !b.Allow() {
		t.Fatal("expected a token to have refilled after 500ms")
	}
	if b.Allow() {
		t.Fatal("expected only one token to have refilled")
	}
}

func TestBucketRefillCapsAtBurst(t *testing.T) {
	clock := &fakeClock{now: time.Unix(0, 0)}
	b := New(100, 5, clock.Now)
	for i := 0; i < 5; i++ {
		b.Allow()
	}
	clock.tick(10 * time.Second) // would refill far past burst
	count := 0
	for b.Allow() {
		count++
	}
	if count != 5 {
		t.Errorf("expected refill capped at burst (5), got %d", count)
	}
}

func TestBucketConcurrentUse(t *testing.T) {
	b := New(1000, 1000, time.Now)
	done := make(chan int, 10)
	for g := 0; g < 10; g++ {
		go func() {
			allowed := 0
			for i := 0; i < 100; i++ {
				if b.Allow() {
					allowed++
				}
			}
			done <- allowed
		}()
	}
	total := 0
	for g := 0; g < 10; g++ {
		total += <-done
	}
	if total > 1000 {
		t.Errorf("expected at most 1000 tokens granted, got %d", total)
	}
	if total < 900 {
		t.Errorf("expected close to 1000 tokens granted (burst 1000), got %d", total)
	}
}
