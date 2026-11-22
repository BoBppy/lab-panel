"""HTTPS for the panel without browser warnings.

A server reached by a LAN address or a local name cannot get a certificate from a public authority, so each server
makes its own small certificate authority, the "lab certificate". It is limited by name constraints to private
addresses and local names: even if its key leaked, it could not vouch for any public website. People install it
once per computer (Settings shows how); after that the panel's own certificate, which this module issues from it
and renews before it expires or when the server's addresses change, is trusted like any other.

A certificate someone put in place themselves (one not issued by the lab certificate, for example from Let's
Encrypt for a real domain) is never replaced.
"""
import base64
import datetime
import hashlib
import ipaddress
import json
import os
import re
import socket
import subprocess
import tempfile

DIR = "/etc/lab/panel"
CA_CRT, CA_KEY = os.path.join(DIR, "ca.crt"), os.path.join(DIR, "ca.key")
CRT, KEY = os.path.join(DIR, "tls.crt"), os.path.join(DIR, "tls.key")
CONF = "/etc/lab/lab.json"
LEAF_DAYS = 397          # browsers and Apple systems refuse longer-lived server certificates
RENEW_DAYS = 30

# Where the lab certificate may vouch: private and local addresses, local names, and the names an owner lists in
# lab.json "tls_names" before the lab certificate is first made.
PRIVATE_NETS = ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16",
                "fc00::/7", "fe80::/10", "::1/128"]
LOCAL_SUFFIXES = ["local", "lan", "internal", "home.arpa", "localhost", "intranet", "corp", "private"]


def _run(*args, inp=None):
    r = subprocess.run(["openssl", *args], input=inp, capture_output=True, text=True, timeout=60)
    if r.returncode:
        raise RuntimeError(r.stderr.strip() or "openssl failed")
    return r.stdout


def _extra_names():
    try:
        return [str(n).strip().lower() for n in json.load(open(CONF)).get("tls_names", []) if str(n).strip()]
    except (OSError, ValueError):
        return []


def host_names():
    h = socket.gethostname().split(".")[0].lower()
    return [h, h + ".local", "localhost"] + [n for n in _extra_names() if not n.replace(".", "").isdigit()]


def host_addresses():
    """Every address of this machine (no container bridges), as strings."""
    out = {"127.0.0.1", "::1"}
    try:
        for fam in ("-4", "-6"):
            for link in json.loads(subprocess.run(["ip", "-j", fam, "addr"], capture_output=True, text=True, timeout=10).stdout or "[]"):
                if link.get("ifname", "").startswith(("docker", "podman", "veth", "br-", "cni", "virbr")):
                    continue
                for a in link.get("addr_info", []):
                    if a.get("scope") in ("global", "host"):
                        out.add(a["local"])
    except (OSError, ValueError, subprocess.TimeoutExpired):
        pass
    return sorted(out)


def _dns_roots():
    """The names the lab certificate may vouch for. Once it exists, the ones written into it decide: a name added
    later (a new host name, new "tls_names") would make browsers reject the panel certificate for every address."""
    if os.path.isfile(CA_CRT):
        try:
            out = _run("x509", "-in", CA_CRT, "-noout", "-ext", "nameConstraints")
            return [l.strip()[4:].lower() for l in out.splitlines() if l.strip().startswith("DNS:")]
        except RuntimeError:
            pass
    return LOCAL_SUFFIXES + [host_names()[0]] + _extra_names()


def allowed(name, roots=None):
    """Whether the lab certificate may vouch for this name or address."""
    try:
        ip = ipaddress.ip_address(name)
        return any(ip in ipaddress.ip_network(n) for n in PRIVATE_NETS)
    except ValueError:
        n = name.lower().rstrip(".")
        return any(n == r or n.endswith("." + r) for r in (_dns_roots() if roots is None else roots))


