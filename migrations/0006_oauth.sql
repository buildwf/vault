-- OAuth for the hosted MCP endpoint (/mcp). An operator approves a client such
-- as Claude in the web UI; that makes a one-time code. Trading the code makes a
-- grant: a scoped system key (the grant's identity, revocable like any key)
-- plus an access token and a refresh token, stored only as keyed hashes. The
-- access token works only at /mcp, never on /v1, so a client never reads values.
CREATE TABLE oauth_codes (
  code_hash TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  -- The operator key that approved, for the audit row.
  key_prefix TEXT NOT NULL,
  scopes_encrypted TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE oauth_grants (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  key_prefix TEXT NOT NULL,
  client_id TEXT NOT NULL,
  access_hash TEXT NOT NULL UNIQUE,
  access_expires_at TEXT NOT NULL,
  refresh_hash TEXT NOT NULL UNIQUE,
  -- use_secret approvals (secret/host pairs), encrypted with the org key.
  approvals_encrypted TEXT,
  expires_at TEXT NOT NULL
);
