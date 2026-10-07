#!/bin/sh
# Prints what a pod can see about its kernel and privileges (S0 VM-signal and capability checks).
echo "== uname"; uname -a
echo "== boot_id"; cat /proc/sys/kernel/random/boot_id
echo "== cmdline"; cat /proc/cmdline
echo "== pid1"; cat /proc/1/cmdline | tr '\0' ' '; echo
echo "== caps"; grep -E '^Cap(Inh|Prm|Eff|Bnd|Amb)' /proc/self/status
echo "== nonewprivs/seccomp"; grep -E 'NoNewPrivs|Seccomp' /proc/self/status
echo "== virtio"; for d in /sys/bus/virtio/devices/*; do [ -e "$d" ] && echo "$d $(cat $d/device)"; done
echo "== dmi"; for f in sys_vendor product_name board_vendor chassis_asset_tag bios_vendor; do [ -r /sys/class/dmi/id/$f ] && echo "$f=$(cat /sys/class/dmi/id/$f)"; done; ls /sys/class/dmi 2>&1
echo "== devicetree"; [ -r /proc/device-tree/compatible ] && tr '\0' ' ' < /proc/device-tree/compatible; echo
echo "== hypervisor"; ls /sys/hypervisor 2>&1; grep -m1 -i hypervisor /proc/cpuinfo; cat /sys/devices/system/clocksource/clocksource0/current_clocksource
echo "== meminfo"; grep MemTotal /proc/meminfo; nproc
echo "== mounts"; grep -E ' /proc | /proc/sys | /sys | /sys/fs/cgroup | /run/kete-config ' /proc/self/mountinfo
echo "== cgroup"; cat /proc/self/cgroup; cat /sys/fs/cgroup/cgroup.controllers 2>&1; cat /sys/fs/cgroup/cgroup.subtree_control 2>&1
echo "== block"; ls /sys/class/block; ls -la /dev | head -40
echo "== route"; cat /proc/net/route
echo "== resolv"; cat /etc/resolv.conf
echo "== adjtimex"; command -v adjtimex || true
