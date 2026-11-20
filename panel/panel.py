#!/usr/bin/env python3
"""Lab admin panel: HTTPS web UI + JSON API for users, containers, resources and LLM usage.
Python stdlib only; runs as root (it manages accounts and Docker)."""
import collections
import http.client
import json
import os
import re
import secrets
import ssl
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import labcore as L  # noqa: E402
import engine as E  # noqa: E402

C = L.conf()
STATIC = os.path.join(HERE, "static")
TLS_DIR = "/etc/lab/panel"
SESSION_TTL = 12 * 3600
SESS = {}
FAILS = {}
LOCK = threading.Lock()
NCPU = os.cpu_count()


def sh(cmd, timeout=20):
    try:
        return subprocess.run(cmd, text=True, capture_output=True, timeout=timeout).stdout
    except Exception:
        return ""


# ---------------------------------------------------------------- stats collector
class Stats:
    def __init__(self):
        self.sys = {}
        self.hist = collections.deque(maxlen=720)            # 1 h at 5 s
        self.cont = {}                                       # container name -> live stats
        self.chist = collections.defaultdict(lambda: collections.deque(maxlen=720))
        self.disk = {}
        self.strata = {}
        self._cpu_prev = None
        self._cg_prev = {}
        self._gacc = {}                                      # (day, who) -> [held_s, busy_s, mem_mib_s, peak_mib]
        self._gprev = None
        self._gflush = time.time()
        threading.Thread(target=self.loop, daemon=True).start()
        threading.Thread(target=self.disk_loop, daemon=True).start()

    def host_cpu(self):
        f = [int(x) for x in open("/proc/stat").readline().split()[1:]]
        idle, total = f[3] + f[4], sum(f[:8])
        prev, self._cpu_prev = self._cpu_prev, (idle, total)
        if not prev or total == prev[1]:
            return 0.0
        return round(100 * (1 - (idle - prev[0]) / (total - prev[1])), 1)

    @staticmethod
    def meminfo():
        m = {}
        for line in open("/proc/meminfo"):
            k, v = line.split(":")
            m[k] = int(v.split()[0]) * 1024
        return m

    def gpu(self):
        out = sh(["nvidia-smi", "--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw,"
                  "power.limit,fan.speed", "--format=csv,noheader,nounits"]).strip().split("\n")[0]
        p = [x.strip() for x in out.split(",")]
        if len(p) < 7:
            return {}

        def num(x):
            try:
                return float(x)
            except ValueError:
                return None
        return {"name": p[0], "util": num(p[1]), "mem_used": num(p[2]), "mem_total": num(p[3]), "temp": num(p[4]),
                "power": num(p[5]), "power_limit": num(p[6]), "fan": num(p[7]) if len(p) > 7 else None}

    @staticmethod
    def _owner(pid):
        try:
            m = re.search(r"(?:docker|libpod)-([0-9a-f]{64})\.scope", open(f"/proc/{pid}/cgroup").read())
        except OSError:
            return None
        return m.group(1) if m else "host"

    def gpu_procs(self):
        """GPU memory (MiB) and compute share (% of the GPU's SMs) per container id."""
        mem, sm = {}, {}
        for line in sh(["nvidia-smi", "--query-compute-apps=pid,used_memory", "--format=csv,noheader,nounits"]).splitlines():
            try:
                pid, mib = [x.strip() for x in line.split(",")]
                key = self._owner(pid)
                if key:
                    mem[key] = mem.get(key, 0) + float(mib)
            except ValueError:
                continue
        # pmon samples per-process SM utilisation over about a second
        for line in sh(["nvidia-smi", "pmon", "-c", "1", "-s", "u"], timeout=10).splitlines():
            f = line.split()
            if line.startswith("#") or len(f) < 4 or not f[1].isdigit() or not f[3].isdigit():
                continue
            key = self._owner(f[1])
            if key:
                sm[key] = min(100.0, sm.get(key, 0) + float(f[3]))
        return mem, sm

    def account_gpu(self, now):
        """Add this interval's GPU use to the per-person daily totals; write them out once a minute."""
        dt = min(15.0, now - self._gprev) if self._gprev else 0
        self._gprev = now
        day = time.strftime("%Y-%m-%d", time.localtime(now))
        for name, c in self.cont.items():
            if not (name.startswith("lab-") or name == "engine") or not c.get("gpu_mib"):
                continue
            who = name[4:] if name.startswith("lab-") else "(language model)"
            a = self._gacc.setdefault((day, who), [0.0, 0.0, 0.0, 0.0])
            a[0] += dt
            a[1] += dt * c.get("gpu_sm", 0) / 100
            a[2] += dt * c["gpu_mib"]
            a[3] = max(a[3], c["gpu_mib"])
        if now - self._gflush >= 60 and self._gacc:
            acc, self._gacc, self._gflush = self._gacc, {}, now
            con = L.db()
            con.executemany(
                "INSERT INTO gpu_usage(day, user, held_s, busy_s, mem_mib_s, peak_mib) VALUES(?,?,?,?,?,?) "
                "ON CONFLICT(day, user) DO UPDATE SET held_s=held_s+excluded.held_s, busy_s=busy_s+excluded.busy_s, "
                "mem_mib_s=mem_mib_s+excluded.mem_mib_s, peak_mib=max(peak_mib, excluded.peak_mib)",
                [(d, w, *v) for (d, w), v in acc.items()])
            con.commit()
            con.close()

    def containers(self, now):
        fmt = "{{.ID}}\t{{.Names}}\t{{.State}}\t{{.Status}}\t{{.Image}}"
        rows = sh(["docker", "ps", "-a", "--no-trunc", "--format", fmt]).splitlines()
        if L.runtime() == "podman":
            rows = [r for r in rows if "\t" + E.NAME + "\t" in r] + sh(["podman", "ps", "-a", "--no-trunc", "--format", fmt]).splitlines()
        gp, gs = self.gpu_procs()
        res = {}
        for r in rows:
            p = r.split("\t")
            if len(p) < 5:
                continue
            cid, name, state, status, image = p
            if not (name.startswith("lab-") or name == E.NAME):
                continue
            if name == E.NAME:
                name = "engine"
            d = {"id": cid[:12], "state": state, "status": status, "image": image, "cpu": 0.0, "mem": 0, "mem_limit": 0,
                 "pids": 0, "mem_anon": 0, "gpu_mib": gp.get(cid, 0.0), "gpu_sm": gs.get(cid, 0.0)}
            base = next((b for b in (f"/sys/fs/cgroup/system.slice/docker-{cid}.scope",
                                     f"/sys/fs/cgroup/machine.slice/libpod-{cid}.scope") if os.path.isdir(b)), "")
            if state == "running" and base:
                try:
                    usage = int(re.search(r"usage_usec (\d+)", open(base + "/cpu.stat").read()).group(1))
                    prev = self._cg_prev.get(cid)
                    self._cg_prev[cid] = (usage, now)
                    if prev and now > prev[1]:
                        d["cpu"] = round((usage - prev[0]) / 1e6 / (now - prev[1]) * 100, 1)   # % of one core
                    cur = int(open(base + "/memory.current").read())
                    mst = open(base + "/memory.stat").read()
                    stat = {k: int(v) for k, v in re.findall(r"^(\w+) (\d+)$", mst, re.M)}
                    d["mem"] = max(0, cur - stat.get("inactive_file", 0))          # what counts toward the limit (docker stats)
                    d["mem_anon"] = stat.get("anon", 0) + stat.get("shmem", 0)    # comparable to the host's "used"
                    mx = open(base + "/memory.max").read().strip()
                    d["mem_limit"] = 0 if mx == "max" else int(mx)
                    d["pids"] = int(open(base + "/pids.current").read())
                except Exception:
                    pass
            res[name] = d
            self.chist[name].append((round(now), d["cpu"], d["mem"], d["gpu_mib"]))
        return res

    def strata_status(self):
        out = {"reachable": False}
        try:
            key = open("/etc/lab/strata.key").read().strip()
            con = http.client.HTTPConnection("127.0.0.1", int(C["strata_port"]), timeout=3)
            con.request("GET", "/metrics", headers={"Authorization": "Bearer " + key})
            m = json.loads(con.getresponse().read())
            con.close()
            live, eng = m.get("live", {}), m.get("engine", {})
            reqs = m.get("requests") or []
            out = {"reachable": True, "state": live.get("state"), "running": live.get("running"),
                   "waiting": (live.get("waiting") or 0) + (live.get("queued") or 0), "parallel": live.get("parallel"),
                   "slots": [{"state": s.get("state"), "generated": s.get("generated"), "tok_s": s.get("tok_s"),
                              "prompt_read": s.get("prompt_read"), "prompt_total": s.get("prompt_total")}
                             for s in (live.get("slots") or []) if isinstance(s, dict)],
                   "tok_s": live.get("tok_s"), "model": eng.get("model"), "engine": eng.get("version"),
                   "context": eng.get("context"), "kv": eng.get("kv"), "drafting": eng.get("drafting"),
                   "recent": [{"time": r.get("time"), "prompt": r.get("prompt_tokens"), "output": r.get("output_tokens"),
                               "decode_tok_s": r.get("decode_tok_s"), "duration_s": r.get("duration_s"),
                               "finish": r.get("finish")} for r in reqs[-10:]]}
        except Exception as e:
            out["error"] = str(e)[:200]
            try:                                  # a non-Strata engine: just check that it serves a model
                m = E.served_model()
                if m:
                    out = {"reachable": True, "model": m, "state": "serving", "engine": "custom", "slots": [], "recent": []}
            except Exception:
                pass
        return out

    def loop(self):
        while True:
            now = time.time()
            try:
                m = self.meminfo()
                g = self.gpu()
                la = os.getloadavg()
                self.sys = {
                    "time": now, "cpu": self.host_cpu(), "ncpu": NCPU, "load": [round(x, 2) for x in la],
                    "mem_total": m["MemTotal"], "mem_used": m["MemTotal"] - m["MemAvailable"],
                    "swap_total": m["SwapTotal"], "swap_used": m["SwapTotal"] - m["SwapFree"],
                    "uptime": float(open("/proc/uptime").read().split()[0]), "gpu": g,
                    "disks": [dict(d, **(self.df(d["path"]) or {})) for d in L.discover_disks()],
                }
                self.cont = self.containers(now)
                self.account_gpu(now)
                self.strata = self.strata_status()
                self.hist.append((round(now), self.sys["cpu"], round(100 * self.sys["mem_used"] / m["MemTotal"], 1),
                                  g.get("util"), g.get("mem_used"), g.get("power")))
            except Exception as e:
                print("stats:", e, flush=True)
            time.sleep(max(0.5, 5 - (time.time() - now)))

    @staticmethod
    def df(path):
        try:
            s = os.statvfs(path)
            return {"total": s.f_blocks * s.f_frsize, "used": (s.f_blocks - s.f_bfree) * s.f_frsize}
        except OSError:
            return None

    def disk_loop(self):
        while True:
            try:
                rep = L.storage_report()
            except Exception:
                rep = {}
            if rep:                               # quota accounting: instant and exact per filesystem
                self.disk = {u: {"fs": rep.get(u, {}), "at": time.time()} for u in L.lab_members()}
                time.sleep(60)
                continue
            for u in L.lab_members():
                try:
                    home = L.pwd.getpwnam(u).pw_dir
                except KeyError:
                    continue
                d = {}
                for k, path in [("home", home)] + [(r, f"{r}/{u}") for r in L.DATA_ROOTS]:
                    out = sh(["nice", "-n", "19", "ionice", "-c3", "du", "-sxb", path], timeout=600).split()
                    d[k] = int(out[0]) if out and out[0].isdigit() else None
                d["at"] = time.time()
                self.disk[u] = d
            time.sleep(900)


