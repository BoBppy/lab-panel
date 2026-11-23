#!/bin/bash
# Low-cost security baseline for a lab host. Idempotent; run as root on Ubuntu 22.04 or newer.
#   sudo ./harden.sh                       firewall + sshd + fail2ban + update policy + Docker live-restore
#   sudo LAN="10.0.0.0/8" ./harden.sh      which networks may reach the panel and gateway (default: all private ranges)
#   sudo EXTRA_LAN_PORTS="80 443" ./harden.sh   other services on this host that the local network should reach
# The firewall step arms a 3-minute auto-disable first; it is cancelled only if this script finishes.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
LAN=${LAN:-"192.168.0.0/16 10.0.0.0/8 172.16.0.0/12"}
read -r PANEL GATEWAY ENGINE < <(python3 -I -c '
import json
try: c = json.load(open("/etc/lab/lab.json"))
except FileNotFoundError: c = {}
print(c.get("panel_port", 39743), c.get("gateway_port", 39700), c.get("strata_port", 39701))')

echo "== packages"
apt-get install -y -qq -o Acquire::Retries=3 ufw fail2ban unattended-upgrades >/dev/null

echo "== sshd"
cat > /etc/ssh/sshd_config.d/05-lab-hardening.conf <<'EOF'
# Lab baseline. Password sign-in stays on because members use it; SSH keys are better.
PermitRootLogin no
X11Forwarding no
MaxAuthTries 5
LoginGraceTime 30
ClientAliveInterval 300
ClientAliveCountMax 3
EOF
sshd -t && { systemctl reload ssh 2>/dev/null || systemctl reload sshd; }

echo "== fail2ban (ssh: 6 failures in 10 minutes = ban, growing up to a day)"
cat > /etc/fail2ban/jail.d/lab-sshd.conf <<'EOF'
[DEFAULT]
backend = systemd
bantime = 10m
bantime.increment = true
bantime.maxtime = 1d
findtime = 10m
maxretry = 6
ignoreip = 127.0.0.1/8 ::1

[sshd]
enabled = true
EOF
systemctl enable fail2ban >/dev/null 2>&1; systemctl restart fail2ban

echo "== automatic security updates, but not for the GPU driver, CUDA or Docker (those need a planned restart)"
cat > /etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF
cat > /etc/apt/apt.conf.d/51lab-unattended <<'EOF'
Unattended-Upgrade::Package-Blacklist {
    "nvidia-";
    "libnvidia-";
    "linux-modules-nvidia-";
    "cuda-";
    "libcudnn";
    "docker-ce";
    "containerd.io";
};
Unattended-Upgrade::Automatic-Reboot "false";
Unattended-Upgrade::Remove-Unused-Kernel-Packages "true";
EOF

echo "== Docker live-restore (containers keep running while Docker itself is upgraded)"
if [ -f /etc/docker/daemon.json ]; then
  python3 -I - <<'P'
import json
p = "/etc/docker/daemon.json"; d = json.load(open(p))
if not d.get("live-restore"):
    d["live-restore"] = True; json.dump(d, open(p, "w"), indent=4)
P
else
  echo '{ "live-restore": true }' > /etc/docker/daemon.json
fi
systemctl reload docker

echo "== firewall"
systemd-run --unit=lab-ufw-failsafe --on-active=180 /usr/sbin/ufw disable >/dev/null 2>&1 || true
ufw --force reset >/dev/null
ufw default deny incoming >/dev/null
ufw default allow outgoing >/dev/null
ufw allow 22/tcp comment 'ssh' >/dev/null
for net in $LAN; do
  for port in $PANEL $GATEWAY ${EXTRA_LAN_PORTS:-}; do
    ufw allow from "$net" to any port "$port" proto tcp comment 'lab, local network' >/dev/null
  done
done
# People (uid >= 1000: host accounts, SSH tunnels, their containers) reach the engine only through the gateway.
"$(dirname "$0")/engine-guard.sh"
ufw --force enable >/dev/null
systemctl stop lab-ufw-failsafe.timer 2>/dev/null || true
ufw status | sed -n '1,3p'
echo "done. Check that a new SSH session still works before closing this one."
