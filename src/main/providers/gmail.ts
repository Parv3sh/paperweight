import type { EmailProvider, EmailMessage, EmailConnection } from "./types";
import { loadCredentials, saveCredentials } from "../credentials";
import { buildRfc822Message, runLoopbackAuth } from "./utils";
import { analyzeMessage } from "@paperweight/analysis";
import type { AnalyzeOptions, RawMessage } from "@paperweight/analysis";
import { BODY_TEXT_MAX_LENGTH } from "@shared/config";
import { headerRecord } from "@shared/utils";
import { syncLog, authLog } from "../utils/log";
import {
  GMAIL_MAX_RETRIES,
  gmailRetryDelayMs,
  isGmailThrottleError,
  isRetryableGmailResponse,
} from "./gmail-retry";
import { mapWithConcurrency } from "./concurrency";
import { RateLimiter } from "./rate-limit";

// Injected at build time via electron-vite define.
// Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET env vars before building.
declare const __GOOGLE_CLIENT_ID__: string;
declare const __GOOGLE_CLIENT_SECRET__: string;
const CLIENT_ID = __GOOGLE_CLIENT_ID__;
const CLIENT_SECRET = __GOOGLE_CLIENT_SECRET__;

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GMAIL_API_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";

const SCOPES_MODIFY =
  "https://www.googleapis.com/auth/gmail.modify";

// Quota pacing. Google enforces a "Total Query Cost per minute per user" limit
// on the Gmail API; projects created recently get 6,000 units. Spend a little
// less than that, spread evenly, so requests are almost never rejected. The
// small burst capacity keeps a fresh sync from front-loading a minute's budget
// into its first seconds. Costs per https://developers.google.com/gmail/api/reference/quota
const GMAIL_UNITS_PER_MINUTE = 5_000;
const GMAIL_BURST_UNITS = 500;
const QUOTA_COST = {
  get: 5,
  list: 5,
  modify: 5,
  trash: 5,
  send: 100,
  history: 2,
  profile: 1,
} as const;
const gmailLimiter = new RateLimiter(GMAIL_UNITS_PER_MINUTE, GMAIL_BURST_UNITS);

// messages.get calls in flight per page. Throughput is bounded by the limiter
// (5,000 units/min = ~16 messages/s); concurrency only needs to be high enough
// that network latency isn't the bottleneck.
const GMAIL_FETCH_CONCURRENCY = 6;

// --- OAuth ---

