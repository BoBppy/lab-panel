#!/usr/bin/env python3
"""LLM engine manager: one engine container ("llm-engine") on 127.0.0.1:<strata_port>, described by
/etc/lab/engine.json. Drivers: "strata" (default) and "custom" (any OpenAI-compatible server image: vLLM, SGLang,
llama.cpp ...). The gateway only needs the backend to speak the OpenAI / Anthropic HTTP APIs on that port.

  python3 engine.py apply      (re)create the engine container from engine.json
  python3 engine.py status
"""
import copy
import http.client
import json
import os
import re
import shlex
import subprocess
import sys
import threading
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import labcore as L  # noqa: E402

ENGINE_JSON = "/etc/lab/engine.json"
ENGINE_PREV = "/etc/lab/engine.prev.json"
NAME = "llm-engine"
KEY_FILE = "/etc/lab/strata.key"
STRATA_REPO = "ghcr.io/niko1221/strata"
C = L.conf()
MODELS_ROOT = C["models_root"].rstrip("/")

DEFAULT = {
    "engine": "strata",
    "strata": {
        "tag": "0.2.23-cuda13",
        "model_dir": "",
        "family": "swift", "model": "IQ3_S",
        "context": "256k", "parallel": 4, "kv": "int8", "vision": "gpu", "drafting": "auto",
        "batch_mtp": True, "resident_experts": True, "route_tail_skip": 0, "extra_set": "",
    },
    "custom": {
        "image": "", "port": 8000, "model_dir": "", "args": "", "env": "", "shm": "16g",
    },
}

CHOICES = {
    "context": ["32k", "64k", "128k", "256k", "384k", "512k", "1m"],   # past 256k Strata adds YaRN, factor = context / 256k
    "kv": ["int8", "q4_0", "k8v4", "fp16"],
    "vision": ["off", "gpu", "cpu"],
    "drafting": ["auto", "mtp", "dflash2", "off"],
}

# Starting points for other engines (not validated on this server; adjust the image, model path and flags).
TEMPLATES = {
    "sglang": {"image": "lmsysorg/sglang:latest", "port": 30000, "shm": "32g",
               "args": "python3 -m sglang.launch_server --model-path /models --host 0.0.0.0 --port 30000 "
                       "--api-key {key} --context-length 262144 --max-running-requests 4 --served-model-name local"},
    "vllm": {"image": "vllm/vllm-openai:latest", "port": 8000, "shm": "32g",
             "args": "--model /models --served-model-name local --api-key {key} --max-model-len 262144 --max-num-seqs 4"},
    "llama.cpp": {"image": "ghcr.io/ggml-org/llama.cpp:server-cuda", "port": 8080, "shm": "8g",
                  "args": "-m /models/MODEL.gguf --host 0.0.0.0 --port 8080 --api-key {key} -c 262144 -np 4 -ngl 999 "
                          "--alias local"},
}


def load():
    cfg = copy.deepcopy(DEFAULT)
    try:
        with open(ENGINE_JSON) as f:
            saved = json.load(f)
        cfg["engine"] = saved.get("engine", cfg["engine"])
        for k in ("strata", "custom"):
            cfg[k].update(saved.get(k) or {})
    except FileNotFoundError:
        pass
    return cfg


def save(cfg):
    if os.path.exists(ENGINE_JSON):
        os.replace(ENGINE_JSON, ENGINE_PREV)
    tmp = ENGINE_JSON + ".tmp"
    with open(tmp, "w") as f:
        json.dump(cfg, f, indent=2)
    os.chmod(tmp, 0o644)
    os.replace(tmp, ENGINE_JSON)


