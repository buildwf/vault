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
var state = { platform: null };

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

/* ---------- routes ---------- */

function route() {
  var parts = location.hash.replace(/^#\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
  return parts.length === 0 ? ["projects"] : parts;
}

function drawNav(section) {
  var items = [["projects", "projects"], ["keys", "keys"], ["parents", "parents"], ["audit", "audit"]];
  if (state.platform) items.push(["orgs", "orgs"]);
  fill(nav,
    items.map(function (item) {
      return h("a", { href: "#/" + item[0], "aria-current": section === item[0] ? "page" : null, text: item[1] });
    }),
    h("span", { class: "who" }, h("button", { type: "button", class: "link", text: "sign out", on: { click: function () {
      setKey(null); state.platform = null; location.hash = "#/"; render();
    } } })),
  );
}

async function render(notice) {
  if (!storedKey()) { fill(nav); fill(main, signIn()); document.title = "Sign in · Vault"; return; }
  if (state.platform == null) {
    try { await api("GET", "/v1/orgs"); state.platform = true; }
    catch (error) {
      if (!storedKey()) return render();
      state.platform = false;
    }
  }
  var parts = route();
  drawNav(parts[0]);
  var view = views[parts[0]] || notFound;
  try {
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
    h("p", { class: "lede", text: "Sign in with a vault key. Operator keys can manage everything in their org; other keys see what their scopes allow." }),
    h("form", { on: { submit: async function (event) {
      event.preventDefault();
      setKey(input.value.trim());
      try { await api("GET", "/v1/projects"); input.value = ""; render(); }
      catch (error) { setKey(null); status.replaceChildren(errorLine(error)); }
    } } },
      field("Vault key", input, "Kept in this tab only and cleared when you close it."),
      status,
      h("button", { type: "submit", class: "primary", text: "Sign in" })),
  ];
}

function notFound() { return [h("h1", { text: "Not found" }), h("p", null, h("a", { href: "#/", text: "Back to projects" }))]; }

var views = {
  projects: async function (rest) {
    if (rest.length === 1) return projectView(rest[0]);
    if (rest.length === 2) return envView(rest[0], rest[1]);
    var data = await api("GET", "/v1/projects");
    return [
      h("h1", { text: "Projects" }),
      table([
        { label: "Name", mono: true, render: function (p) { return h("a", { href: "#/projects/" + enc(p) , text: p }); } },
        { label: "", actions: true, render: function (p) {
          return dangerButton("delete", "Delete project " + p + " with all its environments and secrets?", function () { return api("DELETE", "/v1/projects/" + enc(p)); });
        } },
      ], data.projects, "No projects yet."),
      h("h2", { text: "New project" }),
      actionForm([field("Name", textInput("project-name", { required: true, maxlength: 120 }))], "Create project", async function (form) {
        var name = val(form, "project-name");
        await api("POST", "/v1/projects", { name: name });
        location.hash = "#/projects/" + enc(name.toLowerCase());
      }),
    ];
  },

  keys: async function () {
    var data = await api("GET", "/v1/keys?includeRevoked=1");
    var keys = data.keys.slice().sort(function (a, b) { return Number(a.revoked) - Number(b.revoked); });
    return [
      h("h1", { text: "Keys" }),
      h("p", { class: "lede", text: "Vault keys for people and agents in this org. Only the prefix is stored in the clear." }),
      table([
        { label: "Prefix", mono: true, render: function (k) { return k.keyPrefix; } },
        { label: "Label", render: function (k) { return dash(k.label); } },
        { label: "Type", mono: true, render: function (k) { return k.type + " · " + k.permission; } },
        { label: "Scopes", mono: true, narrow: true, render: function (k) {
          return k.scopes == null ? "all" : k.scopes.map(function (s) { return s.project + "/" + s.env; }).join(", ");
        } },
        { label: "Last used", mono: true, narrow: true, render: function (k) { return when(k.lastUsedAt); } },
        { label: "Expires", mono: true, render: function (k) { return k.revoked ? "revoked " + when(k.revokedAt) : when(k.expiresAt); } },
        { label: "", actions: true, render: function (k) {
          if (k.revoked) return "";
          return dangerButton("revoke", "Revoke key " + k.keyPrefix + "? Anything using it stops working.", function () { return api("DELETE", "/v1/keys/" + enc(k.keyPrefix)); });
        } },
      ], keys, "No keys."),
      h("h2", { text: "New key" }),
      h("p", { class: "muted", text: "A scoped key reads one project environment, for an app or agent. An operator key manages the whole org." }),
      actionForm([
        h("div", { class: "row" },
          field("Kind", select("key-type", ["system", "user"], "system"), "system is scoped; user is an operator"),
          field("Permission", select("key-perm", ["read", "readwrite"], "read"), "ignored for operator keys")),
        h("div", { class: "row" },
          field("Project", textInput("key-project")),
          field("Environment", textInput("key-env"))),
        h("div", { class: "row" },
          field("Label", textInput("key-label", { maxlength: 120 })),
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
      }),
    ];
  },

  parents: async function (rest) {
    if (rest.length === 1) return parentView(rest[0]);
    var data = await api("GET", "/v1/parents");
    return [
      h("h1", { text: "Parent keys" }),
      h("p", { class: "lede", text: "One root credential per service. Apps and agents get short-lived child keys minted from it and never see the parent." }),
      table([
        { label: "Name", mono: true, render: function (p) { return h("a", { href: "#/parents/" + enc(p.name), text: p.name }); } },
        { label: "Provider", mono: true, render: function (p) { return p.provider; } },
        { label: "Config", mono: true, narrow: true, render: function (p) {
          return Object.keys(p.config).map(function (k) { return k + "=" + p.config[k]; }).join(" ") || "—";
        } },
        { label: "Live children", num: true, render: function (p) { return p.activeChildren; } },
        { label: "Updated", mono: true, narrow: true, render: function (p) { return when(p.updatedAt); } },
      ], data.parents, "No parent keys yet."),
      h("h2", { text: "Set a parent key" }),
      h("p", { class: "muted", text: "Adds a parent or replaces the stored credential of an existing one. The value is write-only." }),
      actionForm([
        h("div", { class: "row" },
          field("Name", textInput("parent-name", { required: true, pattern: "[a-z0-9][a-z0-9-]*" })),
          field("Provider", select("parent-provider", ["cloudflare", "github"], "cloudflare"))),
        field("Config", h("textarea", { id: "parent-config", spellcheck: "false" }), "One key=value per line, for example accountId=… for cloudflare or appId=… and installationId=… for github."),
        field("Credential", h("textarea", { id: "parent-value", class: "masked", spellcheck: "false", autocomplete: "off", required: true }), "An API token, or a GitHub App private key (PEM). Encrypted on save. Nobody can read it back."),
      ], "Save parent key", async function (form) {
        var config = {};
        val(form, "parent-config").split("\n").forEach(function (line) {
          var i = line.indexOf("=");
          if (i > 0) config[line.slice(0, i).trim()] = line.slice(i + 1).trim();
        });
        var name = val(form, "parent-name");
        await api("PUT", "/v1/parents/" + enc(name), { provider: val(form, "parent-provider"), config: config, value: form.querySelector("#parent-value").value });
        location.hash = "#/parents/" + enc(name);
      }),
    ];
  },

  audit: async function () {
    var events = [];
    var cursor = null;
    var body = h("div");
    async function more() {
      var data = await api("GET", "/v1/audit?limit=100" + (cursor ? "&cursor=" + enc(cursor) : ""));
      events = events.concat(data.events);
      cursor = data.nextCursor;
      fill(body,
        table([
          { label: "When", mono: true, render: function (e) { return when(e.createdAt); } },
          { label: "Action", mono: true, render: function (e) { return e.action; } },
          { label: "Status", mono: true, render: function (e) { return e.status; } },
          { label: "Secret", mono: true, render: function (e) { return dash(e.secretName); } },
          { label: "Key", mono: true, narrow: true, render: function (e) { return e.keyPrefix; } },
        ], events, "No events."),
        cursor ? h("button", { type: "button", class: "link", text: "Load more", on: { click: function (ev) { ev.target.disabled = true; more(); } } }) : null,
      );
    }
    await more();
    return [h("h1", { text: "Audit" }), h("p", { class: "lede", text: "Every read and change in this org, newest first. Times are UTC." }), body];
  },

  orgs: async function () {
    var data = await api("GET", "/v1/orgs");
    return [
      h("h1", { text: "Orgs" }),
      h("p", { class: "lede", text: "Each org has its own encryption key and operators. The platform org cannot see their projects." }),
      table([{ label: "Name", mono: true, render: function (o) { return o; } }], data.orgs, "No orgs."),
      h("h2", { text: "New org" }),
      actionForm([
        h("div", { class: "row" },
          field("Name", textInput("org-name", { required: true, pattern: "[a-z0-9][a-z0-9-]*" })),
          field("Operator label", textInput("org-label", { maxlength: 120 }))),
      ], "Create org", async function (form) {
        var body = { name: val(form, "org-name") };
        var label = val(form, "org-label");
        if (label) body.label = label;
        var created = await api("POST", "/v1/orgs", body);
        return onceKey("Operator key for " + created.name, created.key, "This is the first operator key of the new org. Copy it now. The vault does not show it again.");
      }),
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

async function projectView(project) {
  var data = await api("GET", "/v1/projects/" + enc(project) + "/environments");
  return [
    crumbs(["projects", "#/projects"], [project]),
    h("h1", { text: project }),
    table([
      { label: "Environment", mono: true, render: function (e) { return h("a", { href: "#/projects/" + enc(project) + "/" + enc(e), text: e }); } },
      { label: "", actions: true, render: function (e) {
        return dangerButton("delete", "Delete environment " + project + "/" + e + " and all its secrets?", function () {
          return api("DELETE", "/v1/projects/" + enc(project) + "/environments/" + enc(e));
        });
      } },
    ], data.environments, "No environments yet."),
    h("h2", { text: "New environment" }),
    actionForm([field("Name", textInput("env-name", { required: true, maxlength: 120 }))], "Create environment", async function (form) {
      var name = val(form, "env-name");
      await api("POST", "/v1/projects/" + enc(project) + "/environments", { name: name });
      location.hash = "#/projects/" + enc(project) + "/" + enc(name.toLowerCase());
    }),
  ];
}

var KIND_HINTS = {
  secret: "secret: apps and agents read the value; it is never shown here.",
  config: "config: a non-secret setting, still stored encrypted.",
  sealed: "sealed: only injected into processes, never returned by a get.",
  minted: "minted: the value is a JSON spec naming a parent key; each read mints a fresh child key.",
};

async function envView(project, env) {
  var base = "/v1/projects/" + enc(project) + "/environments/" + enc(env) + "/secrets";
  var data = await api("GET", base);
  var secrets = data.secrets.slice().sort(function (a, b) { return a.name < b.name ? -1 : 1; });
  var valueInput = h("textarea", { id: "secret-value", spellcheck: "false", autocomplete: "off", class: "masked" });
  // Masked while typing; a minted spec is JSON, not a credential, so it shows.
  var kindSelect = select("secret-kind", ["secret", "config", "sealed", "minted"], "secret");
  kindSelect.addEventListener("change", function () { valueInput.className = kindSelect.value === "minted" ? "" : "masked"; });
  var randomBox = h("input", { id: "secret-random", type: "checkbox", on: { change: function () { valueInput.disabled = randomBox.checked; } } });
  return [
    crumbs(["projects", "#/projects"], [project, "#/projects/" + enc(project)], [env]),
    h("h1", { text: project + " / " + env }),
    h("p", { class: "lede", text: "Names and kinds only. Values are write-only here; apps and agents read them with a scoped key." }),
    table([
      { label: "Name", mono: true, render: function (s) { return s.name; } },
      { label: "Kind", mono: true, render: function (s) { return s.kind; } },
      { label: "", actions: true, render: function (s) {
        return dangerButton("delete", "Delete " + s.name + " from " + project + "/" + env + "?", function () {
          return api("PATCH", base, { delete: [s.name] });
        });
      } },
    ], secrets, "No secrets yet."),
    h("h2", { text: "Set a secret" }),
    h("p", { class: "muted", text: "Adds a secret or replaces the value of one with the same name." }),
    actionForm([
      h("div", { class: "row" },
        field("Name", textInput("secret-name", { required: true, pattern: "[A-Z_][A-Z0-9_]*", placeholder: "DATABASE_URL" })),
        field("Kind", kindSelect)),
      field("Value", valueInput, Object.keys(KIND_HINTS).map(function (k) { return KIND_HINTS[k]; }).join(" ")),
      h("div", { class: "field" }, h("label", { class: "check", for: "secret-random" }, randomBox, "Generate a random value instead")),
    ], "Save secret", async function (form) {
      var item = { name: val(form, "secret-name"), kind: val(form, "secret-kind") };
      if (randomBox.checked) item.random = true;
      else item.value = valueInput.value;
      await api("PATCH", base, { set: [item] });
      return h("p", { class: "status", role: "status", text: "Saved " + item.name + "." });
    }),
  ];
}

async function parentView(name) {
  var data = await api("GET", "/v1/parents/" + enc(name) + "/minted");
  return [
    crumbs(["parents", "#/parents"], [name]),
    h("h1", { text: name }),
    h("p", { class: "lede", text: "Child keys minted from this parent, newest first. The keys themselves are never stored." }),
    table([
      { label: "Label", mono: true, render: function (m) { return m.label; } },
      { label: "Prefix", mono: true, narrow: true, render: function (m) { return dash(m.keyPrefix); } },
      { label: "Status", mono: true, render: function (m) { return m.status; } },
      { label: "Minted", mono: true, render: function (m) { return when(m.createdAt); } },
      { label: "Expires", mono: true, narrow: true, render: function (m) { return m.revokedAt ? "revoked " + when(m.revokedAt) : when(m.expiresAt); } },
    ], data.minted, "Nothing minted yet."),
    h("p", null,
      dangerButton("revoke all live children", "Revoke every live child key minted from " + name + " at the provider?", function () {
        return api("POST", "/v1/parents/" + enc(name) + "/revoke");
      }),
      "   ",
      dangerButton("delete parent", "Delete parent key " + name + "? Minted secrets that name it stop working.", async function () {
        await api("DELETE", "/v1/parents/" + enc(name));
        location.hash = "#/parents";
      })),
  ];
}

window.addEventListener("hashchange", function () { render(); });
render();
`;
