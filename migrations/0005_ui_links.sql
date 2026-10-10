-- One-time web UI sign-in links. `vault ui` creates one for the CLI's own key;
-- the browser trades it for a short-lived session key. A row is deleted when it
-- is used, and expired rows are deleted when a new link is made.
CREATE TABLE ui_links (
  code_hash TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  key_prefix TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