def validate(cfg):
    if cfg.get("engine") not in ("strata", "custom"):
        raise L.LabError("engine must be strata or custom")
    s = cfg["strata"]
    if not re.match(r"^[0-9][0-9a-z._-]{0,40}$", str(s["tag"])):
        raise L.LabError("bad Strata version tag")
    for k, opts in CHOICES.items():
        if s[k] not in opts:
            raise L.LabError(f"{k} must be one of {', '.join(opts)}")
    if not 1 <= int(s["parallel"]) <= 8:
        raise L.LabError("parallel must be 1 to 8")
    if not 0 <= int(s["route_tail_skip"]) <= 9:
        raise L.LabError("route tail skip must be 0 (off) to 9")
    if s["model_dir"] and not (os.path.realpath(s["model_dir"]).startswith(MODELS_ROOT + "/") and os.path.isdir(s["model_dir"])):
        raise L.LabError(f"model folder must be a folder under {MODELS_ROOT}")
    for k in ("family", "model"):
        if not re.match(r"^[A-Za-z0-9_.-]{1,40}$", str(s[k])):
            raise L.LabError(f"bad {k}")
    if not re.match(r"^[A-Za-z0-9_.=:/ -]{0,400}$", str(s["extra_set"])):
        raise L.LabError("extra settings: space-separated key=value pairs")
    c = cfg["custom"]
    if cfg["engine"] == "custom":
        if not re.match(r"^[a-z0-9][a-z0-9._/:@-]{2,200}$", c["image"]):
            raise L.LabError("custom engine needs a Docker image name")
        if not 1 <= int(c["port"]) <= 65535:
            raise L.LabError("bad port")
        if c["model_dir"] and not (os.path.realpath(c["model_dir"]).startswith(MODELS_ROOT + "/") and os.path.isdir(c["model_dir"])):
            raise L.LabError(f"model folder must be a folder under {MODELS_ROOT}")
        if not re.match(r"^[0-9]+[mg]$", c["shm"]):
            raise L.LabError("shm like 16g")
        shlex.split(c["args"])
        for line in c["env"].splitlines():
            if line.strip() and not re.match(r"^[A-Z_][A-Z0-9_]*=.*$", line.strip()):
                raise L.LabError(f"env line must be NAME=value: {line[:40]}")


def docker_args(cfg):
    port = int(L.conf()["strata_port"])
    key = open(KEY_FILE).read().strip()
    common = ["docker", "run", "-d", "--name", NAME, "--restart", "unless-stopped", "--gpus", "all",
              "--ulimit", "memlock=-1:-1", "--stop-timeout", "120",
              # the engine is the last thing the kernel should kill when memory runs out
              "--oom-score-adj", "-900", "--label", "lab.engine=" + cfg["engine"]]
    if cfg["engine"] == "strata":
        s = cfg["strata"]
        sets = []
        if s["resident_experts"]:
            sets.append("resident-experts=1")
        if s["batch_mtp"]:
            sets.append("batch-mtp=1")
        sets.append(f"STRATA_ROUTE_TAIL_SKIP={int(s['route_tail_skip'])}")
        if s["extra_set"].strip():
            sets.append(s["extra_set"].strip())
        a = common + ["-p", f"127.0.0.1:{port}:8080", "--shm-size", "2g", "-v", f"{C['engine_state']}:/data",
                      "-e", "API_KEY_FILE=/run/strata.key", "-v", f"{KEY_FILE}:/run/strata.key:ro",
                      *hf_env(), "-e", "TUNE=skip",
                      "-e", f"FAMILY={s['family']}", "-e", f"MODEL={s['model']}", "-e", f"CONTEXT={s['context']}",
                      "-e", f"PARALLEL={int(s['parallel'])}", "-e", f"KV={s['kv']}", "-e", f"VISION={s['vision']}",
                      "-e", f"DRAFTING={s['drafting']}", "-e", "STRATA_SET=" + " ".join(sets)]
        if s["model_dir"]:
            a += ["-v", f"{s['model_dir']}:/models:ro", "-e", "MODEL_PATH=/models", "-e", "HF_HUB_OFFLINE=1"]
        return a + [f"{STRATA_REPO}:{s['tag']}"]
    c = cfg["custom"]
    a = common + ["-p", f"127.0.0.1:{port}:{int(c['port'])}", "--shm-size", c["shm"], "--ipc", "private",
                  *hf_env(), "-v", f"{C['hf_cache']}:/root/.cache/huggingface"]
    if c["model_dir"]:
        a += ["-v", f"{c['model_dir']}:/models:ro"]
    for line in c["env"].splitlines():
        if line.strip():
            a += ["-e", line.strip()]
    return a + [c["image"]] + [x.replace("{key}", key) for x in shlex.split(c["args"])]


# ---------------------------------------------------------------- backend probing
def backend_get(path, timeout=3):
    key = open(KEY_FILE).read().strip()
    con = http.client.HTTPConnection("127.0.0.1", int(L.conf()["strata_port"]), timeout=timeout)
    try:
        con.request("GET", path, headers={"Authorization": "Bearer " + key})
        r = con.getresponse()
        return r.status, r.read()
    finally:
        con.close()


def served_model():
    st, body = backend_get("/v1/models")
    if st != 200:
        return None
    data = json.loads(body).get("data") or []
    return data[0]["id"] if data else None


