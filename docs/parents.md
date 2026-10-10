# Parent keys

A parent key is one strong key for one service, for example a Cloudflare API token that can make API tokens.
Each org keeps one parent key for each service.
The Worker uses the parent key to make child keys.
The Worker does not show a parent key to any person, app or agent.

## Child keys

A child key has a small scope and an expiry time.
The Worker makes a new child key each time an app or agent reads a `minted` secret.
The vault records each child key in a ledger: the parent, the API key that asked, the `PROJECT/ENV/NAME` label and the expiry.
The provider also shows the label in the name of the child key.

## Providers

| Provider | Parent key | Child key | Config |
|---|---|---|---|
| `cloudflare` | Account API token with "Account API Tokens Write" | Account API token with the spec policies | `accountId` |
| `github` | GitHub App private key (PEM) | Installation token with the spec permissions and repositories | `appId`, `installationId` |

Each org stores its own parent keys. For GitHub, make a GitHub App in your own account or organization, install it, and give the vault its private key.

## Store a parent key

```sh
vault parents set cloudflare --provider cloudflare --config accountId=ACCOUNT_ID
```

Type the parent key into the hidden prompt, or send it on stdin.
Send a GitHub App private key on stdin, because it has more than one line:

```sh
vault parents set github --provider github --config appId=APP_ID --config installationId=INSTALLATION_ID < app.private-key.pem
```

The installation ID is the number at the end of the installation's settings URL.
Only operators can store, list or delete parent keys.

## Make a minted secret

The value of a minted secret is a JSON spec, not a key:

```json
{
  "parent": "cloudflare",
  "ttlMinutes": 60,
  "policies": [
    {
      "effect": "allow",
      "permission_groups": [{ "id": "PERMISSION_GROUP_ID" }],
      "resources": { "com.cloudflare.api.account.ACCOUNT_ID": "*" }
    }
  ]
}
```

```sh
vault secrets set CLOUDFLARE_API_TOKEN --kind minted --project web --env dev < spec.json
```

A GitHub spec has `permissions` and, if you want fewer repositories than the installation has, `repositories`:

```json
{
  "parent": "github",
  "ttlMinutes": 30,
  "permissions": { "contents": "read", "pull_requests": "write" },
  "repositories": ["api"]
}
```

Only operators can set a minted secret.
`ttlMinutes` is 1 to 10080. The default is 60.
GitHub tokens stop after one hour, so for `github` the maximum is 60.
GitHub can revoke a token only with the token itself. Thus the ledger keeps each GitHub child key, encrypted with the org key. The key stops working after one hour.

`vault run` and the agent `use_secret` tool get a new child key each time.
`vault secrets get` shows the spec, not a key.

## Look at and revoke child keys

```sh
vault parents list
vault parents minted cloudflare
vault parents revoke cloudflare --yes
vault parents delete cloudflare --yes
```

`revoke` revokes all child keys of the parent that can still work.
You cannot delete a parent while it has child keys that can still work.
The Worker cron runs each hour. It closes child keys after their expiry.

## Rotate a parent key

1. Make a new parent key at the provider.
2. Run `vault parents set` again with the new value.
3. If the old parent key leaked, run `vault parents revoke` and revoke the old parent key at the provider.
