/**
 * The operator web UI, served by the Worker at `/ui`.
 *
 * Three static assets: a shell page, its stylesheet, and one script that talks
 * to the `/v1` API with the vault key the operator pastes in. The key stays in
 * the tab's `sessionStorage`; the Worker never sees it outside an
 * `Authorization` header, and the page has no cookie to steal.
 *
 * The UI never shows a secret value or a parent key. It lists names and kinds
 * only, and every value input is write-only. The one plaintext it does show is
 * a vault key the operator just created, once, because that is the only time
 * the vault can return it.
 *
 * The script renders every API string through `textContent`, never HTML, and
 * the CSP allows only same-origin script, style and fetch.
 *
 * The script is plain JS in a string so the Worker bundles it with no build
 * step. It avoids template literals so this file can hold it in `String.raw`.
 *
 * Styling follows buildwf.dev/design.md: a document that reads like rendered
 * markdown, with no cards, borders, badges or icons.
 */

export const UI_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "connect-src 'self'",
  "img-src 'self' data:",
  "form-action 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join("; ");

export const UI_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="referrer" content="no-referrer" />
    <title>Vault</title>
    <link rel="icon" href="data:," />
    <link rel="stylesheet" href="/ui/app.css" />
    <script type="module" src="/ui/app.js"></script>
  </head>
  <body>
    <header><nav id="nav" aria-label="Sections"></nav></header>
    <main id="main"><p class="muted">Loading…</p></main>
  </body>
</html>
`;

export const UI_CSS = String.raw`/* CSS adapter for the named roles in buildwf.dev/design.md. */
:root {
  color-scheme: light dark;
  --bg: #f6f6f4;
  --ink: #1c1c1e;
  --lede: #3a3a3c;
  --muted: #6e6e73;
  --codeBg: #efefeb;
  --hover: rgba(0, 0, 0, 0.035);
  --error: #8e2f2f;
  --sans: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  --mono: ui-monospace, "SF Mono", SFMono-Regular, Menlo, monospace;
  --body: 17px;
  --title: 52px;
  --section: 30px;
  --intro: 21px;
  --small: 14px;
  --control: 12.5px;
  --nav: 13px;
  --page-inline: 32px;
  --header-block: 22px;
  --page-end: 120px;
  --section-top: 72px;
  --intro-gap: 26px;
  --block-gap: 48px;
  --group-gap: 12px;
  --prose-width: 46em;
  --radius: 6px;
  font: var(--body)/1.6 var(--sans);
  background: var(--bg);
  color: var(--ink);
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #161618;
    --ink: #ececee;
    --lede: #c8c8cc;
    --muted: #9a9aa1;
    --codeBg: #1f1f22;
    --hover: rgba(255, 255, 255, 0.04);
    --error: #e08585;
  }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); }
header { padding: var(--header-block) var(--page-inline) 0; }
nav { display: flex; flex-wrap: wrap; gap: 22px; font: var(--nav)/1.6 var(--mono); }
nav a { color: var(--muted); text-decoration: none; padding-bottom: 2px; }
nav a:hover { color: var(--ink); }
nav a[aria-current="page"] { color: var(--ink); text-decoration: underline; text-decoration-thickness: 1.5px; text-underline-offset: 5px; }
nav .who { margin-left: auto; color: var(--muted); }
main { padding: var(--section-top) var(--page-inline) var(--page-end); }
h1 { font-size: var(--title); font-weight: 700; line-height: 1.05; letter-spacing: -0.025em; margin: 0 0 var(--intro-gap); overflow-wrap: anywhere; }
h2 { font-size: var(--section); font-weight: 700; line-height: 1.2; letter-spacing: -0.015em; margin: var(--section-top) 0 var(--intro-gap); }
p { max-width: var(--prose-width); margin: 0 0 var(--group-gap); }
.lede { font-size: var(--intro); line-height: 1.55; color: var(--lede); margin-bottom: var(--block-gap); }
.muted { color: var(--muted); }
.crumbs { font: var(--nav)/1.6 var(--mono); color: var(--muted); margin-bottom: var(--group-gap); }
.crumbs a { color: var(--muted); }
a { color: inherit; text-underline-offset: 3px; }
code, .mono { font-family: var(--mono); font-size: 0.88em; }
table { border-collapse: collapse; width: 100%; margin: 0 0 var(--block-gap); font-size: 15px; }
thead th { font: 600 11px/1.6 var(--mono); text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); background: var(--codeBg); text-align: left; padding: 6px 12px; white-space: nowrap; }
thead th:first-child { border-radius: var(--radius) 0 0 var(--radius); }
thead th:last-child { border-radius: 0 var(--radius) var(--radius) 0; }
td { padding: 7px 12px; vertical-align: top; overflow-wrap: anywhere; }
td.mono { font: 14px/1.6 var(--mono); font-variant-numeric: tabular-nums; }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
tbody tr:hover { background: var(--hover); }
td.actions { text-align: right; white-space: nowrap; }
form { max-width: var(--prose-width); margin: 0 0 var(--block-gap); }
.field { margin-bottom: var(--intro-gap); }
.row { display: flex; flex-wrap: wrap; column-gap: var(--intro-gap); }
.row .field { flex: 1 1 180px; }
label { display: block; font-weight: 700; font-size: 15px; margin-bottom: 6px; }
label.check { display: flex; gap: 8px; align-items: center; font-weight: 400; }
.hint { font-size: var(--small); color: var(--muted); margin: 6px 0 0; }
input[type="text"], input[type="password"], input[type="number"], select, textarea {
  width: 100%; padding: 7px 11px; font: var(--control)/1.6 var(--mono);
  border: 0; border-radius: var(--radius); background: var(--codeBg); color: var(--ink);
}
textarea { min-height: 7em; resize: vertical; }
textarea.masked { -webkit-text-security: disc; text-security: disc; }
:focus-visible { outline: 2px solid var(--ink); outline-offset: 2px; }
button { border: 0; border-radius: 0; padding: 7px 0; font: var(--nav)/1.6 var(--mono); background: transparent; color: var(--ink); cursor: pointer; }
button.primary { font-weight: 700; }
button.link { padding: 0; color: var(--muted); text-decoration: underline; text-underline-offset: 3px; }
button.link:hover { color: var(--ink); }
button.danger:hover { color: var(--error); }
button:disabled { color: var(--muted); cursor: default; }
.error { color: var(--error); font: var(--small)/1.6 var(--mono); max-width: var(--prose-width); margin: 0 0 var(--intro-gap); }
.status { font: var(--small)/1.6 var(--mono); margin: 0 0 var(--intro-gap); }
.notice { margin-bottom: var(--block-gap); }
.notice h2 { margin-top: 0; }
pre.once { font: 14px/1.6 var(--mono); background: var(--codeBg); border-radius: var(--radius); padding: 12px 14px; overflow-wrap: anywhere; white-space: pre-wrap; max-width: var(--prose-width); margin: 0 0 var(--group-gap); }
dl { display: grid; grid-template-columns: 150px minmax(0, 1fr); gap: 6px var(--group-gap); margin: 0 0 var(--block-gap); }
dt { font: var(--small)/1.6 var(--mono); color: var(--muted); }
dd { font: 15px/1.6 var(--mono); margin: 0; overflow-wrap: anywhere; }
dl.glossary dd { font: var(--body)/1.6 var(--sans); max-width: var(--prose-width); }
dl.glossary dt { padding-top: 3px; }
.buttons { display: flex; flex-wrap: wrap; gap: var(--intro-gap); }
@media (max-width: 640px) {
  :root { --title: 38px; --section: 24px; --page-inline: 16px; --section-top: 48px; }
  .hide-narrow { display: none; }
  dl { grid-template-columns: minmax(0, 1fr); }
}
@media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
`;

export const UI_JS = String.raw`
"use strict";
var KEY = "vault.key";
var main = document.getElementById("main");
var nav = document.getElementById("nav");
var state = { overview: null };

