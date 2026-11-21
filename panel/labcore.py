#!/usr/bin/env python3
"""Lab core: users, per-user containers and LLM keys.

Shared by lab-ctl (CLI), the admin panel and the LLM gateway. Python stdlib only.
Anything that changes the system runs as root (lab-ctl re-execs itself with sudo).
"""
import grp
import hashlib
import json
import os
import pwd
import re
import secrets
import sqlite3
import subprocess
import time

CONF_PATH = "/etc/lab/lab.json"
CONTAINERS_CONF = "/etc/lab/containers.conf"
DB_PATH = "/var/lib/lab/lab.db"
USERS_DIR = "/etc/lab/users"          # per-user container overrides, sourced by lab-enter
KEYS_DIR = "/etc/lab/keys"            # /etc/lab/keys/<user>/llm.env, mounted read-only into the container
LASTLOGIN_DIR = "/var/lib/lab/lastlogin"
GROUP = "labusers"
LAB_ENTER = "/usr/local/sbin/lab-enter"

NAME_RE = re.compile(r"^[a-z_][a-z0-9_-]{0,31}$")
MEM_RE = re.compile(r"^[1-9][0-9]{0,5}[mg]$")
CPUS_RE = re.compile(r"^[0-9]{1,3}(\.[0-9]{1,2})?$")
PUBKEY_RE = re.compile(r"^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(256|384|521)|sk-ssh-ed25519@openssh\.com|"
                       r"sk-ecdsa-sha2-nistp256@openssh\.com) [A-Za-z0-9+/]+={0,3}( [^\n\r]{0,200})?$")
LIMIT_KEYS = ("MEMORY", "CPUS", "CPUSET", "GPU", "SUDO", "DATA")
CPUSET_RE = re.compile(r"^[0-9]{1,2}(-[0-9]{1,2})?(,[0-9]{1,2}(-[0-9]{1,2})?){0,15}$")

DEFAULTS = {
    "org": "Lab",
    "subtitle": "",                   # line under the name in the sidebar; empty = "<hostname> server"
    "panel_listen": "0.0.0.0", "panel_port": 39743,
    "gateway_listen": "0.0.0.0", "gateway_port": 39700,
    "strata_port": 39701,
    "model": "local",                 # model name people pass to the gateway; set by the engine page
    "default_daily_tokens": 0,        # 0 = unlimited
    "default_concurrency": 2,
    # Disks people can use. "homes": where home folders may live; "data": parent of per-person data folders.
    # Quotas (if enabled on the filesystem) count every file a person owns on "path".
    # Disks people can use, normally edited in the panel (Settings, Disks). "path" is a mount point; "homes" is
    # where home folders may live; "data" is the parent of per-person data folders; "label" overrides the
    # automatic name (kind and size, such as "NVMe SSD, 1 TB"). Empty = the disk that holds /home.
    "storage": [],
    "container_fs": "",               # filesystem holding container system files; empty = detect from Docker
    "default_sudo": True,             # admin rights inside new people's containers
    "default_quota_gb": {},           # per filesystem path, applied to new people; 0 or missing = no limit
    # Language model engine
    "models_root": "/srv/models",     # engine model folders must live under here
    "engine_state": "/var/lib/lab/engine",   # engine caches and compiled kernels
    "hf_cache": "/var/lib/lab/hf-cache",
    "hf_endpoint": "",                # e.g. https://hf-mirror.com where huggingface.co is slow
    "ghcr_mirror": "",                # e.g. ghcr.nju.edu.cn; pulls are verified against ghcr.io's digest
}


def _mount_of(path):
    p = os.path.realpath(path)
    while not os.path.ismount(p):
        p = os.path.dirname(p)
    return p


def _storage():
    try:
        with open(CONF_PATH) as f:
            st = json.load(f).get("storage")
    except (FileNotFoundError, ValueError):
        st = None
    return st or [{"path": _mount_of("/home"), "homes": "/home"}]


def reload_storage():
    """Re-read the storage list (after the panel changes it)."""
    global STORAGE, HOME_BASES, QUOTA_FS, DATA_ROOTS
    STORAGE = _storage()
    HOME_BASES = tuple(d["homes"] for d in STORAGE if d.get("homes"))
    QUOTA_FS = tuple(d["path"] for d in STORAGE)
    DATA_ROOTS = tuple(d["data"] for d in STORAGE if d.get("data"))


reload_storage()

# ---------------------------------------------------------------- disk discovery
LOCAL_FS = ("ext4", "ext3", "xfs", "btrfs", "zfs", "f2fs")
NETWORK_FS = ("nfs", "nfs4", "cifs", "smb3", "ceph", "glusterfs", "fuse.sshfs", "virtiofs", "9p")
SKIP_MOUNT = re.compile(r"^/(boot|efi|snap|proc|sys|dev|run|tmp|var/lib/(docker|containers|snapd|lxcfs|kubelet))(/|$)"
                        r"|/(containers|podman|docker|containerd)/.*(storage|overlay)")
_DISKS = {"t": 0.0, "v": []}


def _size_label(b):
    """Same units as the rest of the panel (1 GB = 1024^3 bytes), so the name matches the space bar."""
    if b >= 1024 ** 4:
        return f"{round(b / 1024 ** 4, 1):g} TB"
    g = b / 1024 ** 3
    return f"{round(g, 1):g} GB" if g < 100 else f"{round(g)} GB"


def _physical(source):
    """The physical disks under a block device, through partitions, LVM, RAID and encryption."""
    r = run(["lsblk", "-J", "-s", "-b", "-o", "PATH,TYPE,ROTA,TRAN,MODEL,VENDOR,SIZE", source], check=False)
    try:
        tree = json.loads(r.stdout)["blockdevices"]
    except (ValueError, KeyError, TypeError):
        return []
    out, seen = [], set()

    def walk(nodes):
        for n in nodes or []:
            if n.get("type") == "disk" and n.get("path") not in seen:
                seen.add(n.get("path"))
                out.append(n)
            walk(n.get("children"))
    walk(tree)
    return out