STATS = None


# ---------------------------------------------------------------- data for the API
def fill_days(rows, n=30):
    """One entry per calendar day (server time), oldest first, zeros where there was no traffic."""
    have = {r["d"]: r for r in rows}
    out = []
    for i in range(n - 1, -1, -1):
        d = time.strftime("%Y-%m-%d", time.localtime(time.time() - i * 86400))
        out.append(have.get(d, {"d": d, "n": 0, "p": 0, "c": 0}))
    return out


def users_payload():
    con = L.db()
    t0 = L.day_start()
    rows = {r["name"]: dict(r) for r in con.execute("SELECT * FROM users")}
    today = {r[0]: (r[1], r[2], r[3]) for r in con.execute(
        "SELECT user, COUNT(*), COALESCE(SUM(prompt),0), COALESCE(SUM(completion),0) FROM usage WHERE ts>=? GROUP BY user",
        (t0,))}
    week = {r[0]: (r[1], r[2]) for r in con.execute(
        "SELECT user, COUNT(*), COALESCE(SUM(prompt+completion),0) FROM usage WHERE ts>=? GROUP BY user",
        (time.time() - 7 * 86400,))}
    since = time.strftime("%Y-%m-%d", time.localtime(time.time() - 29 * 86400))
    gpu30 = {r[0]: (r[1], r[2]) for r in con.execute(
        "SELECT user, SUM(held_s), SUM(busy_s) FROM gpu_usage WHERE day>=? GROUP BY user", (since,))}
    con.close()
    out = []
    for name in L.lab_members():
        r = rows.get(name) or {}
        try:
            pw = L.pwd.getpwnam(name)
        except KeyError:
            continue
        c = STATS.cont.get("lab-" + name, {"state": "none"})
        if c.get("state") == "running":
            c = dict(c, effective_cpus=L.effective_limits(name)["CPUS"] or os.cpu_count())
        td = today.get(name, (0, 0, 0))
        out.append({
            "name": name, "uid": pw.pw_uid, "full_name": r.get("full_name") or pw.pw_gecos.split(",")[0],
            "email": r.get("email", ""), "note": r.get("note", ""), "created": r.get("created"),
            "disabled": bool(r.get("disabled")), "llm_enabled": bool(r.get("llm_enabled", 1)),
            "daily_tokens": r.get("daily_tokens", 0), "concurrency": r.get("concurrency", 2),
            "key_prefix": r.get("key_prefix"), "limits": L.read_limits(name), "effective": L.effective_limits(name),
            "container": c, "disk": STATS.disk.get(name), "last_login": L.last_login(name),
            "home": pw.pw_dir, "home_fs": L.home_fs(pw.pw_dir),
            "llm_today": {"requests": td[0], "prompt": td[1], "completion": td[2]},
            "llm_week": {"requests": week.get(name, (0, 0))[0], "tokens": week.get(name, (0, 0))[1]},
            "gpu_30d": {"held_h": round(gpu30.get(name, (0, 0))[0] / 3600, 2), "busy_h": round(gpu30.get(name, (0, 0))[1] / 3600, 2)},
        })
    return out


