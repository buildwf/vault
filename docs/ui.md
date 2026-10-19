# Web UI

The Worker serves a web UI at `/ui`.
For example: `https://shared-vault.buildwithfriends.workers.dev/ui`.

The UI is built from `web/` with stock shadcn/ui components. `bun install` and `bun run deploy` build it; refer to [web/README.md](../web/README.md).

## Sign in

### With GitHub

Select **Sign in with GitHub** on the sign-in page. This works in any browser, for a GitHub account that an operator added to the org:

```sh
vault people add GITHUB_LOGIN      # or the "People who sign in with GitHub" form on the Access page
vault people list
vault people remove GITHUB_LOGIN --yes
```

A person you add becomes an operator of your org. They manage everything in it.
If your GitHub account is in more than one org, the page asks which org to use.
The session key has the label `web ui (GitHub @LOGIN)` and expires after 12 hours.
If you remove a person, they cannot sign in again. Sessions they already have last until they expire; revoke them on **Access** to end them now.

The button shows only when the vault has a GitHub OAuth app. Refer to [Set up GitHub sign-in](#set-up-github-sign-in).

### With the CLI

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

The browser keeps the key in the tab only. It removes the key when you close the tab or select **Sign out**.

An operator key (`user`) can use all pages.
An operator key of the platform org also sees **Orgs**.
A system key sees only the environments in its scopes.

## Pages

| Page | It shows | You can |
|---|---|---|
| Overview | Who you are, all projects, environments and secret counts, parent keys and the secrets that use them, and what each term means. | Read only. |
| Projects | Each environment's secrets, with what happens when an app reads each one. A minted secret links to its parent key. | Make and delete projects and environments. Set and delete secrets. |
| Parent keys | Each parent, the secrets that use it, and every key minted from it, with its status. | Set and delete parent keys. Revoke minted keys. |
| Access | Every vault key and who holds it, and the GitHub accounts that can sign in. | Make and revoke keys. Add and remove people. |
| Audit | Every read and change, by key label. | Read only. |
| Orgs | The orgs in the vault. Platform org only. | Make orgs. |

Three more pages open from links that an AI client gives you. Refer to [Use the vault with Claude](claude.md).

| Page | You can |
|---|---|
| Connect | Let an MCP client, for example Claude, use some environments. |
| Approve | Let a connected client send a secret to a host. |
| Collect | Type a secret that an AI asked for. |

## Rules

- The UI never shows a secret value or a parent key. It shows names, kinds, and the parent name of a minted secret.
- Value fields are write-only. The UI hides the text while you type it.
- The UI shows a new vault key one time only, when you make it.
- The UI uses the same `/v1` API as the CLI. The same permissions and audit apply.

## Set up GitHub sign-in

Run this in your checkout, with your Cloudflare login and `.env` in place:

```sh
bun run setup:github-signin https://<your vault host>
```

The command opens GitHub with the app already filled in. Select **Create GitHub App**. The command then:

1. Saves the app's client secret in Secrets Store as `<prefix>_GITHUB_CLIENT_SECRET`. It never prints the secret.
2. Saves the client id in `.env` as `VAULT_GITHUB_CLIENT_ID`.
3. Applies the migrations and deploys.

If a step fails, fix it and run the command again. It skips the steps that are done.

The app asks GitHub for no permissions. The vault reads only the account's id and login, one time, at sign-in.

To do it by hand instead, make a GitHub OAuth app whose callback URL is `https://<your vault>/auth/github/callback`, put its client secret in Secrets Store as `<prefix>_GITHUB_CLIENT_SECRET` (scope **Workers**), put its client id in `.env` as `VAULT_GITHUB_CLIENT_ID`, then migrate and deploy.