def _kind(disks, fstype):
    if fstype in NETWORK_FS:
        return "Network storage"
    if not disks:
        return "Disk"
    d = disks[0]
    tran, name = (d.get("tran") or "").lower(), os.path.basename(d.get("path") or "")
    if tran == "nvme" or name.startswith("nvme"):
        k = "NVMe SSD"
    elif tran == "usb":
        k = "USB disk"
    elif name.startswith(("vd", "xvd")) and not d.get("model"):
        k = "Virtual disk"
    elif str(d.get("rota")).lower() in ("1", "true"):
        k = "Hard disk"
    else:
        k = "SSD"
    return f"{k} array of {len(disks)}" if len(disks) > 1 else k


def _model(disks):
    names = []
    for d in disks:
        vendor, model = (d.get("vendor") or "").strip(), " ".join((d.get("model") or "").split())
        if vendor.upper() == "ATA" or model.upper().startswith(vendor.upper()):
            vendor = ""
        n = " ".join(x for x in (vendor, model) if x)
        if n and n not in names:
            names.append(n)
    return ", ".join(names)


def discover_disks(max_age=60):
    """Mounted filesystems people could use: mount point, size, kind, drive model, and whether limits work."""
    if time.time() - _DISKS["t"] < max_age:
        return _DISKS["v"]
    r = run(["findmnt", "-J", "-l", "-b", "-o", "TARGET,SOURCE,FSTYPE,SIZE,USED,AVAIL"], check=False)
    try:
        mounts = json.loads(r.stdout)["filesystems"]
    except (ValueError, KeyError, TypeError):
        mounts = []
    by_src = {}
    for m in mounts:
        t, typ, src = m.get("target") or "", m.get("fstype") or "", m.get("source") or ""
        if typ not in LOCAL_FS + NETWORK_FS or SKIP_MOUNT.match(t):
            continue
        key = src if typ == "btrfs" else re.sub(r"\[.*\]$", "", src)   # bind mounts are the same disk; btrfs subvolumes are not
        if key in by_src and len(by_src[key]["target"]) <= len(t):
            continue
        by_src[key] = m
    out = []
    for src, m in sorted(by_src.items(), key=lambda kv: kv[1]["target"]):
        typ = m["fstype"]
        disks = [] if typ in NETWORK_FS else _physical(re.sub(r"\[.*\]$", "", src))
        size = int(m.get("size") or 0)
        kind = _kind(disks, typ)
        out.append({"path": m["target"], "source": src, "fstype": typ, "size": size,
                    "used": int(m.get("used") or 0), "avail": int(m.get("avail") or 0),
                    "kind": kind, "model": _model(disks), "label": f"{kind}, {_size_label(size)}",
                    "rotational": kind.startswith("Hard disk"), "network": typ in NETWORK_FS,
                    "limits_possible": typ == "ext4"})
    _DISKS.update(t=time.time(), v=out)
    return out


def storage_view():
    """The configured disks with their discovered name, model and limit status (for the panel)."""
    found = {d["path"]: d for d in discover_disks()}
    out = []
    for s in STORAGE:
        d = found.get(s["path"], {})
        on = quotas_enabled(s["path"])
        out.append(dict(s, label=s.get("label") or d.get("label") or s["path"], auto_label=d.get("label", ""),
                        model=d.get("model", ""), kind=d.get("kind", ""), fstype=d.get("fstype", ""),
                        limits="on" if on else ("off" if d.get("limits_possible") else "unsupported")))
    return out


def save_storage(rows, actor="cli"):
    """rows: [{"path", "homes": bool, "data": bool, "label": str}] for discovered mount points."""
    found = {d["path"]: d for d in discover_disks(0)}
    cur = {s["path"]: s for s in STORAGE}
    cfs = container_fs()
    new = []
    for r in rows:
        p = r.get("path")
        if p not in found:
            raise LabError(f"{p} is not a mounted disk on this server")
        old, e = cur.get(p, {}), {"path": p}
        if r.get("homes"):
            if p == "/" and "/home" in found:
                raise LabError("/home is a separate disk here; choose that one for home folders")
            e["homes"] = old.get("homes") or ("/home" if p in ("/", "/home") else p.rstrip("/") + "/home")
        if r.get("data"):
            if p == "/home":
                raise LabError("the /home disk already holds their home folders; pick another disk for data folders")
            e["data"] = old.get("data") or ("/srv/data" if p == "/" else p.rstrip("/") + "/data")
        label = " ".join(str(r.get("label") or "").split())
        if len(label) > 40:
            raise LabError("disk names can be at most 40 characters")
        if label and label != found[p]["label"]:
            e["label"] = label
        if e.get("homes") or e.get("data") or p == cfs:
            new.append(e)
    if not any(e.get("homes") for e in new):
        raise LabError("at least one disk must hold home folders")
    keep = tuple(e["homes"] + "/" for e in new if e.get("homes"))
    stranded = [u for u in lab_members() if not pwd.getpwnam(u).pw_dir.startswith(keep)]
    if stranded:
        raise LabError("move these home folders first (People, Storage): " + ", ".join(stranded))
    for e in new:
        for k in ("homes", "data"):
            if e.get(k):
                os.makedirs(e[k], mode=0o755, exist_ok=True)
    update_conf(storage=new)
    reload_storage()
    audit(actor, "storage", "", {e["path"]: [k for k in ("homes", "data") if e.get(k)] for e in new})


def update_conf(**kv):
    """Change some keys of lab.json in place, atomically, keeping everything else."""
    try:
        c = json.load(open(CONF_PATH))
    except FileNotFoundError:
        c = {}
    c.update(kv)
    tmp = CONF_PATH + ".tmp"
    with open(tmp, "w") as f:
        json.dump(c, f, indent=2, ensure_ascii=False)
    os.chmod(tmp, 0o644)
    os.replace(tmp, CONF_PATH)


# ---------------------------------------------------------------- lab name and logo
LOGO_BASE = os.path.join(os.path.dirname(CONF_PATH), "logo")
LOGO_TYPES = {"png": "image/png", "jpg": "image/jpeg", "webp": "image/webp", "svg": "image/svg+xml"}
LOGO_MAX = 512 * 1024


def logo_file():
    for ext in LOGO_TYPES:
        f = f"{LOGO_BASE}.{ext}"
        if os.path.isfile(f):
            return f, LOGO_TYPES[ext]
    return None, None


def brand():
    """What the sign-in page and the sidebar show. The logo URL changes whenever the file does."""
    f, _ = logo_file()
    c = conf()
    return {"org": c["org"], "subtitle": c.get("subtitle") or f"{os.uname().nodename} server",
            "subtitle_custom": c.get("subtitle") or "", "subtitle_default": f"{os.uname().nodename} server",
            "logo": f"/api/brand/logo?v={os.stat(f).st_mtime_ns}" if f else ""}