def container_info():
    p = L.run(["docker", "container", "inspect", NAME], check=False)
    if p.returncode != 0:
        return None
    d = json.loads(p.stdout)[0]
    return {"state": d["State"]["Status"], "health": (d["State"].get("Health") or {}).get("Status"),
            "image": d["Config"]["Image"], "started": d["State"].get("StartedAt"),
            "engine": d["Config"]["Labels"].get("lab.engine", "?")}


def update_model_name(model):
    """Point lab.json and every user's llm.env at the model id the backend serves (keys unchanged)."""
    c = L.conf()
    if not model or c.get("model") == model:
        return
    with open(L.CONF_PATH) as f:
        raw = json.load(f)
    raw["model"] = model
    with open(L.CONF_PATH + ".tmp", "w") as f:
        json.dump(raw, f, indent=2)
    os.replace(L.CONF_PATH + ".tmp", L.CONF_PATH)
    for u in L.lab_members():
        k = L.read_key(u)
        if k:
            L.write_key_file(u, k)


# ---------------------------------------------------------------- jobs (panel runs these in a thread)
JOBS = {}
JOB_LOCK = threading.Lock()


class Job:
    def __init__(self, kind):
        self.id = f"{kind}-{int(time.time())}"
        self.kind, self.state, self.log, self.started = kind, "running", [], time.time()
        with JOB_LOCK:
            if len(JOBS) > 20:
                JOBS.clear()
            JOBS[self.id] = self

    def say(self, msg):
        self.log.append(f"{time.strftime('%H:%M:%S')} {msg}")

    def to_dict(self):
        return {"id": self.id, "kind": self.kind, "state": self.state, "log": self.log[-60:], "started": self.started}


def running_job():
    with JOB_LOCK:
        return next((j for j in JOBS.values() if j.state == "running"), None)


def apply(cfg, actor="cli", job=None):
    job = job or Job("apply")
    try:
        validate(cfg)
        args = docker_args(cfg)
        image = f"{STRATA_REPO}:{cfg['strata']['tag']}" if cfg["engine"] == "strata" else cfg["custom"]["image"]
        if L.run(["docker", "image", "inspect", image], check=False).returncode != 0:
            job.say(f"image {image} is not on this server; pulling")
            pull(image, job)
        save(cfg)
        job.say("stopping the current engine (up to 2 minutes while it unloads)")
        L.run(["docker", "stop", "-t", "120", NAME], check=False, timeout=200)
        L.run(["docker", "rm", "-f", NAME], check=False)
        L.run(["docker", "rm", "-f", "strata"], check=False)         # the pre-panel container name
        key = open(KEY_FILE).read().strip()
        job.say("starting: " + " ".join(args[2:]).replace(key, "<key>")[:900])
        L.run(args)
        t0 = time.time()
        while time.time() - t0 < 1200:
            time.sleep(5)
            ci = container_info()
            if not ci or ci["state"] != "running":
                tail = L.run(["docker", "logs", "--tail", "15", NAME], check=False)
                raise L.LabError("the engine container exited:\n" + (tail.stdout + tail.stderr)[-1500:])
            try:
                m = served_model()
            except OSError:
                m = None
            if m:
                job.say(f"serving model {m} after {int(time.time() - t0)} s")
                update_model_name(m)
                break
            if int(time.time() - t0) % 30 < 5:
                last = L.run(["docker", "logs", "--tail", "1", NAME], check=False)
                job.say(f"loading… {int(time.time() - t0)} s  {(last.stdout or last.stderr).strip()[-160:]}")
        else:
            raise L.LabError("the engine did not come up within 20 minutes; see docker logs llm-engine")
        L.audit(actor, "engine-apply", cfg["engine"], cfg[cfg["engine"]])
        job.state = "done"
    except Exception as e:
        job.say(f"FAILED: {e}")
        job.state = "failed"
        L.audit(actor, "engine-apply-failed", cfg.get("engine", "?"), str(e)[:500])
    return job


