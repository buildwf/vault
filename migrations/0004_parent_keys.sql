-- Parent keys: one powerful credential per service per org, which the Worker uses
-- to mint short-lived child keys. A parent's value never leaves the Worker.
CREATE TABLE parents (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  name_hash TEXT NOT NULL,
  name_encrypted TEXT NOT NULL,
  provider TEXT NOT NULL,
  config_encrypted TEXT NOT NULL,
  value_encrypted TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (org_id, name_hash)
);

-- The ledger: one row per child key minted from a parent. A row is written
-- before the provider is called, so a mint whose reply is lost still leaves a
-- trace ('pending' or 'unknown'). Parents cannot be deleted while they have rows
-- that may still be live, so there is no cascade.
CREATE TABLE minted_keys (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  parent_id TEXT NOT NULL REFERENCES parents (id),
  provider_key_id_encrypted TEXT,
  key_prefix TEXT NOT NULL,
  label_encrypted TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'unknown', 'failed', 'revoked', 'expired')),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE INDEX minted_keys_due_idx ON minted_keys (status, expires_at);
CREATE INDEX minted_keys_parent_idx ON minted_keys (parent_id, created_at DESC);