def _logo_ext(data):
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "png"
    if data.startswith(b"\xff\xd8\xff"):
        return "jpg"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "webp"
    try:
        text = data.decode("utf-8-sig").lstrip()
    except UnicodeDecodeError:
        return None
    if re.match(r"^(<\?xml[^>]*\?>\s*)?(<!--.*?-->\s*)*<svg[\s>]", text, re.S):
        # it is only ever shown through <img> and served sandboxed, but refuse active content anyway
        if re.search(r"<!DOCTYPE|<!ENTITY|<script|<foreignObject|\son[a-z]+\s*=|javascript:", text, re.I):
            raise LabError("this SVG contains scripts or embedded documents; export it again as a plain SVG or PNG")
        return "svg"
    return None


def _brand_text(v, what):
    v = " ".join(str(v).split())
    if len(v) > 60:
        raise LabError(f"the {what} can be at most 60 characters")
    if re.search(r"[\x00-\x1f\x7f<>]", v):
        raise LabError(f"the {what} cannot contain < or > or control characters")
    return v


def save_brand(org=None, logo=None, subtitle=None, actor="cli"):
    """org: new lab name. subtitle: line under it, "" = "<hostname> server".
    logo: None leaves it, "" goes back to the built-in mark, bytes replace it."""
    changed = []
    if subtitle is not None:
        subtitle = _brand_text(subtitle, "line under the name")
        if subtitle != (conf().get("subtitle") or ""):
            update_conf(subtitle=subtitle)
            changed.append(f"subtitle: {subtitle or '(host name)'}")
    if org is not None:
        org = _brand_text(org, "lab name")
        if not org:
            raise LabError("the lab needs a name")
        if org != conf()["org"]:
            update_conf(org=org)
            changed.append(f"name: {org}")
    if logo is not None:
        old, _ = logo_file()
        if logo == b"" or logo == "":
            if old:
                os.remove(old)
                changed.append("logo: built-in")
        else:
            if len(logo) > LOGO_MAX:
                raise LabError("the logo can be at most 512 KB; a 256 × 256 PNG or an SVG is plenty")
            ext = _logo_ext(logo)
            if not ext:
                raise LabError("the logo must be a PNG, JPEG, WebP or SVG image")
            tmp = f"{LOGO_BASE}.tmp"
            with open(tmp, "wb") as f:
                f.write(logo)
            os.chmod(tmp, 0o644)
            os.replace(tmp, f"{LOGO_BASE}.{ext}")
            for e in LOGO_TYPES:
                if e != ext and os.path.isfile(f"{LOGO_BASE}.{e}"):
                    os.remove(f"{LOGO_BASE}.{e}")
            changed.append(f"logo: {ext}, {len(logo)} bytes")
    if changed:
        audit(actor, "brand", "", "; ".join(changed))
    return brand()


def container_fs():
    """Which configured disk holds container system files (Docker's data root), so its limit also counts them."""
    c = conf().get("container_fs")
    if c:
        return c
    try:
        fmt = "{{.Store.GraphRoot}}" if runtime() == "podman" else "{{.DockerRootDir}}"
        r = subprocess.run([runtime(), "info", "-f", fmt], capture_output=True, text=True, timeout=10)
        droot = r.stdout.strip() or "/var/lib/docker"
    except (OSError, subprocess.TimeoutExpired):
        droot = "/var/lib/docker"
    best = ""
    for d in STORAGE:
        p = d["path"].rstrip("/") + "/"
        if (droot + "/").startswith(p) and len(p) > len(best):
            best = p
    return best.rstrip("/") or "/"


class LabError(Exception):
    pass


# ---------------------------------------------------------------- config / db
def conf():
    c = dict(DEFAULTS)
    try:
        with open(CONF_PATH) as f:
            c.update(json.load(f))
    except FileNotFoundError:
        pass
    return c


def global_container_conf():
    """Parse the simple KEY=value lines of /etc/lab/containers.conf (arrays are ignored here)."""
    out = {}
    try:
        for line in open(CONTAINERS_CONF):
            m = re.match(r"^([A-Z_]+)=([^(\s]*)\s*$", line.strip())
            if m:
                out[m.group(1)] = m.group(2).strip('"')
    except FileNotFoundError:
        pass
    return out


# People's containers run under Podman with a private uid range each (container root = an unprivileged host
# uid that owns nothing), or under Docker without one. The language-model engine always runs under Docker.
USERNS_BASE = 0x80000000        # person with uid U gets host uids USERNS_BASE + (U - 1000) * USERNS_SIZE ...
USERNS_SIZE = 0x10000           # ... for container uids 0..65535


def runtime():
    rt = global_container_conf().get("RUNTIME", "docker")
    return rt if rt in ("docker", "podman") else "docker"


def userns_base(uid):
    """First host uid of a person's container range (Podman only); None for unsupported uids."""
    if runtime() != "podman" or not 1000 <= uid < 1000 + (0xFFFFFFFF - USERNS_BASE) // USERNS_SIZE:
        return None
    return USERNS_BASE + (uid - 1000) * USERNS_SIZE


def userns_owner(host_uid):
    """The lab uid whose container range contains host_uid, else None."""
    if host_uid < USERNS_BASE:
        return None
    return 1000 + (host_uid - USERNS_BASE) // USERNS_SIZE


SCHEMA = """
CREATE TABLE IF NOT EXISTS users(
  name TEXT PRIMARY KEY, full_name TEXT DEFAULT '', email TEXT DEFAULT '', note TEXT DEFAULT '',
  created REAL, key_hash TEXT, key_prefix TEXT, llm_enabled INTEGER DEFAULT 1,
  daily_tokens INTEGER DEFAULT 0, concurrency INTEGER DEFAULT 2, disabled INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS usage(
  id INTEGER PRIMARY KEY, ts REAL, user TEXT, endpoint TEXT, model TEXT, prompt INTEGER, completion INTEGER,
  cached INTEGER, ms INTEGER, ttft_ms INTEGER, status INTEGER, stream INTEGER, ip TEXT);
CREATE INDEX IF NOT EXISTS usage_user_ts ON usage(user, ts);
CREATE INDEX IF NOT EXISTS usage_ts ON usage(ts);
CREATE TABLE IF NOT EXISTS admins(name TEXT PRIMARY KEY, pw TEXT, created REAL);
CREATE TABLE IF NOT EXISTS gpu_usage(
  day TEXT, user TEXT, held_s REAL DEFAULT 0, busy_s REAL DEFAULT 0, mem_mib_s REAL DEFAULT 0, peak_mib REAL DEFAULT 0,
  PRIMARY KEY(day, user));
CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY, ts REAL, actor TEXT, action TEXT, target TEXT, detail TEXT);
"""


