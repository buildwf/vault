# Orgs and projects

## Orgs

An org keeps its projects, secrets, API keys and audit log apart from other orgs.
An API key can see only its own org.
Each org has its own data key.

Bootstrap makes the platform org, `default`.
Only platform operators can make orgs.

Only Convex deployments can have more than one org.
On D1, `vault orgs create` gives the error 501.

### Make an org

1. Log in with a platform operator key.
2. Run `vault orgs create NAME`.
3. Copy the operator key. The CLI shows it one time only.
4. Give the key to the first operator of the new org.

To see all orgs, run `vault orgs list`.

## Projects

Project names are unique in an org.
Two orgs can each have a project with the same name.

```sh
vault projects create web
vault environments create dev --project web
vault environments create prod --project web
vault projects list
```

To delete a project or an environment, add `--yes`.

## Secrets

```sh
vault secrets set NAME --kind secret --project web --env dev
vault secrets list --project web --env dev
vault secrets get NAME --project web --env dev
vault secrets delete NAME --project web --env dev --yes
```

| Kind | `secrets get` | `vault run` |
|---|---|---|
| `config` | Shows the value | Injects it |
| `secret` | Shows the value | Injects it |
| `sealed` | Hides the value | Injects it |

WARNING: `sealed` is not access control. Each key with access to the environment can read a sealed value through `vault run`.
