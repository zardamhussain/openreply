/**
 * Threads API client.
 *
 * Threads runs on its own Graph host and its own version line: the Threads
 * API is versioned separately from the Facebook/Instagram Graph API and has
 * exactly one version (v1.0). That is why the base URL is hard-coded here
 * instead of reusing `getMetaGraphApiVersion()` — a Threads request carrying
 * a Facebook-style graph version is rejected by Meta.
 *
 * Everything in this module is server-side only: the requests carry the
 * account's access token, and the long-lived-token exchange carries the app
 * secret.
 */

// The versioned Graph surface (posts, replies, publishing).
const THREADS_HOST = "https://graph.threads.com";
const THREADS_API_BASE = `${THREADS_HOST}/v1.0`;

// The OAuth/token endpoints are NOT versioned — Meta documents them at the
// host root (https://graph.threads.com/access_token).
const THREADS_TOKEN_BASE = THREADS_HOST;

export class ThreadsApiError extends Error {
  constructor(
    public code: number,
    public subcode: number | undefined,
    public fbTraceId: string | undefined,
    message: string
  ) {
    super(message);
    this.name = "ThreadsApiError";
  }
}

export interface ThreadsUser {
  id: string;
  username: string;
  name?: string;
  profilePictureUrl?: string;
}

export interface ThreadsPost {
  id: string;
  text?: string;
  mediaType?: string;
  mediaUrl?: string;
  permalink?: string;
  timestamp?: string;
  shortcode?: string;
}

export interface ThreadsReply {
  id: string;
  text?: string;
  username?: string;
  permalink?: string;
  timestamp?: string;
  repliedToId?: string;
  rootPostId?: string;
  rootPostOwnerId?: string;
  rootPostUsername?: string;
  isReplyOwnedByMe?: boolean;
  mediaType?: string;
  mediaUrl?: string;
}

interface GraphApiError {
  error: {
    message: string;
    type: string;
    code: number;
    error_subcode?: number;
    fbtrace_id?: string;
  };
}

/** A page of Threads results plus the cursor that continues it. */
interface ThreadsPage<T> {
  data?: T[];
  paging?: {
    cursors?: {
      before?: string;
      after?: string;
    };
  };
}

interface RawThreadsUser {
  id?: string;
  username?: string;
  name?: string;
  threads_profile_picture_url?: string;
}

interface RawThreadsPost {
  id?: string;
  text?: string;
  media_type?: string;
  media_url?: string;
  permalink?: string;
  timestamp?: string;
  shortcode?: string;
}

interface RawThreadsReply {
  id?: string;
  text?: string;
  username?: string;
  permalink?: string;
  timestamp?: string;
  replied_to?: { id?: string };
  root_post?: { id?: string; owner_id?: string; username?: string };
  is_reply_owned_by_me?: boolean;
  media_type?: string;
  media_url?: string;
}

interface TokenResponse {
  access_token?: string;
  access_token_type?: string;
  token_type?: string;
  expires_in?: number;
}

/**
 * Threads caps a page at 100 items and defaults to 25.
 */
const DEFAULT_PAGE_LIMIT = 25;
const MAX_PAGE_LIMIT = 100;

/**
 * How many pages a single call walks before it hands the cursor back to the
 * caller. Threads replies and post lists are cursor-paginated and a busy
 * account can have thousands of them; five pages is enough to reconcile a
 * recent window without letting one call run unbounded.
 */
const MAX_PAGES = 5;

/**
 * Read THREADS_APP_SECRET from the environment. The long-lived-token exchange
 * has to be made server-side because the secret travels with the request, so
 * the secret is never accepted as an argument that could be passed in from a
 * request handler by accident.
 */
function requireThreadsAppSecret(): string {
  const value = process.env.THREADS_APP_SECRET;
  if (!value) {
    throw new Error(
      "THREADS_APP_SECRET environment variable is required to exchange a Threads token"
    );
  }
  return value;
}

/**
 * Turn a Graph error envelope into a ThreadsApiError.
 *
 * `path` is the endpoint path only. The access token travels in the query
 * string of every GET, so the query string is deliberately never part of the
 * error message — a thrown error ends up in logs.
 */
