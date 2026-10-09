import * as v from "valibot";
export function d1DatabaseIdFromListOutput(output: string, name: string): string {
  const databases = v.parse(
    v.array(
      v.looseObject({
        name: v.optional(v.string()),
        uuid: v.optional(v.string()),
      }),
    ),
    JSON.parse(output),
  );
  const match = databases.find((database) => database.name === name)?.uuid;
  if (!v.is(v.string(), match) || !/^[0-9a-f-]{36}$/iu.test(match)) {
    throw new Error("cf d1 list did not list the disposable D1 database id");
  }
  return match;
}

export function deployedWorkersDevUrl(output: string): URL {
  const match = /https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev\/?/iu.exec(output)?.[0];
  if (match === undefined) {
    throw new Error("cf deploy did not report the disposable Worker URL");
  }
  return new URL(match);
}

/** The id of `name` in `cf secrets-store secrets list` JSON (stdout only). */
export function secretsStoreSecretId(output: string, name: string): string {
  const secrets = v.parse(
    v.array(v.looseObject({ id: v.string(), name: v.string() })),
    JSON.parse(output),
  );
  const id = secrets.find((secret) => secret.name === name)?.id;
  if (id === undefined || !/^[0-9a-f]{32}$/iu.test(id)) {
    throw new Error(`Secrets Store did not list ${name}`);
  }
  return id;
}
