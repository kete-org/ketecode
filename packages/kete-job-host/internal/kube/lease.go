package kube

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"time"
)

// Lease is a coordination.k8s.io/v1 Lease.
type Lease struct {
	APIVersion string     `json:"apiVersion"`
	Kind       string     `json:"kind"`
	Metadata   ObjectMeta `json:"metadata"`
	Spec       LeaseSpec  `json:"spec"`
}

// LeaseSpec is the lease record.
type LeaseSpec struct {
	HolderIdentity       *string `json:"holderIdentity,omitempty"`
	LeaseDurationSeconds *int32  `json:"leaseDurationSeconds,omitempty"`
	AcquireTime          *string `json:"acquireTime,omitempty"`
	RenewTime            *string `json:"renewTime,omitempty"`
	LeaseTransitions     *int32  `json:"leaseTransitions,omitempty"`
}

const microTime = "2006-01-02T15:04:05.000000Z07:00"

const leaseGroup = "coordination.k8s.io/v1"

// GetLease reads a Lease.
func (c *Client) GetLease(ctx context.Context, ns, name string) (Lease, error) {
	var l Lease
	return l, c.do(ctx, http.MethodGet, nsPath(leaseGroup, ns, "leases", name), nil, nil, &l)
}

// CreateLease creates a Lease (409 if it exists).
func (c *Client) CreateLease(ctx context.Context, l Lease) (Lease, error) {
	var out Lease
	return out, c.do(ctx, http.MethodPost, nsPath(leaseGroup, l.Metadata.Namespace, "leases", ""), nil, l, &out)
}

// UpdateLease replaces a Lease conditionally on its resourceVersion (409 if stale).
func (c *Client) UpdateLease(ctx context.Context, l Lease) (Lease, error) {
	var out Lease
	return out, c.do(ctx, http.MethodPut, nsPath(leaseGroup, l.Metadata.Namespace, "leases", l.Metadata.Name), nil, l, &out)
}

// Elector holds a Lease so that exactly one controller replica polls with the host's key (spec
// §4.1: never two pollers on one key). It follows client-go's leader election: a lease held by
// someone else counts as expired only when this replica has seen the same record, unchanged, for
// a whole lease duration on its own clock (so clock skew between nodes doesn't matter), and every
// write is conditional on the resourceVersion read (the API server serialises contenders).
type Elector struct {
	Client    *Client
	Namespace string
	Name      string
	// Identity is this replica's holder identity (its pod name).
	Identity string
	// Duration is the lease duration; RenewDeadline how long renewals may fail before leadership
	// counts as lost (< Duration); Retry the attempt period. Defaults 15 s, 10 s, 2 s.
	Duration, RenewDeadline, Retry time.Duration
	Log                            *slog.Logger
	// Now is the local clock (tests).
	Now func() time.Time

	observedRV   string
	observedTime time.Time
}

// ErrLost means the lease could not be renewed within the renew deadline, or another replica took
// it: the caller must stop everything that acts as the host (the runner exits and is restarted).
var ErrLost = errors.New("kube: lease lost")

func (e *Elector) defaults() {
	if e.Duration == 0 {
		e.Duration = 15 * time.Second
	}
	if e.RenewDeadline == 0 {
		e.RenewDeadline = 10 * time.Second
	}
	if e.Retry == 0 {
		e.Retry = 2 * time.Second
	}
	if e.Now == nil {
		e.Now = time.Now
	}
	if e.Log == nil {
		e.Log = slog.New(slog.DiscardHandler)
	}
}

// Acquire blocks until this replica holds the lease (or ctx ends).
func (e *Elector) Acquire(ctx context.Context) error {
	e.defaults()
	logged := false
	for {
		ok, holder, err := e.try(ctx)
		if err != nil {
			e.Log.Warn("lease_error", "lease", e.Name, "error", err.Error())
		}
		if ok {
			e.Log.Info("lease_acquired", "lease", e.Name, "identity", e.Identity)
			return nil
		}
		if !logged && holder != "" {
			e.Log.Info("lease_waiting", "lease", e.Name, "holder", holder)
			logged = true
		}
		if err := sleepCtx(ctx, e.Retry); err != nil {
			return err
		}
	}
}

