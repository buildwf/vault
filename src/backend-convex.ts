/**
 * `ConvexBackend` — the vault's rows in a Convex deployment.
 *
 * Every method is one `POST {siteUrl}/vault/rpc` naming the operation, which
 * `convex/http.ts` authenticates with the shared storage token and runs as one
 * internal Convex function from `convex/vault.ts`. The Worker still holds every
 * key: what crosses this wire is the same ciphertext and keyed hashes D1 holds.
 *
 * A non-2xx answer throws. The Convex side reports refused writes (a taken
 * name, the last user key) as ordinary results, so an exception here is an
 * outage or a misconfiguration, never a policy outcome.
 */
import type {
  AuditRow,
  KeyRow,
  NamedRow,
  OrgRow,
  RevokeOutcome,
  SecretRow,
  VaultBackend,
  WrapRow,
} from "./backend.ts";

/** Must match `PRUNE_BATCH` in `convex/vault.ts`. */
const PRUNE_BATCH = 500;

type Fetch = (input: string, init: RequestInit) => Promise<Response>;

export class ConvexStorageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConvexStorageError";
  }
}

export class ConvexBackend implements VaultBackend {
  private readonly endpoint: string;
  private readonly token: string;
  private readonly fetcher: Fetch;

  constructor(options: { siteUrl: string; token: string; fetch?: Fetch }) {
    if (!URL.canParse(options.siteUrl))
      throw new ConvexStorageError("CONVEX_SITE_URL must be a URL");
    const url = new URL("/vault/rpc", options.siteUrl);
    // Plain http only reaches a local `npx convex dev` backend.
    const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost";
    if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
      throw new ConvexStorageError("CONVEX_SITE_URL must use https");
    if (options.token.length < 32)
      throw new ConvexStorageError("CONVEX_STORAGE_TOKEN must be at least 32 characters");
    this.endpoint = url.toString();
    this.token = options.token;
    this.fetcher = options.fetch ?? ((input, init) => fetch(input, init));
  }

  private async call<T>(op: string, args: object): Promise<T> {
    const response = await this.fetcher(this.endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ op, args }),
    });
    if (!response.ok) {
      throw new ConvexStorageError(`Convex storage ${op} failed with ${response.status}`);
    }
    const body: unknown = await response.json();
    if (typeof body !== "object" || body == null || !("result" in body))
      throw new ConvexStorageError(`Convex storage ${op} returned no result`);
    // SAFETY: the deployment runs `convex/vault.ts`, whose function for `op`
    // returns the shape `VaultBackend` declares for the method of that name.
    return body.result as T;
  }

  findWrap(input: { fingerprint: string }) {
    return this.call<WrapRow | null>("findWrap", input);
  }
  countWraps(input: Record<string, never>) {
    return this.call<number>("countWraps", input);
  }
  insertWrap(input: { wrap: WrapRow }) {
    return this.call<void>("insertWrap", input);
  }
  listWraps(input: Record<string, never>) {
    return this.call<WrapRow[]>("listWraps", input);
  }
  deleteWrap(input: { fingerprint: string }) {
    return this.call<boolean>("deleteWrap", input);
  }

  createOrg(input: { org: OrgRow; key: KeyRow }) {
    return this.call<boolean>("createOrg", input);
  }
  getOrg(input: { id: string }) {
    return this.call<OrgRow | null>("getOrg", input);
  }
  listOrgs(input: Record<string, never>) {
    return this.call<string[]>("listOrgs", input);
  }

  insertKey(input: { key: KeyRow }) {
    return this.call<void>("insertKey", input);
  }
  claimBootstrap(input: { claimedAt: string; key: KeyRow }) {
    return this.call<boolean>("claimBootstrap", input);
  }
  isBootstrapped(input: Record<string, never>) {
    return this.call<boolean>("isBootstrapped", input);
  }
  findKeyByHash(input: { keyHash: string }) {
    return this.call<KeyRow | null>("findKeyByHash", input);
  }
  findKeyByPrefix(input: { orgId: string; keyPrefix: string }) {
    return this.call<KeyRow | null>("findKeyByPrefix", input);
  }
  listKeys(input: { orgId: string; includeRevoked: boolean }) {
    return this.call<KeyRow[]>("listKeys", input);
  }
  revokeKey(input: { orgId: string; keyPrefix: string; revokedAt: string }) {
    return this.call<RevokeOutcome>("revokeKey", input);
  }
  rotateKey(input: { key: KeyRow; revokePrefix: string; revokedAt: string }) {
    return this.call<"rotated" | "last_user_key">("rotateKey", input);
  }
  touchKey(input: { keyPrefix: string; at: string }) {
    return this.call<void>("touchKey", input);
  }

  createProject(input: {
    project: NamedRow & { orgId: string; createdAt: string };
    environments: NamedRow[];
  }) {
    return this.call<boolean>("createProject", input);
  }
  listProjects(input: { orgId: string }) {
    return this.call<string[]>("listProjects", input);
  }
  getProject(input: { orgId: string; name: string }) {
    return this.call<NamedRow | null>("getProject", input);
  }
  deleteProject(input: { id: string }) {
    return this.call<void>("deleteProject", input);
  }
  createEnvironment(input: {
    environment: NamedRow & { projectId: string; createdAt: string };
  }) {
    return this.call<boolean>("createEnvironment", input);
  }
  deleteEnvironment(input: { projectId: string; name: string }) {
    return this.call<boolean>("deleteEnvironment", input);
  }
  listEnvironments(input: { projectId: string }) {
    return this.call<string[]>("listEnvironments", input);
  }
  getEnvironment(input: { projectId: string; name: string }) {
    return this.call<NamedRow | null>("getEnvironment", input);
  }

  listSecretRows(input: { environmentId: string }) {
    return this.call<SecretRow[]>("listSecretRows", input);
  }
  insertSecret(input: { secret: SecretRow }) {
    return this.call<boolean>("insertSecret", input);
  }
  upsertSecret(input: { secret: SecretRow }) {
    return this.call<void>("upsertSecret", input);
  }
  deleteSecret(input: { environmentId: string; keyHash: string }) {
    return this.call<boolean>("deleteSecret", input);
  }
  getSecretRow(input: { environmentId: string; keyHash: string }) {
    return this.call<SecretRow | null>("getSecretRow", input);
  }

  insertAudit(input: { event: AuditRow }) {
    return this.call<void>("insertAudit", input);
  }
  listAudit(input: {
    orgId: string;
    limit: number;
    before: { createdAt: string; id: string } | null;
  }) {
    return this.call<AuditRow[]>("listAudit", input);
  }
  /** Convex caps the rows one mutation may write, so this deletes in batches. */
  async pruneAudit(input: { before: string }): Promise<number> {
    let total = 0;
    for (;;) {
      const deleted = await this.call<number>("pruneAudit", input);
      total += deleted;
      if (deleted < PRUNE_BATCH) return total;
    }
  }
}
