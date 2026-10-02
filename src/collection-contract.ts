import * as v from "valibot";

/** A secret name is an env var name; anything else could carry text into agent context. */
export const SECRET_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,255}$/u;

export const collectionTargetSchema = v.strictObject({
  project: v.pipe(v.string(), v.minLength(1), v.maxLength(120)),
  env: v.pipe(v.string(), v.minLength(1), v.maxLength(120)),
  name: v.pipe(v.string(), v.regex(SECRET_NAME)),
  kind: v.picklist(["secret", "sealed"]),
});
export type CollectionTarget = v.InferOutput<typeof collectionTargetSchema>;
export const collectedSecretSchema = v.strictObject({
  value: v.pipe(v.string(), v.minLength(1), v.maxLength(16384)),
  kind: v.picklist(["secret", "sealed"]),
});
const collectionStateSchema = v.picklist([
  "waiting",
  "saving",
  "stored",
  "cancelled",
  "expired",
  "conflict",
  "unknown",
]);
export const collectionReceiptSchema = v.strictObject({
  requestId: v.pipe(v.string(), v.uuid()),
  target: collectionTargetSchema,
  state: collectionStateSchema,
});
export const collectionContextSchema = v.strictObject({
  receipt: collectionReceiptSchema,
  vaultOrigin: v.string(),
});
