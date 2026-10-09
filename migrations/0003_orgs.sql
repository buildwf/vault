-- Orgs. Every row that predates this migration belongs to the platform org,
-- whose id is 'default' (DEFAULT_ORG in src/backend.ts); it has no orgs row.
CREATE TABLE orgs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  wrapped_data_key TEXT NOT NULL,
  created_at TEXT NOT NULL
);

ALTER TABLE api_keys ADD COLUMN org_id TEXT NOT NULL DEFAULT 'default';
CREATE INDEX api_keys_org_created_idx ON api_keys (org_id, created_at);

ALTER TABLE audit_events ADD COLUMN org_id TEXT NOT NULL DEFAULT 'default';
CREATE INDEX audit_events_org_created_idx ON audit_events (org_id, created_at DESC, id DESC);

-- The last active user key is now counted per org.
DROP TRIGGER prevent_last_active_user_key;
CREATE TRIGGER prevent_last_active_user_key
BEFORE UPDATE OF revoked ON api_keys
WHEN OLD.type = 'user'
  AND OLD.revoked = 0
  AND NEW.revoked = 1
  AND OLD.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  AND (
    SELECT COUNT(*)
    FROM api_keys
    WHERE org_id = OLD.org_id
      AND type = 'user'
      AND revoked = 0
      AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  ) <= 1
BEGIN
  SELECT RAISE(ABORT, 'cannot revoke the last active user key');
END;

-- Project names become unique per org. SQLite cannot drop the old UNIQUE (name),
-- so the project tree is rebuilt: new tables, rows copied, then the old tables
-- dropped children first. Dropping a parent before its children would run their
-- ON DELETE CASCADE and delete the rows this migration means to keep.
CREATE TABLE projects_new (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL DEFAULT 'default',
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (org_id, name)
);

CREATE TABLE environments_new (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects_new (id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (project_id, name)
);

CREATE TABLE secrets_new (
  id TEXT PRIMARY KEY,
  environment_id TEXT NOT NULL REFERENCES environments_new (id) ON DELETE CASCADE,
  key_encrypted TEXT NOT NULL,
  key_hash TEXT NOT NULL,
  value_encrypted TEXT NOT NULL,
  kind TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (environment_id, key_hash)
);

CREATE TABLE routes_new (
  id TEXT PRIMARY KEY,
  environment_id TEXT NOT NULL REFERENCES environments_new (id) ON DELETE CASCADE,
  host TEXT NOT NULL,
  secret_key_hash TEXT NOT NULL,
  inject TEXT NOT NULL,
  strip_headers TEXT NOT NULL,
  dummy_env_name TEXT NOT NULL,
  dummy_value TEXT NOT NULL,
  UNIQUE (environment_id, host)
);

INSERT INTO projects_new (id, name, created_at)
SELECT id, name, created_at FROM projects;

INSERT INTO environments_new (id, project_id, name, created_at)
SELECT id, project_id, name, created_at FROM environments;

INSERT INTO secrets_new (
  id, environment_id, key_encrypted, key_hash, value_encrypted, kind, updated_at
)
SELECT id, environment_id, key_encrypted, key_hash, value_encrypted, kind, updated_at
FROM secrets;

INSERT INTO routes_new (
  id, environment_id, host, secret_key_hash, inject, strip_headers,
  dummy_env_name, dummy_value
)
SELECT id, environment_id, host, secret_key_hash, inject, strip_headers,
  dummy_env_name, dummy_value
FROM routes;

DROP TABLE routes;
DROP TABLE secrets;
DROP TABLE environments;
DROP TABLE projects;

ALTER TABLE projects_new RENAME TO projects;
ALTER TABLE environments_new RENAME TO environments;
ALTER TABLE secrets_new RENAME TO secrets;
ALTER TABLE routes_new RENAME TO routes;
