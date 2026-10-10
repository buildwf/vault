# Web UI

The Worker serves a web UI at `/ui`.
For example: `https://shared-vault.buildwithfriends.workers.dev/ui`.

## Sign in

Run this command where you are logged in to the vault:

```sh
vault ui
```

The command opens the UI in your browser. You are signed in as your CLI login.
To get the link without opening a browser, use `vault ui --print`.

The link works one time only, for 2 minutes. It does not contain your key.
The browser exchanges the link for a session key. The session key has the same type, permission and scopes as your CLI key. It expires after 12 hours, or when your CLI key expires, if that is sooner.
Session keys show in `vault keys list` with the label `web ui (...)`.

You can also paste a vault key on the sign-in page.

The browser keeps the key in the tab only. It removes the key when you close the tab or select **sign out**.

An operator key (`user`) can use all pages.
An operator key of the platform org also sees **orgs**.
A system key sees only the environments in its scopes.

## Pages

| Page | It shows | You can |
|---|---|---|
| overview | Who you are, all projects, environments and secret counts, parent keys and the secrets that use them, and what each term means. | Read only. |
| projects | Each environment's secrets, with what happens when an app reads each one. A minted secret links to its parent key. | Make and delete projects and environments. Set and delete secrets. |
| parent keys | Each parent, the secrets that use it, and every key minted from it, with its status. | Set and delete parent keys. Revoke minted keys. |
| vault keys | Who has access, and to what. | Make and revoke keys. |
| audit | Every read and change, by key label. | Read only. |
| orgs | The orgs in the vault. Platform org only. | Make orgs. |

## Rules

- The UI never shows a secret value or a parent key. It shows names, kinds, and the parent name of a minted secret.
- Value fields are write-only. The UI hides the text while you type it.
- The UI shows a new vault key one time only, when you make it.
- The UI uses the same `/v1` API as the CLI. The same permissions and audit apply.