async function handleResponse<T>(
  response: Response,
  path: string
): Promise<T> {
  let data: unknown;
  try {
    data = await response.json();
  } catch {
    data = undefined;
  }

  const err = (data as GraphApiError | undefined)?.error;
  if (!response.ok || err) {
    const code = err?.code ?? response.status;
    const subcode = err?.error_subcode;
    const traceId = err?.fbtrace_id;
    const message = `${err?.message ?? "Unknown Threads API error"} (${path}) [code=${code} sub=${subcode ?? "-"} type=${err?.type ?? "-"} trace=${traceId ?? "-"}]`;
    throw new ThreadsApiError(code, subcode, traceId, message);
  }

  return data as T;
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_PAGE_LIMIT;
  return Math.min(Math.max(Math.trunc(limit), 1), MAX_PAGE_LIMIT);
}

/**
 * Build a versioned Graph URL. The access token is appended as a query
 * parameter, which is how the Threads API expects it on GETs.
 */
function graphUrl(path: string, params: Record<string, string>): URL {
  const url = new URL(`${THREADS_API_BASE}${path}`);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return url;
}

function mapUser(raw: RawThreadsUser): ThreadsUser {
  return {
    id: raw.id ?? "",
    username: raw.username ?? "",
    name: raw.name,
    profilePictureUrl: raw.threads_profile_picture_url,
  };
}

function mapPost(raw: RawThreadsPost): ThreadsPost {
  return {
    id: raw.id ?? "",
    text: raw.text,
    mediaType: raw.media_type,
    mediaUrl: raw.media_url,
    permalink: raw.permalink,
    timestamp: raw.timestamp,
    shortcode: raw.shortcode,
  };
}

function mapReply(raw: RawThreadsReply): ThreadsReply {
  return {
    id: raw.id ?? "",
    text: raw.text,
    username: raw.username,
    permalink: raw.permalink,
    timestamp: raw.timestamp,
    repliedToId: raw.replied_to?.id,
    rootPostId: raw.root_post?.id,
    rootPostOwnerId: raw.root_post?.owner_id,
    rootPostUsername: raw.root_post?.username,
    isReplyOwnedByMe: raw.is_reply_owned_by_me,
    mediaType: raw.media_type,
    mediaUrl: raw.media_url,
  };
}

/**
 * The connected Threads account behind an access token.
 *
 * `id` is the app-scoped Threads user id — the same id that shows up as
 * `root_post.owner_id` in webhooks and in the reply objects, so it is the
 * key every account is stored under.
 */
export async function getThreadsUser(
  accessToken: string
): Promise<ThreadsUser> {
  const url = graphUrl("/me", {
    fields: "id,username,name,threads_profile_picture_url",
    access_token: accessToken,
  });

  const response = await fetch(url.toString());
  const data = await handleResponse<RawThreadsUser>(response, "/me");
  return mapUser(data);
}

/**
 * The account's own posts, newest first, aggregated over up to five pages.
 *
 * `limit` is the page size Threads returns (25 by default, 100 at most).
 * The returned `nextCursor` is the cursor of the page after the last one
 * read, so the caller can resume where this call stopped — it is undefined
 * when the list was fully read.
 */
export async function getThreadsUserPosts(
  accessToken: string,
  opts?: { limit?: number; after?: string }
): Promise<{ posts: ThreadsPost[]; nextCursor?: string }> {
  const posts: ThreadsPost[] = [];
  const limit = clampLimit(opts?.limit);
  let after = opts?.after;
  let nextCursor: string | undefined;

  for (let page = 0; page < MAX_PAGES; page++) {
    const params: Record<string, string> = {
      fields: "id,media_type,media_url,permalink,timestamp,text,shortcode",
      limit: String(limit),
      access_token: accessToken,
    };
    if (after) params.after = after;

    const response = await fetch(graphUrl("/me/threads", params).toString());
    const data = await handleResponse<ThreadsPage<RawThreadsPost>>(
      response,
      "/me/threads"
    );

    for (const raw of data.data ?? []) {
      posts.push(mapPost(raw));
    }

    nextCursor = data.paging?.cursors?.after;
    if (!nextCursor) break;
    after = nextCursor;
  }

  return { posts, nextCursor };
}

/**
 * The replies on a single Threads post, aggregated over up to five pages.
 *
 * A reply carries no commenter user id — only a username — so `username` is
 * what identifies the replier. `repliedToId` is the media id of the thing
 * that was replied to (the post, or another reply), and `rootPostId` /
 * `rootPostOwnerId` identify the conversation the reply belongs to.
 */
