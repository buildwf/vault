import { VaultClient } from "../client.ts";
import { settle, startSecretCollection } from "../collection.ts";
import { SECRET_NAME } from "../collection-contract.ts";
import {
  brokeredFetch,
  placeholderNames,
  requestHost,
  type BrokeredRequest,
} from "./broker.ts";
import { AgentTasks } from "./tasks.ts";

export class AgentRuntime {
  private closing = false;
  // ponytail: in-memory grants, lost on restart (the user just approves again).
  private readonly grants = new Map<string, number>();
  private readonly active = new Map<
    string,
    { stop: () => Promise<void>; timer: ReturnType<typeof setTimeout> }
  >();
  constructor(
    readonly client: VaultClient,
    readonly project: string,
    readonly env: string,
    readonly tasks: AgentTasks,
  ) {}
  private target(name: string) {
    return { project: this.project, env: this.env, name, kind: "secret" as const };
  }
  private hold(taskId: string, handle: { url: string; stop: () => Promise<void> }) {
    this.tasks.transition(taskId, "waiting", "waiting", handle.url);
    const timer = setTimeout(() => {
      void handle.stop();
      this.active.delete(taskId);
      this.tasks.get(taskId);
    }, 600000);
    this.active.set(taskId, { stop: handle.stop, timer });
  }
  async context() {
    const meta = await this.client.listSecretMeta(this.project, this.env);
    return {
      project: this.project,
      env: this.env,
      // Older rows may predate the name rule; never echo them into agent context.
      secrets: meta.secrets
        .filter(({ name }) => SECRET_NAME.test(name))
        .map(({ name, kind }) => ({ name, kind })),
      message:
        "Collect missing values through collect_secret. Call APIs with use_secret and {{NAME}} placeholders so keys never reach you, or run commands with `vault run -- CMD`.",
    };
  }
  /** Saves a value the user typed into an in-chat prompt for a waiting collection. */
  async store(taskId: string, value: string) {
    const task = this.tasks.get(taskId);
    if (!this.tasks.claim(task.taskId)) return this.tasks.get(task.taskId);
    // Detach the unused browser form first so its receipt cannot overwrite this one.
    const active = this.active.get(task.taskId);
    this.active.delete(task.taskId);
    if (active) clearTimeout(active.timer);
    const state = await settle(() =>
      this.client.createCollectedSecret(this.target(task.target), value),
    );
    const done = this.tasks.transition(task.taskId, "saving", state);
    await active?.stop();
    return done;
  }
  /** Creates a missing secret from a value typed into the panel. Never replaces one. */
  add(name: string, value: string) {
    return settle(() => this.client.createCollectedSecret(this.target(name), value));
  }
  /** The host and the names in `request` the user has not allowed for that host. */
  ungranted(request: BrokeredRequest) {
    const host = requestHost(request);
    const now = Date.now();
    return {
      host,
      names: placeholderNames(request).filter(
        (name) => (this.grants.get(`${name} ${host}`) ?? 0) <= now,
      ),
    };
  }
  grant(names: string[], host: string, minutes = 15) {
    for (const name of names) this.grants.set(`${name} ${host}`, Date.now() + minutes * 60000);
  }
  /** Active grants as `{ name, host, expiresAt }`. */
  activeGrants() {
    const now = Date.now();
    return [...this.grants]
      .filter(([, expiresAt]) => expiresAt > now)
      .map(([key, expiresAt]) => {
        const [name, host] = key.split(" ");
        return { name: name!, host: host!, expiresAt: new Date(expiresAt).toISOString() };
      });
  }
  revokeGrant(name: string, host: string) {
    this.grants.delete(`${name} ${host}`);
  }
  async useSecret(request: BrokeredRequest) {
    const names = placeholderNames(request);
    if (names.length === 0) throw new Error("use_secret needs at least one {{NAME}} placeholder");
    if (this.ungranted(request).names.length > 0) throw new Error("use_secret is not approved");
    // Only the named secrets, so a call mints child keys for the parents it uses.
    const { secrets } = await this.client.exportSecrets(this.project, this.env, names);
    const values = Object.fromEntries(
      secrets.filter((secret) => names.includes(secret.name)).map((s) => [s.name, s.value]),
    );
    const missing = names.filter((name) => !(name in values));
    if (missing.length > 0)
      return { missing, message: "Ask the user for these with collect_secret, then retry." };
    return brokeredFetch(request, values);
  }
  /** A short-lived key scoped to this project/env, for another agent or person. */
  async share(permission: "read" | "readwrite", minutes: number, label?: string) {
    const created = await this.client.createKey({
      type: "system",
      permission,
      label: label ?? "agent handoff",
      scopes: [{ project: this.project, env: this.env }],
      expiresInMinutes: minutes,
    });
    return {
      prefix: created.prefix,
      expiresInMinutes: minutes,
      env: { VAULT_API_URL: this.client.apiUrl, VAULT_API_KEY: created.key },
      usage: `VAULT_API_URL=${this.client.apiUrl} VAULT_API_KEY=${created.key} vault run --project ${this.project} --env ${this.env} -- CMD`,
    };
  }
  async collect(taskId: string, name: string) {
    const { created, task } = this.tasks.create(taskId, "collection", name);
    if (!created && !this.tasks.reclaim(task.taskId)) return task;
    taskId = task.taskId;
    try {
      const meta = await this.client.listSecretMeta(this.project, this.env);
      if (meta.secrets.some((secret) => secret.name === name))
        return this.tasks.transition(taskId, "waiting", "conflict");
      const helper = startSecretCollection({
        target: this.target(name),
        vaultOrigin: this.client.apiUrl,
        save: async (value) => {
          if (!this.tasks.claim(taskId)) throw new Error("Task is no longer waiting");
          await this.client.createCollectedSecret(this.target(name), value);
        },
      });
      this.hold(taskId, helper);
      void helper.completed.then((receipt) => {
        // A missing entry means an in-chat answer (or cancel) took this task over.
        if (this.closing || !this.active.has(taskId)) return;
        const current = this.tasks.get(taskId);
        if (current.state === "waiting" || current.state === "saving")
          this.tasks.transition(taskId, current.state, receipt.state);
      });
      return this.tasks.get(taskId);
    } catch {
      return this.tasks.transition(taskId, "waiting", "unknown");
    }
  }
  async cancel(taskId: string) {
    const current = this.tasks.get(taskId);
    taskId = current.taskId;
    if (current.state === "waiting")
      this.tasks.transition(taskId, "waiting", "cancelled");
    const active = this.active.get(taskId);
    if (active && current.state === "waiting") {
      clearTimeout(active.timer);
      await active.stop();
      this.active.delete(taskId);
    }
    return this.tasks.get(taskId);
  }
  async resume(taskId: string) {
    const task = this.tasks.get(taskId);
    if (task.state !== "waiting" || task.url) return task;
    return this.collect(task.requestId, task.target);
  }
  async close() {
    this.closing = true;
    for (const [taskId, active] of this.active) {
      clearTimeout(active.timer);
      this.tasks.release(taskId);
      await active.stop();
    }
    this.active.clear();
  }
}
