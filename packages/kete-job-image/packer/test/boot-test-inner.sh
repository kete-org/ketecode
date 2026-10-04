#!/usr/bin/env bash
# Kete-owned. The container half of boot-test.sh (read that first). Root inside its own network
# namespace: a bridge with the "provider" side (gateway, metadata address), dnsmasq handing out a
# provider-shaped lease, a fake metadata service, QEMU on a tap, and the serial log checked
# against the phase lines kete-job-init must print.
# QEMU and dnsmasq arguments are comma-separated by design.
# shellcheck disable=SC2054
set -euo pipefail
: "${DISK:?}" "${ARCH:?}" "${PROVIDER:?}" "${FIRMWARE:?}" "${TIMEOUT:?}" "${LOG:?}" "${DEBIAN_SNAPSHOT:?}" "${HOST_ID:?}"

cat > /etc/apt/sources.list.d/debian.sources <<EOF
Types: deb
URIs: http://snapshot.debian.org/archive/debian/$DEBIAN_SNAPSHOT
Suites: trixie trixie-updates
Components: main
Signed-By: /usr/share/keyrings/debian-archive-keyring.gpg
Check-Valid-Until: no
EOF
case "$ARCH" in
  arm64) qpkgs="qemu-system-arm qemu-efi-aarch64" ;;
  amd64) qpkgs="qemu-system-x86 ovmf seabios" ;;
esac
apt-get -o Acquire::Retries=5 update -qq
DEBIAN_FRONTEND=noninteractive apt-get -o Acquire::Retries=5 install -y -qq --no-install-recommends \
  $qpkgs dnsmasq-base python3 iproute2 procps >/dev/null

# The provider's network: gateway 10.77.0.1 (Hetzner's router 172.31.1.1 as well), the metadata
# service at 169.254.169.254, the guest leased 10.77.0.50.
ip link add br0 type bridge
ip addr add 10.77.0.1/24 dev br0
ip addr add 172.31.1.1/32 dev br0
ip addr add 169.254.169.254/32 dev br0
ip link set br0 up
ip tuntap add tap0 mode tap
ip link set tap0 master br0 up

dhcp=(--dhcp-range=10.77.0.50,10.77.0.50,255.255.255.0,2h --dhcp-option=option:dns-server,169.254.169.254)
case "$PROVIDER" in
  gcp) dhcp+=(--dhcp-option=option:netmask,255.255.255.255 --dhcp-option=option:router,10.77.0.1
         --dhcp-option=option:classless-static-route,10.77.0.1/32,0.0.0.0,0.0.0.0/0,10.77.0.1 --dhcp-option=option:mtu,1460) ;;
  hetzner) dhcp+=(--dhcp-option=option:netmask,255.255.255.255 --dhcp-option=option:router,172.31.1.1) ;;
  oci|digitalocean) dhcp+=(--dhcp-option=option:router,10.77.0.1) ;;
esac
dnsmasq --interface=br0 --bind-interfaces --except-interface=lo --port=0 --log-dhcp --log-facility=/tmp/dnsmasq.log \
  --dhcp-leasefile=/tmp/leases --pid-file=/tmp/dnsmasq.pid "${dhcp[@]}"

# The job's user data, as the platform's adapter writes it (bootenv.Config, host_profile cloudvm).
cat > /tmp/user-data <<EOF
{"job_id":"0d9a3c55-8f0e-4b6e-9a43-3f1f6c2b7e10","platform_url":"https://portal.kete.invalid","claim_token":"kete-boot-test-claim-token-0123456789abcdef","storage_host":"storage.kete.invalid","host_profile":"cloudvm","host_provider":"$PROVIDER"}
EOF
cat > /tmp/metadata.py <<'EOF'
import base64, http.server, os, sys
provider = os.environ["PROVIDER"]
data = open("/tmp/user-data", "rb").read()
paths = {
    "gcp": "/computeMetadata/v1/instance/attributes/user-data",
    "digitalocean": "/metadata/v1/user-data",
    "hetzner": "/hetzner/v1/userdata",
    "oci": "/opc/v2/instance/metadata/user_data",
}
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        with open("/tmp/metadata.log", "a") as f:
            f.write(f"GET {self.path} flavor={self.headers.get('Metadata-Flavor')} auth={self.headers.get('Authorization')}\n")
        if self.path != paths[provider]:
            self.send_response(404); self.end_headers(); return
        if provider == "gcp" and self.headers.get("Metadata-Flavor") != "Google":
            self.send_response(403); self.end_headers(); return
        if provider == "oci" and self.headers.get("Authorization") != "Bearer Oracle":
            self.send_response(401); self.end_headers(); return
        body = base64.b64encode(data) if provider == "oci" else data
        self.send_response(200)
        if provider == "gcp":
            self.send_header("Metadata-Flavor", "Google")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
    def log_message(self, *a):
        pass
http.server.HTTPServer(("169.254.169.254", 80), H).serve_forever()
EOF
touch /tmp/metadata.log
PROVIDER="$PROVIDER" python3 /tmp/metadata.py &
meta=$!

