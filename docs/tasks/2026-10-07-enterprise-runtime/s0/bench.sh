#!/bin/sh
# S0 throwaway: where does time go in a Kata guest? CPU, rootfs (virtio-fs) I/O, tmpfs, kete start.
t() { s=$(date +%s%N); "$@" >/dev/null 2>&1; echo "$(( ($(date +%s%N) - s) / 1000000 )) ms: $*"; }
echo "nproc=$(nproc) mem=$(grep MemTotal /proc/meminfo)"
grep -E ' / ' /proc/self/mountinfo
t sh -c 'i=0; while [ $i -lt 300000 ]; do i=$((i+1)); done'
t sha256sum /usr/local/bin/kete
t sha256sum /usr/local/bin/kete
t dd if=/dev/zero of=/var/tmp/s0.bin bs=1M count=200 conv=fsync
t dd if=/dev/zero of=/dev/shm/s0.bin bs=1M count=200
t sh -c 'for i in $(seq 500); do echo x > /var/tmp/f$i; done; rm -f /var/tmp/f*'
t /usr/local/bin/kete --version
t /usr/local/bin/kete --version
t python3 -c 'import sqlite3,os; c=sqlite3.connect("/var/tmp/s0.db"); c.execute("pragma journal_mode=wal"); c.execute("create table t(x)"); [ (c.execute("insert into t values (?)",(i,)), c.commit()) for i in range(300)]'
t python3 -c 'import sqlite3,os; c=sqlite3.connect("/dev/shm/s0.db"); c.execute("pragma journal_mode=wal"); c.execute("create table t(x)"); [ (c.execute("insert into t values (?)",(i,)), c.commit()) for i in range(300)]'