def user_detail(name):
    L.require_lab_user(name)
    con = L.db()
    days = [dict(r) for r in con.execute(
        "SELECT date(ts,'unixepoch','localtime') d, COUNT(*) n, COALESCE(SUM(prompt),0) p, COALESCE(SUM(completion),0) c "
        "FROM usage WHERE user=? AND ts>=? GROUP BY d ORDER BY d", (name, time.time() - 30 * 86400))]
    recent = [dict(r) for r in con.execute(
        "SELECT ts, endpoint, model, prompt, completion, ms, ttft_ms, status, stream, ip FROM usage WHERE user=? "
        "ORDER BY ts DESC LIMIT 50", (name,))]
    since = time.strftime("%Y-%m-%d", time.localtime(time.time() - 29 * 86400))
    gdays = {r["day"]: r for r in con.execute(
        "SELECT day, held_s, busy_s, mem_mib_s, peak_mib FROM gpu_usage WHERE user=? AND day>=?", (name, since))}
    con.close()
    keys = L.list_keys(name)
    return {"name": name, "ssh_keys": [{"index": i, "type": k.split()[0], "comment": " ".join(k.split()[2:]) or "",
                                        "fingerprint": k.split()[1][-16:] if len(k.split()) > 1 else ""}
                                       for i, k in enumerate(keys)],
            "usage_days": fill_days(days), "recent": recent, "history": list(STATS.chist.get("lab-" + name, [])),
            "gpu_days": [{"d": d, "busy": round(r["busy_s"] / 3600, 2) if r else 0,
                          "idle": round(max(0, r["held_s"] - r["busy_s"]) / 3600, 2) if r else 0,
                          "avg_gib": round(r["mem_mib_s"] / r["held_s"] / 1024, 1) if r and r["held_s"] else 0,
                          "peak_gib": round(r["peak_mib"] / 1024, 1) if r else 0}
                         for d in (x["d"] for x in fill_days([])) for r in [gdays.get(d)]]}


