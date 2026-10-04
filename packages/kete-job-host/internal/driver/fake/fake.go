// Package fake is an in-memory Driver for tests: machines are table entries whose status, start
// failures, hangs and console lines the test controls. It records the configuration each machine
// received (a real driver never keeps it) so tests can assert delivery. It survives an agent
// "restart" by being handed to the next agent, like VMs outliving the agent process.
package fake

import (
	"context"
	"errors"
	"sort"
	"sync"

	"github.com/kete-org/ketecode/packages/kete-job-host/internal/driver"
)

// Machine is a fake machine.
type Machine struct {
	Spec   driver.Spec
	Config []byte
	Status driver.Status
	Lines  [][]byte
}

// Driver is the fake. Safe for concurrent use.
type Driver struct {
	mu        sync.Mutex
	machines  map[string]*Machine
	failStart map[string]bool
	failStop  map[string]bool
	hang      map[string]bool
	failList  bool
	starts    int
	stops     []string
}

// New returns an empty fake.
func New() *Driver {
	return &Driver{machines: map[string]*Machine{}, failStart: map[string]bool{}, failStop: map[string]bool{}, hang: map[string]bool{}}
}

var errFake = errors.New("fake driver: injected failure")

// wait blocks a call on a hung machine until its context ends (a driver must honour the
// context; the agent bounds every call with a timeout).
func (d *Driver) wait(ctx context.Context, id string) error {
	d.mu.Lock()
	h := d.hang[id]
	d.mu.Unlock()
	if !h {
		return nil
	}
	<-ctx.Done()
	return ctx.Err()
}

// Start implements driver.Driver.
func (d *Driver) Start(ctx context.Context, s driver.Spec) error {
	if err := d.wait(ctx, s.MachineID); err != nil {
		return err
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	d.starts++
	if d.failStart[s.MachineID] {
		return errFake
	}
	if _, ok := d.machines[s.MachineID]; ok {
		return errors.New("fake driver: machine exists")
	}
	cfg := append([]byte(nil), s.Config...)
	s.Config = nil
	d.machines[s.MachineID] = &Machine{Spec: s, Config: cfg, Status: driver.StatusRunning}
	return nil
}

// Stop implements driver.Driver.
func (d *Driver) Stop(ctx context.Context, id string) error {
	if err := d.wait(ctx, id); err != nil {
		return err
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.failStop[id] {
		return errFake
	}
	if _, ok := d.machines[id]; ok {
		d.stops = append(d.stops, id)
	}
	delete(d.machines, id)
	return nil
}

// Status implements driver.Driver.
func (d *Driver) Status(ctx context.Context, id string) (driver.Status, error) {
	if err := d.wait(ctx, id); err != nil {
		return 0, err
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	m, ok := d.machines[id]
	if !ok {
		return driver.StatusGone, nil
	}
	return m.Status, nil
}

// List implements driver.Driver.
func (d *Driver) List(context.Context) ([]string, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.failList {
		return nil, errFake
	}
	ids := make([]string, 0, len(d.machines))
	for id := range d.machines {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	return ids, nil
}

// Logs implements driver.Driver: the lines queued since the last call.
func (d *Driver) Logs(ctx context.Context, id string) ([][]byte, error) {
	if err := d.wait(ctx, id); err != nil {
		return nil, err
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	m, ok := d.machines[id]
	if !ok {
		return nil, nil
	}
	out := m.Lines
	m.Lines = nil
	return out, nil
}

// --- test controls

// Get returns a copy of a machine, or false.
func (d *Driver) Get(id string) (Machine, bool) {
	d.mu.Lock()
	defer d.mu.Unlock()
	m, ok := d.machines[id]
	if !ok {
		return Machine{}, false
	}
	return *m, true
}

// SetStatus changes a machine's status (exited, crashed, …).
func (d *Driver) SetStatus(id string, s driver.Status) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if m, ok := d.machines[id]; ok {
		m.Status = s
	}
}

// Emit queues raw console lines for a machine.
func (d *Driver) Emit(id string, lines ...string) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if m, ok := d.machines[id]; ok {
		for _, l := range lines {
			m.Lines = append(m.Lines, []byte(l))
		}
	}
}

// Adopt inserts a machine the agent doesn't know about (a VM left from before a restart).
func (d *Driver) Adopt(id string) {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.machines[id] = &Machine{Spec: driver.Spec{MachineID: id}, Status: driver.StatusRunning}
}

// Remove deletes a machine without a Stop (it vanished while the agent was down).
func (d *Driver) Remove(id string) {
	d.mu.Lock()
	defer d.mu.Unlock()
	delete(d.machines, id)
}

// SetFailStart makes Start of id fail.
func (d *Driver) SetFailStart(id string, on bool) { d.set(d.failStart, id, on) }

// SetFailStop makes Stop of id fail (the machine stays).
func (d *Driver) SetFailStop(id string, on bool) { d.set(d.failStop, id, on) }

// SetHang makes every Start, Stop, Status and Logs call for id block until its context ends.
func (d *Driver) SetHang(id string, on bool) { d.set(d.hang, id, on) }

// SetFailList makes List fail.
func (d *Driver) SetFailList(on bool) {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.failList = on
}

func (d *Driver) set(m map[string]bool, id string, on bool) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if on {
		m[id] = true
	} else {
		delete(m, id)
	}
}

// Starts counts Start calls.
func (d *Driver) Starts() int {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.starts
}

// Stops lists the machines Stop removed, in order.
func (d *Driver) Stops() []string {
	d.mu.Lock()
	defer d.mu.Unlock()
	return append([]string(nil), d.stops...)
}
