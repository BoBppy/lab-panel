#!/usr/bin/env python3
"""Lab LLM gateway: per-user API keys, daily token quotas, concurrency caps and usage logging
in front of the local Strata server. OpenAI (chat, completions, responses) and Anthropic (messages)
requests are passed through unchanged apart from the key. Python stdlib only; runs as user labgw."""
import http.client
import json
import os
import sqlite3
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import labcore  # noqa: E402

C = labcore.conf()
BACKEND = ("127.0.0.1", int(C["strata_port"]))
BACKEND_KEY = open(os.environ.get("STRATA_KEY_FILE", "/etc/lab/strata.key")).read().strip()
MAX_BODY = 64 * 2**20

GEN_POST = {"/v1/chat/completions", "/v1/completions", "/v1/messages", "/v1/responses",
            "/chat/completions", "/completions", "/messages", "/responses"}
OTHER_POST = {"/v1/messages/count_tokens", "/v1/tokenize", "/v1/detokenize"}
GET_OK = {"/v1/models", "/models", "/health", "/v1/health"}
HOP = {"connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailers",
       "transfer-encoding", "upgrade", "host", "content-length", "authorization", "x-api-key", "accept-encoding"}


# ---------------------------------------------------------------- key cache
class Keys:
    def __init__(self):
        self.lock = threading.Lock()
        self.by_hash = {}
        self.loaded = 0
        self.sems = {}

    def get(self, key):
        now = time.time()
        with self.lock:
            if now - self.loaded > 3:
                con = labcore.db()
                rows = con.execute("SELECT * FROM users WHERE key_hash IS NOT NULL").fetchall()
                con.close()
                self.by_hash = {r["key_hash"]: dict(r) for r in rows}
                self.loaded = now
            u = self.by_hash.get(labcore.hash_key(key))
            if u:
                n = max(1, int(u["concurrency"] or 1))
                s = self.sems.get(u["name"])
                if s is None or s[0] != n:
                    s = (n, threading.BoundedSemaphore(n))
                    self.sems[u["name"]] = s
                u["_sem"] = s[1]
            return u


KEYS = Keys()


def log_usage(**r):
    for _ in range(3):
        try:
            con = labcore.db()
            con.execute("INSERT INTO usage(ts,user,endpoint,model,prompt,completion,cached,ms,ttft_ms,status,stream,ip) "
                        "VALUES(:ts,:user,:endpoint,:model,:prompt,:completion,:cached,:ms,:ttft_ms,:status,:stream,:ip)",
                        r)
            con.commit()
            con.close()
            return
        except sqlite3.OperationalError:
            time.sleep(0.5)


# ---------------------------------------------------------------- usage parsing
def merge_usage(acc, obj):
    """Collect token counts from OpenAI / Anthropic / Responses payloads (stream events or full bodies)."""
    if not isinstance(obj, dict):
        return
    cands = [obj.get("usage")]
    if isinstance(obj.get("message"), dict):          # anthropic message_start
        cands.append(obj["message"].get("usage"))
    if isinstance(obj.get("response"), dict):         # responses: response.completed
        cands.append(obj["response"].get("usage"))
    for u in cands:
        if not isinstance(u, dict):
            continue
        p = u.get("prompt_tokens", u.get("input_tokens"))
        if "prompt_tokens" not in u and isinstance(p, int):   # Anthropic splits the prompt into three counters
            p += (u.get("cache_creation_input_tokens") or 0) + (u.get("cache_read_input_tokens") or 0)
        c = u.get("completion_tokens", u.get("output_tokens"))
        cached = (u.get("prompt_tokens_details") or {}).get("cached_tokens") or u.get("cache_read_input_tokens") \
            or (u.get("input_tokens_details") or {}).get("cached_tokens")
        if isinstance(p, int):
            acc["prompt"] = max(acc["prompt"], p)
        if isinstance(c, int):
            acc["completion"] = max(acc["completion"], c)
        if isinstance(cached, int):
            acc["cached"] = max(acc["cached"], cached)


def has_text(obj):
    if not isinstance(obj, dict):
        return False
    for ch in obj.get("choices") or []:
        d = ch.get("delta") or {}
        if d.get("content") or d.get("reasoning_content") or d.get("reasoning") or d.get("tool_calls") or ch.get("text"):
            return True
    t = obj.get("type", "")
    if t == "content_block_delta":
        return True
    if t.startswith("response.") and t.endswith(".delta"):
        return True
    return False


