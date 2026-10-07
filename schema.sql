-- Dids File Storage — D1 schema
-- Run with:  wrangler d1 execute dids-file-storage --file=./schema.sql --remote

CREATE TABLE IF NOT EXISTS keys (
  id            TEXT PRIMARY KEY,          -- uuid
  label         TEXT NOT NULL DEFAULT '',  -- human note, e.g. "John (staff)"
  role          TEXT NOT NULL,             -- 'admin' | 'staff' | 'public'
  key_hash      TEXT NOT NULL,             -- sha-256 of the secret key
  key_prefix    TEXT NOT NULL,             -- first chars shown in UI, e.g. dids_SK_1a2b
  status        TEXT NOT NULL DEFAULT 'active', -- 'active' | 'revoked'
  -- device / network lock (bound on first successful use)
  bound_hwid    TEXT,                      -- persistent device token (null = unbound)
  bound_fp      TEXT,                      -- browser fingerprint hash
  bound_ip      TEXT,
  bound_geo     TEXT,                      -- "City, Region, CC"
  bound_at      TEXT,                      -- ISO timestamp of first bind
  last_ip       TEXT,
  last_geo      TEXT,
  last_seen     TEXT,
  created_at    TEXT NOT NULL,
  created_by    TEXT NOT NULL DEFAULT 'admin'
);

CREATE TABLE IF NOT EXISTS folders (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  permission    TEXT NOT NULL DEFAULT 'staff',  -- 'everyone' | 'staff'
  created_at    TEXT NOT NULL,
  created_by    TEXT NOT NULL                    -- key id or 'admin'
);

CREATE TABLE IF NOT EXISTS files (
  id            TEXT PRIMARY KEY,          -- uuid, also the R2 object key
  name          TEXT NOT NULL,
  size          INTEGER NOT NULL DEFAULT 0,
  content_type  TEXT NOT NULL DEFAULT 'application/octet-stream',
  folder_id     TEXT,
  permission    TEXT NOT NULL DEFAULT 'staff',  -- 'everyone' | 'staff'
  status        TEXT NOT NULL DEFAULT 'uploading', -- 'uploading' | 'ready'
  r2_upload_id  TEXT,                      -- active multipart upload id
  part_size     INTEGER,
  -- uploader audit trail
  uploader_key  TEXT,                      -- keys.id
  uploader_role TEXT,
  uploader_hwid TEXT,
  uploader_ip   TEXT,
  uploader_geo  TEXT,
  created_at    TEXT NOT NULL,
  completed_at  TEXT,
  downloads     INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS tickets (
  id            TEXT PRIMARY KEY,
  file_link     TEXT NOT NULL,
  reason        TEXT NOT NULL,
  discord       TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'open', -- 'open' | 'resolved' | 'dismissed'
  requester_key TEXT,
  requester_ip  TEXT,
  requester_geo TEXT,
  created_at    TEXT NOT NULL,
  resolved_at   TEXT,
  resolution    TEXT
);

CREATE TABLE IF NOT EXISTS activity (
  id            TEXT PRIMARY KEY,
  ts            TEXT NOT NULL,
  event         TEXT NOT NULL,   -- 'key_enter' | 'key_locked' | 'upload' | 'download' | 'delete' | 'ticket' | 'key_gen' | 'key_revoke' | 'key_restore' | 'key_reset' | 'folder_create' | 'login_fail'
  key_id        TEXT,
  role          TEXT,
  ip            TEXT,
  geo           TEXT,
  hwid          TEXT,
  detail        TEXT
);

CREATE INDEX IF NOT EXISTS idx_files_perm   ON files(permission, status);
CREATE INDEX IF NOT EXISTS idx_files_folder ON files(folder_id);
CREATE INDEX IF NOT EXISTS idx_activity_ts  ON activity(ts);
CREATE INDEX IF NOT EXISTS idx_tickets_st   ON tickets(status);