export async function getThreadsMediaReplies(
  accessToken: string,
  mediaId: string,
  opts?: { limit?: number; after?: string }
): Promise<{ replies: ThreadsReply[]; nextCursor?: string }> {
  const replies: ThreadsReply[] = [];
  const limit = clampLimit(opts?.limit);
  let after = opts?.after;
  let nextCursor: string | undefined;

  for (let page = 0; page < MAX_PAGES; page++) {
    const params: Record<string, string> = {
      fields:
        "id,text,username,permalink,timestamp,replied_to,root_post,is_reply_owned_by_me,media_type,media_url",
      limit: String(limit),
      access_token: accessToken,
    };
    if (after) params.after = after;

    const response = await fetch(
      graphUrl(`/${mediaId}/replies`, params).toString()
    );
    const data = await handleResponse<ThreadsPage<RawThreadsReply>>(
      response,
      `/${mediaId}/replies`
    );

    for (const raw of data.data ?? []) {
      replies.push(mapReply(raw));
    }

    nextCursor = data.paging?.cursors?.after;
    if (!nextCursor) break;
    after = nextCursor;
  }

  return { replies, nextCursor };
}

/**
 * Step one of publishing: create a text container that replies to a post or
 * to another reply.
 *
 * Publishing a reply is two separate HTTP calls — create the container,
 * then publish it. The container id returned here is what
 * `publishThreadsContainer` needs.
 *
 * The docs use multipart/form-data, but Threads accepts a plain
 * urlencoded body for these endpoints, which keeps the request readable and
 * testable.
 */
export async function createThreadsReplyContainer(
  accessToken: string,
  params: { replyToId: string; text: string }
): Promise<{ id: string }> {
  const body = new URLSearchParams({
    media_type: "TEXT",
    text: params.text,
    reply_to_id: params.replyToId,
    access_token: accessToken,
  });

  const response = await fetch(`${THREADS_API_BASE}/me/threads`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  return handleResponse<{ id: string }>(response, "/me/threads");
}

/**
 * Step two of publishing: publish a previously created container.
 *
 * The published id is the media id of the live reply — the id a webhook
 * later reports and the id a reply-to-reply has to point at.
 */
export async function publishThreadsContainer(
  accessToken: string,
  userId: string,
  creationId: string
): Promise<{ id: string }> {
  const body = new URLSearchParams({
    creation_id: creationId,
    access_token: accessToken,
  });

  const response = await fetch(
    `${THREADS_API_BASE}/${userId}/threads_publish`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    }
  );

  return handleResponse<{ id: string }>(
    response,
    `/${userId}/threads_publish`
  );
}

/**
 * Exchange a short-lived Threads token for a long-lived one.
 *
 * Threads user tokens live for one hour by default; the long-lived token is
 * valid for 60 days and can be refreshed. The request carries the app
 * secret, so it must only ever be made server-side.
 */
export async function getThreadsLongLivedToken(
  accessToken: string
): Promise<{ accessToken: string; expiresIn: number }> {
  const url = new URL(`${THREADS_TOKEN_BASE}/access_token`);
  url.searchParams.set("grant_type", "th_exchange_token");
  url.searchParams.set("client_secret", requireThreadsAppSecret());
  url.searchParams.set("access_token", accessToken);

  const response = await fetch(url.toString());
  const data = await handleResponse<TokenResponse>(response, "/access_token");

  return {
    accessToken: data.access_token ?? "",
    expiresIn: data.expires_in ?? 0,
  };
}

/**
 * Refresh a long-lived Threads token. The token has to be at least 24 hours
 * old and unexpired; a refreshed token is valid for another 60 days.
 */
export async function refreshThreadsAccessToken(
  accessToken: string
): Promise<{ accessToken: string; expiresIn: number }> {
  const url = new URL(`${THREADS_TOKEN_BASE}/refresh_access_token`);
  url.searchParams.set("grant_type", "th_refresh_token");
  url.searchParams.set("access_token", accessToken);

  const response = await fetch(url.toString());
  const data = await handleResponse<TokenResponse>(
    response,
    "/refresh_access_token"
  );

  return {
    accessToken: data.access_token ?? "",
    expiresIn: data.expires_in ?? 0,
  };
}