def db():
    con = sqlite3.connect(DB_PATH, timeout=15)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA journal_mode=WAL")
    con.execute("PRAGMA busy_timeout=15000")
    return con


def init_db():
    con = db()
    con.executescript(SCHEMA)
    con.commit()
    con.close()
    migrate_admins()


def audit(actor, action, target="", detail=""):
    con = db()
    con.execute("INSERT INTO audit(ts,actor,action,target,detail) VALUES(?,?,?,?,?)",
                (time.time(), actor, action, target, detail if isinstance(detail, str) else json.dumps(detail)))
    con.commit()
    con.close()


# ---------------------------------------------------------------- helpers
def run(cmd, input=None, check=True, timeout=120):
    p = subprocess.run(cmd, input=input, text=True, capture_output=True, timeout=timeout)
    if check and p.returncode != 0:
        raise LabError(f"{cmd[0]} failed: {(p.stderr or p.stdout).strip()[:500]}")
    return p


def valid_name(name):
    if not isinstance(name, str) or not NAME_RE.match(name):
        raise LabError(f"invalid user name {name!r} (lowercase letters, digits, _ and -, max 32, not starting with a digit)")
    return name


def lab_members():
    try:
        g = grp.getgrnam(GROUP)
    except KeyError:
        return []
    members = set(g.gr_mem)
    for p in pwd.getpwall():          # users whose primary group is labusers
        if p.pw_gid == g.gr_gid:
            members.add(p.pw_name)
    return sorted(members)


def is_lab_user(name):
    return name in lab_members()


def require_lab_user(name):
    valid_name(name)
    if not is_lab_user(name):
        raise LabError(f"{name} is not a lab user")
    return pwd.getpwnam(name)


def clean_text(s, maxlen=200):
    s = str(s or "")
    s = re.sub(r"[\x00-\x1f:\x7f]", " ", s).strip()
    return s[:maxlen]


def as_user(name, shell_cmd, input=None):
    """Run a shell snippet as the user (so symlinks a user planted in their home can't redirect root writes)."""
    return run(["runuser", "-u", name, "--", "sh", "-c", shell_cmd], input=input)


# ---------------------------------------------------------------- limits
def read_limits(name):
    out = {k: "" for k in LIMIT_KEYS}
    try:
        for line in open(os.path.join(USERS_DIR, name + ".conf")):
            m = re.match(r"^(MEMORY|CPUS|CPUSET|GPU|SUDO|DATA)=([a-z0-9.,/_-]*)$", line.strip())
            if m:
                out[m.group(1)] = m.group(2)
    except FileNotFoundError:
        pass
    return out


def effective_limits(name):
    g = global_container_conf()
    lim = read_limits(name)
    return {"MEMORY": lim["MEMORY"] or g.get("MEMORY", ""), "CPUS": lim["CPUS"] or g.get("CPUS", ""),
            "CPUSET": lim["CPUSET"], "GPU": lim["GPU"] or "all",
            "SUDO": lim["SUDO"] or ("yes" if conf().get("default_sudo", True) else "no"),
            "DATA": data_roots_for(name, lim)}


def data_roots_for(name, lim=None):
    """Which data disks this person can use (list of data roots). Unset = every configured data root."""
    lim = lim or read_limits(name)
    if not lim["DATA"]:
        return list(DATA_ROOTS)
    if lim["DATA"] == "none":
        return []
    return [d for d in lim["DATA"].split(",") if d in DATA_ROOTS]


def validate_limits(memory=None, cpus=None, gpu=None, cpuset=None, sudo=None, data=None):
    if sudo not in (None, "", "yes", "no"):
        raise LabError("sudo must be yes or no")
    if data not in (None, "", "none") and any(d not in DATA_ROOTS for d in data.split(",")):
        raise LabError("unknown data disk; choose from " + ", ".join(DATA_ROOTS))
    if memory not in (None, "") and not MEM_RE.match(memory):
        raise LabError("memory must look like 24g or 8192m")
    if memory:
        n = int(memory[:-1]) * (1024 if memory[-1] == "g" else 1)
        total_mb = os.sysconf("SC_PAGE_SIZE") * os.sysconf("SC_PHYS_PAGES") // 2**20
        if n < 512 or n > total_mb:
            raise LabError(f"memory must be between 512m and {total_mb // 1024}g")
    if cpus not in (None, ""):
        if not CPUS_RE.match(cpus) or not (0.1 <= float(cpus) <= os.cpu_count()):
            raise LabError(f"cpus must be a number between 0.1 and {os.cpu_count()}")
    if gpu not in (None, "", "all", "none"):
        raise LabError("gpu must be 'all' or 'none'")
    if cpuset not in (None, ""):
        if not CPUSET_RE.match(cpuset) or any(int(x) >= os.cpu_count() for x in re.findall(r"\d+", cpuset)):
            raise LabError(f"cpu set must look like 0-7 or 8-23 or 0-3,8-11 (CPUs 0..{os.cpu_count() - 1})")


def write_limits(name, memory=None, cpus=None, gpu=None, cpuset=None, sudo=None, data=None):
    """None = keep, '' = use the global default."""
    validate_limits(memory, cpus, gpu, cpuset, sudo, data)
    cur = read_limits(name)
    for k, v in (("MEMORY", memory), ("CPUS", cpus), ("GPU", gpu), ("CPUSET", cpuset), ("SUDO", sudo), ("DATA", data)):
        if v is not None:
            cur[k] = v
    os.makedirs(USERS_DIR, exist_ok=True)
    tmp = os.path.join(USERS_DIR, f".{name}.tmp")
    with open(tmp, "w") as f:
        f.write("# per-user container settings (written by lab-ctl / panel); empty = global default\n")
        for k in LIMIT_KEYS:
            f.write(f"{k}={cur[k]}\n")
        # resolved values for lab-enter (it does not read lab.json)
        f.write("SUDO_EFFECTIVE=" + ("yes" if (cur["SUDO"] or ("yes" if conf().get("default_sudo", True) else "no")) == "yes" else "no") + "\n")
        f.write("DATA_MOUNTS=" + ",".join(f"{d}/{name}" for d in data_roots_for(name, cur)) + "\n")
    os.chmod(tmp, 0o644)
    os.replace(tmp, os.path.join(USERS_DIR, name + ".conf"))
    return cur


