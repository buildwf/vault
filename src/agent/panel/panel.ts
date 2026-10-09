import {
  App,
  applyDocumentTheme,
  applyHostStyleVariables,
  type McpUiHostContext,
} from "@modelcontextprotocol/ext-apps";

type PanelState = {
  project: string;
  env: string;
  secrets: { name: string; kind: string }[];
  grants: { name: string; host: string; expiresAt: string }[];
  added?: string;
};
type CallResult = Awaited<ReturnType<App["callServerTool"]>>;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const name = $<HTMLInputElement>("name");
const value = $<HTMLInputElement>("value");
const status = $<HTMLParagraphElement>("status");
const addButton = $<HTMLButtonElement>("add");
const app = new App({ name: "vault-panel", version: "1.0.0" });

function theme(context: Partial<McpUiHostContext>) {
  if (context.theme) applyDocumentTheme(context.theme);
  if (context.styles?.variables) applyHostStyleVariables(context.styles.variables);
}

// structuredContent, else the JSON text block (some hosts strip structuredContent).
function parse(result: CallResult): PanelState {
  if (result.structuredContent) return result.structuredContent as PanelState;
  const text = result.content.find((block) => block.type === "text");
  return JSON.parse(text?.type === "text" ? text.text : "{}") as PanelState;
}

function item(text: string, extra?: HTMLElement) {
  const li = document.createElement("li");
  const label = document.createElement("code");
  label.textContent = text;
  li.append(label);
  if (extra) li.append(extra);
  return li;
}

function render(state: PanelState) {
  $("scope").textContent = `${state.project}/${state.env}`;
  $("secrets").replaceChildren(
    ...(state.secrets.length > 0
      ? state.secrets.map((secret) => item(`${secret.name}  ${secret.kind}`))
      : [item("none yet")]),
  );
  $("grants").replaceChildren(
    ...(state.grants.length > 0
      ? state.grants.map((grant) => {
          const revoke = document.createElement("button");
          revoke.textContent = "Revoke";
          revoke.addEventListener("click", () => void call({ revoke: { name: grant.name, host: grant.host } }));
          return item(`${grant.name} → ${grant.host}`, revoke);
        })
      : [item("none")]),
  );
}

async function call(args: Record<string, unknown>) {
  try {
    const result = await app.callServerTool({ name: "vault_panel", arguments: args });
    if (result.isError) throw new Error("vault_panel failed");
    const state = parse(result);
    render(state);
    return state;
  } catch {
    status.textContent = "The vault could not be reached.";
    return null;
  }
}

function saveMessage(secretName: string, outcome: string | undefined): string {
  if (outcome === "stored") return `${secretName} saved.`;
  if (outcome === "conflict") return `${secretName} already exists; the vault never replaces a value.`;
  return "Save outcome unknown; check the list before retrying.";
}

// No <form>: hosts may sandbox the frame without allow-forms.
addButton.addEventListener("click", () => {
  const added = { name: name.value.trim(), value: value.value };
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,255}$/u.test(added.name)) {
    status.textContent = "Use an env var name: letters, digits, and _ (not starting with a digit).";
    return;
  }
  if (!added.value) {
    status.textContent = "Enter a value.";
    return;
  }
  status.textContent = "Saving…";
  addButton.disabled = true;
  void call({ add: added })
    .then((state) => {
      if (state == null) return;
      status.textContent = saveMessage(added.name, state.added);
      if (state.added === "stored") {
        name.value = "";
        value.value = "";
      }
    })
    .finally(() => {
      addButton.disabled = false;
    });
});

app.onhostcontextchanged = theme;
try {
  await app.connect();
  theme(app.getHostContext() ?? {});
  if ((await call({})) != null) status.textContent = "";
} catch {
  status.textContent = "The vault panel could not connect to this host.";
}