def llm_payload():
    con = L.db()
    since = time.time() - 30 * 86400
    days = [dict(r) for r in con.execute(
        "SELECT date(ts,'unixepoch','localtime') d, COUNT(*) n, COALESCE(SUM(prompt),0) p, COALESCE(SUM(completion),0) c "
        "FROM usage WHERE ts>=? GROUP BY d ORDER BY d", (since,))]
    per_user = [dict(r) for r in con.execute(
        "SELECT user, COUNT(*) n, COALESCE(SUM(prompt),0) p, COALESCE(SUM(completion),0) c, "
        "COALESCE(SUM(status>=400),0) err, AVG(CASE WHEN completion>0 AND ms>0 THEN completion*1000.0/ms END) tps "
        "FROM usage WHERE ts>=? GROUP BY user ORDER BY p+c DESC", (since,))]
    recent = [dict(r) for r in con.execute(
        "SELECT ts, user, endpoint, model, prompt, completion, ms, ttft_ms, status, stream FROM usage ORDER BY ts DESC LIMIT 100")]
    con.close()
    return {"strata": STATS.strata, "days": fill_days(days), "per_user": per_user, "recent": recent,
            "gateway": {"port": C["gateway_port"], "listen": C["gateway_listen"], "model": L.conf()["model"],
                        "active": sh(["systemctl", "is-active", "lab-llm-gateway"]).strip()}}


def start_job(fn, *a):
    if E.running_job():
        raise L.LabError("another engine/storage job is still running")
    holder = {}

    def run():
        holder["job"] = fn(*a)
    t = threading.Thread(target=run, daemon=True)
    t.start()
    for _ in range(20):                      # return as soon as the job object exists
        j = E.running_job()
        if j or not t.is_alive():
            break
        time.sleep(0.05)
    return (j or holder.get("job")).to_dict() if (j or holder.get("job")) else {"state": "starting"}


def move_home_job(name, base, actor):
    job = E.Job("move-home")
    try:
        L.move_home(name, base, actor=actor, say=job.say)
        job.state = "done"
    except Exception as e:
        job.say(f"FAILED: {e}")
        job.state = "failed"
    return job


VERSIONS = {"at": 0, "data": None}
UPDATES = {}
PENDING_TOTP = {}
CPU_TOPO = L.cpu_topology()


def disk_limits_job(path, actor):
    """Turn on per-person limits for one disk (ext4 journaled quotas; remounts it)."""
    job = E.Job("disk-limits")
    try:
        p = subprocess.Popen(["bash", "/opt/lab/panel/storage-setup.sh", path], stdout=subprocess.PIPE,
                             stderr=subprocess.STDOUT, text=True)
        for line in p.stdout:
            if line.strip():
                job.say(line.rstrip()[:200])
        if p.wait() != 0 or not L.quotas_enabled(path):
            raise L.LabError(f"limits are not on for {path}")
        L.audit(actor, "disk-limits", path)
        job.state = "done"
    except Exception as e:
        job.say(f"FAILED: {e}")
        job.state = "failed"
    return job


