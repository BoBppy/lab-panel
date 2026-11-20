#!/bin/bash
# Install or update the lab panel, LLM gateway and per-person container tooling. Idempotent; run as root.
#   sudo ./install.sh
#   sudo LAB_ORG="Physics Lab" ./install.sh     name shown in the panel, used on first install only
# Host-specific settings live in /etc/lab/lab.json (see lab.example.json); this script never overwrites them.
set -euo pipefail
SRC=$(cd "$(dirname "$0")" && pwd)
cd "$SRC"
[ "$(id -u)" = 0 ] || { echo "run as root"; exit 1; }
for c in docker python3 openssl sshd; do command -v $c >/dev/null || { echo "missing: $c"; exit 1; }; done
python3 -c 'import sys; sys.exit(sys.version_info < (3, 10))' || { echo "python 3.10 or newer needed"; exit 1; }

getent group labusers >/dev/null || groupadd labusers
id labgw >/dev/null 2>&1 || useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin labgw

install -d -m 755 /opt/lab/panel /opt/lab/panel/static /etc/lab /etc/lab/users /etc/lab/panel /etc/lab/keys
install -d -m 770 -o root -g labgw /var/lib/lab
install -d -m 755 /var/lib/lab/lastlogin
install -m 644 labcore.py panel.py gateway.py engine.py /opt/lab/panel/
install -m 644 static/* /opt/lab/panel/static/
install -m 755 lab-ctl /usr/local/sbin/lab-ctl
install -m 755 lab-enter /usr/local/sbin/lab-enter
install -m 755 llm-engine.sh /opt/lab/llm-engine.sh
install -m 644 systemd/*.service /etc/systemd/system/
[ -f /etc/lab/containers.conf ] || install -m 644 containers.conf /etc/lab/containers.conf
RT=$(sed -n 's/^RUNTIME=//p' /etc/lab/containers.conf | tail -1); RT=${RT:-docker}
if [ "$RT" = podman ]; then
  command -v podman >/dev/null || { echo "containers.conf says RUNTIME=podman: apt install podman crun (or set RUNTIME=docker)"; exit 1; }
  systemctl enable podman-restart.service >/dev/null 2>&1 || true      # restart people's containers after a reboot
  if command -v nvidia-ctk >/dev/null; then                             # GPU spec for user-namespaced containers
    nvidia-ctk cdi generate --vendor lab.local --class gpu --disable-hook all --enable-hook apply-cuda-memory-limits \
      --output=/etc/cdi/lab-gpu.yaml >/dev/null 2>&1 || echo "warning: could not generate /etc/cdi/lab-gpu.yaml"
  fi
fi
if [ -d ../devbox ]; then install -d /opt/lab/devbox && cp -a ../devbox/. /opt/lab/devbox/; fi

# ssh: members of labusers land in their own container
install -m 755 system/lab-shell /usr/local/bin/lab-shell
install -m 440 system/sudoers-lab-containers /etc/sudoers.d/lab-containers
visudo -cq -f /etc/sudoers.d/lab-containers
install -m 644 system/sshd-lab-containers.conf /etc/ssh/sshd_config.d/50-lab-containers.conf
sshd -t && { systemctl reload ssh 2>/dev/null || systemctl reload sshd; }

# configuration: written once; later releases add new keys through defaults in labcore.py
if [ ! -f /etc/lab/lab.json ]; then
  ORG="${LAB_ORG:-Lab}" python3 -I - <<'P'
import json, os
json.dump({"org": os.environ["ORG"], "panel_listen": "0.0.0.0", "panel_port": 39743,
           "gateway_listen": "0.0.0.0", "gateway_port": 39700, "strata_port": 39701,
           "storage": [{"path": "/home", "label": "System disk", "homes": "/home"}]},
          open("/etc/lab/lab.json", "w"), indent=2)
P
  echo "wrote /etc/lab/lab.json; add more disks there (see lab.example.json), then run storage-setup.sh"
fi
chmod 644 /etc/lab/lab.json

# folders named in the configuration
python3 -I - <<'P'
import os, sys
sys.path.insert(0, "/opt/lab/panel"); import labcore as L
c = L.conf()
for d in [c["engine_state"], c["hf_cache"], c["models_root"]] + [s.get("homes") for s in L.STORAGE] + list(L.DATA_ROOTS):
    if d:
        os.makedirs(d, exist_ok=True)
os.chmod(c["engine_state"], 0o700)
P

# database (the gateway writes usage as labgw; root manages people)
python3 -I -c 'import sys; sys.path.insert(0,"/opt/lab/panel"); import labcore; labcore.init_db()'
chown labgw:labgw /var/lib/lab/lab.db*; chmod 660 /var/lib/lab/lab.db*

# key between the gateway and the engine: root and the gateway only
[ -s /etc/lab/strata.key ] || python3 -c 'import secrets; print("sk-" + secrets.token_hex(24))' > /etc/lab/strata.key
chown root:labgw /etc/lab/strata.key; chmod 640 /etc/lab/strata.key

# self-signed TLS for the panel (put your own certificate at the same paths if you have one)
if [ ! -f /etc/lab/panel/tls.crt ]; then
  ip=$(hostname -I | awk '{print $1}')
  org=$(python3 -I -c 'import json; print(json.load(open("/etc/lab/lab.json")).get("org", "Lab"))')
  openssl req -x509 -newkey rsa:3072 -sha256 -days 3650 -nodes -keyout /etc/lab/panel/tls.key -out /etc/lab/panel/tls.crt \
    -subj "/O=$org/CN=$(hostname)" -addext "subjectAltName=DNS:$(hostname),DNS:localhost,IP:$ip,IP:127.0.0.1" 2>/dev/null
  chmod 600 /etc/lab/panel/tls.key
fi

# existing members: database row, model key, and a complete per-person file for lab-enter
python3 -I -c '
import sys; sys.path.insert(0,"/opt/lab/panel"); import labcore as L
for u in L.lab_members():
    L.ensure_db_row(u); L.write_limits(u)'

# first admin
if ! python3 -I -c 'import sys; sys.path.insert(0,"/opt/lab/panel"); import labcore as L; c=L.db(); sys.exit(0 if c.execute("select 1 from admins").fetchone() else 1)'; then
  pw=$(python3 -c 'import secrets; print(secrets.token_urlsafe(12))')
  python3 -I -c "import sys; sys.path.insert(0,'/opt/lab/panel'); import labcore as L; L.set_admin('admin', '$pw')"
  echo "First admin: admin / $pw   (change it under Settings and turn on two-factor sign-in)"
fi

systemctl daemon-reload
systemctl enable lab-panel lab-llm-gateway >/dev/null 2>&1
systemctl restart lab-panel lab-llm-gateway
sleep 1; systemctl is-active lab-panel lab-llm-gateway
"$RT" image exists lab/devbox:latest 2>/dev/null || "$RT" image inspect lab/devbox:latest >/dev/null 2>&1 || echo "next: build the container image with:  lab-ctl build"