function storedKey() {
  try { return sessionStorage.getItem(KEY); } catch (e) { return null; }
}
function setKey(value) {
  try {
    if (value == null) sessionStorage.removeItem(KEY);
    else sessionStorage.setItem(KEY, value);
  } catch (e) {}
}

function h(tag, attrs) {
  var el = document.createElement(tag);
  if (attrs) {
    for (var name in attrs) {
      var value = attrs[name];
      if (value == null || value === false) continue;
      if (name === "on") { for (var ev in value) el.addEventListener(ev, value[ev]); }
      else if (name === "text") el.textContent = value;
      else if (name === "class") el.className = value;
      else if (value === true) el.setAttribute(name, "");
      else el.setAttribute(name, String(value));
    }
  }
  for (var i = 2; i < arguments.length; i++) append(el, arguments[i]);
  return el;
}
function fill(el) {
  el.replaceChildren();
  for (var i = 1; i < arguments.length; i++) append(el, arguments[i]);
}
function append(el, child) {
  if (child == null || child === false) return;
  if (Array.isArray(child)) { child.forEach(function (c) { append(el, c); }); return; }
  el.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
}

function ApiError(status, message) { this.status = status; this.message = message; }

async function api(method, path, body) {
  var headers = { Authorization: "Bearer " + storedKey() };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  var res = await fetch(path, {
    method: method,
    headers: headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
  });
  var data = null;
  try { data = await res.json(); } catch (e) {}
  if (!res.ok) {
    if (res.status === 401) { setKey(null); }
    throw new ApiError(res.status, (data && data.error) || "request failed (" + res.status + ")");
  }
  return data;
}

function enc(part) { return encodeURIComponent(part); }
function dash(value) { return value == null || value === "" ? "—" : value; }
function when(value) {
  if (value == null) return "—";
  return String(value).replace("T", " ").replace(/\.\d+/, "").replace(/Z$/, "").replace(/:\d\d$/, "");
}
function group(n) { return typeof n === "number" ? n.toLocaleString("en-US") : dash(n); }

function table(columns, rows, empty) {
  if (rows.length === 0) return h("p", { class: "muted", text: empty });
  return h("table", null,
    h("thead", null, h("tr", null, columns.map(function (c) {
      return h("th", { class: (c.num ? "num " : "") + (c.narrow ? "hide-narrow" : ""), scope: "col", text: c.label });
    }))),
    h("tbody", null, rows.map(function (row) {
      return h("tr", null, columns.map(function (c) {
        var value = c.render(row);
        var cls = [c.mono ? "mono" : "", c.num ? "num" : "", c.actions ? "actions" : "", c.narrow ? "hide-narrow" : ""].join(" ").trim();
        return h("td", { class: cls || null }, typeof value === "number" ? group(value) : value);
      }));
    })));
}

function errorLine(error) {
  return h("p", { class: "error", role: "alert", text: "Error: " + (error && error.message ? error.message : String(error)) });
}