def apply_limits_live(name):
    """Push memory/cpu limits into a running container. Returns a note if a rebuild is needed."""
    st = container_state(name)
    if st == "none":
        return "applies when the container is created"
    lim = effective_limits(name)
    args = [runtime(), "update"]
    if lim["MEMORY"]:
        args += ["--memory", lim["MEMORY"], "--memory-swap", lim["MEMORY"]]
    args += ["--cpus", lim["CPUS"] or str(os.cpu_count())]
    args += ["--cpuset-cpus", lim["CPUSET"] or f"0-{os.cpu_count() - 1}"]
    run(args + ["lab-" + name])
    # lab-enter records what the container was created with as labels; compare with the settings now.
    labels = json.loads(run([runtime(), "container", "inspect", "-f", "{{json .Config.Labels}}", "lab-" + name]).stdout or "{}") or {}
    if labels.get("lab.gpu", "all") != (lim["GPU"] or "all"):
        return "GPU access changes after a rebuild (Rebuild container)"
    want_data = ",".join(sorted(f"{d}/{name}" for d in lim["DATA"]))
    if labels.get("lab.sudo") != lim["SUDO"] or labels.get("lab.data") != want_data:
        return "admin-rights and disk-access changes take effect after a rebuild (Container, Rebuild)"
    return "applied to the running container (thread-count hints such as OMP_NUM_THREADS update after a rebuild)"


# ---------------------------------------------------------------- LLM keys
def hash_key(key):
    return hashlib.sha256(key.encode()).hexdigest()


def key_file(name):
    return os.path.join(KEYS_DIR, name, "llm.env")


def write_key_file(name, key):
    p = pwd.getpwnam(name)
    c = conf()
    d = os.path.join(KEYS_DIR, name)
    os.makedirs(d, exist_ok=True)
    os.chown(d, 0, p.pw_gid)
    os.chmod(d, 0o750)
    base = f"http://127.0.0.1:{c['gateway_port']}"
    body = (f"# Local LLM access for {name} ({c['org']}). Personal key: do not share. Regenerate in the panel.\n"
            f"OPENAI_BASE_URL={base}/v1\nOPENAI_API_KEY={key}\n"
            f"ANTHROPIC_BASE_URL={base}\nANTHROPIC_AUTH_TOKEN={key}\n"
            f"LAB_LLM_MODEL={c['model']}\nLAB_LLM_KEY={key}\n")
    tmp = os.path.join(d, ".llm.env.tmp")
    with open(tmp, "w") as f:
        f.write(body)
    os.chown(tmp, 0, p.pw_gid)
    os.chmod(tmp, 0o640)
    os.replace(tmp, key_file(name))   # the directory (not the file) is bind-mounted, so the new file is visible


def read_key(name):
    try:
        for line in open(key_file(name)):
            if line.startswith("LAB_LLM_KEY="):
                return line.split("=", 1)[1].strip()
    except FileNotFoundError:
        return None
    return None


def new_llm_key(name, actor="cli"):
    key = "rl-" + secrets.token_hex(20)
    con = db()
    con.execute("UPDATE users SET key_hash=?, key_prefix=? WHERE name=?", (hash_key(key), key[:9], name))
    con.commit()
    con.close()
    write_key_file(name, key)
    audit(actor, "llm-key-regenerate", name)
    return key


# ---------------------------------------------------------------- users
def db_user(name):
    con = db()
    r = con.execute("SELECT * FROM users WHERE name=?", (name,)).fetchone()
    con.close()
    return dict(r) if r else None


def ensure_db_row(name):
    if db_user(name) is None:
        c = conf()
        con = db()
        con.execute("INSERT INTO users(name, created, daily_tokens, concurrency) VALUES(?,?,?,?)",
                    (name, time.time(), c["default_daily_tokens"], c["default_concurrency"]))
        con.commit()
        con.close()
        new_llm_key(name, actor="system")


def set_password(name, password, actor="cli"):
    require_lab_user(name)
    if not isinstance(password, str) or len(password) < 8 or any(ch in password for ch in "\n\r:"):
        raise LabError("password must be at least 8 characters (no newline or ':')")
    run(["chpasswd"], input=f"{name}:{password}\n")
    audit(actor, "password", name)


def list_keys(name):
    p = require_lab_user(name)
    path = os.path.join(p.pw_dir, ".ssh", "authorized_keys")
    try:
        r = as_user(name, f"cat {path!r} 2>/dev/null || true")
    except LabError:
        return []
    return [ln for ln in r.stdout.splitlines() if ln.strip() and not ln.lstrip().startswith("#")]


def add_key(name, pubkey, actor="cli"):
    require_lab_user(name)
    pubkey = (pubkey or "").strip()
    if not PUBKEY_RE.match(pubkey):
        raise LabError("not a valid OpenSSH public key line (ssh-ed25519 AAAA... comment)")
    if pubkey.split()[1] in [k.split()[1] for k in list_keys(name) if len(k.split()) > 1]:
        raise LabError("key already installed")
    as_user(name, 'umask 077; mkdir -p "$HOME/.ssh" && cat >> "$HOME/.ssh/authorized_keys"', input=pubkey + "\n")
    audit(actor, "ssh-key-add", name, pubkey.split()[-1] if len(pubkey.split()) > 2 else pubkey[:30])


def remove_key(name, index, actor="cli"):
    keys = list_keys(name)
    if not 0 <= index < len(keys):
        raise LabError("no such key")
    gone = keys.pop(index)
    as_user(name, 'umask 077; mkdir -p "$HOME/.ssh" && cat > "$HOME/.ssh/authorized_keys.new" && '
                  'mv "$HOME/.ssh/authorized_keys.new" "$HOME/.ssh/authorized_keys"',
            input="".join(k + "\n" for k in keys))
    audit(actor, "ssh-key-remove", name, gone[:60])