def _constraints():
    parts = []
    for net in PRIVATE_NETS:
        n = ipaddress.ip_network(net)
        parts.append(f"permitted;IP:{n.network_address}/{n.netmask}")
    for d in dict.fromkeys(LOCAL_SUFFIXES + [host_names()[0]] + _extra_names()):
        parts.append(f"permitted;DNS:{d}")
    return "critical," + ",".join(parts)


def _cert_info(path):
    """subject, issuer, not-after and SHA-256 fingerprint of a PEM certificate, or None."""
    if not os.path.isfile(path):
        return None
    try:
        out = _run("x509", "-in", path, "-noout", "-subject", "-issuer", "-enddate", "-ext", "subjectAltName")
        # not openssl -fingerprint: OpenSSL 4 prints a wrong digest when it is combined with -ext
        info = {"names": [], "sha256": fingerprint_der(open(path, "rb").read())}
    except (RuntimeError, OSError, ValueError):
        return None
    for line in out.splitlines():
        line = line.strip()
        if line.startswith("subject="):
            info["subject"] = line[8:].strip()
        elif line.startswith("issuer="):
            info["issuer"] = line[7:].strip()
        elif line.startswith("notAfter="):
            info["expires"] = datetime.datetime.strptime(line[9:].replace("  ", " "), "%b %d %H:%M:%S %Y %Z").replace(tzinfo=datetime.timezone.utc)
        elif line.startswith(("DNS:", "IP Address:")):
            info["names"] = [p.split(":", 1)[1].strip() for p in line.split(", ")]
    return info


def _issued_by_ca():
    if not (os.path.isfile(CRT) and os.path.isfile(CA_CRT)):
        return False
    r = subprocess.run(["openssl", "verify", "-CAfile", CA_CRT, CRT], capture_output=True, text=True, timeout=30)
    return r.returncode == 0


def _self_signed(info):
    return bool(info) and info.get("subject") == info.get("issuer")


def ensure_ca(org="Lab"):
    if os.path.isfile(CA_CRT) and os.path.isfile(CA_KEY):
        return False
    os.makedirs(DIR, exist_ok=True)
    host = host_names()[0]
    with tempfile.TemporaryDirectory() as t:
        cnf = os.path.join(t, "ca.cnf")
        with open(cnf, "w") as f:
            f.write(f"""[req]
distinguished_name = dn
x509_extensions = ext
prompt = no
[dn]
O = {org.replace('/', ' ')[:60]}
CN = {org.replace('/', ' ')[:40]} local CA ({host})
[ext]
basicConstraints = critical, CA:TRUE, pathlen:0
keyUsage = critical, keyCertSign, cRLSign
subjectKeyIdentifier = hash
nameConstraints = {_constraints()}
""")
        old = os.umask(0o077)
        try:
            _run("req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-days", "3650",
                 "-keyout", CA_KEY, "-out", CA_CRT, "-config", cnf)
        finally:
            os.umask(old)
    os.chmod(CA_KEY, 0o600)
    os.chmod(CA_CRT, 0o644)
    return True


def needs_new_leaf():
    """Why the panel certificate should be (re)issued, or "" if it is fine or is someone's own certificate."""
    info = _cert_info(CRT)
    if info is None:
        return "missing"
    ours = _issued_by_ca()
    if not ours and not _self_signed(info):
        return ""                                           # someone's own certificate: leave it alone
    if not ours:
        return "self-signed"
    if info["expires"] - datetime.datetime.now(datetime.timezone.utc) < datetime.timedelta(days=RENEW_DAYS):
        return "expiring"
    roots = _dns_roots()
    want = {_norm(n) for n in host_names() + host_addresses() if allowed(n, roots)}
    if not want <= {_norm(n) for n in info["names"]}:
        return "addresses changed"
    return ""


def _norm(name):
    try:
        return str(ipaddress.ip_address(name))
    except ValueError:
        return name.lower()


