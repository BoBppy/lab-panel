#!/bin/bash
# People reach the language model engine only through the metered gateway. Idempotent; run as root.
#   sudo ./engine-guard.sh          (harden.sh runs it too; run it again after changing strata_port in lab.json)
#
# "People" are every uid from 1000 up: host accounts, SSH tunnels (which run as the person's own uid) and the
# processes in people's containers, whose host uids are 2^31 and above because each container has its own user
# namespace. Two rules go into ufw's before.rules, ahead of its loopback allow:
#   1. connections to the engine's port on loopback (Docker's proxy, or its NAT, for 127.0.0.1:<strata_port>)
#   2. connections into Docker's bridge, where the engine container itself listens, unless Docker translated
#      them from a published port, so services that other containers publish stay reachable
# The gateway runs as a system user (uid below 1000) and is not affected.
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "run as root"; exit 1; }
command -v ufw >/dev/null || { echo "ufw is not installed; nothing changed"; exit 0; }
ENGINE=$(python3 -I -c '
import json
try: c = json.load(open("/etc/lab/lab.json"))
except FileNotFoundError: c = {}
print(int(c.get("strata_port", 39701)))')
BR=$(docker network inspect bridge --format '{{index .Options "com.docker.network.bridge.name"}}' 2>/dev/null || true)
BR=${BR:-docker0}
case "$BR" in *[!A-Za-z0-9_.-]*) echo "unexpected bridge name: $BR"; exit 1 ;; esac
PEOPLE="-m owner --uid-owner 1000-4294967294"
TAG="-m comment --comment lab-engine-guard"

R=/etc/ufw/before.rules
grep -q '^# allow all on loopback' "$R" || { echo "$R has no '# allow all on loopback' line; add the rules by hand"; exit 1; }
cp -a "$R" "$R.lab-bak"
# what earlier versions added (their uid range stopped at 65533, which missed people's containers), then ours
sed -i -e '/^# lab: engine only via gateway/d' -e '/--uid-owner 1000-65533 -j REJECT/d' -e '/lab-engine-guard/d' "$R"
sed -i "s|^# allow all on loopback|# lab: engine only via gateway (scripts/engine-guard.sh)\n\
-A ufw-before-output -p tcp -m conntrack --ctorigdst 127.0.0.0/8 --ctorigdstport $ENGINE $PEOPLE $TAG -j REJECT --reject-with tcp-reset\n\
-A ufw-before-output -o $BR -p tcp -m conntrack ! --ctstate DNAT $PEOPLE $TAG -j REJECT --reject-with tcp-reset\n\
\n# allow all on loopback|" "$R"

if ufw status | grep -q '^Status: active'; then
  if ! ufw reload >/dev/null; then
    echo "ufw refused the new rules; putting the old before.rules back"
    cp -a "$R.lab-bak" "$R"; ufw reload >/dev/null
    exit 1
  fi
  echo "engine guard on: port $ENGINE on loopback and the $BR bridge, for uids 1000 and up"
else
  echo "engine guard written; it takes effect when ufw is enabled"
fi
