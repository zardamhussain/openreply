/**
 * Threads OAuth.
 *
 * The Threads authorization hop lives on threads.com, not on the Graph host:
 * the user is sent to threads.com/oauth/authorize, and the code that comes
 * back is exchanged for a user token at the Graph host.
 */

const THREADS_AUTHORIZE_URL = "https://threads.com/oauth/authorize";
const THREADS_TOKEN_URL = "https://graph.threads.com/oauth/access_token";

/**
 * The permissions OpenReply needs from a Threads account:
 * reading the profile, reading replies to the account's posts, and
 * publishing replies.
 */
const DEFAULT_SCOPES = [
  "threads_basic",
  "threads_content_publish",
  "threads_read_replies",
  "threads_manage_replies",
];

function requireThreadsAppId(): string {
  const value = process.env.THREADS_APP_ID;
  if (!value) {
    throw new Error(
      "THREADS_APP_ID environment variable is required for the Threads OAuth flow"
    );
  }
  return value;
}

/**
 * The Threads app secret is read from the environment rather than threaded
 * through as a parameter. It is a server-side credential that must never
 * travel in a request body that a caller could hand in from the outside, and
 * keeping it out of the function signature makes that impossible to do by
 * accident.
 */
function requireThreadsAppSecret(): string {
  const value = process.env.THREADS_APP_SECRET;
  if (!value) {
    throw new Error(
      "THREADS_APP_SECRET environment variable is required for the Threads OAuth flow"
    );
  }
  return value;
}

/**
 * The URL the account owner is sent to in order to grant access.
 *
 * `state` is echoed back by Threads and has to be checked against the value
 * we generated, otherwise the callback is an open redirect into somebody
 * else's session.
 */
export function getThreadsAuthorizationUrl(params: {
  redirectUri: string;
  state: string;
  scopes?: string[];
}): string {
  const scopes = params.scopes ?? DEFAULT_SCOPES;

  const query = new URLSearchParams({
    client_id: requireThreadsAppId(),
    redirect_uri: params.redirectUri,
    scope: scopes.join(","),
    response_type: "code",
    state: params.state,
  });

  return `${THREADS_AUTHORIZE_URL}?${query.toString()}`;
}

interface ThreadsTokenResponse {
  access_token?: string;
  user_id?: string;
  expires_in?: number;
  error?: {
    message?: string;
    type?: string;
    code?: number;
  };
  error_message?: string;
  error_code?: number;
}

/**
 * Exchange the authorization code for a Threads user access token.
 *
 * The token comes back short-lived (one hour); the caller exchanges it for a
 * long-lived one through `getThreadsLongLivedToken` in the API client.
 */
export async function exchangeThreadsCodeForToken(params: {
  code: string;
  redirectUri: string;
}): Promise<{ accessToken: string; expiresIn: number }> {
  const body = new URLSearchParams({
    client_id: requireThreadsAppId(),
    client_secret: requireThreadsAppSecret(),
    grant_type: "authorization_code",
    redirect_uri: params.redirectUri,
    code: params.code,
  });

  const response = await fetch(THREADS_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  let data: ThreadsTokenResponse = {};
  try {
    data = (await response.json()) as ThreadsTokenResponse;
  } catch {
    data = {};
  }

  if (!response.ok || data.error || data.error_message) {
    const code = data.error?.code ?? data.error_code;
    const message =
      data.error?.message ?? data.error_message ?? "Unknown Threads OAuth error";
    throw new Error(
      `Threads token exchange failed [code=${code ?? "-"}]: ${message}`
    );
  }

  return {
    accessToken: data.access_token ?? "",
    expiresIn: data.expires_in ?? 0,
  };
}