export async function startLoopbackAuth(
  openInBrowser = true
): Promise<{ success: boolean; error?: string }> {
  if (!CLIENT_ID || !CLIENT_SECRET) {
    const missing = [!CLIENT_ID && "GOOGLE_CLIENT_ID", !CLIENT_SECRET && "GOOGLE_CLIENT_SECRET"].filter(Boolean).join(" and ");
    authLog.error(`Gmail auth aborted: ${missing} not set at build time`);
    return {
      success: false,
      error: `Missing env variables: ${missing}. See README for setup instructions.`,
    };
  }
  try {
    const scopes = SCOPES_MODIFY;
    const { code, redirectUri } = await runLoopbackAuth(
      "http://127.0.0.1",
      (redirectUri) => {
        const authUrl = new URL(GOOGLE_AUTH_URL);
        authUrl.searchParams.set("client_id", CLIENT_ID);
        authUrl.searchParams.set("redirect_uri", redirectUri);
        authUrl.searchParams.set("response_type", "code");
        authUrl.searchParams.set("scope", scopes);
        authUrl.searchParams.set("access_type", "offline");
        authUrl.searchParams.set("prompt", "consent");
        return authUrl.toString();
      },
      openInBrowser
    );

    const response = await fetch(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      return {
        success: false,
        error: `Token exchange failed (${response.status}): ${text}`,
      };
    }

    const data = await response.json();

    if (data.error) {
      return {
        success: false,
        error: `${data.error}: ${data.error_description || ""}`,
      };
    }

    if (data.access_token) {
      saveCredentials({
        providerType: "gmail",
        gmail: {
          accessToken: data.access_token,
          refreshToken: data.refresh_token || "",
          expiresAt: Date.now() + (data.expires_in || 3600) * 1000,
        },
      });
      return { success: true };
    }

    return { success: false, error: "No access token in response" };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// --- Token management ---

async function getValidAccessToken(): Promise<string> {
  const creds = loadCredentials();
  if (!creds?.gmail) throw new Error("No Gmail credentials stored");

  if (Date.now() < creds.gmail.expiresAt - 60_000) {
    return creds.gmail.accessToken;
  }

  // Refresh the token
  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: creds.gmail.refreshToken,
      grant_type: "refresh_token",
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Token refresh failed (${response.status}): ${text}`);
  }

  const data = await response.json();
  if (data.access_token) {
    creds.gmail.accessToken = data.access_token;
    creds.gmail.expiresAt = Date.now() + (data.expires_in || 3600) * 1000;
    saveCredentials(creds);
    return data.access_token;
  }

  const errDetail = data.error_description || data.error || "Unknown error";
  throw new Error(`Failed to refresh access token: ${errDetail}`);
}

// --- Gmail API helpers ---

// One request, paced by the quota limiter and covered by the retry policy from
// ./gmail-retry. Every attempt (retries included) reserves `cost` units, since
// Google charges rejected calls too. The access token is re-read on every
// attempt so a refresh that happens mid-backoff is picked up.
async function gmailRequest(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string },
  cost: number,
): Promise<unknown> {
  let attempt = 0;
  while (true) {
    await gmailLimiter.acquire(cost);
    const token = await getValidAccessToken();
    const response = await fetch(url, {
      method: init.method,
      headers: { ...init.headers, Authorization: `Bearer ${token}` },
      body: init.body,
    });

    if (response.ok) return response.json();

    const text = await response.text();
    if (
      attempt < GMAIL_MAX_RETRIES &&
      isRetryableGmailResponse(response.status, text)
    ) {
      const delay = gmailRetryDelayMs(response.headers.get("Retry-After"), attempt);
      attempt++;
      if (response.status === 429 || response.status === 403) {
        // We were throttled despite pacing: hold every in-flight worker, not
        // just this one, so the whole sync eases off together.
        gmailLimiter.penalize(delay);
      }
      syncLog.warn(
        `Gmail API ${response.status}; retrying in ${Math.round(delay / 1000)}s (attempt ${attempt}/${GMAIL_MAX_RETRIES})`,
      );
      await new Promise((r) => setTimeout(r, delay));
      continue;
    }

    throw new Error(`Gmail API error (${response.status}): ${text}`);
  }
}

async function gmailApiFetch(
  path: string,
  params?: Record<string, string | string[]>,
  cost: number = QUOTA_COST.get,
): Promise<unknown> {
  const url = new URL(`${GMAIL_API_BASE}${path}`);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (Array.isArray(v)) {
        for (const val of v) url.searchParams.append(k, val);
      } else {
        url.searchParams.set(k, v);
      }
    }
  }

  return gmailRequest(url.toString(), {}, cost);
}

async function gmailApiPost(
  path: string,
  body?: Record<string, unknown>,
  cost: number = QUOTA_COST.modify,
): Promise<unknown> {
  return gmailRequest(
    `${GMAIL_API_BASE}${path}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    },
    cost,
  );
}

// --- Profile ---

export async function fetchGmailProfileEmail(
  accessToken: string
): Promise<string | undefined> {
  try {
    const resp = await fetch(`${GMAIL_API_BASE}/profile`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      authLog.error(`Gmail profile fetch failed (${resp.status}): ${body}`);
      return undefined;
    }
    const profile = (await resp.json()) as { emailAddress?: string };
    if (!profile.emailAddress) {
      authLog.error("Gmail profile response missing emailAddress");
    }
    return profile.emailAddress;
  } catch (err) {
    authLog.error("Gmail profile fetch threw:", err instanceof Error ? err.message : String(err));
    return undefined;
  }
}

// --- Message parsing ---