/**
 * A form whose submit runs "action" and then re-renders the current route.
 * "action" may return a node to show above the re-rendered page (a one-time key).
 */
function actionForm(fields, submitLabel, action) {
  var status = h("div");
  var button = h("button", { type: "submit", class: "primary", text: submitLabel });
  var form = h("form", { on: { submit: async function (event) {
    event.preventDefault();
    button.disabled = true;
    status.replaceChildren();
    try {
      var notice = await action(form);
      await render(notice);
    } catch (error) {
      status.replaceChildren(errorLine(error));
      button.disabled = false;
    }
  } } }, fields, status, button);
  return form;
}

function field(label, input, hint) {
  return h("div", { class: "field" }, h("label", { for: input.id, text: label }), input, hint ? h("p", { class: "hint", text: hint }) : null);
}
function textInput(id, attrs) {
  return h("input", Object.assign({ id: id, type: "text", autocomplete: "off", spellcheck: "false" }, attrs || {}));
}
function select(id, options, value) {
  return h("select", { id: id }, options.map(function (o) {
    return h("option", { value: o, selected: o === value, text: o });
  }));
}
function val(form, id) { return form.querySelector("#" + id).value.trim(); }

function dangerButton(label, question, action) {
  return h("button", { type: "button", class: "link danger", text: label, on: { click: async function (event) {
    if (!confirm(question)) return;
    var button = event.currentTarget;
    button.disabled = true;
    try { await action(); await render(); }
    catch (error) { button.disabled = false; alert(error.message); }
  } } });
}

function onceKey(title, key, note) {
  return [
    h("h2", { text: title }),
    h("p", { text: note || "Copy it now. The vault does not show it again." }),
    h("pre", { class: "once", text: key }),
    h("p", null, h("button", { type: "button", class: "link", text: "Copy", on: { click: function (e) {
      navigator.clipboard.writeText(key).then(function () { e.target.textContent = "Copied"; });
    } } })),
  ];
}

/* ---------- words ---------- */

var KINDS = {
  config: ["config", "A plain setting, like a URL. Stored encrypted, and anyone with access can read it."],
  secret: ["secret", "A credential, like a database password. Apps and agents with access read it at runtime."],
  sealed: ["sealed", "Only injected into a running process by vault run. A get never returns it."],
  minted: ["minted", "Holds no key. Each read makes a fresh short-lived key from a parent key."],
};

var STATUSES = {
  active: "live at the provider until it expires",
  expired: "past its lifetime; dead at the provider",
  revoked: "killed at the provider",
  pending: "being made; the provider has not answered yet",
  unknown: "the provider's answer was lost; it may be live, so revoke treats it as live",
  failed: "the provider refused it; it never worked",
};

var ACTIONS = {
  audit_list: "read the audit log",
  bootstrap: "bootstrapped the vault",
  broker: "used a secret through the broker",
  environment_create: "created an environment",
  environment_delete: "deleted an environment",
  get: "read secret values",
  inject: "loaded secrets into a process",
  key_create: "created a vault key",
  key_revoke: "revoked a vault key",
  key_rotate: "rotated a vault key",
  list: "listed secret names",
  master_key_prepare: "prepared a root key",
  master_key_retire: "retired a root key",
  mint: "minted a child key",
  mint_revoke: "revoked minted keys",
  org_create: "created an org",
  project_create: "created a project",
  project_delete: "deleted a project",
  parent_delete: "deleted a parent key",
  parent_set: "set a parent key",
  secret_delete: "deleted a secret",
  set: "wrote a secret",
  ui_signin: "signed in to this web UI",
};

function access(k) {
  if (k.type === "user") return "operator: manages everything in this org";
  var verb = k.permission === "read" ? "reads " : "reads and writes ";
  return verb + (k.scopes || []).map(function (s) { return s.project + "/" + s.env; }).join(", ");
}

function plural(n, word) { return group(n) + " " + word + (n === 1 ? "" : "s"); }

function kindCounts(secrets) {
  var counts = {};
  secrets.forEach(function (s) { counts[s.kind] = (counts[s.kind] || 0) + 1; });
  return Object.keys(KINDS).filter(function (k) { return counts[k]; }).map(function (k) { return counts[k] + " " + k; }).join(", ") || "empty";
}

function mintedFrom(parent) {
  var uses = [];
  (state.overview.projects || []).forEach(function (p) {
    p.environments.forEach(function (e) {
      e.secrets.forEach(function (s) { if (s.kind === "minted" && s.parent === parent) uses.push([p.name, e.name, s.name]); });
    });
  });
  return uses;
}

function envLink(project, env, text) {
  return h("a", { href: "#/projects/" + enc(project) + "/" + enc(env), text: text || project + "/" + env });
}

function cmd(text) { return h("pre", { class: "once", text: text }); }

function adding(title, intro, form) {
  return [h("h2", { text: title }), intro ? h("p", { class: "muted", text: intro }) : null, form];
}

/* ---------- routes ---------- */