def err_body(path, status, msg, etype):
    if "messages" in path:
        return {"type": "error", "error": {"type": etype, "message": msg}}
    return {"error": {"message": msg, "type": etype, "code": status}}


# ---------------------------------------------------------------- handler
class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "LabLLM/1.0"
    timeout = 600

    def log_message(self, fmt, *args):
        pass

    def send_json(self, status, obj, extra=None):
        b = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(b)))
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(b)

    def fail(self, path, status, msg, etype):
        self.send_json(status, err_body(path, status, msg, etype))

    def do_GET(self):
        self.route("GET")

    def do_POST(self):
        self.route("POST")

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def read_body(self):
        if self.headers.get("Transfer-Encoding", "").lower() == "chunked":
            out = bytearray()
            while True:
                n = int(self.rfile.readline().split(b";")[0].strip() or b"0", 16)
                if n == 0:
                    self.rfile.readline()
                    break
                out += self.rfile.read(n)
                self.rfile.readline()
                if len(out) > MAX_BODY:
                    raise ValueError("body too large")
            return bytes(out)
        n = int(self.headers.get("Content-Length") or 0)
        if n > MAX_BODY:
            raise ValueError("body too large")
        return self.rfile.read(n) if n else b""

    def route(self, method):
        path = urlsplit(self.path).path.rstrip("/") or "/"
        if method == "GET" and path in ("/", "/health"):
            return self.send_json(200, {"status": "ok", "service": f"{C['org']} LLM gateway", "model": C["model"]})
        auth = self.headers.get("Authorization", "")
        key = auth[7:].strip() if auth.lower().startswith("bearer ") else self.headers.get("x-api-key", "").strip()
        u = KEYS.get(key) if key else None
        if not u:
            return self.fail(path, 401, "invalid or missing API key (your key is in $OPENAI_API_KEY inside your lab container)",
                             "authentication_error")
        if u["disabled"] or not u["llm_enabled"]:
            return self.fail(path, 403, "LLM access is disabled for this account", "permission_error")
        if method == "GET" and path == "/lab/me":
            return self.me(u)
        if not ((method == "GET" and (path in GET_OK or path.startswith("/v1/models/")))
                or (method == "POST" and (path in GEN_POST or path in OTHER_POST))):
            return self.fail(path, 404, f"{method} {path} is not available through the gateway", "not_found_error")
        try:
            body = self.read_body() if method == "POST" else b""
        except ValueError as e:
            self.close_connection = True
            return self.fail(path, 413, str(e), "invalid_request_error")
        gen = method == "POST" and path in GEN_POST
        if gen and u["daily_tokens"]:
            con = labcore.db()
            used = labcore.usage_today(con, u["name"])
            con.close()
            if used >= u["daily_tokens"]:
                return self.fail(path, 429, f"daily token quota reached ({used:,}/{u['daily_tokens']:,}); resets at midnight server time",
                                 "rate_limit_error")
        injected = False
        req = None
        if gen and body:
            try:
                req = json.loads(body)
            except ValueError:
                return self.fail(path, 400, "request body is not JSON", "invalid_request_error")
            if req.get("stream") and path.endswith(("chat/completions", "/completions")):
                so = req.get("stream_options") or {}
                if not so.get("include_usage"):
                    req["stream_options"] = dict(so, include_usage=True)
                    injected = True
                    body = json.dumps(req).encode()
        sem = u["_sem"] if gen else None
        if sem and not sem.acquire(timeout=900):
            return self.fail(path, 429, "too many concurrent requests for this account", "rate_limit_error")
        try:
            self.proxy(method, path, body, u, req, injected, gen)
        finally:
            if sem:
                sem.release()

    def me(self, u):
        con = labcore.db()
        today = labcore.usage_today(con, u["name"])
        r = con.execute("SELECT COUNT(*), COALESCE(SUM(prompt),0), COALESCE(SUM(completion),0) FROM usage "
                        "WHERE user=? AND ts>=?", (u["name"], time.time() - 30 * 86400)).fetchone()
        con.close()
        self.send_json(200, {"user": u["name"], "model": C["model"], "tokens_today": today,
                             "daily_limit": u["daily_tokens"] or None, "concurrency": u["concurrency"],
                             "last_30_days": {"requests": r[0], "prompt_tokens": r[1], "completion_tokens": r[2]}})

    def proxy(self, method, path, body, u, req, injected, gen):
        t0 = time.time()
        acc = {"prompt": 0, "completion": 0, "cached": 0}
        ttft = None
        pieces = 0
        status = 0
        stream = bool(req and req.get("stream"))
        up = http.client.HTTPConnection(*BACKEND, timeout=3600)
        headers = {k: v for k, v in self.headers.items() if k.lower() not in HOP}
        headers["Authorization"] = "Bearer " + BACKEND_KEY
        headers["x-api-key"] = BACKEND_KEY
        headers["Content-Length"] = str(len(body))
        headers["X-Forwarded-For"] = self.client_address[0]
        try:
            try:
                up.request(method, self.path, body=body if method == "POST" else None, headers=headers)
                resp = up.getresponse()
            except OSError:
                status = 503
                return self.fail(path, 503, "the LLM server is not reachable (starting, loading or stopped); try again shortly",
                                 "api_error")
            status = resp.status
            ctype = resp.getheader("Content-Type", "")
            self.send_response(resp.status)
            for k, v in resp.getheaders():
                if k.lower() not in HOP:
                    self.send_header(k, v)
            if "text/event-stream" in ctype or (resp.getheader("Content-Length") is None and stream):
                stream = True
                self.send_header("Transfer-Encoding", "chunked")
                self.send_header("X-Accel-Buffering", "no")
                self.end_headers()
                buf = b""
                while True:
                    chunk = resp.read1(65536)
                    if not chunk:
                        break
                    buf += chunk
                    out = []
                    while True:
                        i = buf.find(b"\n\n")
                        j = buf.find(b"\r\n\r\n")
                        if i < 0 and j < 0:
                            break
                        cut, sep = (i, 2) if j < 0 or (0 <= i < j) else (j, 4)
                        ev, buf = buf[:cut + sep], buf[cut + sep:]
                        drop = False
                        for line in ev.splitlines():
                            if line.startswith(b"data:"):
                                data = line[5:].strip()
                                if not data or data == b"[DONE]":
                                    continue
                                try:
                                    obj = json.loads(data)
                                except ValueError:
                                    continue
                                merge_usage(acc, obj)
                                if has_text(obj):
                                    pieces += 1
                                    if ttft is None:
                                        ttft = time.time() - t0
                                if injected and obj.get("usage") and not obj.get("choices"):
                                    drop = True
                        if not drop:
                            out.append(ev)
                    if out:
                        data = b"".join(out)
                        self.wfile.write(b"%x\r\n%s\r\n" % (len(data), data))
                        self.wfile.flush()
                if buf:
                    self.wfile.write(b"%x\r\n%s\r\n" % (len(buf), buf))
                self.wfile.write(b"0\r\n\r\n")
                self.wfile.flush()
            else:
                data = resp.read()
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
                ttft = time.time() - t0
                if gen and "json" in ctype:
                    try:
                        merge_usage(acc, json.loads(data))
                    except ValueError:
                        pass
        except (BrokenPipeError, ConnectionResetError, TimeoutError):
            status = 499                      # client went away: closing upstream stops generation in Strata
            self.close_connection = True
        finally:
            up.close()
            if gen:
                if not acc["completion"] and pieces:
                    acc["completion"] = pieces    # aborted stream: count streamed pieces
                log_usage(ts=t0, user=u["name"], endpoint=path, model=str((req or {}).get("model", ""))[:80],
                          prompt=acc["prompt"], completion=acc["completion"], cached=acc["cached"],
                          ms=int((time.time() - t0) * 1000), ttft_ms=int(ttft * 1000) if ttft else None,
                          status=status, stream=1 if stream else 0, ip=self.client_address[0])


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True
    request_queue_size = 128


if __name__ == "__main__":
    srv = Server((C["gateway_listen"], int(C["gateway_port"])), Handler)
    print(f"gateway on {C['gateway_listen']}:{C['gateway_port']} -> strata 127.0.0.1:{C['strata_port']}", flush=True)
    srv.serve_forever()