function parseEmailAddress(raw: string): { name: string; email: string } {
  const match = raw.match(/^(.+?)\s*<([^>]+)>$/);
  if (match) {
    return {
      name: match[1].replace(/^["']|["']$/g, "").trim(),
      email: match[2].toLowerCase(),
    };
  }
  // Handle bare angle-bracketed address with no display name: <email@domain.com>
  const bareMatch = raw.match(/^<([^>]+)>$/);
  if (bareMatch) {
    return { name: "", email: bareMatch[1].toLowerCase() };
  }
  const emailMatch = raw.match(/[^\s<>]+@[^\s<>]+/);
  return { name: "", email: emailMatch ? emailMatch[0].toLowerCase() : raw.toLowerCase().trim() };
}

function base64UrlDecode(str: string): string {
  const padded = str.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(padded, "base64").toString("utf-8");
}

type MimePart = {
  mimeType: string;
  body?: { data?: string };
  parts?: MimePart[];
};

function extractPartByMime(parts: MimePart[], mime: string): string {
  for (const part of parts) {
    if (part.mimeType === mime && part.body?.data) {
      return base64UrlDecode(part.body.data);
    }
    if (part.parts) {
      const result = extractPartByMime(part.parts, mime);
      if (result) return result;
    }
  }
  return "";
}

interface GmailHistoryEntry {
  id: string;
  messagesDeleted?: Array<{ message: { id: string } }>;
  // A message gaining the TRASH/SPAM label is a removal from our all-mail scope.
  labelsAdded?: Array<{ message: { id: string }; labelIds?: string[] }>;
}

interface GmailHistoryResponse {
  history?: GmailHistoryEntry[];
  historyId: string;
  nextPageToken?: string;
}

interface GmailRawMessage {
  id: string;
  snippet: string;
  internalDate: string;
  sizeEstimate?: number;
  payload: {
    headers: Array<{ name: string; value: string }>;
    mimeType: string;
    body?: { data?: string };
    parts?: MimePart[];
  };
}

async function parseGmailMessage(
  msg: GmailRawMessage,
  analysisOptions?: AnalyzeOptions,
): Promise<EmailMessage> {
  const headers = msg.payload.headers;
  const getHeader = (name: string): string =>
    headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ||
    "";

  const fromRaw = getHeader("From");
  const { name: senderName, email: senderEmail } = parseEmailAddress(fromRaw);

  let bodyText = "";
  let bodyHtml = "";
  if (msg.payload.parts) {
    bodyText = extractPartByMime(msg.payload.parts, "text/plain");
    bodyHtml = extractPartByMime(msg.payload.parts, "text/html");
  } else if (msg.payload.body?.data) {
    const decoded = base64UrlDecode(msg.payload.body.data);
    if (msg.payload.mimeType === "text/html") {
      bodyHtml = decoded;
    } else {
      bodyText = decoded;
    }
  }

  // Lossless: ordered [name, value] pairs, duplicates preserved. The same pairs
  // feed the engine, so stored headers and analyzed headers can't diverge.
  const pairs = headers.map((h): [string, string] => [h.name, h.value]);
  const raw: RawMessage = { headers: headerRecord(pairs) };
  if (bodyText) raw.text = bodyText;
  if (bodyHtml) raw.html = bodyHtml;
  const analysis = await analyzeMessage(raw, {
    ...analysisOptions,
    maxTextLength: BODY_TEXT_MAX_LENGTH,
  });

  const internalDate = parseInt(msg.internalDate, 10);
  const date = !isNaN(internalDate)
    ? internalDate
    : (() => {
      const t = new Date(getHeader("Date")).getTime();
      return !isNaN(t) && t > 946684800000 ? t : Date.now();
    })();

  return {
    id: msg.id,
    date,
    subject: getHeader("Subject"),
    snippet: msg.snippet,
    senderEmail,
    senderName,
    headersJson: JSON.stringify(pairs),
    sizeBytes: msg.sizeEstimate ?? 0,
    analysis,
    bodyTruncated: analysis.textTruncated || undefined,
  };
}

// --- Provider ---

export function createGmailProvider(
  analysisOptions?: AnalyzeOptions,
): EmailProvider {
  return {
    type: "gmail",

    async connect(): Promise<EmailConnection> {
      const token = await getValidAccessToken();
      const email = await fetchGmailProfileEmail(token);

      return {
        type: "gmail-oauth",
        email: email || "",
      };
    },

    isAuthenticated(): boolean {
      const creds = loadCredentials();
      return !!creds?.gmail?.accessToken;
    },

    async getMessageCount(since: Date, until?: Date): Promise<number | undefined> {
      try {
        // Use messages.list with maxResults=1 to get resultSizeEstimate
        // for the same query scope the sync will use (excludes spam/trash).
        // Profile's messagesTotal includes spam/trash so it overestimates.
        const afterEpoch = Math.floor(since.getTime() / 1000);
        const params: Record<string, string> = { maxResults: "1" };
        const qParts: string[] = [];
        if (afterEpoch > 0) qParts.push(`after:${afterEpoch}`);
        if (until) qParts.push(`before:${Math.floor(until.getTime() / 1000)}`);
        if (qParts.length > 0) params.q = qParts.join(" ");
        const result = (await gmailApiFetch("/messages", params)) as {
          resultSizeEstimate?: number;
        };
        return result.resultSizeEstimate;
      } catch {
        return undefined;
      }
    },

    async listMessages(
      since: Date,
      until?: Date,
      pageToken?: string,
      onProgress?: (fetched: number, estimatedTotal?: number) => void
    ): Promise<{ messages: EmailMessage[]; nextPageToken?: string }> {
      const afterEpoch = Math.floor(since.getTime() / 1000);

      const params: Record<string, string> = {
        maxResults: "50",
      };
      // Build date-range query. after:0 is unreliable so only add when non-zero.
      const qParts: string[] = [];
      if (afterEpoch > 0) qParts.push(`after:${afterEpoch}`);
      if (until) qParts.push(`before:${Math.floor(until.getTime() / 1000)}`);
      if (qParts.length > 0) params.q = qParts.join(" ");
      if (pageToken) {
        params.pageToken = pageToken;
      }

      const listResult = (await gmailApiFetch("/messages", params)) as {
        messages?: Array<{ id: string }>;
        nextPageToken?: string;
        resultSizeEstimate?: number;
      };

      if (!listResult.messages || listResult.messages.length === 0) {
        return { messages: [] };
      }

      const estimatedTotal = listResult.resultSizeEstimate;
      let fetched = 0;

      // A message that fails for its own reasons (deleted mid-sync, malformed)
      // is logged and skipped. A throttle that outlived the retries is not: it
      // fails the page so the caller leaves its page token in place and the
      // next refresh fetches the same page again, instead of silently losing
      // messages from the inventory.
      const fetchedMessages = await mapWithConcurrency(
        listResult.messages,
        GMAIL_FETCH_CONCURRENCY,
        async (msgRef): Promise<EmailMessage | undefined> => {
          try {
            const msg = (await gmailApiFetch(`/messages/${msgRef.id}`, {
              format: "full",
            })) as GmailRawMessage;
            const parsed = await parseGmailMessage(msg, analysisOptions);
            fetched++;
            onProgress?.(fetched, estimatedTotal);
            return parsed;
          } catch (err) {
            if (isGmailThrottleError(err)) throw err;
            syncLog.error(`Failed to fetch message ${msgRef.id}:`, err instanceof Error ? err.message : String(err));
            return undefined;
          }
        },
      );

      return {
        messages: fetchedMessages.filter((m): m is EmailMessage => m !== undefined),
        nextPageToken: listResult.nextPageToken,
      };
    },

    async getMessage(messageId: string): Promise<EmailMessage> {
      const msg = (await gmailApiFetch(`/messages/${messageId}`, {
        format: "full",
      })) as GmailRawMessage;

      return await parseGmailMessage(msg, analysisOptions);
    },

    async trashMessage(messageId: string): Promise<void> {
      await gmailApiPost(`/messages/${messageId}/trash`);
    },

    async markAsSpam(messageId: string): Promise<void> {
      await gmailApiPost(`/messages/${messageId}/modify`, {
        addLabelIds: ["SPAM"],
        removeLabelIds: ["INBOX"],
      });
    },

    async markAsRead(messageId: string, isRead: boolean): Promise<void> {
      if (isRead) {
        await gmailApiPost(`/messages/${messageId}/modify`, {
          removeLabelIds: ["UNREAD"],
        });
      } else {
        await gmailApiPost(`/messages/${messageId}/modify`, {
          addLabelIds: ["UNREAD"],
        });
      }
    },

    async sendEmail(to: string, subject: string, body: string, inReplyTo?: string): Promise<string | undefined> {
      const token = await getValidAccessToken();
      const from = await fetchGmailProfileEmail(token);
      // Gmail rejects messages with an empty From; fail loudly so the renderer
      // gets a clear error instead of a confusing "header invalid" from the API.
      if (!from) throw new Error("Could not resolve sender address from Gmail profile");
      const raw = buildRfc822Message(from, to, subject, body, inReplyTo);
      const encoded = Buffer.from(raw, "utf-8").toString("base64url");
      const sent = (await gmailApiPost("/messages/send", { raw: encoded }, QUOTA_COST.send)) as { id?: string };
      // Read the Message-ID back from the sent message — Gmail assigns it
      // server-side, so what we sent is not what went out.
      if (!sent?.id) return undefined;
      try {
        const meta = (await gmailApiFetch(`/messages/${sent.id}`, {
          format: "metadata",
          metadataHeaders: "Message-ID",
        })) as { payload?: { headers?: Array<{ name: string; value: string }> } };
        return meta.payload?.headers?.find((h) => h.name.toLowerCase() === "message-id")?.value;
      } catch {
        return undefined;
      }
    },

    // --- Removal tracking (History API) ---
    // historyId is a mailbox-wide version cursor (not a date), so removals of messages of
    // any age are reported, as long as the cursor is within Gmail's retention (~1 week of
    // inactivity → 404 → re-baseline). Adds come from the date-range listMessages() path,
    // so this consumes removals only: permanent deletions and TRASH/SPAM label additions.

    async getRemovalCursor(): Promise<string | undefined> {
      try {
        const profile = (await gmailApiFetch("/profile", undefined, QUOTA_COST.profile)) as { historyId?: string };
        return profile.historyId;
      } catch {
        return undefined;
      }
    },

    async listRemovals(cursor: string): Promise<{
      removedIds: string[];
      nextCursor: string;
    } | null> {
      const removedIds = new Set<string>();
      let pageToken: string | undefined;
      let nextCursor = cursor;

      try {
        // eslint-disable-next-line no-constant-condition
        while (true) {
          // No labelId filter → all-mail (matches the add path's scope).
          const params: Record<string, string> = { startHistoryId: cursor };
          if (pageToken) params.pageToken = pageToken;

          const result = (await gmailApiFetch("/history", params, QUOTA_COST.history)) as GmailHistoryResponse;

          // Always update to the latest historyId returned, even if history array is empty
          nextCursor = result.historyId;

          // Adds come from the date-range path, so collect removals only: permanent
          // deletions and messages that gained the TRASH or SPAM label.
          for (const entry of result.history ?? []) {
            for (const item of entry.messagesDeleted ?? []) {
              removedIds.add(item.message.id);
            }
            for (const item of entry.labelsAdded ?? []) {
              if (item.labelIds?.some((l) => l === "TRASH" || l === "SPAM")) {
                removedIds.add(item.message.id);
              }
            }
          }

          if (result.nextPageToken) {
            pageToken = result.nextPageToken;
          } else {
            break;
          }
        }
      } catch (err) {
        // Gmail returns 404 when the historyId is too old (typically > 7 days of inactivity)
        if (err instanceof Error && err.message.includes("404")) return null;
        throw err;
      }

      return { removedIds: Array.from(removedIds), nextCursor };
    },

    async disconnect(): Promise<void> {
      // Nothing to clean up for Gmail API
    },
  };
}