function route() {
  var parts = location.hash.replace(/^#\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
  return parts.length === 0 ? ["overview"] : parts;
}

function drawNav(section) {
  var items = [["overview", "overview"], ["projects", "projects"]];
  if (state.overview.parents) items.push(["parents", "parent keys"]);
  if (state.overview.key.type === "user") items.push(["keys", "vault keys"], ["audit", "audit"]);
  if (state.overview.platform) items.push(["orgs", "orgs"]);
  fill(nav,
    items.map(function (item) {
      return h("a", { href: "#/" + item[0], "aria-current": section === item[0] ? "page" : null, text: item[1] });
    }),
    h("span", { class: "who" }, h("button", { type: "button", class: "link", text: "sign out", on: { click: function () {
      setKey(null); state.overview = null; location.hash = "#/"; render();
    } } })),
  );
}

async function render(notice) {
  if (!storedKey()) { fill(nav); fill(main, signIn()); document.title = "Sign in · Vault"; return; }
  var parts = route();
  try {
    // One request says who you are and everything you can see; every page uses it.
    state.overview = await api("GET", "/v1/overview");
    drawNav(parts[0]);
    var view = views[parts[0]] || notFound;
    var nodes = await view(parts.slice(1));
    fill(main, nodes);
    if (notice) {
      // A one-time result goes under the page title, above the tables.
      var anchor = main.querySelector("h1");
      if (anchor && anchor.nextElementSibling && anchor.nextElementSibling.classList.contains("lede")) anchor = anchor.nextElementSibling;
      var box = h("section", { class: "notice" }, notice);
      if (anchor) anchor.after(box); else main.prepend(box);
    }
  } catch (error) {
    if (!storedKey()) return render();
    fill(main, h("h1", { text: "Something went wrong" }), errorLine(error));
  }
  var heading = main.querySelector("h1");
  document.title = (heading ? heading.textContent + " · " : "") + "Vault";
}

function signIn() {
  var input = h("input", { id: "key", type: "password", autocomplete: "off", spellcheck: "false", required: true });
  var status = h("div");
  return [
    h("h1", { text: "Vault" }),
    h("p", { class: "lede" }, "Run ", h("code", { text: "vault ui" }), " in a terminal where you are logged in. It opens this page signed in as you."),
    h("p", { class: "muted", text: "Or paste a vault key. Operator keys manage everything in their org; other keys see what their scopes allow." }),
    h("form", { on: { submit: async function (event) {
      event.preventDefault();
      setKey(input.value.trim());
      try { await api("GET", "/v1/overview"); input.value = ""; render(); }
      catch (error) { setKey(null); status.replaceChildren(errorLine(error)); }
    } } },
      field("Vault key", input, "Kept in this tab only and cleared when you close it."),
      status,
      h("button", { type: "submit", class: "primary", text: "Sign in" })),
  ];
}

function notFound() { return [h("h1", { text: "Not found" }), h("p", null, h("a", { href: "#/", text: "Back to the overview" }))]; }

var views = {
  overview: async function () {
    var ov = state.overview;
    var k = ov.key;
    var envCount = 0, secretCount = 0;
    ov.projects.forEach(function (p) { envCount += p.environments.length; p.environments.forEach(function (e) { secretCount += e.secrets.length; }); });
    var rows = [];
    ov.projects.forEach(function (p) {
      if (p.environments.length === 0) rows.push({ project: p.name, env: null, secrets: [] });
      p.environments.forEach(function (e) { rows.push({ project: p.name, env: e.name, secrets: e.secrets }); });
    });
    return [
      h("h1", { text: ov.platform ? "Platform" : (ov.org || "Vault") }),
      h("p", { class: "lede", text: "This vault keeps the secrets your apps and AI agents run with: database URLs, API tokens, and the root credentials that new keys are made from. Values are encrypted, and this page never shows them. It shows what is stored, who can reach it, and where every minted key came from." }),
      h("dl", null,
        h("dt", { text: "signed in as" }), h("dd", { text: (k.label || "unlabelled key") + " (" + k.keyPrefix + ")" }),
        h("dt", { text: "org" }), h("dd", { text: ov.platform ? "platform: the vault's own org" : dash(ov.org) }),
        h("dt", { text: "access" }), h("dd", { text: access(k) }),
        h("dt", { text: "this key expires" }), h("dd", { text: when(k.expiresAt) })),
      ov.platform ? [
        h("h2", { text: "You are in the platform org" }),
        h("p", null, "The platform org runs the vault itself. It creates orgs on ", h("a", { href: "#/orgs", text: "orgs" }), " and holds the root keys, but it cannot see inside any org: each org's secrets are encrypted with that org's own key. To see an org's projects and secrets, run ", h("code", { text: "vault ui" }), " with that org's login."),
      ] : null,
      h("h2", { text: "What is stored" }),
      rows.length === 0
        ? h("p", { class: "muted" }, ov.platform ? "The platform org has no projects of its own." : "Nothing yet. Create a project on ", ov.platform ? null : h("a", { href: "#/projects", text: "projects" }), ov.platform ? null : ", then add an environment and its secrets.")
        : [
          h("p", { text: plural(ov.projects.length, "project") + ", " + plural(envCount, "environment") + ", " + plural(secretCount, "secret") + "." }),
          table([
            { label: "Project", mono: true, render: function (r) { return h("a", { href: "#/projects/" + enc(r.project), text: r.project }); } },
            { label: "Environment", mono: true, render: function (r) { return r.env ? envLink(r.project, r.env, r.env) : "—"; } },
            { label: "Secrets", num: true, render: function (r) { return r.secrets.length; } },
            { label: "Kinds", mono: true, narrow: true, render: function (r) { return r.env ? kindCounts(r.secrets) : "no environments"; } },
          ], rows, ""),
        ],
      ov.parents && ov.parents.length > 0 ? [
        h("h2", { text: "Parent keys" }),
        h("p", { text: "Root credentials the vault makes short-lived keys from. Apps never see these." }),
        table([
          { label: "Parent", mono: true, render: function (p) { return h("a", { href: "#/parents/" + enc(p.name), text: p.name }); } },
          { label: "Service", mono: true, render: function (p) { return p.provider; } },
          { label: "Used by", mono: true, render: function (p) {
            var uses = mintedFrom(p.name);
            return uses.length === 0 ? "no secrets yet" : uses.map(function (u) { return u[0] + "/" + u[1] + " " + u[2]; }).join(", ");
          } },
          { label: "Live keys", num: true, render: function (p) { return p.activeChildren; } },
        ], ov.parents, ""),
      ] : null,
      h("h2", { text: "How it fits together" }),
      h("dl", { class: "glossary" },
        h("dt", { text: "org" }), h("dd", { text: "One customer or team. Each org has its own encryption key and its own operators, and cannot see other orgs." }),
        h("dt", { text: "project" }), h("dd", { text: "One app or service, like manyave-management." }),
        h("dt", { text: "environment" }), h("dd", { text: "The secrets for one stage of a project, like dev or prod. An app reads exactly one environment." }),
        h("dt", { text: "secret" }), h("dd", { text: "A named value, like DATABASE_URL. Its kind (config, secret, sealed or minted) says who can read it back." }),
        h("dt", { text: "parent key" }), h("dd", { text: "One powerful credential per service, like a Cloudflare account token or a GitHub App. It never leaves the vault." }),
        h("dt", { text: "minted key" }), h("dd", { text: "A short-lived key the vault makes from a parent each time an app reads a minted secret. Every one is logged, so you can see who got which key and kill them all at once." }),
        h("dt", { text: "vault key" }), h("dd", { text: "How a person, app or agent talks to the vault. Operator keys manage the org; scoped keys read one environment." })),
      h("h2", { text: "From a terminal" }),
      h("p", { text: "Run a command with an environment's secrets as variables:" }),
      cmd("vault run --project PROJECT --env ENV -- your-command"),
    ];
  },

  projects: async function (rest) {
    if (rest.length === 1) return projectView(rest[0]);
    if (rest.length === 2) return envView(rest[0], rest[1]);
    var ov = state.overview;
    var operator = ov.key.type === "user";
    return [
      h("h1", { text: "Projects" }),
      h("p", { class: "lede", text: "A project is one app or service. Each has environments, like dev and prod, and each environment holds the secrets that app runs with." }),
      table([
        { label: "Project", mono: true, render: function (p) { return h("a", { href: "#/projects/" + enc(p.name), text: p.name }); } },
        { label: "Environments", mono: true, render: function (p) {
          if (p.environments.length === 0) return "none yet";
          return p.environments.map(function (e, i) { return [i ? ", " : "", envLink(p.name, e.name, e.name + " (" + e.secrets.length + ")")]; });
        } },
        { label: "", actions: true, render: function (p) {
          if (!operator) return "";
          return dangerButton("delete", "Delete project " + p.name + " with all its environments and secrets?", function () { return api("DELETE", "/v1/projects/" + enc(p.name)); });
        } },
      ], ov.projects, ov.platform ? "The platform org has no projects. Orgs keep their projects to themselves." : "No projects yet."),
      operator ? adding("New project", "Name it after the app, like manyave-management.",
        actionForm([field("Name", textInput("project-name", { required: true, maxlength: 120 }))], "Create project", async function (form) {
          var name = val(form, "project-name");
          await api("POST", "/v1/projects", { name: name });
          location.hash = "#/projects/" + enc(name.toLowerCase());
        })) : null,
    ];
  },

  keys: async function () {
    var data = await api("GET", "/v1/keys?includeRevoked=1");
    var me = state.overview.key.keyPrefix;
    var keys = data.keys.slice().sort(function (a, b) { return Number(a.revoked) - Number(b.revoked); });
    return [
      h("h1", { text: "Vault keys" }),
      h("p", { class: "lede", text: "Every person, app and agent that talks to this vault uses one of these. The vault stores only a hash of each key, so a lost key cannot be shown again; revoke it and make a new one." }),
      table([
        { label: "Who", render: function (k) { return [dash(k.label), k.keyPrefix === me ? h("span", { class: "muted", text: " (you)" }) : null]; } },
        { label: "Access", render: function (k) { return access(k); } },
        { label: "Prefix", mono: true, narrow: true, render: function (k) { return k.keyPrefix; } },
        { label: "Last used", mono: true, narrow: true, render: function (k) { return when(k.lastUsedAt); } },
        { label: "Expires", mono: true, render: function (k) { return k.revoked ? "revoked " + when(k.revokedAt) : when(k.expiresAt); } },
        { label: "", actions: true, render: function (k) {
          if (k.revoked || k.keyPrefix === me) return "";
          return dangerButton("revoke", "Revoke " + (k.label || k.keyPrefix) + "? Anything using it stops working.", function () { return api("DELETE", "/v1/keys/" + enc(k.keyPrefix)); });
        } },
      ], keys, "No keys."),
      h("p", { class: "muted", text: "Keys labelled \"web ui\" are this page's own sessions, made by vault ui. They expire within 12 hours." }),
      adding("Give an app or agent access", "A scoped key reads one environment and nothing else. Hand it to the app as VAULT_API_KEY. An operator key manages the whole org; give those only to people.",
        actionForm([
          h("div", { class: "row" },
            field("Kind", select("key-type", ["system", "user"], "system"), "system: scoped, for apps and agents. user: an operator."),
            field("Permission", select("key-perm", ["read", "readwrite"], "read"), "Scoped keys only.")),
          h("div", { class: "row" },
            field("Project", textInput("key-project")),
            field("Environment", textInput("key-env"))),
          h("div", { class: "row" },
            field("Label", textInput("key-label", { maxlength: 120 }), "Who holds it, like \"web prod\" or \"Zack's laptop\"."),
            field("Expires in days", h("input", { id: "key-days", type: "number", min: 1, max: 365, value: 90 }))),
        ], "Create key", async function (form) {
          var type = val(form, "key-type");
          var body = { type: type, expiresInDays: Number(val(form, "key-days")) || 90 };
          var label = val(form, "key-label");
          if (label) body.label = label;
          if (type === "system") {
            body.permission = val(form, "key-perm");
            body.scopes = [{ project: val(form, "key-project"), env: val(form, "key-env") }];
          }
          var created = await api("POST", "/v1/keys", body);
          return onceKey("New key " + created.prefix, created.key);
        })),
    ];
  },

  parents: async function (rest) {
    if (rest.length === 1) return parentView(rest[0]);
    var parents = state.overview.parents || [];
    return [
      h("h1", { text: "Parent keys" }),
      h("p", { class: "lede", text: "A parent key is one powerful credential for one service, like a Cloudflare account token or a GitHub App. It stays in the vault. When an app reads a minted secret, the vault uses the parent to make a fresh key that expires on its own, and logs it here. So there is one real credential to rotate, and you can see and kill every key made from it." }),
      table([
        { label: "Parent", mono: true, render: function (p) { return h("a", { href: "#/parents/" + enc(p.name), text: p.name }); } },
        { label: "Service", mono: true, render: function (p) { return p.provider; } },
        { label: "Used by", mono: true, render: function (p) {
          var uses = mintedFrom(p.name);
          if (uses.length === 0) return "no secrets yet";
          return uses.map(function (u, i) { return [i ? ", " : "", envLink(u[0], u[1], u[0] + "/" + u[1] + " " + u[2])]; });
        } },
        { label: "Live keys", num: true, render: function (p) { return p.activeChildren; } },
        { label: "Updated", mono: true, narrow: true, render: function (p) { return when(p.updatedAt); } },
      ], parents, "No parent keys yet. Add one below, then make a minted secret that names it."),
      adding("Add or replace a parent key", "Saving over an existing name replaces its credential and keeps its history. The credential is write-only.",
        actionForm([
          h("div", { class: "row" },
            field("Name", textInput("parent-name", { required: true, pattern: "[a-z0-9][a-z0-9-]*" }), "Lowercase, like cloudflare."),
            field("Service", select("parent-provider", ["cloudflare", "github"], "cloudflare"))),
          field("Config", h("textarea", { id: "parent-config", spellcheck: "false" }), "One key=value per line: accountId=… for cloudflare, or appId=… and installationId=… for github."),
          field("Credential", h("textarea", { id: "parent-value", class: "masked", spellcheck: "false", autocomplete: "off", required: true }), "A Cloudflare API token that can create tokens, or a GitHub App private key (PEM). Nobody can read it back."),
        ], "Save parent key", async function (form) {
          var config = {};
          val(form, "parent-config").split("\n").forEach(function (line) {
            var i = line.indexOf("=");
            if (i > 0) config[line.slice(0, i).trim()] = line.slice(i + 1).trim();
          });
          var name = val(form, "parent-name");
          await api("PUT", "/v1/parents/" + enc(name), { provider: val(form, "parent-provider"), config: config, value: form.querySelector("#parent-value").value });
          location.hash = "#/parents/" + enc(name);
        })),
    ];
  },

  audit: async function () {
    var keys = {};
    try { (await api("GET", "/v1/keys?includeRevoked=1")).keys.forEach(function (k) { keys[k.keyPrefix] = k.label; }); } catch (e) {}
    var events = [];
    var cursor = null;
    var body = h("div");
    async function more() {
      var data = await api("GET", "/v1/audit?limit=100" + (cursor ? "&cursor=" + enc(cursor) : ""));
      events = events.concat(data.events);
      cursor = data.nextCursor;
      fill(body,
        table([
          { label: "When (UTC)", mono: true, render: function (e) { return when(e.createdAt); } },
          { label: "Who", render: function (e) { return keys[e.keyPrefix] || e.keyPrefix; } },
          { label: "Did", render: function (e) { return ACTIONS[e.action] || e.action; } },
          { label: "On", mono: true, render: function (e) { return dash(e.secretName); } },
          { label: "Result", mono: true, render: function (e) { return e.status; } },
        ], events, "Nothing has happened yet."),
        cursor ? h("button", { type: "button", class: "link", text: "Load older", on: { click: function (ev) { ev.target.disabled = true; more(); } } }) : null,
      );
    }
    await more();
    return [h("h1", { text: "Audit" }), h("p", { class: "lede", text: "Every read and change in this org, newest first, with the key that did it. Rows are written in the same step as the change, so nothing happens without a trace." }), body];
  },

  orgs: async function () {
    var data = await api("GET", "/v1/orgs");
    return [
      h("h1", { text: "Orgs" }),
      h("p", { class: "lede", text: "Each org is a separate customer or team in this vault. It gets its own encryption key and its own operators. The platform org can create orgs but cannot read anything inside them." }),
      table([{ label: "Org", mono: true, render: function (o) { return o; } }], data.orgs, "No orgs yet."),
      adding("New org", "Creates the org and its first operator key. Give that key to the org's owner; they log in with vault login and manage everything else.",
        actionForm([
          h("div", { class: "row" },
            field("Name", textInput("org-name", { required: true, pattern: "[a-z0-9][a-z0-9-]*" }), "Lowercase, like manyave."),
            field("Operator label", textInput("org-label", { maxlength: 120 }))),
        ], "Create org", async function (form) {
          var body = { name: val(form, "org-name") };
          var label = val(form, "org-label");
          if (label) body.label = label;
          var created = await api("POST", "/v1/orgs", body);
          return onceKey("Operator key for " + created.name, created.key, "This is the first operator key of the new org. Copy it now. The vault does not show it again.");
        })),
    ];
  },
};

function crumbs() {
  var nodes = [];
  for (var i = 0; i < arguments.length; i++) {
    if (i > 0) nodes.push(" / ");
    var c = arguments[i];
    nodes.push(c[1] ? h("a", { href: c[1], text: c[0] }) : c[0]);
  }
  return h("div", { class: "crumbs" }, nodes);
}

function findProject(name) {
  return state.overview.projects.find(function (p) { return p.name === name; });
}

async function projectView(name) {
  var project = findProject(name);
  if (!project) return notFound();
  var operator = state.overview.key.type === "user";
  return [
    crumbs(["projects", "#/projects"], [name]),
    h("h1", { text: name }),
    h("p", { class: "lede", text: "Each environment is a separate set of secrets for this app, like dev and prod. An app gets a key for one environment and sees only that." }),
    table([
      { label: "Environment", mono: true, render: function (e) { return envLink(name, e.name, e.name); } },
      { label: "Secrets", num: true, render: function (e) { return e.secrets.length; } },
      { label: "Kinds", mono: true, render: function (e) { return kindCounts(e.secrets); } },
      { label: "", actions: true, render: function (e) {
        if (!operator) return "";
        return dangerButton("delete", "Delete environment " + name + "/" + e.name + " and all its secrets?", function () {
          return api("DELETE", "/v1/projects/" + enc(name) + "/environments/" + enc(e.name));
        });
      } },
    ], project.environments, "No environments yet. Most apps start with dev and prod."),
    operator ? adding("New environment", null,
      actionForm([field("Name", textInput("env-name", { required: true, maxlength: 120 }), "Like dev, staging or prod.")], "Create environment", async function (form) {
        var env = val(form, "env-name");
        await api("POST", "/v1/projects/" + enc(name) + "/environments", { name: env });
        location.hash = "#/projects/" + enc(name) + "/" + enc(env.toLowerCase());
      })) : null,
  ];
}

async function envView(project, env) {
  var base = "/v1/projects/" + enc(project) + "/environments/" + enc(env) + "/secrets";
  var found = findProject(project);
  var environment = found && found.environments.find(function (e) { return e.name === env; });
  if (!environment) return notFound();
  var secrets = environment.secrets;
  var hasParents = state.overview.parents && state.overview.parents.length > 0;
  var valueInput = h("textarea", { id: "secret-value", spellcheck: "false", autocomplete: "off", class: "masked" });
  // Masked while typing; a minted spec is JSON, not a credential, so it shows.
  var kindSelect = select("secret-kind", ["secret", "config", "sealed", "minted"], "secret");
  var kindHint = h("p", { class: "hint", text: KINDS.secret[1] });
  kindSelect.addEventListener("change", function () {
    valueInput.className = kindSelect.value === "minted" ? "" : "masked";
    kindHint.textContent = KINDS[kindSelect.value][1] + (kindSelect.value === "minted" ? " The value is a JSON spec, like {\"parent\": \"cloudflare\", \"ttlMinutes\": 60, ...}." : "");
  });
  var randomBox = h("input", { id: "secret-random", type: "checkbox", on: { change: function () { valueInput.disabled = randomBox.checked; } } });
  return [
    crumbs(["projects", "#/projects"], [project, "#/projects/" + enc(project)], [env]),
    h("h1", { text: project + " / " + env }),
    h("p", { class: "lede", text: plural(secrets.length, "secret") + " that " + project + " runs with in " + env + ". Values are encrypted and never shown here; apps and agents read them at runtime with a key for this environment." }),
    table([
      { label: "Name", mono: true, render: function (s) { return s.name; } },
      { label: "Kind", mono: true, render: function (s) { return s.kind; } },
      { label: "What happens when an app reads it", render: function (s) {
        if (s.kind === "minted") {
          return s.parent
            ? ["Gets a fresh key made from parent ", h("a", { href: "#/parents/" + enc(s.parent), text: s.parent }), ". See every key made on that page."]
            : KINDS.minted[1];
        }
        return KINDS[s.kind][1];
      } },
      { label: "", actions: true, render: function (s) {
        return dangerButton("delete", "Delete " + s.name + " from " + project + "/" + env + "?", function () {
          return api("PATCH", base, { delete: [s.name] });
        });
      } },
    ], secrets, "No secrets yet. Add one below."),
    h("h2", { text: "Use these secrets" }),
    h("p", { text: "From a terminal or a deploy, run your command with every secret here as an environment variable:" }),
    cmd("vault run --project " + project + " --env " + env + " -- your-command"),
    state.overview.key.type === "user"
      ? h("p", null, "To give an app or agent its own access, make a scoped key for " + project + "/" + env + " on ", h("a", { href: "#/keys", text: "vault keys" }), ".")
      : null,
    adding("Add or replace a secret", "Saving a name that exists replaces its value.",
      actionForm([
        h("div", { class: "row" },
          field("Name", textInput("secret-name", { required: true, pattern: "[A-Z_][A-Z0-9_]*", placeholder: "DATABASE_URL" }), "Uppercase, as the app expects the variable."),
          h("div", { class: "field" }, h("label", { for: "secret-kind", text: "Kind" }), kindSelect, kindHint)),
        field("Value", valueInput, hasParents ? null : "Minted secrets need a parent key first; add one on parent keys."),
        h("div", { class: "field" }, h("label", { class: "check", for: "secret-random" }, randomBox, "Generate a random value instead")),
      ], "Save secret", async function (form) {
        var item = { name: val(form, "secret-name"), kind: val(form, "secret-kind") };
        if (randomBox.checked) item.random = true;
        else item.value = valueInput.value;
        await api("PATCH", base, { set: [item] });
        return h("p", { class: "status", role: "status", text: "Saved " + item.name + "." });
      })),
  ];
}

async function parentView(name) {
  var parent = (state.overview.parents || []).find(function (p) { return p.name === name; });
  if (!parent) return notFound();
  var data = await api("GET", "/v1/parents/" + enc(name) + "/minted");
  var uses = mintedFrom(name);
  var seen = {};
  data.minted.forEach(function (m) { seen[m.status] = true; });
  return [
    crumbs(["parent keys", "#/parents"], [name]),
    h("h1", { text: name }),
    h("p", { class: "lede", text: "A " + parent.provider + " credential kept in the vault. Apps never see it; they get short-lived keys made from it, listed below." }),
    h("dl", null,
      h("dt", { text: "service" }), h("dd", { text: parent.provider }),
      h("dt", { text: "config" }), h("dd", { text: Object.keys(parent.config).map(function (k) { return k + "=" + parent.config[k]; }).join(" ") || "—" }),
      h("dt", { text: "credential" }), h("dd", { text: "stored encrypted; write-only" }),
      h("dt", { text: "live keys now" }), h("dd", { text: group(parent.activeChildren) }),
      h("dt", { text: "updated" }), h("dd", { text: when(parent.updatedAt) }),
      h("dt", { text: "used by" }), h("dd", null, uses.length === 0 ? "no minted secrets yet" : uses.map(function (u, i) { return [i ? ", " : "", envLink(u[0], u[1], u[0] + "/" + u[1] + " " + u[2])]; }))),
    h("h2", { text: "Keys made from " + name }),
    h("p", { text: "Newest first. Each row is one key handed to an app or agent; the label says which secret it was read through. The key itself is never stored." }),
    table([
      { label: "For", mono: true, render: function (m) {
        var parts = m.label.split("/");
        return parts.length === 3 ? envLink(parts[0], parts[1], m.label) : m.label;
      } },
      { label: "Status", mono: true, render: function (m) { return m.status; } },
      { label: "Made", mono: true, render: function (m) { return when(m.createdAt); } },
      { label: "Expires", mono: true, narrow: true, render: function (m) { return m.revokedAt ? "revoked " + when(m.revokedAt) : when(m.expiresAt); } },
      { label: "Provider id", mono: true, narrow: true, render: function (m) { return dash(m.keyPrefix); } },
    ], data.minted, "No keys made yet. One appears here the first time an app reads a minted secret that names " + name + "."),
    Object.keys(seen).length > 0 ? h("dl", null, Object.keys(STATUSES).filter(function (s) { return seen[s]; }).map(function (s) {
      return [h("dt", { text: s }), h("dd", { text: STATUSES[s] })];
    })) : null,
    h("h2", { text: "If something leaks" }),
    h("p", { text: "Revoke every live key made from this parent at the provider. Apps get a fresh key on their next read." }),
    h("p", { class: "buttons" },
      dangerButton("revoke all live keys", "Revoke every live key made from " + name + " at " + parent.provider + "?", function () {
        return api("POST", "/v1/parents/" + enc(name) + "/revoke");
      }),
      dangerButton("delete this parent", "Delete parent key " + name + "? Minted secrets that name it stop working.", async function () {
        await api("DELETE", "/v1/parents/" + enc(name));
        location.hash = "#/parents";
      })),
  ];
}

/**
 * "vault ui" opens /ui#signin=CODE. The code works once: trade it for a session
 * key, then drop it from the address bar and history before anything renders.
 */
async function start() {
  var match = /^#signin=([0-9a-f]+)$/.exec(location.hash);
  if (match) {
    history.replaceState(null, "", location.pathname + "#/");
    try {
      var res = await fetch("/v1/ui/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: match[1] }),
        cache: "no-store",
      });
      var data = await res.json();
      if (!res.ok) throw new Error(data && data.error ? data.error : "sign-in failed (" + res.status + ")");
      setKey(data.key);
      state.overview = null;
    } catch (error) {
      setKey(null);
      fill(nav);
      fill(main, signIn());
      main.querySelector(".lede").after(errorLine(error));
      window.addEventListener("hashchange", function () { render(); });
      return;
    }
  }
  window.addEventListener("hashchange", function () { render(); });
  render();
}
start();
`;