def issue_leaf():
    roots = _dns_roots()
    names = [n for n in dict.fromkeys(host_names()) if allowed(n, roots)] or ["localhost"]
    ips = [a for a in host_addresses() if allowed(a)]
    san = ",".join([f"DNS:{n}" for n in names] + [f"IP:{a}" for a in ips])
    with tempfile.TemporaryDirectory() as t:
        cnf, csr, key = os.path.join(t, "leaf.cnf"), os.path.join(t, "leaf.csr"), os.path.join(t, "leaf.key")
        with open(cnf, "w") as f:
            f.write(f"""[req]
distinguished_name = dn
prompt = no
[dn]
CN = {names[0]}
[ext]
basicConstraints = critical, CA:FALSE
keyUsage = critical, digitalSignature
extendedKeyUsage = serverAuth
subjectAltName = {san}
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid
""")
        old = os.umask(0o077)
        try:
            _run("req", "-new", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-keyout", key, "-out", csr, "-config", cnf)
            _run("x509", "-req", "-in", csr, "-CA", CA_CRT, "-CAkey", CA_KEY, "-CAserial", CA_CRT + ".srl", "-CAcreateserial",
                 "-days", str(LEAF_DAYS), "-sha256",
                 "-extfile", cnf, "-extensions", "ext", "-out", os.path.join(t, "leaf.crt"))
        finally:
            os.umask(old)
        # certificate and key replace the old pair together
        for src, dst, mode in ((os.path.join(t, "leaf.crt"), CRT, 0o644), (key, KEY, 0o600)):
            tmp = dst + ".new"
            with open(src, "rb") as a, open(tmp, "wb") as b:
                b.write(a.read())
            os.chmod(tmp, mode)
            os.replace(tmp, dst)


def ensure(org="Lab"):
    """Make the lab certificate if needed and (re)issue the panel certificate when due. Returns the reason or ""."""
    ensure_ca(org)
    why = needs_new_leaf()
    if why:
        issue_leaf()
    return why


_STATUS = (None, None)


def status():
    """What the panel shows about its certificates; cached until one of the files changes."""
    global _STATUS
    try:
        key = tuple(os.stat(p).st_mtime_ns for p in (CA_CRT, CRT) if os.path.exists(p))
    except OSError:
        key = None
    if key is not None and _STATUS[0] == key:
        return _STATUS[1]
    s = _status()
    _STATUS = (key, s)
    return s


def _status():
    ca, leaf = _cert_info(CA_CRT), _cert_info(CRT)
    ours = _issued_by_ca()
    return {
        "mode": "lab" if ours else ("self-signed" if _self_signed(leaf) else "own") if leaf else "missing",
        "ca_sha256": ca["sha256"] if ca else "",
        "ca_expires": ca["expires"].date().isoformat() if ca else "",
        "expires": leaf["expires"].date().isoformat() if leaf else "",
        "names": [_norm(n) for n in leaf["names"]] if leaf else [],
        "issuer": leaf.get("issuer", "") if leaf else "",
    }


def ca_pem():
    return open(CA_CRT, "rb").read() if os.path.isfile(CA_CRT) else b""


def fingerprint_der(pem):
    """SHA-256 of the first certificate in a PEM file (over its DER bytes), as browsers and systems show it."""
    m = re.search(r"-----BEGIN CERTIFICATE-----(.+?)-----END CERTIFICATE-----", pem.decode("ascii", "replace"), re.S)
    if not m:
        raise ValueError("no certificate")
    return ":".join(f"{b:02X}" for b in hashlib.sha256(base64.b64decode("".join(m.group(1).split()))).digest())


if __name__ == "__main__":
    import sys
    org = sys.argv[1] if len(sys.argv) > 1 else "Lab"
    why = ensure(org)
    s = status()
    print(f"panel certificate: {s['mode']}" + (f" (re-issued: {why})" if why else "") + f", valid until {s['expires']}")
    if s["ca_sha256"]:
        print(f"lab certificate SHA-256: {s['ca_sha256']}")
