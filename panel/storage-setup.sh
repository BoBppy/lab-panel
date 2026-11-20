#!/bin/bash
# Turn on per-person disk limits (journaled ext4 user quotas) on the given mount points, or on every disk in
# /etc/lab/lab.json "storage", and install lxcfs so containers report their own limits. Idempotent; run as root.
#   storage-setup.sh            all configured disks
#   storage-setup.sh /data      one disk (the panel's "Turn on limits" button runs this)
# Each storage "path" must be the mount point of an ext4 filesystem with an fstab entry.
# Other filesystems are skipped: the panel then shows usage without limits there.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
dpkg -s quota lxcfs rsync >/dev/null 2>&1 || { apt-get -o Acquire::Retries=5 update -qq; apt-get -o Acquire::Retries=5 install -y -qq quota lxcfs rsync >/dev/null; }
systemctl enable --now lxcfs >/dev/null 2>&1 || true
paths="$*"
[ -n "$paths" ] || paths=$(python3 -I -c 'import sys; sys.path.insert(0,"/opt/lab/panel"); import labcore as L; print(" ".join(L.QUOTA_FS))')
cp -n /etc/fstab /etc/fstab.before-quota
for fs in $paths; do
  type=$(findmnt -no FSTYPE --target "$fs" || true)
  if [ "$(findmnt -no TARGET --target "$fs")" != "$fs" ] || [ "$type" != ext4 ]; then
    echo "skip $fs: not an ext4 mount point (${type:-none})"; continue
  fi
  if ! awk -v m="$fs" '$2==m && $1 !~ /^#/' /etc/fstab | grep -q .; then
    echo "skip $fs: no /etc/fstab entry"; continue
  fi
  if ! awk -v m="$fs" '$2==m && $1 !~ /^#/ {print $4}' /etc/fstab | grep -q usrjquota; then
    awk -v m="$fs" 'BEGIN{OFS="\t"} $2==m && $1 !~ /^#/ {$4=$4",usrjquota=aquota.user,jqfmt=vfsv1"} {print}' /etc/fstab > /etc/fstab.new
    mv /etc/fstab.new /etc/fstab
  fi
  mount -o remount "$fs"
  if ! { quotaon -p -u "$fs" 2>/dev/null || true; } | grep -q "is on"; then
    quotacheck -cum "$fs" 2>/dev/null || true
    quotaon -u "$fs" 2>/dev/null || true
  fi
  { quotaon -p -u "$fs" 2>/dev/null || true; } | grep "$fs" || true
done
systemctl daemon-reload
findmnt -no TARGET,OPTIONS $paths || true
