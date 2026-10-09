/**
 * The set of master-key wraps, and the two-slot rotation ceremony over them.
 *
 * Each wrap row is one root fingerprint and the vault data key
 * wrapped under that root. `open` resolves the configured root to its wrap and
 * unwraps the data key for the request.
 *
 * The one condition under which key material is *generated* is a database with
 * zero wraps. Everything else fails closed: a configured root with no wrap
 * throws rather than initializing, because initializing there would create a
 * second vault sitting on top of rows nobody can read — while looking healthy.
 *
 * `prepare` refuses a slot holding the active root (409), since that would look
 * like a successful rotation and leave one root. `retire` refuses the active
 * wrap (409), since removing it makes the database unreadable by the running
 * Worker.
 *
 * @see {@link https://vault.buildwithfriends.dev/operations/master-key-rotation/}
 */
import type { VaultBackend } from "./backend.ts";
import {
  MasterKeyError,
  VaultCrypto,
  masterKeyFingerprint,
  parseMasterKey,
} from "./crypto.ts";
import { PolicyError } from "./policy.ts";
import type { MasterKeyWrapMeta } from "./types.ts";

export class VaultKeyring {
  private constructor(
    readonly backend: VaultBackend,
    readonly crypto: VaultCrypto,
    readonly activeFingerprint: string,
  ) {}

  static async open(
    backend: VaultBackend,
    masterKey: string | undefined,
  ): Promise<VaultKeyring> {
    const parsed = parseMasterKey(masterKey);
    const fingerprint = await masterKeyFingerprint(parsed);
    let row = await backend.findWrap({ fingerprint });
    if (row == null) {
      const count = await backend.countWraps({});
      if (count > 0) {
        throw new MasterKeyError(
          `MASTER_KEY fingerprint ${fingerprint} has no prepared vault wrap`,
        );
      }
      const crypto = await VaultCrypto.generate();
      await insertWrap(backend, await crypto.wrapForMasterKey(masterKey));
      row = await backend.findWrap({ fingerprint });
      if (row == null) throw new MasterKeyError("vault key material was not initialized");
    }
    return new VaultKeyring(
      backend,
      await VaultCrypto.fromWrappedDataKey(masterKey, row.wrappedDataKey),
      fingerprint,
    );
  }

  async prepare(masterKey: string | undefined): Promise<string> {
    const prepared = await this.crypto.wrapForMasterKey(masterKey);
    if (prepared.fingerprint === this.activeFingerprint) {
      throw new PolicyError(409, "inactive master-key slot matches the active slot");
    }
    await insertWrap(this.backend, prepared);
    return prepared.fingerprint;
  }

  async list(): Promise<MasterKeyWrapMeta[]> {
    const wraps = await this.backend.listWraps({});
    return wraps.map((wrap) => ({
      fingerprint: wrap.fingerprint,
      createdAt: wrap.createdAt,
    }));
  }

  async retire(fingerprint: string): Promise<void> {
    if (fingerprint === this.activeFingerprint) {
      throw new PolicyError(409, "cannot retire the active master-key wrap");
    }
    if (!(await this.backend.deleteWrap({ fingerprint }))) {
      throw new PolicyError(404, "master-key wrap not found");
    }
  }
}

async function insertWrap(
  backend: VaultBackend,
  wrap: { fingerprint: string; wrappedDataKey: string },
): Promise<void> {
  await backend.insertWrap({
    wrap: {
      fingerprint: wrap.fingerprint,
      wrappedDataKey: wrap.wrappedDataKey,
      createdAt: new Date().toISOString(),
    },
  });
}
