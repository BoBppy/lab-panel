#!/bin/bash
# Let lab members read GPU hardware performance counters (Nsight Compute, CUPTI metrics) from their containers.
# By default the NVIDIA driver allows that only for host root, which no container is.
#   sudo ./gpu-profiling.sh on      allow everyone (takes effect after a reboot)
#   sudo ./gpu-profiling.sh off     back to the default (after a reboot)
#   ./gpu-profiling.sh status       what the loaded driver does now
# Trade-off: counters let one person's program learn something about other programs on the same GPU
# (NVIDIA security bulletin CVE-2018-6260). Research groups usually accept that; public hosting should not.
set -euo pipefail
CONF=/etc/modprobe.d/lab-gpu-profiling.conf
now() { grep -i 'RmProfilingAdminOnly' /proc/driver/nvidia/params 2>/dev/null | awk '{print ($2 == 1) ? "host root only" : "everyone"}'; }
case "${1:-status}" in
  on)
    echo "options nvidia NVreg_RestrictProfilingToAdminUsers=0" > "$CONF"
    update-initramfs -u >/dev/null 2>&1 || true
    echo "GPU counters will be open to everyone after the next reboot (now: $(now))." ;;
  off)
    rm -f "$CONF"
    update-initramfs -u >/dev/null 2>&1 || true
    echo "GPU counters will be limited to host root after the next reboot (now: $(now))." ;;
  status)
    echo "GPU performance counters: $(now)"
    [ -f "$CONF" ] && echo "configured: open to everyone from the next boot" || echo "configured: default (host root only)" ;;
  *) echo "usage: $0 on|off|status" >&2; exit 2 ;;
esac