def add_user(name, password=None, pubkey=None, full_name="", email="", note="", memory="", cpus="", gpu="",
             daily_tokens=None, concurrency=None, actor="cli", home_base="/home", cpuset="", quotas=None,
             sudo="", data=""):
    valid_name(name)
    try:
        pwd.getpwnam(name)
        raise LabError(f"account {name} already exists on this server")
    except KeyError:
        pass
    if not password and not pubkey:
        raise LabError("give a password, an SSH public key, or both")
    if pubkey and not PUBKEY_RE.match(pubkey.strip()):
        raise LabError("not a valid OpenSSH public key line")
    if password and (len(password) < 8 or any(ch in password for ch in "\n\r:")):
        raise LabError("password must be at least 8 characters (no newline or ':')")
    validate_limits(memory, cpus, gpu, cpuset, sudo, data)
    home_base = home_base or "/home"
    if home_base not in HOME_BASES:
        raise LabError("home location must be one of " + ", ".join(HOME_BASES))
    quotas = quotas if quotas is not None else conf().get("default_quota_gb", {})
    validate_quotas(quotas)
    os.makedirs(home_base, mode=0o755, exist_ok=True)
    run(["useradd", "-m", "-d", f"{home_base}/{name}", "-s", "/bin/bash", "-G", GROUP,
         "-c", clean_text(full_name, 60), name])
    try:
        p = pwd.getpwnam(name)
        for d in DATA_ROOTS:
            run(["install", "-d", "-o", name, "-g", str(p.pw_gid), "-m", "750", f"{d}/{name}"])
        if password:
            run(["chpasswd"], input=f"{name}:{password}\n")
        if pubkey:
            as_user(name, 'umask 077; mkdir -p "$HOME/.ssh" && cat >> "$HOME/.ssh/authorized_keys"',
                    input=pubkey.strip() + "\n")
        write_limits(name, memory, cpus, gpu, cpuset, sudo, data)
        set_quotas(name, quotas, actor=None)
        c = conf()
        con = db()
        con.execute("DELETE FROM users WHERE name=?", (name,))
        con.execute("INSERT INTO users(name, full_name, email, note, created, daily_tokens, concurrency) "
                    "VALUES(?,?,?,?,?,?,?)",
                    (name, clean_text(full_name, 60), clean_text(email, 100), clean_text(note, 300), time.time(),
                     int(c["default_daily_tokens"] if daily_tokens is None else daily_tokens),
                     int(c["default_concurrency"] if concurrency is None else concurrency)))
        con.commit()
        con.close()
        new_llm_key(name, actor=actor)
    except Exception:
        run(["userdel", "-r", name], check=False)
        raise
    audit(actor, "user-add", name, {"memory": memory, "cpus": cpus, "cpuset": cpuset, "gpu": gpu or "all",
                                    "home": f"{home_base}/{name}", "quota_gb": quotas,
                                    "password": bool(password), "key": bool(pubkey)})


def update_user(name, actor="cli", **f):
    """Fields: full_name, email, note, llm_enabled, daily_tokens, concurrency, memory, cpus, cpuset, gpu, quotas."""
    require_lab_user(name)
    ensure_db_row(name)
    cols, vals = [], []
    for k in ("full_name", "email", "note"):
        if k in f and f[k] is not None:
            cols.append(k)
            vals.append(clean_text(f[k], 300 if k == "note" else 100))
    if f.get("full_name") is not None:
        run(["usermod", "-c", clean_text(f["full_name"], 60), name])
    for k, lo, hi in (("llm_enabled", 0, 1), ("daily_tokens", 0, 10**12), ("concurrency", 1, 8)):
        if k in f and f[k] is not None:
            v = int(f[k])
            if not lo <= v <= hi:
                raise LabError(f"{k} must be between {lo} and {hi}")
            cols.append(k)
            vals.append(v)
    if cols:
        con = db()
        con.execute(f"UPDATE users SET {', '.join(c + '=?' for c in cols)} WHERE name=?", (*vals, name))
        con.commit()
        con.close()
    note = ""
    if f.get("quotas") is not None:
        set_quotas(name, f["quotas"], actor=None)
    if any(f.get(k) is not None for k in ("memory", "cpus", "gpu", "cpuset", "sudo", "data")):
        write_limits(name, f.get("memory"), f.get("cpus"), f.get("gpu"), f.get("cpuset"), f.get("sudo"), f.get("data"))
        note = apply_limits_live(name)
    audit(actor, "user-edit", name, {k: v for k, v in f.items() if v is not None})
    return note


def set_disabled(name, disabled, actor="cli"):
    require_lab_user(name)
    ensure_db_row(name)
    if disabled:
        run(["usermod", "-e", "1", name])          # expired account: no password or key logins
        run(["pkill", "-KILL", "-u", name], check=False)
        run([runtime(), "stop", "-t", "5", "lab-" + name], check=False)
    else:
        run(["usermod", "-e", "", name])
    con = db()
    con.execute("UPDATE users SET disabled=? WHERE name=?", (1 if disabled else 0, name))
    con.commit()
    con.close()
    audit(actor, "user-disable" if disabled else "user-enable", name)


def delete_user(name, purge=False, actor="cli"):
    require_lab_user(name)
    p = pwd.getpwnam(name)
    if p.pw_uid < 1000:
        raise LabError("refusing to delete a system account")
    run([runtime(), "rm", "-f", "lab-" + name], check=False)
    run(["pkill", "-KILL", "-u", name], check=False)
    time.sleep(0.5)
    base = userns_base(p.pw_uid)
    if base is not None:                       # drop the limits on the container's own uids
        for fs in QUOTA_FS:
            if quotas_enabled(fs):
                for u in (base, base + p.pw_uid):
                    run(["setquota", "-u", str(u), "0", "0", "0", "0", fs], check=False)
    run(["userdel", name])
    removed = []
    if purge:
        for path in (p.pw_dir, *(f"{d}/{name}" for d in DATA_ROOTS)):
            if path.startswith(tuple(b + "/" for b in (*HOME_BASES, *DATA_ROOTS))) and os.path.isdir(path):
                run(["rm", "-rf", "--one-file-system", path], timeout=3600)
                removed.append(path)
    for path in (os.path.join(USERS_DIR, name + ".conf"), os.path.join(LASTLOGIN_DIR, name)):
        if os.path.exists(path):
            os.remove(path)
    run(["rm", "-rf", os.path.join(KEYS_DIR, name)], check=False)
    con = db()
    con.execute("DELETE FROM users WHERE name=?", (name,))
    con.commit()
    con.close()
    audit(actor, "user-delete", name, {"purge": purge, "removed": removed})
    return removed


