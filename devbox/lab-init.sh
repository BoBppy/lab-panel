#!/bin/bash
# Container entrypoint: create the owning user with the host's UID/GID, give it
# passwordless sudo inside this container, then idle (sessions arrive via docker/podman exec).
set -eu
: "${LAB_USER:?}" "${LAB_UID:?}" "${LAB_GID:?}"

if ! getent group "$LAB_GID" >/dev/null; then
    groupadd -g "$LAB_GID" "$LAB_USER"
fi
if ! id -u "$LAB_USER" >/dev/null 2>&1; then
    # Home is bind-mounted from the host, so do not create or copy skeleton files into it.
    useradd -M -d "${LAB_HOME:-/home/$LAB_USER}" -s /bin/bash -u "$LAB_UID" -g "$LAB_GID" -G sudo,video "$LAB_USER"
fi
# The user stays in group "sudo" because /opt/ai, /opt/sec and /opt/rust are writable by that group;
# whether that group can actually use sudo is decided by the admin (LAB_SUDO).
if [ "${LAB_SUDO:-1}" = 1 ]; then
    echo "$LAB_USER ALL=(ALL) NOPASSWD:ALL" > "/etc/sudoers.d/90-$LAB_USER"
    chmod 440 "/etc/sudoers.d/90-$LAB_USER"
else
    rm -f "/etc/sudoers.d/90-$LAB_USER"
    sed -i 's/^%sudo/# disabled by the lab admin: %sudo/' /etc/sudoers
fi

# GPU libraries are mounted in at start (Podman CDI without hooks): refresh the linker cache.
ldconfig 2>/dev/null || true

touch /run/lab-ready
trap 'exit 0' TERM INT
sleep infinity & wait
