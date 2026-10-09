# Vault documentation

These documents use ASD-STE100 Simplified Technical English.

## What the vault is

The vault keeps secrets for apps, people and AI agents.
It is a Cloudflare Worker.
It keeps encrypted data in D1.

The Worker does all encryption and decryption.
The storage keeps only ciphertext and keyed hashes.
Two root keys in Cloudflare Secrets Store protect all data.

## Data model

| Item | Description |
|---|---|
| Org | The top level. Each org has its own data key. |
| Project | A group of environments in one org. |
| Environment | A set of secrets, for example `dev` or `prod`. |
| Secret | A name and a value. The kind is `config`, `secret` or `sealed`. |
| API key | Gives access to one org. |

## Instances

| Instance | Storage | Use |
|---|---|---|
| `shared-vault.buildwithfriends.workers.dev` | D1 | Hosted, multi-org. The first customer org is `manyave`. |
| `bwf-vault` | D1 | Build With Friends production. |

## Documents

- [Setup and deploy](setup.md)
- [Orgs and projects](orgs.md)
- [API keys](keys.md)
- [CLI reference](cli.md)
- [Use the vault in an app](apps.md)