# ---------------------------------------------------------------- containers
def container_state(name):
    p = run([runtime(), "container", "inspect", "-f", "{{.State.Status}}", "lab-" + name], check=False)
    return p.stdout.strip() if p.returncode == 0 else "none"


def container_action(name, action, actor="cli"):
    require_lab_user(name)
    c = "lab-" + name
    if action == "start":
        env = dict(os.environ, SUDO_USER=name)
        p = subprocess.run([LAB_ENTER, "--ensure"], env=env, text=True, capture_output=True, timeout=180)
        if p.returncode != 0:
            raise LabError(p.stderr.strip()[-400:] or "start failed")
    elif action == "stop":
        run([runtime(), "stop", "-t", "10", c], check=False)
    elif action == "restart":
        if container_state(name) == "none":
            return container_action(name, "start", actor)
        run([runtime(), "restart", "-t", "10", c])
    elif action == "rebuild":
        run([runtime(), "rm", "-f", c], check=False)
    else:
        raise LabError("unknown action")
    audit(actor, "container-" + action, name)


# ---------------------------------------------------------------- usage
def day_start(ts=None):
    t = time.localtime(ts or time.time())
    return time.mktime((t.tm_year, t.tm_mon, t.tm_mday, 0, 0, 0, 0, 0, -1))


def usage_today(con, name):
    r = con.execute("SELECT COALESCE(SUM(prompt+completion),0) FROM usage WHERE user=? AND ts>=?",
                    (name, day_start())).fetchone()
    return r[0]


def last_login(name):
    try:
        return os.path.getmtime(os.path.join(LASTLOGIN_DIR, name))
    except OSError:
        return None


# ---------------------------------------------------------------- admins
def hash_pw(pw):
    salt = secrets.token_bytes(16)
    h = hashlib.scrypt(pw.encode(), salt=salt, n=2**14, r=8, p=1, dklen=32)
    return f"scrypt${salt.hex()}${h.hex()}"


def check_pw(pw, stored):
    try:
        _, salt, h = stored.split("$")
        got = hashlib.scrypt(pw.encode(), salt=bytes.fromhex(salt), n=2**14, r=8, p=1, dklen=32)
        return secrets.compare_digest(got.hex(), h)
    except Exception:
        return False


def set_admin(name, pw, role=None):
    """CLI: create an admin (owner if it is the first) or reset its password."""
    migrate_admins()
    con = db()
    first = con.execute("SELECT COUNT(*) FROM admins").fetchone()[0] == 0
    con.close()
    save_admin(name, pw=pw, role=role or ("owner" if first else None), actor="cli")


# ---------------------------------------------------------------- storage: quotas and home location
def quotas_enabled(fs):
    p = run(["quotaon", "-p", "-u", fs], check=False)
    return "is on" in (p.stdout + p.stderr)


def validate_quotas(q):
    if not isinstance(q, dict):
        raise LabError("quotas must be a mapping of filesystem to GB")
    for fs, gb in q.items():
        if fs not in QUOTA_FS:
            raise LabError(f"no quotas on {fs}")
        if not isinstance(gb, (int, float)) or not 0 <= gb <= 100000:
            raise LabError("quota must be 0 (no limit) to 100000 GB")


def set_quotas(name, q, actor="cli"):
    """q = {"/home": GB, "/ssd": GB, "/hdd": GB}; 0 = no limit. Soft limit 95% (7-day grace), hard limit = GB."""
    validate_quotas(q)
    for fs, gb in q.items():
        if not quotas_enabled(fs):
            if gb:
                raise LabError(f"quotas are not enabled on {fs}")
            continue
        hard = int(gb * 1024 * 1024)                # 1K blocks
        run(["setquota", "-u", name, str(int(hard * 0.95)), str(hard), "0", "0", fs])
        # Under Podman, files written by root inside the container belong to the container's base uid
        # (on every disk it can reach), and packages the person installs inside the container belong to
        # base + their uid (on the disk that holds container files). Each gets the same limit.
        base = userns_base(pwd.getpwnam(name).pw_uid)
        if base is not None:
            for u in (base, base + pwd.getpwnam(name).pw_uid) if fs == container_fs() else (base,):
                run(["setquota", "-u", str(u), str(int(hard * 0.95)), str(hard), "0", "0", fs])
    if actor:
        audit(actor, "quota", name, q)


def storage_report():
    """{user: {fs: {"used": bytes, "limit": bytes or 0}}} for every user, from the quota files (instant, no du)."""
    out = {}
    for fs in QUOTA_FS:
        if not quotas_enabled(fs):
            continue
        p = run(["repquota", "-u", "-O", "csv", "-n", fs], check=False)
        for line in p.stdout.splitlines()[1:]:
            f = line.split(",")
            if len(f) < 6 or not f[0].lstrip("#").isdigit():
                continue
            uid = int(f[0].lstrip("#"))
            owner = userns_owner(uid)          # files of a container's own uids count for its person
            try:
                user = pwd.getpwuid(owner if owner is not None else uid).pw_name
            except KeyError:
                continue
            e = out.setdefault(user, {}).setdefault(fs, {"used": 0, "limit": 0})
            e["used"] += int(f[3]) * 1024
            if owner is None:
                e["limit"] = int(f[5]) * 1024
    return out


def home_fs(path):
    return next((fs for fs in sorted(QUOTA_FS, key=len, reverse=True) if path == fs or path.startswith(fs + "/")), "/")


def move_home(name, base, actor="cli", say=print):
    p = require_lab_user(name)
    if base not in HOME_BASES:
        raise LabError("home location must be one of " + ", ".join(HOME_BASES))
    old, new = p.pw_dir, f"{base}/{name}"
    if not any(old.startswith(b + "/") for b in HOME_BASES):
        raise LabError(f"refusing to move an unusual home directory ({old})")
    if old == new:
        raise LabError("already there")
    if os.path.exists(new):
        raise LabError(f"{new} already exists")
    say(f"stopping lab-{name} and closing {name}'s sessions")
    run([runtime(), "rm", "-f", "lab-" + name], check=False)
    run(["pkill", "-KILL", "-u", name], check=False)
    os.makedirs(base, mode=0o755, exist_ok=True)
    say(f"copying {old} -> {new}")
    run(["rsync", "-aHAX", "--numeric-ids", old + "/", new + "/"], timeout=6 * 3600)
    run(["usermod", "-d", new, name])
    say(f"removing the old copy {old}")
    run(["rm", "-rf", "--one-file-system", old], timeout=3600)
    audit(actor, "home-move", name, {"from": old, "to": new})
    say("done; the container is recreated at the next login")


