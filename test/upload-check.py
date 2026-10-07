#!/usr/bin/env python3
# Drives a real multipart upload against the harness and verifies integrity.
import json, os, sys, hashlib, http.client, urllib.request, urllib.error

BASE = os.environ.get("BASE", "localhost:8788")
ADMIN = os.environ.get("ADMIN_KEY", "dids_admin_master_test")

def req(method, path, body=None, cookie=None, raw=None, headers=None):
    h = {}
    if headers: h.update(headers)
    if cookie: h["Cookie"] = cookie
    data = None
    if raw is not None:
        data = raw
    elif body is not None:
        data = json.dumps(body).encode(); h["Content-Type"] = "application/json"
    c = http.client.HTTPConnection(BASE); c.request(method, path, body=data, headers=h)
    r = c.getresponse(); payload = r.read()
    setc = r.getheader("Set-Cookie")
    ck = setc.split(";")[0] if setc else None
    return r.status, payload, ck, dict(r.getheaders())

def jpost(path, body, cookie=None):
    s, p, ck, _ = req("POST", path, body=body, cookie=cookie)
    try: return s, json.loads(p), ck
    except Exception: return s, p, ck

# 1. admin login
s, d, admin_ck = jpost("/api/key/enter", {"key": ADMIN, "hwid": "pydev-admin"})
assert s == 200, (s, d)

# 2. make staff key, login staff
s, d, _ = jpost("/api/admin/keys", {"role": "staff", "label": "py"}, cookie=admin_ck)
staffkey = d["key"]
s, d, staff_ck = jpost("/api/key/enter", {"key": staffkey, "hwid": "pydev-staff"})
assert s == 200 and d["role"] == "staff", (s, d)

# 3. folder
s, d, _ = jpost("/api/folders", {"name": "PyFolder", "permission": "everyone"}, cookie=staff_ck)
fid = d["id"]

# 4. make a 12 MiB file, create upload
blob = os.urandom(12 * 1024 * 1024)
sha = hashlib.sha256(blob).hexdigest()
s, create, _ = jpost("/api/uploads/create",
    {"name": "py.bin", "size": len(blob), "permission": "everyone", "folderId": fid}, cookie=staff_ck)
assert s == 200, (s, create)
fileId, part_size, part_count = create["fileId"], create["partSize"], create["partCount"]
print(f"size={len(blob)} partSize={part_size} partCount={part_count}")

# 5. upload parts
parts = []
for i in range(part_count):
    chunk = blob[i*part_size:(i+1)*part_size]
    s, p, _, _ = req("PUT", f"/api/uploads/part?fileId={fileId}&part={i+1}", raw=chunk, cookie=staff_ck)
    pj = json.loads(p); parts.append({"partNumber": pj["partNumber"], "etag": pj["etag"]})
assert len(parts) == part_count

# 6. complete
s, d, _ = jpost("/api/uploads/complete", {"fileId": fileId, "parts": parts}, cookie=staff_ck)
assert s == 200 and d.get("ok"), (s, d)

# 7. full download + verify
s, got, _, _ = req("GET", f"/dl/{fileId}", cookie=staff_ck)
assert s == 200, s
ok_full = hashlib.sha256(got).hexdigest() == sha and len(got) == len(blob)

# 8. ranged download
s, got_r, _, hdrs = req("GET", f"/dl/{fileId}", cookie=staff_ck, headers={"Range": "bytes=1000-1099"})
ok_range = (s == 206 and got_r == blob[1000:1100])

# 9. public listing shows it (no cookie)
st, pl, _, _ = req("GET", "/api/public/files")
pubfiles = json.loads(pl)["files"]
ok_public = any(f["id"] == fileId for f in pubfiles)

print(f"multipart parts: {part_count} (expect >1 if PART_SIZE small)")
print("full integrity :", "PASS" if ok_full else "FAIL")
print("range (206)    :", "PASS" if ok_range else "FAIL", "status", s)
print("public listing :", "PASS" if ok_public else "FAIL")
print("RESULT:", "ALL PASS ✅" if (ok_full and ok_range and ok_public) else "FAILURES ❌")
sys.exit(0 if (ok_full and ok_range and ok_public) else 1)
