# Security model

lab-panel is meant for a research group: people who are trusted not to attack each other, but who make mistakes and whose accounts can be stolen. This page states what separates them and what does not.

## What separates people

| | |
|---|---|
| Root inside | Under Podman (the default) each container runs in its own user namespace with a fixed range of 65,536 host uids. Root inside is host uid `2147483648 + (uid - 1000) * 65536`: it owns nothing on the host, and it is a different uid for every person. Someone who breaks out of a container lands as that uid, not as root and not as any other person. |
| Files | Each container sees its own root filesystem plus that person's home and data folders and any shared folders. Other people's homes are not mounted. Mounts are id-mapped: the person's files keep their real owner on disk, and files created by root inside the container (with `sudo`) are owned on disk by the container's base uid, never by host root. |
| Processes | Each container has its own PID namespace. `ps` shows only that person's processes. |
| Memory, CPU, processes | cgroup limits per container. An out-of-memory kill stays inside the container, and the engine is protected with `--oom-score-adj -900`. |
| Disk space | ext4 user quotas, enforced by the kernel on every write. |
| Model use | Personal API key, daily token quota and concurrency cap, enforced by the gateway. The raw engine port is reachable only from root and the gateway (`scripts/harden.sh` adds the firewall rule). |
| Raw sockets | `NET_RAW` is dropped: no packet capture or forged packets. |

## What they share

- **Network namespace.** Containers use the host network, so people can reach services that listen on the host's `localhost`. Bind private services to a Unix socket, or protect them with a password. Per-person networks are on the roadmap.
- **GPU.** One GPU is shared with no memory partitioning, unless your card supports MIG. One person can fill its memory.
- **The kernel.** A user namespace removes host root from the picture, but every container still talks to the same kernel. Keep the host updated.
- **With `RUNTIME=docker`:** Docker cannot give each container its own user namespace, so root inside is the host's uid 0, limited only by namespaces, dropped capabilities and seccomp. Prefer Podman. Under Docker, turn admin rights off for anyone who does not need `apt install`: the container then sets `no-new-privileges`.
- **SSH tunnels.** `ssh -L` runs on the host as the person's own uid. Tunnels are allowed because Jupyter and TensorBoard need them.

## Panel

- HTTPS only. Each server makes its own lab certificate (a small certificate authority) and issues the panel's certificate from it, renewing it before it expires or when the server's addresses change. Name constraints limit the lab certificate to private addresses and local names, so installing it on a computer cannot let it vouch for a public website, even if its key leaks. A certificate you put at `/etc/lab/panel/tls.crt` yourself is never replaced. Session cookies are `HttpOnly`, `Secure` and `SameSite=Strict`. Every change must carry a custom header, which defeats cross-site requests.
- Failed sign-ins slow down exponentially per address.
- Owner, admin and viewer roles. Only owners manage admins and install system updates. Viewers cannot change anything or see API keys.
- Optional TOTP two-factor sign-in per admin.
- Every change is written to the activity log with who, what and when.
- A change that could cut everyone off from the panel (so far, its port) is tried next to the old setting and kept only if an owner reaches the panel the new way within two minutes; otherwise it is undone by itself. `lab.json` changes only once it is kept. What the trial adds to the firewall is recorded before it is added, so if the panel stops mid-trial it starts again on the old port and removes those rules.
- Restarting the panel from Settings signs everyone out; containers and the language model keep running.
- The lab logo is the only file anyone can upload. It must be a PNG, JPEG, WebP or SVG of at most 512 KB; SVGs with scripts, event handlers or embedded documents are refused. It is shown only through `<img>` and served with a sandboxing Content-Security-Policy, so even a crafted SVG opened directly cannot run.

## Baseline for the host (`scripts/harden.sh`)

- Firewall: SSH open; panel and gateway reachable only from private networks; everything else closed.
- fail2ban on SSH, with growing ban times.
- sshd: no root login, no X11 forwarding, 5 attempts per connection.
- Automatic security updates, except the GPU driver, CUDA and Docker, which the panel lists for a planned restart.
- Docker live-restore, so a Docker upgrade does not stop everyone's containers.

Still worth doing yourself:
- Use SSH keys and turn off password sign-in when your group is ready.
- Turn on two-factor sign-in for every panel admin.
- Keep the panel off the public internet; reach it through a VPN such as WireGuard or Tailscale.
- Back up `/etc/lab` and `/var/lib/lab`.