// Hold renews the lease until ctx ends (then releases it and returns nil) or leadership is lost
// (ErrLost).
func (e *Elector) Hold(ctx context.Context) error {
	e.defaults()
	last := e.Now()
	for {
		if err := sleepCtx(ctx, e.Retry); err != nil {
			e.release()
			return nil
		}
		ok, holder, err := e.try(ctx)
		switch {
		case ok:
			last = e.Now()
		case holder != "" && holder != e.Identity:
			return fmt.Errorf("%w: now held by %s", ErrLost, holder)
		default:
			if err != nil {
				e.Log.Warn("lease_renew_failed", "lease", e.Name, "error", err.Error())
			}
			if e.Now().Sub(last) > e.RenewDeadline {
				return fmt.Errorf("%w: not renewed for %s", ErrLost, e.RenewDeadline)
			}
		}
	}
}

// try acquires or renews once. It returns whether this replica holds the lease, the current
// holder when another does, and any API error.
func (e *Elector) try(ctx context.Context) (bool, string, error) {
	now := e.Now()
	nowS := now.UTC().Format(microTime)
	dur := int32(e.Duration / time.Second)
	l, err := e.Client.GetLease(ctx, e.Namespace, e.Name)
	if IsNotFound(err) {
		id, zero := e.Identity, int32(0)
		_, err := e.Client.CreateLease(ctx, Lease{
			APIVersion: leaseGroup, Kind: "Lease",
			Metadata: ObjectMeta{Name: e.Name, Namespace: e.Namespace, Labels: map[string]string{"app.kubernetes.io/managed-by": "kete-runner"}},
			Spec:     LeaseSpec{HolderIdentity: &id, LeaseDurationSeconds: &dur, AcquireTime: &nowS, RenewTime: &nowS, LeaseTransitions: &zero},
		})
		if err != nil {
			return false, "", err
		}
		e.observedRV, e.observedTime = "", now
		return true, e.Identity, nil
	}
	if err != nil {
		return false, "", err
	}
	holder := ""
	if l.Spec.HolderIdentity != nil {
		holder = *l.Spec.HolderIdentity
	}
	if l.Metadata.ResourceVersion != e.observedRV {
		e.observedRV, e.observedTime = l.Metadata.ResourceVersion, now
	}
	held := holder != "" && holder != e.Identity
	if held {
		d := e.Duration
		if l.Spec.LeaseDurationSeconds != nil && *l.Spec.LeaseDurationSeconds > 0 {
			d = time.Duration(*l.Spec.LeaseDurationSeconds) * time.Second
		}
		if now.Before(e.observedTime.Add(d)) {
			return false, holder, nil
		}
	}
	spec := l.Spec
	if holder != e.Identity {
		id := e.Identity
		spec.HolderIdentity = &id
		spec.AcquireTime = &nowS
		n := int32(1)
		if spec.LeaseTransitions != nil {
			n = *spec.LeaseTransitions + 1
		}
		spec.LeaseTransitions = &n
	}
	spec.RenewTime = &nowS
	spec.LeaseDurationSeconds = &dur
	l.Spec = spec
	out, err := e.Client.UpdateLease(ctx, l)
	if err != nil {
		if IsConflict(err) {
			return false, holder, nil
		}
		return false, "", err
	}
	e.observedRV, e.observedTime = out.Metadata.ResourceVersion, now
	return true, e.Identity, nil
}

// release gives the lease up (best effort) so a replacement replica takes over at once.
func (e *Elector) release() {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	l, err := e.Client.GetLease(ctx, e.Namespace, e.Name)
	if err != nil || l.Spec.HolderIdentity == nil || *l.Spec.HolderIdentity != e.Identity {
		return
	}
	empty, one := "", int32(1)
	l.Spec.HolderIdentity = &empty
	l.Spec.LeaseDurationSeconds = &one
	if _, err := e.Client.UpdateLease(ctx, l); err == nil {
		e.Log.Info("lease_released", "lease", e.Name)
	}
}

func sleepCtx(ctx context.Context, d time.Duration) error {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return nil
	}
}