# ---------------------------------------------------------------- versions
def strata_versions():
    """Remote tags (ghcr.io API, small and fast here) + local images."""
    local = [ln.split(":", 1)[1] for ln in L.run(["docker", "images", STRATA_REPO, "--format", "{{.Repository}}:{{.Tag}}"],
                                                  check=False).stdout.split() if ":" in ln]
    remote = []
    try:
        tok = json.loads(L.run(["curl", "-s", "-m", "15", "https://ghcr.io/token?scope=repository:niko1221/strata:pull"]).stdout)["token"]
        tags = json.loads(L.run(["curl", "-s", "-m", "20", "-H", "Authorization: Bearer " + tok,
                                 "https://ghcr.io/v2/niko1221/strata/tags/list"]).stdout)["tags"]
        remote = [t for t in tags if t.endswith("-cuda13")]
    except Exception:
        pass

    def vkey(t):
        return [int(x) for x in re.findall(r"\d+", t.split("-")[0])]
    remote.sort(key=vkey, reverse=True)
    return {"remote": remote[:15], "local": sorted(local, key=vkey, reverse=True)}


def ghcr_digest(repo, tag):
    tok = json.loads(L.run(["curl", "-s", "-m", "15", f"https://ghcr.io/token?scope=repository:{repo}:pull"]).stdout)["token"]
    hdr = L.run(["curl", "-sI", "-m", "20", "-H", "Authorization: Bearer " + tok, "-H",
                 "Accept: application/vnd.oci.image.index.v1+json,application/vnd.docker.distribution.manifest.list.v2+json,"
                 "application/vnd.oci.image.manifest.v1+json,application/vnd.docker.distribution.manifest.v2+json",
                 f"https://ghcr.io/v2/{repo}/manifests/{tag}"]).stdout
    m = re.search(r"docker-content-digest:\s*(sha256:[0-9a-f]{64})", hdr, re.I)
    if not m:
        raise L.LabError("could not read the image digest from ghcr.io")
    return m.group(1)


def hf_env():
    return ["-e", f"HF_ENDPOINT={C['hf_endpoint']}"] if C.get("hf_endpoint") else []


def pull(image, job):
    """With "ghcr_mirror" set, ghcr.io images come through that mirror and are checked against ghcr.io's own
    manifest digest before use. Everything else is a plain docker pull (Docker's registry mirrors apply)."""
    if image.startswith("ghcr.io/") and C.get("ghcr_mirror"):
        repo, tag = image[len("ghcr.io/"):].rsplit(":", 1)
        want = ghcr_digest(repo, tag)
        mirror = f"{C['ghcr_mirror']}/{repo}:{tag}"
        job.say(f"pulling {mirror} (expect digest {want[:19]}…)")
        p = subprocess.run(["docker", "pull", mirror], text=True, capture_output=True, timeout=7200)
        if p.returncode != 0:
            job.say("mirror failed, pulling from ghcr.io directly (slow)")
            L.run(["docker", "pull", image], timeout=14400)
        else:
            got = L.run(["docker", "image", "inspect", mirror, "-f", "{{json .RepoDigests}}"]).stdout
            if want not in got:
                L.run(["docker", "rmi", mirror], check=False)
                raise L.LabError(f"digest mismatch from mirror ({got.strip()[:120]}); not using it")
            L.run(["docker", "tag", mirror, image])
            L.run(["docker", "rmi", mirror], check=False)
        job.say(f"pulled {image}, digest verified")
    else:
        job.say(f"pulling {image}")
        L.run(["docker", "pull", image], timeout=14400)
        job.say(f"pulled {image}")


def pull_job(tag, actor):
    job = Job("pull")
    try:
        if not re.match(r"^[0-9][0-9a-z._-]{0,40}$", tag):
            raise L.LabError("bad tag")
        pull(f"{STRATA_REPO}:{tag}", job)
        L.audit(actor, "engine-pull", tag)
        job.state = "done"
    except Exception as e:
        job.say(f"FAILED: {e}")
        job.state = "failed"
    return job


def local_models():
    out = []
    for d in sorted(os.listdir(MODELS_ROOT)):
        p = os.path.join(MODELS_ROOT, d)
        if os.path.isdir(p):
            files = [f for f in os.listdir(p) if f.endswith((".gguf", ".safetensors"))]
            size = sum(os.path.getsize(os.path.join(p, f)) for f in files)
            out.append({"path": p, "name": d, "files": len(files), "size": size})
    return out


if __name__ == "__main__":
    if os.geteuid() != 0:
        sys.exit("run as root")
    cmd = sys.argv[1] if len(sys.argv) > 1 else "status"
    if cmd == "apply":
        j = apply(load(), actor="cli")
        print("\n".join(j.log))
        sys.exit(0 if j.state == "done" else 1)
    print(json.dumps({"config": load(), "container": container_info()}, indent=2))
