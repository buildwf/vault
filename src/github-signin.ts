/**
 * Signing in to the web UI with GitHub.
 *
 * GitHub only says who the person is. Whether they may sign in, and to which
 * org, is the `github_people` table: an operator adds a GitHub account to
 * their org, and that account then signs in as an operator of it. Matching is
 * on the numeric GitHub id, never the login, because a login can be renamed
 * and then claimed by someone else.
 *
 * The flow asks GitHub for no scopes, so the token it returns can read only
 * public profile data. The Worker uses it once, to learn the id, and drops it.
 *
 * @see {@link https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps}
 */
import * as v from "valibot";

import { PolicyError } from "./policy.ts";

export type GithubSignInConfig = {
  clientId: string;
  clientSecret: string;
};

export type GithubUser = { id: string; login: string };

/** How the Worker reaches GitHub; tests pass a fake. */
export type GithubFetch = (url: string, init?: RequestInit) => Promise<Response>;

const defaultFetch: GithubFetch = (url, init) => fetch(url, init);

/** GitHub logins: letters, digits and single hyphens, at most 39 characters. */
export const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/u;

const userSchema = v.looseObject({ id: v.number(), login: v.string() });
const tokenSchema = v.looseObject({ access_token: v.string() });

const API_HEADERS = {
  Accept: "application/vnd.github+json",
  "User-Agent": "buildwf-vault",
  "X-GitHub-Api-Version": "2022-11-28",
};

export function githubAuthorizeUrl(config: GithubSignInConfig, redirectUri: string, state: string): string {
  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", state);
  url.searchParams.set("scope", "");
  url.searchParams.set("allow_signup", "false");
  return url.toString();
}

/** Trades the callback's code for a token, then reads who it belongs to. */
export async function githubUserFromCode(
  config: GithubSignInConfig,
  code: string,
  redirectUri: string,
  fetcher: GithubFetch = defaultFetch,
): Promise<GithubUser> {
  const tokenResponse = await fetcher("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json", "User-Agent": API_HEADERS["User-Agent"] },
    body: JSON.stringify({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code,
      redirect_uri: redirectUri,
    }),
  });
  // GitHub answers 200 with an `error` field when the code is bad.
  const token = v.safeParse(tokenSchema, await tokenResponse.json().catch(() => null));
  if (!tokenResponse.ok || !token.success) throw new PolicyError(401, "GitHub did not accept the sign-in; try again");
  const userResponse = await fetcher("https://api.github.com/user", {
    headers: { ...API_HEADERS, Authorization: `Bearer ${token.output.access_token}` },
  });
  const user = v.safeParse(userSchema, await userResponse.json().catch(() => null));
  if (!userResponse.ok || !user.success) throw new PolicyError(502, "could not read the GitHub account");
  return { id: String(user.output.id), login: user.output.login };
}

/** The account a login names right now, or null if there is none. */
export async function githubUserByLogin(login: string, fetcher: GithubFetch = defaultFetch): Promise<GithubUser | null> {
  const response = await fetcher(`https://api.github.com/users/${encodeURIComponent(login)}`, {
    headers: API_HEADERS,
  });
  if (response.status === 404) return null;
  const user = v.safeParse(userSchema, await response.json().catch(() => null));
  if (!response.ok || !user.success) throw new PolicyError(502, "could not look up that GitHub account; try again");
  return { id: String(user.output.id), login: user.output.login };
}