def upgrade_job(actor):
    job = E.Job("upgrade")
    try:
        env = dict(os.environ, DEBIAN_FRONTEND="noninteractive")
        for cmd in (["apt-get", "update", "-o", "Acquire::Retries=3"],
                    ["apt-get", "-y", "-o", "Dpkg::Options::=--force-confdef", "-o", "Dpkg::Options::=--force-confold", "full-upgrade"],
                    ["apt-get", "-y", "autoremove"], ["snap", "refresh"]):
            job.say("$ " + " ".join(cmd))
            p = subprocess.Popen(cmd, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
            for line in p.stdout:
                if line.strip() and not line.startswith(("Get:", "Hit:", "Ign:", "(Reading database")):
                    job.say(line.rstrip()[:200])
            if p.wait() != 0 and cmd[0] == "apt-get":
                raise L.LabError(f"{' '.join(cmd[:3])} failed")
        st = L.update_status()
        job.say("reboot needed to finish (" + ", ".join(st["reboot_pkgs"][:6]) + ")" if st["reboot_required"] else "no reboot needed")
        L.audit(actor, "system-upgrade", os.uname().nodename)
        job.state = "done"
    except Exception as e:
        job.say(f"FAILED: {e}")
        job.state = "failed"
    return job


def engine_payload(refresh_versions=False):
    if refresh_versions or time.time() - VERSIONS["at"] > 600:
        VERSIONS["data"], VERSIONS["at"] = E.strata_versions(), time.time()
    try:
        st, body = E.backend_get("/v1/status")
        status = json.loads(body) if st == 200 else {}
    except Exception:
        status = {}
    with E.JOB_LOCK:
        jobs = sorted((j.to_dict() for j in E.JOBS.values()), key=lambda j: j["started"], reverse=True)[:3]
    return {"config": E.load(), "has_prev": os.path.exists(E.ENGINE_PREV), "choices": E.CHOICES, "templates": E.TEMPLATES,
            "container": E.container_info(), "versions": VERSIONS["data"], "models": E.local_models(),
            "serving": {"concurrency": (status.get("concurrency") or {}).get("serving"), "engine": status.get("engine"),
                        "model": status.get("model"), "context": (status.get("context") or {}).get("native")},
            "jobs": jobs}


def strata_action(action, actor):
    if action not in ("start", "stop", "restart"):
        raise L.LabError("unknown action")
    L.run(["docker", action, *(["-t", "120"] if action != "start" else []), E.NAME], timeout=200)
    L.audit(actor, "strata-" + action, "strata")


# ---------------------------------------------------------------- HTTP
class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "LabPanel/1.0"
    timeout = 120

    def log_message(self, fmt, *args):
        pass

    def send(self, status, body, ctype="application/json", extra=None):
        if not isinstance(body, bytes):
            body = json.dumps(body, default=str).encode()
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Content-Security-Policy",
                         "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def session(self):
        m = re.search(r"(?:^|;\s*)rlsess=([A-Za-z0-9_-]+)", self.headers.get("Cookie", ""))
        if not m:
            return None
        with LOCK:
            s = SESS.get(m.group(1))
            if not s or s[1] < time.time():
                SESS.pop(m.group(1), None)
                return None
            SESS[m.group(1)] = (s[0], time.time() + SESSION_TTL)
            return s[0]

    def body_json(self):
        n = int(self.headers.get("Content-Length") or 0)
        if n > 1 << 20:
            raise L.LabError("request too large")
        try:
            return json.loads(self.rfile.read(n) or b"{}")
        except ValueError:
            raise L.LabError("bad JSON")

    def do_GET(self):
        self.dispatch("GET")

    def do_POST(self):
        self.dispatch("POST")

    def do_PATCH(self):
        self.dispatch("PATCH")

    def do_DELETE(self):
        self.dispatch("DELETE")

    def dispatch(self, method):
        u = urlsplit(self.path)
        path, qs = u.path, parse_qs(u.query)
        try:
            if method == "GET" and not path.startswith("/api/"):
                return self.static(path)
            if path == "/api/login" and method == "POST":
                return self.login()
            if path == "/api/brand" and method == "GET":      # shown on the sign-in page
                return self.send(200, {"org": L.conf()["org"]})
            admin = self.session()
            if not admin:
                return self.send(401, {"error": "login required"})
            if method != "GET" and self.headers.get("X-RL") != "1":     # CSRF guard: custom header forces same-origin
                return self.send(403, {"error": "missing X-RL header"})
            acct = L.get_admin(admin)
            if not acct:
                return self.send(401, {"error": "login required"})
            role = acct["role"]
            own = path.startswith("/api/me/") or path == "/api/logout"
            if role == "viewer" and (method != "GET" or path.endswith("/llm-key")) and not own:
                return self.send(403, {"error": "Your account can view the panel but not change anything."})
            if role != "owner" and (path.startswith("/api/admins") or (path.startswith("/api/system/") and method != "GET")):
                return self.send(403, {"error": "Only an owner can do that."})
            return self.api(method, path, qs, admin)
        except L.LabError as e:
            return self.send(400, {"error": str(e)})
        except Exception as e:
            print("error:", method, path, repr(e), flush=True)
            return self.send(500, {"error": f"internal error: {e}"})

    def static(self, path):
        name = {"/": "index.html"}.get(path, path.lstrip("/"))
        if not re.match(r"^[a-z0-9_.-]+$", name):
            return self.send(404, b"not found", "text/plain")
        f = os.path.join(STATIC, name)
        if not os.path.isfile(f):
            return self.send(404, b"not found", "text/plain")
        ctype = {"html": "text/html; charset=utf-8", "js": "text/javascript", "css": "text/css",
                 "svg": "image/svg+xml", "ico": "image/x-icon", "woff2": "font/woff2"}.get(name.rsplit(".", 1)[-1], "application/octet-stream")
        self.send(200, open(f, "rb").read(), ctype)

    def login(self):
        ip = self.client_address[0]
        with LOCK:
            n, until = FAILS.get(ip, (0, 0))
        if until > time.time():
            return self.send(429, {"error": f"too many attempts, wait {int(until - time.time())} s"})
        b = self.body_json()
        con = L.db()
        r = con.execute("SELECT pw, totp FROM admins WHERE name=?", (str(b.get("user", ""))[:64],)).fetchone()
        con.close()
        ok = bool(r) and L.check_pw(str(b.get("password", "")), r["pw"])
        if ok and r["totp"]:
            if not b.get("code"):
                return self.send(401, {"need_code": True, "error": "Enter the 6-digit code from your authenticator app."})
            ok = L.totp_ok(r["totp"], b["code"])
        if not ok:
            with LOCK:
                n += 1
                FAILS[ip] = (n, time.time() + (30 * 2 ** min(n - 5, 6) if n >= 5 else 0))
            L.audit(b.get("user", "?"), "login-failed", "", ip)
            time.sleep(1)
            return self.send(403, {"error": "Wrong name, password or code."})
        with LOCK:
            FAILS.pop(ip, None)
            tok = secrets.token_urlsafe(32)
            SESS[tok] = (b["user"], time.time() + SESSION_TTL)
        L.audit(b["user"], "login", "", ip)
        self.send(200, {"ok": True, "user": b["user"]},
                  extra={"Set-Cookie": f"rlsess={tok}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age={SESSION_TTL}"})

    def api(self, method, path, qs, admin):
        parts = path.strip("/").split("/")[1:]          # after "api"
        if method == "POST" and parts == ["logout"]:
            m = re.search(r"rlsess=([A-Za-z0-9_-]+)", self.headers.get("Cookie", ""))
            with LOCK:
                SESS.pop(m.group(1) if m else "", None)
            return self.send(200, {"ok": True}, extra={"Set-Cookie": "rlsess=; Max-Age=0; Path=/; Secure"})
        if method == "GET" and parts == ["me"]:
            return self.send(200, {"user": admin, "org": C["org"], "host": os.uname().nodename,
                                   "gateway_port": C["gateway_port"], "model": L.conf()["model"], "ncpu": os.cpu_count(),
                                   "home_bases": {d["homes"]: f"{d['label']} ({d['homes']})" for d in L.storage_view() if d.get("homes")}, "quota_fs": [fs for fs in L.QUOTA_FS if L.quotas_enabled(fs)],
                                   "default_quota_gb": L.conf().get("default_quota_gb", {}),
                                   "role": L.get_admin(admin)["role"], "two_factor": bool(L.get_admin(admin)["totp"]),
                                   "cpu": CPU_TOPO, "storage": L.storage_view(), "data_roots": list(L.DATA_ROOTS),
                                   "container_fs": L.container_fs(),
                                   "default_sudo": L.conf().get("default_sudo", True)})
        if method == "GET" and parts == ["overview"]:
            return self.send(200, {"sys": STATS.sys, "hist": list(STATS.hist), "strata": STATS.strata,
                                   "containers": STATS.cont, "users": users_payload()})
        if method == "GET" and parts == ["users"]:
            return self.send(200, users_payload())
        if method == "POST" and parts == ["users"]:
            b = self.body_json()
            L.add_user(str(b.get("name", "")), password=b.get("password") or None, pubkey=b.get("pubkey") or None,
                       full_name=b.get("full_name", ""), email=b.get("email", ""), note=b.get("note", ""),
                       memory=b.get("memory", ""), cpus=b.get("cpus", ""), gpu=b.get("gpu", ""),
                       daily_tokens=b.get("daily_tokens"), concurrency=b.get("concurrency"), actor=admin,
                       home_base=b.get("home_base") or "/home", cpuset=b.get("cpuset", ""), quotas=b.get("quotas"),
                       sudo=b.get("sudo", ""), data=b.get("data", ""))
            return self.send(200, {"ok": True})
        if len(parts) >= 2 and parts[0] == "users":
            name = L.valid_name(parts[1])
            sub = parts[2:]
            if method == "GET" and not sub:
                return self.send(200, user_detail(name))
            if method == "PATCH" and not sub:
                b = self.body_json()
                allowed = ("full_name", "email", "note", "llm_enabled", "daily_tokens", "concurrency", "memory", "cpus",
                           "cpuset", "gpu", "quotas", "sudo", "data")
                note = L.update_user(name, actor=admin, **{k: b[k] for k in allowed if k in b})
                if "disabled" in b:
                    L.set_disabled(name, bool(b["disabled"]), actor=admin)
                return self.send(200, {"ok": True, "note": note})
            if method == "DELETE" and not sub:
                return self.send(200, {"ok": True, "removed": L.delete_user(name, purge=qs.get("purge") == ["1"], actor=admin)})
            if method == "POST" and sub == ["password"]:
                L.set_password(name, self.body_json().get("password", ""), actor=admin)
                return self.send(200, {"ok": True})
            if method == "POST" and sub == ["keys"]:
                L.add_key(name, self.body_json().get("pubkey", ""), actor=admin)
                return self.send(200, {"ok": True})
            if method == "DELETE" and len(sub) == 2 and sub[0] == "keys":
                L.remove_key(name, int(sub[1]), actor=admin)
                return self.send(200, {"ok": True})
            if method == "POST" and sub == ["container"]:
                L.container_action(name, self.body_json().get("action", ""), actor=admin)
                return self.send(200, {"ok": True})
            if method == "GET" and sub == ["llm-key"]:
                L.audit(admin, "llm-key-view", name)
                return self.send(200, {"key": L.read_key(name)})
            if method == "POST" and sub == ["llm-key"]:
                L.ensure_db_row(name)
                return self.send(200, {"key": L.new_llm_key(name, actor=admin)})
        if method == "GET" and parts == ["llm"]:
            return self.send(200, llm_payload())
        if parts == ["me", "password"] and method == "POST":
            b = self.body_json()
            if not L.check_pw(str(b.get("current", "")), L.get_admin(admin)["pw"]):
                raise L.LabError("the current password is wrong")
            L.save_admin(admin, pw=str(b.get("new", "")), actor=admin)
            return self.send(200, {"ok": True})
        if parts == ["me", "totp", "start"] and method == "POST":
            sec = L.new_totp_secret()
            PENDING_TOTP[admin] = sec
            org = re.sub(r"[^A-Za-z0-9]", "", C["org"]) or "Lab"
            return self.send(200, {"secret": sec, "uri": f"otpauth://totp/{org}:{admin}?secret={sec}&issuer={org}"})
        if parts == ["me", "totp", "confirm"] and method == "POST":
            sec = PENDING_TOTP.get(admin)
            if not sec or not L.totp_ok(sec, self.body_json().get("code")):
                raise L.LabError("that code does not match; check the time on your phone and try again")
            L.set_totp(admin, sec, admin)
            PENDING_TOTP.pop(admin, None)
            return self.send(200, {"ok": True})
        if parts == ["me", "totp", "off"] and method == "POST":
            a = L.get_admin(admin)
            if a["totp"] and not L.totp_ok(a["totp"], self.body_json().get("code")):
                raise L.LabError("that code does not match")
            L.set_totp(admin, None, admin)
            return self.send(200, {"ok": True})
        if parts == ["admins"] and method == "GET":
            return self.send(200, L.list_admins())
        if parts == ["admins"] and method == "POST":
            b = self.body_json()
            if L.get_admin(str(b.get("name", ""))):
                raise L.LabError("that admin already exists")
            L.save_admin(str(b.get("name", "")), pw=str(b.get("password", "")), role=b.get("role", "admin"), actor=admin)
            return self.send(200, {"ok": True})
        if len(parts) == 2 and parts[0] == "admins" and method == "PATCH":
            b = self.body_json()
            L.save_admin(L.valid_name(parts[1]), pw=b.get("password") or None, role=b.get("role"), actor=admin)
            return self.send(200, {"ok": True})
        if len(parts) == 2 and parts[0] == "admins" and method == "DELETE":
            if parts[1] == admin:
                raise L.LabError("you cannot delete your own account")
            L.delete_admin(L.valid_name(parts[1]), admin)
            return self.send(200, {"ok": True})
        if parts == ["system", "disks"] and method == "GET":
            cfg = {s["path"]: s for s in L.STORAGE}
            homes = [L.pwd.getpwnam(u).pw_dir for u in L.lab_members()]
            out = []
            for d in L.discover_disks(0 if qs.get("refresh") == ["1"] else 60):
                s = cfg.get(d["path"], {})
                out.append(dict(d, homes=bool(s.get("homes")), data=bool(s.get("data")), custom_label=s.get("label", ""),
                                homes_dir=s.get("homes", ""), data_dir=s.get("data", ""),
                                people=sum(1 for h in homes if s.get("homes") and h.startswith(s["homes"] + "/")),
                                limits="on" if L.quotas_enabled(d["path"]) else ("off" if d["limits_possible"] else "unsupported")))
            return self.send(200, {"disks": out, "container_fs": L.container_fs()})
        if parts == ["system", "disks"] and method == "PUT":
            L.save_storage(self.body_json().get("disks") or [], actor=admin)
            return self.send(200, {"ok": True})
        if parts == ["system", "disks", "limits"] and method == "POST":
            path = str(self.body_json().get("path", ""))
            if path not in L.QUOTA_FS:
                raise L.LabError("turn on home or data folders for this disk first")
            return self.send(200, start_job(disk_limits_job, path, admin))
        if parts == ["system", "updates"] and method == "GET":
            if qs.get("refresh") == ["1"] or time.time() - UPDATES.get("checked", 0) > 1800:
                if qs.get("refresh") == ["1"]:
                    L.run(["apt-get", "update", "-qq", "-o", "Acquire::Retries=3"], check=False, timeout=300)
                UPDATES.clear()
                UPDATES.update(L.update_status())
            return self.send(200, UPDATES)
        if parts == ["system", "upgrade"] and method == "POST":
            UPDATES.clear()
            return self.send(200, start_job(upgrade_job, admin))
        if parts == ["system", "reboot"] and method == "POST":
            if self.body_json().get("confirm") != "reboot":
                raise L.LabError("confirmation missing")
            L.audit(admin, "reboot", os.uname().nodename)
            subprocess.Popen(["systemd-run", "--on-active=5", "systemctl", "reboot"])
            return self.send(200, {"ok": True})
        if method == "GET" and parts == ["engine"]:
            return self.send(200, engine_payload(qs.get("refresh") == ["1"]))
        if method == "POST" and parts == ["engine", "apply"]:
            cfg = self.body_json().get("config")
            if not isinstance(cfg, dict):
                raise L.LabError("missing config")
            base = E.load()
            base["engine"] = cfg.get("engine", base["engine"])
            for k in ("strata", "custom"):
                base[k].update({kk: vv for kk, vv in (cfg.get(k) or {}).items() if kk in E.DEFAULT[k]})
            E.validate(base)
            return self.send(200, start_job(E.apply, base, admin))
        if method == "POST" and parts == ["engine", "rollback"]:
            if not os.path.exists(E.ENGINE_PREV):
                raise L.LabError("no previous configuration")
            prev = json.load(open(E.ENGINE_PREV))
            return self.send(200, start_job(E.apply, prev, admin))
        if method == "POST" and parts == ["engine", "pull"]:
            return self.send(200, start_job(E.pull_job, str(self.body_json().get("tag", "")), admin))
        if method == "POST" and parts == ["storage", "move-home"]:
            b = self.body_json()
            return self.send(200, start_job(move_home_job, L.valid_name(str(b.get("user", ""))), str(b.get("base", "")), admin))
        if method == "GET" and parts == ["jobs"]:
            with E.JOB_LOCK:
                return self.send(200, sorted((j.to_dict() for j in E.JOBS.values()), key=lambda j: j["started"], reverse=True)[:5])
        if method == "POST" and parts == ["strata"]:
            strata_action(self.body_json().get("action", ""), admin)
            return self.send(200, {"ok": True})
        if method == "GET" and parts == ["audit"]:
            con = L.db()
            rows = [dict(r) for r in con.execute("SELECT * FROM audit ORDER BY id DESC LIMIT 300")]
            con.close()
            return self.send(200, rows)
        return self.send(404, {"error": "no such endpoint"})


class Server(ThreadingHTTPServer):
    """TLS handshake happens in the per-connection thread, so a slow client cannot block accept()."""
    daemon_threads = True
    allow_reuse_address = True
    request_queue_size = 64
    ctx = None

    def finish_request(self, request, client_address):
        request.settimeout(20)
        try:
            tls = self.ctx.wrap_socket(request, server_side=True)
        except (ssl.SSLError, OSError):
            return
        try:
            self.RequestHandlerClass(tls, client_address, self)
        finally:
            try:
                tls.close()
            except OSError:
                pass


if __name__ == "__main__":
    L.init_db()
    STATS = Stats()
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.minimum_version = ssl.TLSVersion.TLSv1_2
    ctx.load_cert_chain(os.path.join(TLS_DIR, "tls.crt"), os.path.join(TLS_DIR, "tls.key"))
    Server.ctx = ctx
    srv = Server((C["panel_listen"], int(C["panel_port"])), Handler)
    print(f"panel on https://{C['panel_listen']}:{C['panel_port']}", flush=True)
    srv.serve_forever()
