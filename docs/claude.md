# Use the vault with Claude

There are two ways to connect Claude to the vault.

| Where Claude runs | Use | Values leave the Worker |
|---|---|---|
| Claude Code on your computer | The Claude Code plugin. It runs `vault mcp` and `vault run` on your computer. | Yes, to your computer. |
| claude.ai, Claude Desktop, Cowork, Managed Agents, or any MCP client that cannot run the CLI | The hosted MCP endpoint at `/mcp`. | No. |
| An agent that runs the CLI where you are not, such as a Claude Code cloud session | `vault login --device`. You approve a link. | Yes, to that machine, for one day. |

## The Claude Code plugin

Install the CLI and log in. Then run:

```sh
claude plugin marketplace add /path/to/this/repo
claude plugin install vault@vault
```

Refer to "Claude Code plugin" in the [README](../README.md).

## The hosted MCP endpoint

The Worker is an MCP server at `/mcp`.
For example: `https://shared-vault.buildwithfriends.workers.dev/mcp`.
It uses OAuth. You do not copy a key.

### Connect

1. In Claude, add a custom connector. Use the `/mcp` URL above.
2. Claude opens the vault web UI. Sign in as an operator. Use `vault ui` or paste an operator key.
   If you use `vault ui`, the new tab goes to the connect page.
3. Select the environments that Claude can use. Select **Connect**.

The connection lasts 30 days. Then connect again.

Each connection is a system key with the label `CLIENT (MCP connector)`, for example `Claude (MCP connector)`.
It can read only the environments that you selected.
To disconnect, revoke that key in `vault keys list` or on the **vault keys** page.

### Tools

| Tool | It does |
|---|---|
| `describe_context` | Shows the environments and the secret names and kinds. It never shows values. |
| `use_secret` | Sends an HTTPS request with `{{NAME}}` in a header. The Worker adds the value and sends the request. The response comes back with the value replaced by `{{NAME}}`. |
| `collect_secret` | Gives a link to a page in the web UI. You type the value there, not in the chat. |

`use_secret` mints a new child key for each `minted` secret, the same as `vault run`.

### Approvals

`use_secret` sends a secret to a host only after you allow that pair.

- If the client can show a question in the chat, you answer in the chat. The approval lasts 15 minutes.
- If it cannot, Claude gives you a link to an approval page in the web UI. Only a signed-in operator can use it, so Claude cannot approve itself. You select 15 minutes, 1 day or 30 days.

### Security

- The access token works only at `/mcp`. It does not work on `/v1`, so the client cannot read values.
- Access tokens expire after one hour. Refresh tokens change each time that they are used.
- The vault keeps only hashes of codes and tokens.
- Only operators can connect clients and approve requests.
- The connect page shows where the browser goes back to. Do not connect a client that you do not know.

## Device login

Use this when an agent runs the CLI on a machine that is not yours, for example a cloud container. You do not copy a key.

1. The agent runs `vault login --api-url URL --device`. Run it in the background: it waits up to 10 minutes.
2. It gives you a link. Open it and sign in as an operator.
3. The page says **Sign in**, not Connect. Select the environments. Select **Connect**.
4. The CLI saves a read-only key. Now `vault run` works on that machine.

The key lasts one day. Then the agent logs in again.
It is a system key with the label `NAME (CLI login)`. The default name is `vault CLI on HOSTNAME`; set it with `--label`.
It can read the values of every secret in the environments that you selected. Approve only a login that you started.
To end it early, revoke that key in `vault keys list` or on the **vault keys** page.