# ---------------------------------------------------------------- hardware facts (so the UI is not tied to one box)
def cpu_topology():
    """Group logical CPUs by max clock: on hybrid Intel parts this separates performance from efficiency cores."""
    groups = {}
    try:
        for line in run(["lscpu", "-e=CPU,CORE,MAXMHZ"]).stdout.splitlines()[1:]:
            cpu, core, mhz = (line.split() + ["", "", ""])[:3]
            groups.setdefault(round(float(mhz or 0) / 500), []).append(int(cpu))
    except Exception:
        return {"ncpu": os.cpu_count(), "groups": []}
    out = []
    for i, (_, cpus) in enumerate(sorted(groups.items(), reverse=True)):
        cpus.sort()
        rng = f"{cpus[0]}-{cpus[-1]}" if cpus == list(range(cpus[0], cpus[-1] + 1)) else ",".join(map(str, cpus))
        out.append({"cpus": rng, "count": len(cpus),
                    "kind": ("performance" if i == 0 else "efficiency") if len(groups) > 1 else "cores"})
    return {"ncpu": os.cpu_count(), "groups": out}


# ---------------------------------------------------------------- admin accounts: roles and two-factor sign-in
ROLES = ("owner", "admin", "viewer")     # owner: everything incl. admins and system; admin: people and engine; viewer: read only


def migrate_admins():
    con = db()
    cols = [r[1] for r in con.execute("PRAGMA table_info(admins)")]
    if "role" not in cols:
        con.execute("ALTER TABLE admins ADD COLUMN role TEXT DEFAULT 'admin'")
        con.execute("UPDATE admins SET role='owner'")          # accounts made before roles existed
    if "totp" not in cols:
        con.execute("ALTER TABLE admins ADD COLUMN totp TEXT")
    con.commit()
    con.close()


def list_admins():
    con = db()
    rows = [{"name": r["name"], "role": r["role"], "created": r["created"], "two_factor": bool(r["totp"])}
            for r in con.execute("SELECT * FROM admins ORDER BY created")]
    con.close()
    return rows


def get_admin(name):
    con = db()
    r = con.execute("SELECT * FROM admins WHERE name=?", (name,)).fetchone()
    con.close()
    return dict(r) if r else None


def save_admin(name, pw=None, role=None, actor="cli"):
    valid_name(name)
    if pw is not None and len(pw) < 10:
        raise LabError("admin passwords need at least 10 characters")
    if role is not None and role not in ROLES:
        raise LabError("role must be owner, admin or viewer")
    con = db()
    if con.execute("SELECT 1 FROM admins WHERE name=?", (name,)).fetchone():
        if pw is not None:
            con.execute("UPDATE admins SET pw=? WHERE name=?", (hash_pw(pw), name))
        if role is not None:
            if role != "owner" and con.execute("SELECT COUNT(*) FROM admins WHERE role='owner' AND name<>?", (name,)).fetchone()[0] == 0:
                raise LabError("keep at least one owner")
            con.execute("UPDATE admins SET role=? WHERE name=?", (role, name))
    else:
        if pw is None:
            raise LabError("a new admin needs a password")
        con.execute("INSERT INTO admins(name,pw,created,role) VALUES(?,?,?,?)", (name, hash_pw(pw), time.time(), role or "admin"))
    con.commit()
    con.close()
    audit(actor, "admin-save", name, {"role": role, "password": pw is not None})


def delete_admin(name, actor):
    con = db()
    r = con.execute("SELECT role FROM admins WHERE name=?", (name,)).fetchone()
    if not r:
        raise LabError("no such admin")
    if r["role"] == "owner" and con.execute("SELECT COUNT(*) FROM admins WHERE role='owner'").fetchone()[0] <= 1:
        raise LabError("keep at least one owner")
    con.execute("DELETE FROM admins WHERE name=?", (name,))
    con.commit()
    con.close()
    audit(actor, "admin-delete", name)


def totp_code(secret_b32, t=None, step=30, digits=6):
    import base64
    import hmac
    import struct
    key = base64.b32decode(secret_b32 + "=" * (-len(secret_b32) % 8))
    msg = struct.pack(">Q", int((t or time.time()) // step))
    h = hmac.new(key, msg, "sha1").digest()
    o = h[-1] & 15
    return str((struct.unpack(">I", h[o:o + 4])[0] & 0x7FFFFFFF) % 10 ** digits).zfill(digits)


def totp_ok(secret, code):
    code = str(code or "").strip().replace(" ", "")
    return any(secrets.compare_digest(totp_code(secret, time.time() + d * 30), code) for d in (-1, 0, 1))


def new_totp_secret():
    import base64
    return base64.b32encode(secrets.token_bytes(20)).decode().rstrip("=")


def set_totp(name, secret, actor):
    con = db()
    con.execute("UPDATE admins SET totp=? WHERE name=?", (secret, name))
    con.commit()
    con.close()
    audit(actor, "two-factor-on" if secret else "two-factor-off", name)


# ---------------------------------------------------------------- host software updates
HELD_BACK = ("nvidia", "libnvidia", "linux-modules-nvidia", "cuda", "docker-ce", "containerd")


def update_status():
    p = run(["apt", "list", "--upgradable"], check=False)
    pk = [ln.split("/")[0] for ln in p.stdout.splitlines() if "/" in ln]
    auto = ""
    try:
        lines = open("/var/log/unattended-upgrades/unattended-upgrades.log").read().splitlines()
        auto = next((ln[:19] for ln in reversed(lines) if "Packages that will be upgraded" in ln or "No packages found" in ln), "")
    except OSError:
        pass
    return {"upgradable": pk, "driver_or_docker": [x for x in pk if x.startswith(HELD_BACK)],
            "reboot_required": os.path.exists("/var/run/reboot-required"),
            "reboot_pkgs": open("/var/run/reboot-required.pkgs").read().split() if os.path.exists("/var/run/reboot-required.pkgs") else [],
            "last_auto_run": auto, "checked": time.time()}
