# Threads API Research (2026) — for OpenReply comment-to-DM parity

**Status:** Official Meta developer documentation only (developers.facebook.com). Read 2026-11-20.
**Headline:** The Threads API has **no messaging surface at all**. A brand cannot DM a Threads
commenter — not proactively, not reactively, not by any permission. The comment-to-DM product
concept does **not** exist on Threads. Public replies are available and are the only engagement path.

**Docs moved.** Canonical URLs are now `developers.facebook.com/documentation/threads/*`
(old `developers.facebook.com/docs/threads/*` still resolve). Every page has a `.md` variant
(e.g. `.../documentation/threads/webhooks.md`) and there is a full index at
`https://developers.facebook.com/documentation/threads/llms.txt`.

---

## 1. OAuth

### Answer
Threads uses **neither Facebook Login nor Instagram Login**. It has its own first-party
Authorization Window hosted on `threads.com`, and its own token endpoints on `graph.threads.com`.
It is a **separate app product** with its own app ID and app secret ("Threads App ID" / "Threads App
Secret"), distinct from the Facebook App ID on the same Meta app.

**Authorization URL** — `GET https://threads.com/oauth/authorize`

| Param | Required | Value |
|---|---|---|
| `client_id` | yes | **Threads App ID** (App Dashboard → App settings → Basic → Threads App ID) |
| `redirect_uri` | yes | Must exactly match a valid OAuth URI (dashboard may add a trailing slash) |
| `response_type` | yes | `code` |
| `scope` | yes | Comma- or space-separated. `threads_basic` required |
| `state` | no | CSRF |

```
https://threads.com/oauth/authorize
  ?client_id=<THREADS_APP_ID>
  &redirect_uri=<REDIRECT_URI>
  &scope=threads_basic,threads_content_publish,threads_read_replies,threads_manage_replies
  &response_type=code
  &state=<STATE>
```
Docs note: on Android, open the URL in a webview/browser, not the native app. Threads appends `#_`
to the redirect URI — strip it before parsing the `code`.

**Token exchange** — `POST https://graph.threads.com/oauth/access_token`
(`application/x-www-form-urlencoded`):
```
client_id=<THREADS_APP_ID>
client_secret=<THREADS_APP_SECRET>
grant_type=authorization_code
redirect_uri=<REDIRECT_URI>
code=<AUTHORIZATION_CODE>
```
Auth codes are valid 1 hour and single-use.

**Long-lived token** — `GET https://graph.threads.com/access_token`
`?grant_type=th_exchange_token&client_secret=<THREADS_APP_SECRET>&access_token=<SHORT_LIVED>`
Valid 60 days. Server-side only (it carries the app secret).

**Refresh** — `GET https://graph.threads.com/refresh_access_token`
`?grant_type=th_refresh_token&access_token=<LONG_LIVED>` → new 60-day token. Must be ≥24h old and
unexpired. Tokens not refreshed within 60 days expire permanently.

**Token lifetimes vs. Instagram:** short-lived 1h / long-lived 60d / refresh every 60d — the same
shape OpenReply already implements for Instagram. Permission *grants* are valid 90 days and refresh
extends them **only if the app user has a public profile**; private-profile users must re-grant.

### Scopes — what actually exists
The Threads use case exposes exactly these permissions (App Dashboard → Use Cases → Customize):

| Permission | Purpose |
|---|---|
| `threads_basic` | Required for **all** Threads endpoints. Cannot be removed. |
| `threads_content_publish` | Publishing posts/replies (POST) |
| `threads_read_replies` | GET on reply endpoints |
| `threads_manage_replies` | POST to reply endpoints (`reply_to_id`), hide/unhide, reply_control |
| `threads_manage_insights` | GET insights endpoints |
| `threads_delete` | Delete posts |
| `threads_keyword_search` | Keyword/topic search; also unlocks replying to others' posts |
| `threads_location_tagging` | Location search + tagging |
| `threads_manage_mentions` | Retrieve mentions; also unlocks replying to others' posts |
| `threads_profile_discovery` | Public profile lookup (`/profile_lookup`, `/profile_posts`) |
| `threads_share_to_instagram` | Cross-share a Threads post to linked IG as a Story (2026-03-25) |

Also documented elsewhere: `threads_business_basic` (retrieve a Threads account ID matching an
Instagram account by username — for ads), `threads_user_id` (a *field*, not a permission).

**❌ `threads_messaging` — DOES NOT EXIST.**
**❌ `threads_manage_settings` — DOES NOT EXIST.**

Verified three independent ways:
1. Live scrape of the Permissions Reference page → the complete set of `threads_*` names is:
   `threads_basic`, `threads_business_basic`, `threads_content_publish`, `threads_delete`,
   `threads_keyword_search`, `threads_location_tagging`, `threads_manage_insights`,
   `threads_manage_mentions`, `threads_manage_replies`, `threads_profile_discovery`,
   `threads_read_replies`, `threads_share_to_instagram`. Zero occurrences of `threads_messaging`
   or `threads_manage_settings`.
2. The "Get access tokens" page enumerates the legal `scope` values: `threads_basic`,
   `threads_content_publish`, `threads_read_replies`, `threads_manage_replies`,
   `threads_manage_insights`. No messaging scope.
3. The Use Case Permission Mapping page lists the same set for "Access the Threads API".

### Required scopes by capability

| Capability | Scopes |
|---|---|
| (a) Read comments/replies | `threads_basic` + `threads_read_replies` |
| (b) Reply publicly | `threads_basic` + `threads_content_publish` + `threads_manage_replies` |
| (c) Send DMs | **Not possible — no messaging endpoint, no messaging scope** |

**Docs:**
- https://developers.facebook.com/documentation/threads/get-started
- https://developers.facebook.com/documentation/threads/get-started/get-access-tokens-and-permissions
- https://developers.facebook.com/documentation/threads/get-started/long-lived-tokens
- https://developers.facebook.com/documentation/development/create-an-app/threads-use-case
- https://developers.facebook.com/docs/development/create-an-app/use-cases-permission-mapping

---

## 2. Identity

### Answer
There is **one** identifier type in the official Threads API: the **app-scoped Threads user ID**,
obtained from `GET /me?fields=id,username,name,threads_profile_picture_url,threads_biography,is_verified`
(the `id` field). It is unique per (app, user) pair — the same app-scoped model as Instagram's IGSID.

- `threads_user_id` — the canonical name for this ID in doc prose and path parameters
  (`{threads-user-id}`). This is what you use in every Graph path.
- `threads_profile_id` — **not an official Threads API term.** It appears only in third-party
  Instagram *private*-API libraries (instagrapi/aiograpi) as a cross-posting destination for
  Instagram→Threads. In the official Threads API there is no separate "profile id" object.
- `threads_id` — informal; the docs use `threads-media-id` (a post/reply id) and
  `threads-user-id` (a user id). In the create-replies example `reply_to_id=<THREADS_ID>` means
  a **media** id, not a user id.

### Which goes in Graph API paths
- **Posting content / replying** → `{threads-user-id}` = the app-scoped user id of the connected
  account (`/me` works for the connected user).
- **Reading a post** → `{threads-media-id}` = the media id of the post/reply.
- The media id is *not* interchangeable with a user id.

### Getting the id from a media or a user id
- **From a user:** `GET /{threads-user-id}?fields=id,username,name,...`. Limitation: *"You may only
  fetch the profile of the app-scoped user."* For other users you need Profile Discovery
  (`GET /profile_lookup?username=...`, `threads_profile_discovery`, public profiles with ≥100
  followers).
- **From a media object:** `GET /{threads-media-id}?fields=owner` → `{ "owner": { "id": "..." } }`.
  **Caveat:** the `owner` field is *"only available on top-level posts that you own."*
- **From a reply:** there is no `owner` field on replies. The `replies`/`conversation` field list has
  no owner/user id at all. The webhook payload exposes `root_post.owner_id` instead.
- **From a username:** `GET /profile_lookup?username=...` returns the profile; the returned `id` is
  app-scoped to *your* app, so it is not portable across apps.

**Docs:**
- https://developers.facebook.com/documentation/threads/threads-profiles
- https://developers.facebook.com/documentation/threads/reference/user
- https://developers.facebook.com/documentation/threads/reference/media-retrieval
- https://developers.facebook.com/documentation/threads/retrieve-and-discover-posts/retrieve-posts

---

## 3. Webhooks

### Answer — and this is where Threads diverges most from Instagram

**Threads webhooks do NOT use the standard Graph `{object, entry, changes}` envelope.** They use a
completely different, flat, per-event payload shape. Instagram's shape is:

```json
{"object":"instagram","entry":[{"id":"...","time":...,"changes":[{"field":"comments","value":{...}}]}]}
```

Threads' shape is:
```json
{
  "app_id": "123456",
  "topic": "moderate",
  "target_id": "78901",
  "time": 1723226877,
  "subscription_id": "234567",
  "has_uid_field": false,
  "values": {
    "value": {
      "id": "8901234",
      "username": "test_username",
      "text": "Reply",
      "media_type": "TEXT_POST",
      "permalink": "https://www.threads.com/@test_username/post/Pp",
      "replied_to": { "id": "567890" },
      "root_post": { "id": "123456", "owner_id": "123456", "username": "test_username_2" },
      "shortcode": "Pp",
      "timestamp": "2024-08-07T10:33:16+0000"
    },
    "field": "replies"
  }
}
```
No `object`, no `entry`, no `changes`. The field name lives at `values.field` and the payload at
`values.value`. **OpenReply's Instagram webhook parser will not work on Threads payloads.**

### Which object/field to subscribe to
There is no "app object" to subscribe to (no `threads` object analogous to Instagram's `instagram`).
Subscription is configured in the App Dashboard under the Threads use case → **Webhooks**
sub-use case → pick a **topic**, then fields within that topic.

| Topic | Field | Fires for | Required scopes |
|---|---|---|---|
| `moderate` | **`replies`** | Replies on a Threads post **owned by the authenticated user** | `threads_basic`, `threads_read_replies` |
| `moderate` | `delete` | Posts deleted by the authenticated user | `threads_basic`, `threads_delete` |
| `interaction` | `mentions` | Mentions of the authenticated user on a public post | `threads_basic`, `threads_manage_mentions` (+`threads_read_replies` for `has_replies`/`is_reply`/`replied_to`/`root_post`) |
| `interaction` | `publish` | Posts published by the authenticated user (incl. replies to others) | `threads_basic` |

**❌ There is no `comments` field for Threads.** Threads has no comment object — comments *are*
replies. The `replies` field is the comment field.
**❌ No `follows`, `messaging`, `message_replies`, or `live_events` fields exist for Threads.**
`mentions` exists but is a Threads-post mention, not a comment mention.

### Delivery requirements
- App must have the Threads webhooks sub-use case + fields subscribed in the dashboard.
- App must be **published** (App Review is not required to *use* webhooks, but advanced-access
  permissions + a **verified business** are required to actually *receive* notifications).
- Without advanced access on the permission → no webhook notifications.
- The media owner must not have a **private** account, or no notification is delivered.
- Payload is per-`subscription_id`; `target_id` = the media id (for `replies`/`delete`) or the
  mentioned user's app-scoped user id (for `mentions`).

**Docs:**
- https://developers.facebook.com/documentation/threads/webhooks
- https://developers.facebook.com/documentation/development/graph-api/webhooks/reference/instagram
- https://developers.facebook.com/documentation/instagram-platform/webhooks/examples

---

## 4. THE CRITICAL QUESTION — proactive messaging

### Answer: **No. It is not merely restricted — it is not implemented.**

There is **no Threads messaging API**. Not "reply-only", not "7-day window", not "requires prior
message" — the capability does not exist at all in the official documentation.

**Evidence (all official):**
1. **Threads API reference index** lists every endpoint group: Publishing, Media retrieval, Reply
   management, User, Locations, Location search, Insights, oEmbed, Debug. There is **no Messaging
   group** and no `/{id}/messages` edge.
   → https://developers.facebook.com/documentation/threads/reference
2. **Threads docs index (`llms.txt`)** — the complete list of ~45 Threads doc pages. No messaging
   page.
   → https://developers.facebook.com/documentation/threads/llms.txt
3. **Permissions Reference** — no `threads_messaging` permission exists (scraped live; see §1).
4. **Webhook fields** — no `messages` / `message_replies` / `messaging` field (see §3).
5. **Get-started scope list** — no messaging scope (see §1).
6. `https://developers.facebook.com/documentation/threads/messaging` resolves to an **empty page
   shell** (title "Meta for Developers", 438 chars of nav chrome, no H1, no content) — it is not a
   real doc page.

Threads *the consumer product* has had DMs since July 2025 (announced by Meta, with EU rollout
following), but the **API for businesses to send them was never shipped**. Threads DMs live in the
Threads inbox and are **not** covered by the Instagram Messaging API — Instagram's Send API targets
Instagram-scoped IDs on `graph.instagram.com` / `graph.facebook.com`, not Threads IDs on
`graph.threads.net`.

### Explicitly answering each sub-question
| Question | Answer |
|---|---|
| Can a business DM a commenter who hasn't messaged them? | **No.** No API exists. |
| Can a business DM someone who *has* messaged the business first? | **No.** No messaging endpoint at all. |
| What does `threads_messaging` allow? | **The permission does not exist.** |
| Is there a 7-day response window on Threads? | **Not applicable.** No Threads messaging, so no window of any kind. The 7-day rule in your brief is an *Instagram* rule and does not carry over. |
| Does commenting count as initiating a conversation? | **There is no conversation surface to initiate.** |
| Does Threads require the recipient to have messaged first (reply-only)? | **Neither** — the axis doesn't exist. |

### Explicit comparison with Instagram (this is where your brief's premise is correct)

Instagram's rule — and it is genuinely permissive here:

- **Instagram Private Replies** is the sanctioned comment→DM path.
  - `POST /{IG_ID}/messages` with `{"recipient": {"comment_id": "<COMMENT_ID>"}, "message": {"text": "..."}}`
  - Host: `graph.instagram.com` (Instagram Login) or `graph.facebook.com` (Facebook Login for Business).
  - Scope: `instagram_manage_messages` (plus `instagram_manage_comments` to *receive* the comment).
  - **One message only**, must be sent **within 7 days of the comment** (Live: only during the broadcast).
  - Delivered to the commenter's Inbox if they follow you, else to Requests.
  - **Follow-ups require the recipient to reply first**, and then only within the 24-hour standard
    messaging window. "Only when the Instagram user responds to the private message can you continue
    the conversation within the 24-hour messaging window."
- A comment also opens the **standard messaging window** (24h) per the Messenger Platform policy —
  but for Instagram specifically the Private Replies doc is the stricter governing rule, and the
  practical reading is: one DM per comment, 7 days; conversation continues only if they reply.
- Instagram requires an **Instagram Professional account (Business or Creator)** for any of this.

**So: OpenReply's existing Instagram comment-to-DM feature has no Threads equivalent.** The
"equivalent Threads support" that was requested does not exist as a DM capability. What *does* exist
is the public-reply analogue, which is a different product (a public comment reply, not a DM).

**Ambiguity flag:** The Threads documentation is not ambiguous on Q4 — it is *silent*. There is no
page that says "messaging is not supported"; there is simply no messaging page, permission, endpoint,
or webhook field. Absence of documentation is the finding. The nearest thing to an official
statement is the Threads API reference index (which enumerates all endpoint groups and omits
messaging) and the Threads API overview's own summary of scope: *"Use the Threads API to create and
publish posts, retrieve media and profiles, moderate replies, and access insights."*
→ https://developers.facebook.com/documentation/threads.md

**Docs:**
- https://developers.facebook.com/documentation/threads/reference
- https://developers.facebook.com/documentation/threads/llms.txt
- https://developers.facebook.com/docs/permissions/threads
- https://developers.facebook.com/documentation/business-messaging/instagram-messaging/features/private-replies
- https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login/messaging-api/private-replies
- https://developers.facebook.com/documentation/business-messaging/messenger-platform/send-messages
- https://about.fb.com/news/2025/07/introducing-messaging-highlighted-perspectives-threads (consumer DMs exist)

---

## 5. Replying publicly

### Reply to a comment on a Threads post (and to any post) — same endpoint
Two-step, container-then-publish:

**Step 1** — `POST https://graph.threads.com/v1.0/me/threads`
```
media_type=TEXT
text=<TEXT>
reply_to_id=<THREADS_MEDIA_ID_OF_THE_COMMENT_OR_POST>
access_token=<ACCESS_TOKEN>
```
→ `{ "id": "<CONTAINER_ID>" }`

**Step 2** — `POST https://graph.threads.com/v1.0/{threads-user-id}/threads_publish`
```
creation_id=<CONTAINER_ID>
access_token=<ACCESS_TOKEN>
```
→ `{ "id": "<THREADS_MEDIA_ID>" }`

Wait ~30 seconds between steps so the media pipeline finishes processing.

`reply_to_id` = **the media id of the thing you are replying to** — i.e. the comment's id if you're
answering a comment, or the root post's id if you're replying to a post. Both are the same call.

### Scopes
`threads_basic` + `threads_content_publish` + `threads_manage_replies`.

### Eligibility gate (important)
> "In addition, to reply to a thread, you must meet one of the following requirements:
>  - You are the owner of the root Threads post.
>  - Your app has either the `threads_keyword_search` or the `threads_manage_mentions` permission."

So replying to comments on **your own** posts needs no extra scope. Replying to **someone else's**
post requires `threads_keyword_search` or `threads_manage_mentions` (both need App Review).

### Replies are flat, not nested
Threading gotcha: to chain a multi-part reply, **every** reply must target the **root** post's id
(`reply_to_id = root_id`), not the previous reply's id. Pointing at the previous reply splits the
conversation. *(This is community-documented behaviour, not in Meta's docs — flagged as such.)*

### Answering a specific comment
The official Create Replies doc is explicit that you reply to a particular comment by pointing at
that comment:

> "Use the `reply_to_id` parameter to reply to a specific reply under the root post."

So `reply_to_id` = the **comment's own media id**, and the reply nests under that comment. This
supersedes the community note above, which claimed every reply must target the root post. OpenReply
answers a comment by using the comment's id, which is what the official doc specifies.

### Moderation endpoints (bonus)
- `POST /{threads-reply-id}/manage_reply` with `hide=true|false` — hides/unhides a top-level
  reply (cascades to nested replies; deeper-than-top-level replies can't be targeted alone).
- `GET /{threads-media-id}/pending_replies?approval_status=pending|ignored` — reply approvals.
- `POST /{threads-reply-id}/manage_pending_reply` with `approve=true|false`.
- `reply_control` on container creation: `everyone`, `accounts_you_follow`, `mentioned_only`,
  `parent_post_author_only`, `followers_only`.

**Docs:**
- https://developers.facebook.com/documentation/threads/retrieve-and-manage-replies/create-replies
- https://developers.facebook.com/documentation/threads/reference/publishing
- https://developers.facebook.com/documentation/threads/reply-management

---

## 6. Reading content

### User content
| Endpoint | Purpose | Scopes |
|---|---|---|
| `GET /{threads-user-id}/threads` | All posts by a user (app-scoped user only) | `threads_basic` |
| `GET /{threads-user-id}/replies` | All replies authored by a user | `threads_basic` (+`threads_read_replies`) |
| `GET /{threads-user-id}/mentions` | Posts where the user is mentioned | `threads_basic` + `threads_manage_mentions` |
| `GET /{threads-user-id}/ghost_posts` | Ghost posts (24h, auto-expire) | `threads_basic` |
| `GET /{threads-user-id}?fields=id,username,name,...` | Own profile | `threads_basic` |
| `GET /{threads-user-id}/threads_publishing_limit` | Quota usage | `threads_basic` |
| `GET /profile_lookup?username=...` | Public profile by exact username | `threads_basic` + `threads_profile_discovery` |
| `GET /profile_posts?username=...` | Public profile's posts | same |

### Media + replies
| Endpoint | Purpose | Scopes |
|---|---|---|
| `GET /{threads-media-id}` | Single media object | `threads_basic` |
| **`GET /{threads-media-id}/replies`** | **Paginated top-level replies (= comments)** | `threads_basic` + `threads_read_replies` |
| **`GET /{threads-media-id}/conversation`** | **Paginated, flattened top-level + nested replies** | `threads_basic` + `threads_read_replies` |
| `GET /{threads-media-id}/pending_replies` | Pending/ignored replies | + `threads_manage_replies` |
| `GET /keyword_search?q=...` | Public post search by keyword/topic | `threads_basic` + `threads_keyword_search` |

**`/replies` vs `/conversation`:** `/replies` returns only top-level replies; `/conversation` returns
a flattened list of all top-level and nested replies. Both are what OpenReply needs for a
comment/reply tree.

### Pagination
Cursor-based: `before` / `after` (never both), plus:
- `limit` — default **25**, max **100**
- `reverse` — bool, default `true` (reverse chronological) on reply endpoints
- `since` / `until` — datetime (Unix ts or `YYYY-MM-DD`); `since` must be ≥ `1688540400`
- Response: `data[]` + `paging.cursors.{before,after}` + `paging.next` / `paging.previous`

### Reply fields you can rely on
`id`, `text`, `username`, `permalink`, `timestamp`, `media_type`, `media_url`, `shortcode`,
`thumbnail_url`, `children`, `is_quote_post`, `quoted_post`, `has_replies`, `root_post`,
`replied_to`, `is_reply`, `is_reply_owned_by_me`, `hide_status`, `reply_audience`,
`reposted_post`, `gif_url`, `topic_tag`, `is_verified`, `profile_picture_url`, `media_product_type`.

⚠️ **`username` on a reply "only works for public users and your own user."** There is **no
commenter user id** in the reply field list — only `username`. (Contrast Instagram, whose
`comments` webhook includes `from.id` = Instagram-scoped ID, which is what OpenReply's DM path
needs.) On Threads you get a display name, not a messageable identifier.

**Docs:**
- https://developers.facebook.com/documentation/threads/reference/user
- https://developers.facebook.com/documentation/threads/reference/reply-management
- https://developers.facebook.com/documentation/threads/reference/media-retrieval
- https://developers.facebook.com/documentation/threads/retrieve-and-discover-posts/retrieve-posts
- https://developers.facebook.com/documentation/threads/keyword-search

---

## 7. Regional limits and account type

### Account type — the big difference from Instagram
**Any Threads profile can be connected. No professional/creator/business account is required, and
no linked Instagram account is required either.**

- Since **2025-09-23** (changelog): *"The Threads API is now available to Threads profiles without
  a linked Instagram account. These users can use all Threads API functionalities except for the
  `followers_count` and `follower_demographics` user metrics."* (Those two metrics were restored
  for unlinked profiles on **2026-01-30**.)
- Threads has no notion of "professional account" for API purposes. The Threads consumer app does
  have creator/professional features, but the API gates on *permission grants*, not account type.
- Contrast Instagram: Private Replies and all messaging require an **Instagram Professional
  account (Business or Creator)**, and OpenReply's current flow depends on that.
- Threads profiles are also decoupled from Instagram in Business Manager as of **September 2026**
  (task-based Threads-specific access controls no longer inherited from the linked Instagram profile).

### Availability
- **The Threads app** is available worldwide (ads rolled out globally 2026-01; DM rollout to the EU
  followed in July 2025).
- **The Threads API itself:** Meta's docs state **no regional restriction**. I found no
  country-by-country availability table or regional gating in the Threads API documentation.
  ⚠️ *Flag: I could not find an explicit "available in all countries" sentence in the docs — the
  absence of a restriction is inferred from the docs being globally unremarkable on this point, not
  from a positive statement.*
- The only country-scoped feature is **geo-gating** (`allowlisted_country_codes`, ISO 3166-1 alpha-2)
  which restricts *where your post is shown*, not where the API works. It has its own user-eligibility
  check (`is_eligible_for_geo_gating` on `GET /me`).
- Regional constraints that *do* apply: EU requires a **Data Protection Officer** contact to
  publish your app; `ads_management` needs Business Verification.

### Other eligibility facts
- **App Review** is required per permission before users without a role on your app can grant it.
  Threads testers can grant any time.
- **Business Verification** is required for advanced access, and for receiving webhook notifications.
- `profile_lookup` / `profile_posts` require the public profile to have **≥100 followers** (lowered
  from 1,000 on 2025-11-20), and cap at **1,000 requests / rolling 24h**.
- `keyword_search` caps at **2,200 queries / rolling 24h**, counted **per user across all apps**.

**Docs:**
- https://developers.facebook.com/documentation/threads/changelog
- https://developers.facebook.com/documentation/threads/get-started
- https://developers.facebook.com/documentation/threads/get-started/create-an-app
- https://developers.facebook.com/documentation/threads/threads-profiles
- https://developers.facebook.com/documentation/threads/posts/geo-gating

---

## 8. Threads-specific limitations vs. Instagram

### Rate limits (per profile, rolling 24h)
| Limit | Value |
|---|---|
| API-published posts | **250** (a carousel counts as 1) |
| Replies | **1,000** |
| Deletions | **100** |
| Location searches | **500** |
| API calls | `4800 × Number of Impressions` in 24h, **min impressions = 10** (so a brand-new/low-reach profile gets a tiny budget) |
| CPU time | `720000 × impressions` total_cputime; `2880000 × impressions` total_time |

Check live usage: `GET /{threads-user-id}/threads_publishing_limit?fields=quota_usage,config,reply_quota_usage,reply_config,delete_quota_usage,delete_config,location_search_quota_usage,location_search_config`.

### Text limits
| Item | Limit |
|---|---|
| Post text | **500 characters** (emojis counted as **UTF-8 bytes**, not code points — budget accordingly) |
| Text attachments (long-form) | up to **10,000 characters** + a link |
| Links per post | **max 5** — >5 fails at container creation with `THREADS_API__LINK_LIMIT_EXCEEDED` (since 2025-12-22) |
| Topic tag | 1–50 chars; no `.` or `&` |
| Alt text | 1,000 chars |
| Link count | unique URLs in `text` + a differing `link_attachment` URL each count separately |

### Media requirements
| Type | Spec |
|---|---|
| Images | **JPEG/PNG only**. Max 8 MB. Aspect ≤ 10:1. Min width 320 (upscaled). Max 4096×4096 (scaled down); if aspect ≥2:1, scaled to ~16.8 MP. sRGB. **Max width 1440** (scaled down). |
| Video | MOV/MP4 (no edit lists, `moov` first). HEVC/H264 progressive, closed GOP, 4:2:0. 23–60 fps. Max **1920** columns (9:16 recommended). VBR ≤100 Mbps. AAC 48kHz ≤128 kbps. **Max 300 s**, **max 1 GB**. |
| Carousel | **2–20** children (mixed image/video allowed). Counts as 1 post. |
| GIF | **GIPHY only** (Tenor sunset 2026-03-31). **Text-only posts only.** |
| Link attachment | **Text-only posts only.** |
| Poll / spoiler / text attachment | Supported; reply approvals not available on ghost posts. |

Publishing is **two-step** (container → publish) with a **~30s wait** between them; validation and
content moderation happen at **container creation**, not publish.

### Messaging capabilities (the ones you asked about)
| Capability | Threads | Instagram |
|---|---|---|
| Send a DM | **Not available** | ✅ |
| DM with a **link button** | **N/A** | ✅ (button template; OpenReply already uses this) |
| **Carousel** DM | **N/A** | ✅ |
| **Video** DM | **N/A** | ✅ (video, images, PDF, audio, IG posts, stickers, templates) |
| Private reply to a commenter | **N/A** | ✅ (1 msg, 7 days) |
| Read an inbox / conversations | **N/A** | ✅ |
| Public reply to a comment | ✅ | ✅ (`POST /{comment-id}/replies`) |

### Other gaps vs. Instagram worth knowing
- **No edit endpoint** for published posts (the app allows editing text within ~15 min; the API does not).
- **No message/notification read API**, no follow/unfollow, no like API, no follower-list API.
- **No DMs, so no messaging templates, no message tags, no Human Agent tag, no messaging webhooks.**
- `media_type` collapses: `TEXT_POST` is returned for text posts, GIF posts **and** polls.
- `permalink` may be omitted for copyrighted/flagged media.
- `username` / `permalink` on replies only work for public users and your own user.
- **Webhooks are a separate sub-use case** and require app published + advanced access + verified
  business + public media owner, or you get nothing.
- Webhook delivery for Threads has had real-world reliability reports (community thread: deliveries
  stopped abruptly for all connected accounts on 2026-07-10; re-subscription did not restore it).
  Treat Threads webhooks as best-effort and keep a polling fallback.

### API versioning
- **Threads API is versioned separately**: `graph.threads.net` / `graph.threads.com` at **`v1.0`**.
  The Graph API version ladder (v21 → v27) does **not** apply to Threads. Threads has had exactly
  one version.
- The **current Graph API version is v27.0** (released 2026-11-04). **v21.0 is deprecated and is
  removed on 2027-01-21**; **v22.0 is removed on 2027-05-20**. OpenReply's Instagram calls should
  already be on v27.0 — worth confirming `META_GRAPH_API_VERSION` in `lib/env.ts`.
- Instagram Platform (`graph.instagram.com`) also versions independently of `graph.facebook.com`
  but tracks the same vN.N scheme.

**Docs:**
- https://developers.facebook.com/documentation/threads/overview
- https://developers.facebook.com/documentation/threads/posts
- https://developers.facebook.com/documentation/threads/changelog
- https://developers.facebook.com/documentation/development/graph-api/changelog
- https://developers.facebook.com/blog/post/2026/11/04/introducing-graph-api-v27-and-marketing-api-v27

---

## Recommendation for OpenReply

**Do not build Threads comment-to-DM.** It cannot work through any sanctioned API.

Three realistic options:

1. **Public Threads reply automation** (buildable today). Subscribe to the `moderate`/`replies`
   webhook → keyword match → `POST /me/threads` with `reply_to_id=<comment media id>` →
   `POST /me/threads_publish`. This is the "reply to the comment publicly" analogue, and it is a
   genuinely different product from a DM (visible in the thread). Needs `threads_basic`,
   `threads_content_publish`, `threads_manage_replies`, `threads_read_replies` + App Review.
2. **Deep link / instruction fallback** (buildable today). When a Threads commenter triggers your
   keyword, the public reply contains a link to your Instagram DM flow (ManyChat-style "DM us on
   Instagram"). This preserves the commercial outcome — comment on Threads → DM on Instagram —
   using the sanctioned Instagram API that OpenReply already has. **No Threads messaging needed.**
3. **Wait for a Threads messaging API.** If Meta ships `threads_messaging`, the work is
   substantial (separate auth, separate app ID/secret, a non-Graph webhook envelope, and an
   unknown window policy). Build option 1 or 2 now and treat Threads messaging as a future
   provider.

If you pursue option 1, plan for these deltas from the Instagram implementation:
- **New OAuth flow** — `threads.com/oauth/authorize` + `graph.threads.com/oauth/access_token`,
  separate Threads App ID/secret, separate token store. Not a new scope on the existing IG token.
- **New webhook parser** — completely different envelope (`app_id`/`topic`/`target_id`/`values`)
  from Instagram's `{object, entry, changes}`.
- **New Graph base URL** — `https://graph.threads.net/v1.0`, not `graph.instagram.com/v27.0`.
- **Different identifier semantics** — replies expose `username` only, no commenter user id. Keying
  must be by username/display name, which is not a stable unique key.
- **Different rate-limit model** — 250 posts / 1,000 replies / 24h per profile, plus an
  impressions-scaled call budget (min 10 impressions).
- **No DM, no inbox, no button templates, no follow-ups.** Any "reveal the link" multi-step
  pattern must collapse into a single public reply.
- **App Review** for `threads_content_publish` and `threads_manage_replies` at advanced access.

---

## Confidence ledger

| Claim | Confidence | Basis |
|---|---|---|
| Threads has no messaging endpoint / scope / webhook field | **High** | 6 independent official sources incl. the full docs index and a live permissions-page scrape |
| `threads_messaging` and `threads_manage_settings` do not exist | **High** | Live scrape of Permissions Reference (0 occurrences) + scope enumerations on 2 pages |
| Threads OAuth uses threads.com Authorization Window, not FB/IG Login | **High** | Get-access-tokens doc |
| Threads webhook envelope ≠ Graph `{object, entry, changes}` | **High** | Official Threads webhooks doc sample payloads |
| No `comments` field; `replies` under `moderate` is the comment equivalent | **High** | Official webhooks doc field tables |
| Instagram private reply = 1 message / 7 days / follow-up only if they reply | **High** | Official Private Replies doc |
| `reply_to_id` = media id; 2-step publish | **High** | Official Create Replies doc |
| `reply_to_id` = the specific comment's id, not the root post | **High** | Official Create Replies doc: "reply to a specific reply under the root post" — supersedes the community claim below |
| Any Threads profile connectable, no IG link required since 2025-09-23 | **High** | Official changelog |
| Graph API v27.0 current; v21.0 removed 2027-01-21 | **High** | Official Graph API changelog + v27 launch blog |
| No Threads API regional restriction | **Medium** | No restriction documented; absence-based inference, no positive statement found |
| Replies must all target the root post id (no nesting) | **Low–Medium** | Community-sourced, **not** in Meta docs |
| Threads webhook delivery reliability incidents (2026-07-10) | **Low** | Meta Developer Community forum report, not official |