case "$PROVIDER" in
  gcp) smbios=(-smbios "type=1,manufacturer=Google,product=Google Compute Engine") ;;
  hetzner) smbios=(-smbios "type=1,manufacturer=Hetzner,product=vServer") ;;
  digitalocean) smbios=(-smbios "type=1,manufacturer=DigitalOcean,product=Droplet") ;;
  oci) smbios=(-smbios "type=1,manufacturer=QEMU,product=Standard PC" -smbios "type=3,asset=OracleCloud.com") ;;
esac
case "$PROVIDER" in
  digitalocean) disk=(-drive "file=$DISK,format=raw,if=none,id=d0,snapshot=on" -device virtio-blk-pci,drive=d0) ;;
  *) disk=(-device virtio-scsi-pci,id=scsi0 -drive "file=$DISK,format=raw,if=none,id=d0,snapshot=on" -device scsi-hd,drive=d0,bus=scsi0.0) ;;
esac
accel=(-accel tcg)
[ -c /dev/kvm ] && [ "$ARCH" = "$(dpkg --print-architecture)" ] && accel=(-accel kvm -cpu host)
case "$ARCH" in
  arm64)
    cp /usr/share/AAVMF/AAVMF_VARS.fd /tmp/vars.fd
    [ "${accel[1]}" = kvm ] || accel+=(-cpu max)
    qemu=(qemu-system-aarch64 -M virt "${accel[@]}"
      -drive if=pflash,format=raw,readonly=on,file=/usr/share/AAVMF/AAVMF_CODE.fd
      -drive if=pflash,format=raw,file=/tmp/vars.fd) ;;
  amd64)
    qemu=(qemu-system-x86_64 -M q35 "${accel[@]}")
    if [ "$FIRMWARE" = uefi ]; then
      cp /usr/share/OVMF/OVMF_VARS_4M.fd /tmp/vars.fd
      qemu+=(-drive if=pflash,format=raw,readonly=on,file=/usr/share/OVMF/OVMF_CODE_4M.fd -drive if=pflash,format=raw,file=/tmp/vars.fd)
    fi ;;
esac
: > "$LOG"
"${qemu[@]}" -m 1024 -smp 2 -no-reboot -display none -serial "file:$LOG" -monitor none \
  "${smbios[@]}" "${disk[@]}" \
  -netdev tap,id=n0,ifname=tap0,script=no,downscript=no -device virtio-net-pci,netdev=n0,romfile= &
vm=$!
echo "== booting $ARCH $FIRMWARE as $PROVIDER (${accel[*]}), serial log $LOG"

# Wait for the entrypoint's first own steps after init started it (or the VM ending).
deadline=$(( $(date +%s) + TIMEOUT ))
while kill -0 "$vm" 2>/dev/null && [ "$(date +%s)" -lt "$deadline" ]; do
  if grep -q '"step":"setup_host"' "$LOG" 2>/dev/null; then sleep 3; break; fi
  sleep 1
done
kill "$vm" 2>/dev/null || true
wait "$vm" 2>/dev/null || true
kill "$meta" 2>/dev/null || true
kill "$(cat /tmp/dnsmasq.pid)" 2>/dev/null || true
chown "$HOST_ID" "$LOG"

echo "== phase lines"
grep -a '^{"ts"' "$LOG" | sed 's/^{"ts":"[^"]*",/  {/' | head -n 40 || true
echo "== dhcp"; grep -a -E 'DHCP(ACK|OFFER)' /tmp/dnsmasq.log | sed 's/^/  /' || true
echo "== metadata"; sed 's/^/  /' /tmp/metadata.log

fail=0
want=(
  '"step":"init_root","event":"ok"'
  '"step":"init_mount","event":"ok"'
  '"step":"init_network","event":"ok"'
  '"step":"init_config","event":"ok"'
  '"step":"init_metadata_drop","event":"ok"'
  '"step":"init_entrypoint","event":"start"'
  '"step":"boot"'
  '"step":"setup_host","event":"ok"'
)
pos=0
for w in "${want[@]}"; do
  n="$(grep -a -n -F "$w" "$LOG" | head -n1 | cut -d: -f1 || true)"
  if [ -z "$n" ]; then echo "MISSING: $w" >&2; fail=1; continue; fi
  if [ "$n" -lt "$pos" ]; then echo "OUT OF ORDER: $w" >&2; fail=1; fi
  pos="$n"
done
if grep -a -q '"event":"failed"' "$LOG" && grep -a '"event":"failed"' "$LOG" | grep -q '"step":"init_'; then
  echo "FAILED init step" >&2; fail=1
fi
[ "$(wc -l < /tmp/metadata.log)" = 1 ] || { echo "metadata requests: $(wc -l < /tmp/metadata.log), want 1" >&2; fail=1; }
if [ "$fail" = 0 ]; then echo "PASS: $ARCH $FIRMWARE $PROVIDER"; else echo "FAIL: $ARCH $FIRMWARE $PROVIDER" >&2; fi
exit "$fail"
