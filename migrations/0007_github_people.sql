-- People who sign in to the web UI with GitHub. An operator adds a GitHub
-- account to their org; signing in as that account makes a short-lived
-- operator session key in that org, like `vault ui` does. The numeric GitHub
-- id is what matches, because a login can be renamed and then reused.
CREATE TABLE github_people (
  org_id TEXT NOT NULL,
  github_id TEXT NOT NULL,
  github_login TEXT NOT NULL,
  -- The operator key that added this person, for the record.
  added_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (org_id, github_id)
);
CREATE INDEX github_people_github_idx ON github_people (github_id);
