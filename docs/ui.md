# Web UI

The Worker serves a web UI at `/ui`.
For example: `https://shared-vault.buildwithfriends.workers.dev/ui`.

## Sign in

Paste a vault key.
The browser keeps the key in the tab only. It removes the key when you close the tab or select **sign out**.

An operator key (`user`) can use all pages.
An operator key of the platform org also sees **orgs**.
A system key sees only the environments in its scopes.

## Pages

| Page | You can |
|---|---|
| projects | Make and delete projects and environments. Set and delete secrets. |
| keys | Make and revoke keys. |
| parents | Set and delete parent keys. See and revoke minted child keys. |
| audit | Read the audit log. |
| orgs | Make orgs. Platform org only. |

## Rules

- The UI never shows a secret value or a parent key. It shows names and kinds only.
- Value fields are write-only. The UI hides the text while you type it.
- The UI shows a new vault key one time only, when you make it.
- The UI uses the same `/v1` API as the CLI. The same permissions and audit apply.
