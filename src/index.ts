interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * WORDING IS LOAD-BEARING, same rule as labelAge's note in authority.ts. This
 * string is appended to a pack's thrown Error message (shared/src/http.ts),
 * and a thrown Error's message is exactly what the gateway hands back to the
 * caller as `content[0].text` when nothing rewrites it (workers/gateway/src
 * catches the throw and sets `rawResult.message = stripClassPrefix(error)`,
 * which does not touch this suffix) — so the original wording,
 * " [pipeworx-hosted origin — our own service, not a third party]", was not a
 * theoretical leak: it shipped live on pipeworx-catalog's 522s, 7 times in 6
 * hours on 2026-09-02 (see tests/golden-internal-service.test.ts), verbatim
 * naming Pipeworx as the host. check:hosting-claims never caught it because it
 * did not scan shared/ at all (task #2009). Reworded to describe the
 * OBSERVATION (the origin did not answer) without a claim about who runs it —
 * the identical fix labelAge got: drop the possessive, keep the fact.
 */
const INTERNAL_ORIGIN_MARKER = ' [origin did not respond — retry before concluding the named source is down]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * `workers/gateway/src/provenance.ts`'s `OUR_HOSTS` answers the same
 * question and DOES include `workers.dev` — a documented divergence
 * (task #2051), not a bug to converge. That list decides what a response may
 * cite as a data SOURCE, where a false negative (citing our own worker as an
 * external source) is the hosting-disclosure leak this whole file exists to
 * prevent, so it errs broad. This one decides who gets BLAMED for a 5xx in
 * outage metrics read by on-call, where a false positive (crediting our own
 * infra with a third party's outage) hides the real failure, so it errs
 * narrow. Same suffix, opposite direction, because they are never called for
 * the same reason.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}


/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}`,
    res.url,
    res.status,
  );
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    throw err;
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}
/**
 * Pipeworx Catalog MCP — Exposes the full Pipeworx platform to Claude
 *
 * Provides live access to all available packs, tools, connection configs,
 * platform status, and the MCP directory. Updated daily as new packs
 * are added. Load this in every Claude session so I always know what's
 * available on Pipeworx.
 */


// Bound the fetch() calls in this pack that pass no signal of their own — a
// file with one guarded call still reads as "guarded" to the file-level grep
// while its other call sites hang unbounded (fleet #685).
async function pwFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  return fetchWithTimeout(url, init ?? {}, 'Pipeworx Catalog');
}

const GATEWAY = 'https://gateway.pipeworx.io';
const REGISTRY = 'https://registry.pipeworx.io';

async function fetchJson(url: string): Promise<unknown> {
  const res = await pwFetch(url);
  // Hand-built like the fleet pack's, so stamped here for the same reason
  // (fleet #1096): every URL this function is given is registry.pipeworx.io,
  // so a 5xx here is our own service, never a third party.
  if (!res.ok) throw new Error(markInternalOrigin(`HTTP ${res.status} from ${url}`, url, res.status));
  return res.json();
}

async function postJsonRpc(url: string, method: string, params?: Record<string, unknown>): Promise<unknown> {
  const res = await pwFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (!res.ok) throw await httpError(res, 'Pipeworx catalog error');
  const data = (await res.json()) as { result?: unknown; error?: { message: string } };
  if (data.error) throw new Error(data.error.message);
  return data.result;
}

const tools: McpToolExport['tools'] = [
  {
    name: 'list_packs',
    description: 'Browse all available Pipeworx packs. Returns pack names, categories, tool counts, and gateway URLs. Use to discover data sources or explore what\'s available.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        category: { type: 'string', description: 'Free-text filter matched against pack slugs, descriptions, and tool names/descriptions — not a fixed taxonomy (e.g. "weather", "pesticide", "sec filings"). Omit to list everything.' },
      },
      required: [],
    },
  },
  {
    name: 'get_pack_tools',
    description: 'Get tool definitions for a specific pack (e.g., \'weather\', \'polygon-io\'). Returns tool names, descriptions, parameters, and requirements. Use before calling a tool to verify its interface.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        slug: { type: 'string', description: 'Pack slug (e.g., weather, pokemon, github)' },
      },
      required: ['slug'],
    },
  },
  {
    name: 'get_connection_config',
    description: 'Get MCP setup instructions for connecting to Pipeworx packs. Returns connection details and gateway URLs. Use to configure your environment.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        slugs: { type: 'string', description: 'Comma-separated pack slugs (e.g., "weather,github,jokes") or "all" for everything' },
      },
      required: ['slugs'],
    },
  },
  {
    name: 'search_packs',
    description: 'Search Pipeworx packs by keyword or a plain question across pack names, descriptions and tool descriptions (e.g. "weather", "translate", "Colombia procurement contracts awarded to a supplier"). Returns matching packs ranked best-first with each one\'s matched terms, cost, auth and reliability. Use to find which pack covers a capability before connecting to it; question filler and proper names are ignored, so the subject words are what match.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Keywords or a question naming the data you want. The subject words match (country, system, dataset, topic); names of specific companies or people do not, since no pack describes them.' },
        limit: { type: 'number', description: 'Maximum packs to return, best match first (1-200, default 25).' },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_platform_status',
    description: 'Check Pipeworx platform health and availability. Returns pack count, active tool count, and any service alerts. Use to verify system status before operations.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  {
    name: 'search_mcp_directory',
    description: 'Search thousands of MCP servers by use case (e.g., \'database\', \'email\', \'calendar\'). Returns community and hosted servers. Use to find tools beyond Pipeworx.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Search query' },
        category: { type: 'string', description: 'Filter by category' },
        limit: { type: 'number', description: 'Max results (default 10)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'data_freshness',
    description:
      'MEASURES publication lag for a curated set of high-value live-data sources — how fresh is this data, how old is this number, is this feed real-time, what\'s the data staleness on X. Every entry is PROBED LIVE against its upstream (not read from a hardcoded table): fetches the newest available datapoint right now and reports the observed lag between that datapoint and this moment. Use before pricing or settling off a number ("can I trust this PortWatch chokepoint count as current", "how stale is Polymarket vs Kalshi order flow", "when did BLS last publish CPI"). Covers maritime chokepoint traffic (IMF PortWatch), vessel AIS positions (Digitraffic), prediction-market trade tape (Polymarket, Kalshi), global news event ingestion (GDELT), and US CPI (BLS) — pass `source` (forgiving match, e.g. "portwatch", "digitraffic ais", "polymarket", "kalshi", "gdelt", "cpi") or `category` ("maritime", "markets", "news", "economics") to scope the probe, or omit both to probe every curated source. Lag is measured at call time and can vary between calls — this tool never reports a lag it did not just observe.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        source: { type: 'string', description: 'Forgiving name match against one curated source, e.g. "portwatch", "polymarket", "kalshi", "digitraffic", "gdelt", "cpi". Omit to probe everything.' },
        category: { type: 'string', description: 'Filter to one category: maritime | markets | news | economics. Omit to probe everything.' },
        _blsKey: { type: 'string', description: 'BLS registration key (gateway-injected; raises the keyless 25/day-per-IP cap that made the CPI probe intermittently unmeasurable).' },
      },
      required: [],
    },
  },
];

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'list_packs':
      return listPacks(args.category as string | undefined, args._packCatalogManifest as CatalogPackEntry[] | undefined);
    case 'get_pack_tools':
      return getPackTools(args.slug as string, args._packToolsManifest as PackToolsManifest | undefined, args._packCatalogManifest as CatalogPackEntry[] | undefined);
    case 'get_connection_config':
      return getConnectionConfig(args.slugs as string);
    case 'search_packs':
      return searchPacks(
        args.query as string,
        args._packCatalogManifest as CatalogPackEntry[] | undefined,
        args.limit as number | undefined,
        args._surface as string | undefined,
        args._origin as string | undefined,
      );
    case 'get_platform_status':
      return getPlatformStatus(args._platformTotals as { pack_count: number; tool_count: number } | undefined);
    case 'search_mcp_directory':
      return searchDirectory(args.query as string, args.category as string | undefined, (args.limit as number) ?? 10);
    case 'data_freshness':
      return dataFreshness(args.source as string | undefined, args.category as string | undefined, args._blsKey as string | undefined, args._supabaseUrl as string | undefined, args._supabaseKey as string | undefined);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// The pack-level catalog list_packs/search_packs browse. Slug + a synthesized
// one-line description (the pack's flagship tool's opening sentence — same
// PACK_DOMAIN_HINT the gateway uses to lift weak tool descriptions at
// embedding time) + every tool's name/description, so a keyword search has
// real text to match against instead of a hand-curated blurb.
// `kind: 'bundle'` entries (fleet #441) are scoped vertical connections the
// gateway appends to the manifest — a job-level surface ("sales prospecting")
// no single source pack describes. They carry their own `url` (a ?vertical=
// connection, not /{slug}/mcp) and a display `name` (slugs like "gtm" don't
// humanize well).
// Exported for tests/catalog-search-ranking.test.ts: the ranking rules are the
// product here (fleet #1200) and a source-text assertion cannot exercise them.
export type CatalogPackEntry = {
  slug: string;
  description: string;
  tool_count: number;
  tools: Array<{ name: string; description: string }>;
  name?: string;
  kind?: 'bundle';
  url?: string;
  // Pre-call disclosure (fleet #489), attached by the gateway when it injects
  // the manifest: what a call costs at the caller's plan rate, whether it needs
  // a key, and what we have actually MEASURED about the pack. Passed through
  // opaquely — this pack must not invent, default or reshape any of it, and in
  // particular an absent `reliability` stays absent rather than becoming a
  // score. Undefined when this pack runs standalone (the HTTP fallback below),
  // where these facts are not available.
  cost?: unknown;
  auth?: unknown;
  reliability?: unknown;
};

// Fleet task #145: list_packs/search_packs used to read a Supabase
// `api_registry` table that was hand-seeded at launch (~199 rows) and never
// kept in sync with the packs actually shipped (~1,290 and counting) — a
// pack could be live and callable for months and still be invisible to
// browsing. The gateway now injects `_packCatalogManifest`, built in-process
// from the same MCP_PACKS data every other advertised count comes from, so
// this can never drift again. The GATEWAY/tools HTTP fetch below is only a
// fallback for when this pack runs standalone (outside the gateway process,
// e.g. the published npm package) — same underlying data, just over HTTP.
async function fetchLiveCatalog(): Promise<CatalogPackEntry[]> {
  const data = (await fetchJson(`${GATEWAY}/tools`)) as {
    packs: Array<{ slug: string; tool_count: number; tools: Array<{ name: string; description: string }> }>;
  };
  return data.packs
    .filter((p) => p.slug !== 'fleet') // internal-only pack, kept out of the browsable catalog
    .map((p) => {
      let longest = '';
      for (const t of p.tools) {
        if ((t.description ?? '').length > longest.length) longest = t.description ?? '';
      }
      const firstSentence = (longest.split(/(?<=[.!?])\s/)[0] ?? longest).slice(0, 120);
      return { slug: p.slug, description: firstSentence, tool_count: p.tool_count, tools: p.tools };
    });
}

function humanizeSlug(slug: string): string {
  return slug
    .split(/[-_]/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function packHaystack(p: CatalogPackEntry): string {
  // `description` is the pack's CURATED blurb (fleet #1200) — the text the
  // catalog page actually publishes. It used to be a truncated slice of the
  // longest tool description, so a phrase printed on the pack's own page could
  // be unfindable here. `name` joins it because "Bank of England" is how a
  // caller names boe-uk and the slug spells it neither way.
  return `${p.slug} ${p.name ?? ''} ${p.description} ${p.tools
    .map((t) => `${t.name} ${t.description}`)
    .join(' ')}`.toLowerCase();
}

// Multi-word queries ("pesticide residue limits food") rarely appear verbatim
// in a pack's own wording (which might say "maximum residue limits" for the
// same concept) — an exact-phrase-only match sent a real query in the wild
// (fleet #145) back with 0 results even though codex-mrl/jecfa plainly cover
// it. Try the exact phrase first (best precision); otherwise require most of
// the query's significant words to appear (not just one) — matching on any
// single word let generic terms like "food" pull in irrelevant packs
// (emojihub, kroger) ahead of the packs that actually cover the topic.
//
// "Most of the words" has to mean the words that could ever match (fleet
// #1175). A caller typed a whole question — "Which public contracts has the
// supplier Constructora Conconcreto been awarded recently in Colombia SECOP
// procurement system" — and got ZERO packs, 14 times in 48h, while
// colombia_search_contracts answered it. Fifteen tokens made the bar 9; five
// were question filler ("which", "has", "been", "the", "recently") that no
// pack description contains, and two were a supplier's name that no catalog
// could contain, so the one pack that says "Colombian", "SECOP II",
// "supplier", "awarded" and "procurement" scored 7 and lost. Two changes:
// filler is dropped before counting, and the bar is set over the tokens that
// appear SOMEWHERE in the catalog, so a proper noun nobody describes cannot
// count against every pack. Matches are then RANKED — a token in the slug
// itself ("colombia", "secop") outweighs one buried in a tool description —
// so a lenient bar does not push the right pack below the generic ones.
const CATALOG_STOP_WORDS = new Set([
  // question shape
  'what', 'which', 'who', 'whom', 'whose', 'where', 'when', 'why', 'how',
  'does', 'did', 'has', 'have', 'had', 'been', 'being', 'are', 'was', 'were',
  'can', 'could', 'would', 'should', 'will', 'shall', 'may', 'might', 'must',
  // function words
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'these', 'those', 'into',
  'about', 'than', 'then', 'there', 'their', 'they', 'them', 'its', 'our', 'your',
  'any', 'all', 'some', 'each', 'every', 'per', 'via', 'using', 'across', 'within',
  'not', 'but', 'also', 'both', 'either', 'more', 'most', 'many', 'much', 'very',
  // request verbs — "find me", "show", "list", "give me" say nothing about the data
  'find', 'show', 'list', 'give', 'get', 'tell', 'look', 'lookup', 'search', 'please',
  'need', 'want', 'like', 'know', 'see', 'check', 'fetch', 'pull', 'retrieve',
  // temporal filler — every live-data pack is "recent"
  'recent', 'recently', 'latest', 'current', 'currently', 'today', 'now', 'new',
  // Two-letter function words. These only became reachable when the minimum
  // token length dropped from 3 to 2 (below); before that every two-letter
  // token was discarded, filler and country alike.
  //
  // Several of these are also ISO country codes — 'in' India, 'it' Italy,
  // 'at' Austria, 'is' Iceland, 'no' Norway, 'be' Belgium, 'so' Somalia. We
  // take the function-word reading, because in an English query they are that
  // far more often, and because a caller after Italian data writes "Italy",
  // which pack text spells out. The codes we deliberately KEEP searchable are
  // the ones that are not English words: uk, us, eu, un, gb, ie, nz, za, ai.
  'of', 'to', 'on', 'at', 'by', 'as', 'or', 'an', 'is', 'it', 'in', 'be', 'do',
  'no', 'so', 'up', 'we', 'me', 'my', 'he', 'if', 'am',
]);

// Two chars, not three (fleet #1200). The floor was 3, which silently deleted
// "UK" — and "US", "EU", "UN" — from every query that named a country that
// way. search_packs("UK government publications and policies") was therefore
// executed as "government publications policies", a query with no country in
// it at all, and it duly returned Dutch and international procurement packs.
// The most discriminating token in a country-plus-topic query was the one
// token guaranteed to be thrown away.
const CATALOG_MIN_TOKEN = 2;

function catalogQueryTokens(needle: string): string[] {
  return Array.from(
    new Set(
      needle
        .split(/[^a-z0-9]+/)
        .filter((t) => t.length >= CATALOG_MIN_TOKEN && !CATALOG_STOP_WORDS.has(t)),
    ),
  );
}

// Longer tokens match as substrings, which is what lets "publication" find
// "publications" and has been the behaviour for every token the ranker has
// ever seen. A two-letter token cannot afford that: bare `includes('uk')`
// hits "sukuk", "bukkit" and every "Luke" in the catalog, and would hand a
// country query a pile of packs that merely contain those letters. So tokens
// admitted by the lowered floor — and ONLY those — must match on a word
// boundary. Existing 3+-char behaviour is untouched on purpose: this change
// adds tokens, it does not re-interpret the ones already in use.
function catalogTokenMatcher(token: string): (text: string) => boolean {
  if (token.length > CATALOG_MIN_TOKEN) return (text) => text.includes(token);
  // Tokens are [a-z0-9]+ by construction (catalogQueryTokens splits on
  // everything else), so there is nothing to escape here.
  const re = new RegExp(`(?:^|[^a-z0-9])${token}(?:[^a-z0-9]|$)`);
  return (text) => re.test(text);
}

type CatalogHit = { entry: CatalogPackEntry; score: number; matched: string[] };

// How the bar is computed. The defaults ARE production; the knobs exist so
// scripts/catalog-search-bar-cost.test.ts can price the alternatives against
// the same corpus in the same run, instead of pricing a reimplementation of
// them (fleet #1203 — the #1200 numbers it had to beat were measured against a
// query set nobody committed, so they could not be reproduced, only quoted).
export type CatalogBarPolicy = {
  /** Share of the known tokens a pack must carry. */
  fraction?: number;
  /** Whether a token matched in the pack's own slug/name counts double. */
  selfNaming?: boolean;
  /**
   * Only tokens this rare — as a share of the catalog — earn the self-naming
   * credit. 0 disables the gate (every self-named token counts double).
   */
  selfNamingMaxDf?: number;
};

// A token the pack matches IN ITS OWN SLUG OR NAME counts double toward the
// bar (fleet #1203). Two live misses, both of the same shape:
//
//   search_packs("Japan official statistics portal") -> 0 results.
//     estat-japan carries japan + statistics, and loses on "official" and
//     "portal" — words for what a data source IS, which a pack blurb has no
//     reason to spend words on.
//   search_packs("UK central bank interest rates and monetary statistics")
//     -> 11 packs, and boe-uk is not among them. It is beaten by the central
//     banks of Germany, Norway, Peru, Mexico, Japan, the EU, Korea, Hong Kong,
//     Australia, South Africa and Switzerland — every one of them the WRONG
//     COUNTRY, each matching six generic finance words while matching nothing
//     that says which country. boe-uk matches "uk" and is the only one that
//     does. The pack IS the UK central bank; the phrase "central bank" appears
//     nowhere in its text because it calls itself the Bank of England.
//
// The obvious direction was document frequency — a token in 400 packs should
// not cost what a token in 3 does — and it was measured and DOES NOT WORK.
// "portal" occurs in 30 of 1,502 packs (2%), so every df scheme reads it as
// rare and therefore discriminating, and raises its weight; it is nonetheless
// pure source-vocabulary that separates nothing. Rarity in the catalog is not
// aboutness, and the first case fails under IDF exactly as it does today.
//
// What the two misses have in common is not frequency, it is WHERE the match
// lands. Both packs name the thing the caller asked for in their own slug —
// `estat-japan`, `boe-uk` — while the packs that beat them match only in tool
// prose. The ranker already believes this: `slugHits` has been worth more than
// a body match since #1175, on the reasoning that a slug hit is "the pack
// naming the thing itself". That belief was only ever spent on ORDERING the
// survivors, so it could not save a pack the bar had already cut. This
// extends the signal the ranker already trusts to the bar that runs first.
//
// Deliberately NOT a lower bar: #1200 priced 0.6->0.5 and 0.6->0.4 and both
// buy recall by admitting every pack that matches a few generic words. This
// admits only packs that match the query IN THEIR OWN NAME, which is why it
// costs a fraction of what those did — see the numbers in
// tests/catalog-search-bar-cost.test.ts.
//
// Document frequency DOES have a job here, just not the one #1203 proposed.
// It cannot decide the bar (see above), but it can decide which self-named
// tokens are worth crediting: "uk" in `boe-uk` names the pack, while "bank" in
// `bundesbank-de` is a word 61 packs carry and credits half the catalog's
// finance section for saying nothing. Gating the credit at 3% of the corpus
// keeps the country and the institution and drops the category noun — which is
// what makes this cost 1.4x instead of 2.1x for the same recall.
const CATALOG_SELF_NAMING_MIN_DF = 3;

const CATALOG_BAR_DEFAULTS: Required<CatalogBarPolicy> = {
  fraction: 0.6,
  selfNaming: true,
  selfNamingMaxDf: 0.03,
};

// Ranked search over the catalog. Empty query → every pack, unranked. The bar
// (how many query tokens a pack must contain) is computed over the tokens that
// occur in at least one pack; a query whose tokens occur nowhere yields no hits.
export function rankCatalog(packs: CatalogPackEntry[], q: string, policy?: CatalogBarPolicy): CatalogHit[] {
  const needle = q.toLowerCase().trim();
  if (!needle) return packs.map((entry) => ({ entry, score: 0, matched: [] }));
  const bar = { ...CATALOG_BAR_DEFAULTS, ...policy };
  // `self` is what the pack calls ITSELF — its slug and its catalog name. The
  // name belongs here as much as the slug: boe-uk answers to "Bank of England"
  // and gov-uk-content to "GOV.UK", and a caller naming either has named the
  // pack, not merely touched one word of its prose.
  const hays = packs.map((entry) => ({
    entry,
    hay: packHaystack(entry),
    slug: entry.slug.toLowerCase(),
    self: `${entry.slug} ${entry.name ?? ''}`.toLowerCase(),
  }));
  // One matcher per token, built once: rankCatalog runs over ~1,450 packs and
  // compiling a RegExp per pack per token would be ~1,450x the work.
  const tokens = catalogQueryTokens(needle).map((token) => ({ token, test: catalogTokenMatcher(token) }));
  // One pass for document frequency. `known` is just df > 0 — the same filter
  // as before — but the self-naming gate needs the count itself, not its sign.
  const df = new Map<string, number>();
  for (const t of tokens) {
    let n = 0;
    for (const h of hays) if (t.test(h.hay)) n += 1;
    df.set(t.token, n);
  }
  const known = tokens.filter((t) => (df.get(t.token) ?? 0) > 0);
  // The gate is a SHARE of the catalog, so on a small corpus it collapses:
  // 3% of twelve packs is 0.36, every real token has df >= 1, and the credit
  // silently never applies — the rule would mean one thing in production and
  // the opposite in a fixture or in matchesCatalogQuery's corpus of one. The
  // floor keeps "a token in three packs is rare" true at every corpus size.
  const dfCap = bar.selfNamingMaxDf > 0
    ? Math.max(CATALOG_SELF_NAMING_MIN_DF, bar.selfNamingMaxDf * hays.length)
    : Infinity;
  const creditable = new Set(known.filter((t) => (df.get(t.token) ?? 0) <= dfCap).map((t) => t.token));
  const required = known.length <= 2 ? known.length : Math.max(2, Math.ceil(known.length * bar.fraction));
  const hits: CatalogHit[] = [];
  for (const h of hays) {
    const phrase = h.hay.includes(needle);
    const matched = known.filter((t) => t.test(h.hay));
    // Credit, not exemption: a self-named token counts twice toward the bar,
    // so a pack still has to carry real coverage of the query. boe-uk clears a
    // bar of 5 on "UK central bank interest rates and monetary statistics"
    // with four matched tokens because one of them is the country in its slug;
    // a pack whose only tie to the query is its own name still fails.
    const selfNamed = bar.selfNaming
      ? matched.filter((t) => creditable.has(t.token) && t.test(h.self)).length
      : 0;
    if (!phrase && (known.length === 0 || matched.length + selfNamed < required)) continue;
    const slugHits = matched.filter((t) => t.test(h.slug)).length;
    // Exact phrase dominates; then breadth of coverage; a slug hit is the
    // pack naming the thing itself, worth more than a mention in one tool.
    const score = (phrase ? 100 : 0) + matched.length * 10 + slugHits * 15;
    hits.push({ entry: h.entry, score, matched: matched.map((t) => t.token) });
  }
  hits.sort((a, b) => b.score - a.score || a.entry.slug.localeCompare(b.entry.slug));
  return hits;
}

function matchesCatalogQuery(p: CatalogPackEntry, q: string): boolean {
  // Document frequency over a corpus of one is not a frequency. It needs no
  // special case here only because CATALOG_SELF_NAMING_MIN_DF floors the gate:
  // without that floor this would quietly apply a stricter rule than the
  // search it is supposed to agree with.
  return rankCatalog([p], q).length > 0;
}

// ── Naming a tool, not just a pack (fleet #2252) ─────────────────────────
//
// search_packs returned slug, description, cost, auth and reliability — and NO
// TOOL NAME. Meanwhile the gateway's llms.txt, the 404 body for an unknown
// tool, and ~1,312 pack READMEs all say "Find one: POST /v1/tools/search_packs"
// and then expect the caller to POST /v1/tools/<tool>. Getting from the slug
// `fred` to `fred_get_series` meant discovering get_pack_tools unaided — a
// fourth request nobody documents, on the path we advertise most.
//
// HOW THE TOOLS ARE PICKED: the same token matcher that ranked the PACK, run
// over each tool's own name + description. Deliberately NOT an embedding call
// — /tools?q= pays for one of those, and search_packs must stay cheap enough
// to be the first thing an agent does. It only ever runs over the packs
// already being returned (<= `limit`, default 25), never the whole catalog.
// A tool matching more of the query's tokens sorts first; ties keep the pack's
// own declared order, so a pack whose tools all match equally hands back its
// flagship endpoints rather than an arbitrary shuffle.
const TOOLS_PER_PACK = 3;
/** Long enough to say what the tool does, short enough that 3x25 stays small. */
const TOOL_SUMMARY_CHARS = 110;

function summarizeTool(description: string): string {
  const s = (description || '').replace(/\s+/g, ' ').trim();
  if (s.length <= TOOL_SUMMARY_CHARS) return s;
  return `${s.slice(0, TOOL_SUMMARY_CHARS - 1).trimEnd()}…`;
}

function bestToolsFor(p: CatalogPackEntry, query: string) {
  const tokens = catalogQueryTokens(query.toLowerCase());
  const matchers = tokens.map((t) => catalogTokenMatcher(t));
  const scored = p.tools.map((t, i) => {
    const hay = `${t.name} ${t.description || ''}`.toLowerCase();
    let score = 0;
    for (const m of matchers) if (m(hay)) score += 1;
    return { t, i, score };
  });
  scored.sort((a, b) => (b.score - a.score) || (a.i - b.i));
  return scored.slice(0, TOOLS_PER_PACK).map(({ t }) => ({
    name: t.name,
    summary: summarizeTool(t.description),
  }));
}

/**
 * The next request to make, in the shape of the surface this call arrived on.
 *
 * `rest` gets the unmetered inspect-then-call pair on /v1/tools/<name>; an MCP
 * caller gets tools/call, because /v1/tools is not where it lives. Anything
 * else falls back to the REST form, which is the one a stranger reading a
 * README will have.
 */
function nextStepFor(name: string, surface: string | undefined, origin: string) {
  if (surface === 'mcp') {
    return `MCP tools/call {"name":"${name}","arguments":{…}} on this same connection. tools/list carries its inputSchema and examples.`;
  }
  return `GET ${origin}/v1/tools/${name} for its schema and a worked example (unmetered), then POST the same URL with the arguments to get data.`;
}

// Shared output shape for list_packs/search_packs. Bundle entries surface
// their scoped connection URL and kind so a caller knows it's a curated
// multi-pack connection rather than a single pack.
function renderCatalogEntry(p: CatalogPackEntry) {
  return {
    slug: p.slug,
    name: p.name ?? humanizeSlug(p.slug),
    ...(p.kind ? { kind: p.kind } : {}),
    description: p.description || `${p.tool_count} tool${p.tool_count === 1 ? '' : 's'}: ${p.tools.slice(0, 3).map((t) => t.name).join(', ')}`,
    tool_count: p.tool_count,
    gateway_url: p.url ?? `${GATEWAY}/${p.slug}/mcp`,
    ...(p.cost ? { cost: p.cost } : {}),
    ...(p.auth ? { auth: p.auth } : {}),
    ...(p.reliability ? { reliability: p.reliability } : {}),
  };
}

async function listPacks(category: string | undefined, manifest?: CatalogPackEntry[]): Promise<unknown> {
  const packs = manifest ?? (await fetchLiveCatalog());

  let filtered = packs;
  if (category) {
    filtered = rankCatalog(packs, category).map((h) => h.entry);
  }

  return {
    // Bundles are curated views over packs, so they don't add to the pack count.
    total_packs: packs.filter((p) => p.kind !== 'bundle').length,
    ...(category ? { matched: filtered.length } : {}),
    gateway: GATEWAY,
    packs: filtered.map(renderCatalogEntry),
    ...(category
      ? {
          note: 'category is matched as free text against pack slugs, descriptions, and tool names/descriptions — there is no fixed taxonomy. Try search_packs for the same search with a query-shaped name.',
        }
      : {}),
  };
}

type PackToolEntry = { name: string; description: string; inputSchema: unknown };
type PackToolsManifest = Record<string, PackToolEntry[]>;

async function getPackTools(slug: string, manifest?: PackToolsManifest, catalog?: CatalogPackEntry[]): Promise<unknown> {
  // A bundle slug (e.g. "gtm") is a scoped connection, not a pack, so it has
  // no /{slug}/mcp endpoint — answer with its connect URL instead of letting
  // the HTTP fallback 404.
  const bundle = catalog?.find((p) => p.kind === 'bundle' && p.slug === slug);
  if (bundle && bundle.url) {
    return {
      slug,
      kind: 'bundle',
      gateway_url: bundle.url,
      tool_count: bundle.tool_count,
      description: bundle.description,
      note: `A curated scoped connection spanning many packs. Connect to ${bundle.url} and call tools/list there to enumerate its ${bundle.tool_count} tools.`,
      connect: {
        claude_desktop: {
          mcpServers: {
            [`pipeworx-${slug}`]: {
              command: 'npx',
              args: ['-y', 'mcp-remote', bundle.url],
            },
          },
        },
        claude_code: `claude mcp add pipeworx-${slug} -- npx -y mcp-remote "${bundle.url}"`,
      },
    };
  }

  // Prefer the in-process manifest the gateway injects (avoids the 522 from
  // the worker fetching its own public hostname). Fall back to HTTP only when
  // the manifest isn't available — e.g. when the pack is run standalone.
  let tools: PackToolEntry[];
  if (manifest && manifest[slug]) {
    tools = manifest[slug];
  } else {
    const result = (await postJsonRpc(`${GATEWAY}/${slug}/mcp`, 'tools/list')) as {
      tools: PackToolEntry[];
    };
    tools = result.tools;
  }

  return {
    slug,
    gateway_url: `${GATEWAY}/${slug}/mcp`,
    tool_count: tools.length,
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
    })),
    connect: {
      claude_desktop: {
        mcpServers: {
          [`pipeworx-${slug}`]: {
            command: 'npx',
            args: ['-y', 'mcp-remote', `${GATEWAY}/${slug}/mcp`],
          },
        },
      },
      claude_code: `claude mcp add pipeworx-${slug} -- npx -y mcp-remote ${GATEWAY}/${slug}/mcp`,
    },
  };
}

async function getConnectionConfig(slugs: string): Promise<unknown> {
  const slugList = slugs === 'all' ? ['all'] : slugs.split(',').map((s) => s.trim());

  if (slugList.length === 1 && slugList[0] === 'all') {
    return {
      note: 'Connects to ALL Pipeworx tools in a single MCP connection',
      claude_desktop: {
        mcpServers: {
          pipeworx: {
            command: 'npx',
            args: ['-y', 'mcp-remote', `${GATEWAY}/mcp`],
          },
        },
      },
      claude_code: `claude mcp add pipeworx -- npx -y mcp-remote ${GATEWAY}/mcp`,
      endpoint: `${GATEWAY}/mcp`,
    };
  }

  const mcpServers: Record<string, { command: string; args: string[] }> = {};
  for (const slug of slugList) {
    mcpServers[`pipeworx-${slug}`] = {
      command: 'npx',
      args: ['-y', 'mcp-remote', `${GATEWAY}/${slug}/mcp`],
    };
  }

  return {
    claude_desktop: { mcpServers },
    claude_code: slugList
      .map((s) => `claude mcp add pipeworx-${s} -- npx -y mcp-remote ${GATEWAY}/${s}/mcp`)
      .join('\n'),
    endpoints: slugList.map((s) => `${GATEWAY}/${s}/mcp`),
  };
}

async function searchPacks(
  query: string,
  manifest?: CatalogPackEntry[],
  limit?: number,
  surface?: string,
  origin?: string,
): Promise<unknown> {
  const packs = manifest ?? (await fetchLiveCatalog());
  const hits = rankCatalog(packs, query);
  // Best match first. A sentence-shaped query can clear the bar for a dozen
  // packs on the same concept (every procurement portal says "contracts",
  // "supplier", "awarded"); the ranking is what puts the one that also names
  // the country and the system at the top, and the cap keeps a broad query
  // from returning the whole catalog with cost/auth/reliability on every row.
  const cap = Math.min(Math.max(Math.floor(limit ?? 25), 1), 200);
  const shown = hits.slice(0, cap);
  const gw = origin || GATEWAY;
  const rendered = shown.map((h) => {
    const base = {
      ...renderCatalogEntry(h.entry),
      ...(h.matched.length ? { matched_terms: h.matched } : {}),
    };
    // A bundle is a scoped CONNECTION spanning many packs, not a pack with a
    // tool list of its own, so it gets no tools[] and no per-tool next step —
    // its gateway_url already IS its next step.
    if (h.entry.kind === 'bundle') return base;
    const tools = bestToolsFor(h.entry, query);
    if (tools.length === 0) return base;
    return {
      ...base,
      tools,
      next_step: nextStepFor(tools[0].name, surface, gw),
    };
  });
  return {
    query,
    results: hits.length,
    ...(hits.length > shown.length ? { showing: shown.length, truncated: true } : {}),
    packs: rendered,
    ...(hits.length === 0
      ? {
          hint: 'No pack text contains enough of these words. Phrase the SUBJECT of the data (e.g. "Colombia procurement contracts" rather than a full sentence with names in it), or call ask_pipeworx with the question — it routes semantically across every pack and runs the tool.',
        }
      : {}),
    ...(rendered.some((p) => 'cost' in p)
      ? {
          note: 'Each pack carries `cost` (expected credits + USD at YOUR plan rate for one call), `auth` (keyless / platform-keyed / caller-key-required) and `reliability`. reliability.measured:false means we hold NO measurement for that pack — read it as unknown, NOT as healthy. Non-paid callers pay nothing until their free daily cap; `cost` is the price past it. `tools` names up to 3 tools in that pack that best match your query, BY THE NAME YOU MUST CALL (namespaced when several packs export the same one), and `next_step` is the exact request to make next. Call get_pack_tools with the slug for the pack\'s full tool list.',
        }
      : {}),
  };
}

async function getPlatformStatus(totals?: { pack_count: number; tool_count: number }): Promise<unknown> {
  const [status, live] = await Promise.all([
    fetchJson(`${REGISTRY}/status`) as Promise<{
      total_apis: number;
      live: number;
      degraded: number;
      down: number;
      status: string;
    }>,
    totals
      ? Promise.resolve(totals)
      : (fetchJson(`${GATEWAY}/version`) as Promise<{ pack_count: number; tool_count: number }>),
  ]);

  return {
    gateway: GATEWAY,
    website: 'https://pipeworx.io',
    // The full browsable catalog — same numbers tools/list and /version
    // advertise. This is what "pack count" / "active tool count" in this
    // tool's own description actually promises.
    total_packs: live.pack_count,
    total_tools: live.tool_count,
    // A SEPARATE, smaller, curated set that synthetic monitoring actively
    // health-checks on a rotation (fleet task #145/#118): monitored_apis is
    // real and accurate for what it measures, it just isn't catalog size —
    // conflating the two is what made this tool look broken.
    monitored_apis: status.total_apis,
    monitoring_note:
      'monitored_apis is a curated subset under active synthetic health-checking (rotates through in ~4h, checked every ~15min) — it is not the size of the catalog. See total_packs/total_tools for that.',
    live: status.live,
    degraded: status.degraded,
    down: status.down,
    overall_status: status.status,
  };
}

async function searchDirectory(query: string, category?: string, limit: number = 10): Promise<unknown> {
  const params = new URLSearchParams({ q: query, limit: String(limit) });
  if (category) params.set('category', category);

  const data = (await fetchJson(`${REGISTRY}/discover?${params}`)) as {
    total: number;
    results: Array<{
      name: string;
      title: string;
      description: string;
      category: string;
      quality_score: number;
      verified: boolean;
    }>;
  };

  return {
    query,
    total: data.total,
    results: data.results.map((r) => ({
      name: r.name,
      title: r.title,
      description: r.description,
      category: r.category,
      quality_score: r.quality_score,
      verified: r.verified,
    })),
  };
}

// ── data_freshness ────────────────────────────────────────────────────
//
// Curated, hand-verified set of high-value live-data sources. Each entry's
// `probe` fetches the upstream DIRECTLY (no gateway round-trip, no importing
// other packs — this pack must stay stateless and self-contained) and reads
// the newest available datapoint's timestamp. `observed_lag` is always
// computed from that live read; `expected_cadence` is a documented constant
// describing how often the source publishes, never a substitute for the
// measurement. Sources whose upstream requires an API key we don't hold
// inside this pack (EIA, FRED, Census international trade — all gated
// behind PLATFORM_*_KEY on the gateway, which this standalone pack cannot
// reach) are intentionally NOT in this registry: a probe that always fails
// for lack of credentials is worse than no probe at all.
const FRESHNESS_PROBE_TIMEOUT_MS = 8000;

interface FreshnessProbeResult {
  newest: string; // ISO 8601
  detail?: string | Record<string, unknown>;
}

// Gateway-injected platform credentials handed to probes that need one.
interface ProbeKeys { bls?: string; supabaseUrl?: string; supabaseKey?: string }


// hosting-claims-ok: this pack's whole job is knowing which data is local
// ── Freshness for data we HOST ──────────────────────────────────────────
//
// Every probe above this point checks an UPSTREAM feed we proxy. None checked a
// hosting-claims-ok: internal reasoning for the freshness selector
// dataset we host ourselves, and those are the ones that have actually rotted:
// usaspending answered every DOD contract query with zero for 108 days behind a
// crashed load, and a human noticed, not an instrument.
//
// That asymmetry is the whole point. When we PROXY a source, the upstream going
// hosting-claims-ok: internal reasoning for the freshness selector
// stale is visible in the response. When we HOST it, staleness is SILENT — the
// tool keeps answering confidently from old rows, which is the
// hallucination-prevention promise failing quietly.
//
// TWO TRAPS THIS ENCODES, both found by measuring before writing any code:
//
// 1. The column must be an INGEST/OBSERVATION timestamp, never a forward-looking
//    deadline. max(close_date) on auction_lots reads 2046 and on procurement_bids
//    2037 — those are when listings CLOSE. A naive max() over a plausibly-named
//    date column reports a rotted mirror as fresh for the next twenty years.
//
// 2. Lag is only meaningful against the SOURCE's cadence. 32 days old is healthy
//    for a monthly series and broken for a daily one, so each entry carries its
//    expected cadence and the verdict is computed against that rather than
//    against a single global threshold.
interface HostedMirror {
  key: string;
  table: string;
  column: string;        // MUST be ingest/observation, never a deadline. See trap 1.
  source: string;
  category: string;
  expected_cadence: string;
  cadence_days: number;  // what "fresh" means for THIS source. See trap 2.
  note?: string;
  // Set for a historical corpus: judged on load success via pipeline_runs
  // instead of data age. cadence_days then bounds how long a load may be ABSENT.
  archival?: boolean;
  load_prefix?: string;  // pipeline_runs.dataset_name prefix; defaults to `table`
  /**
   * Extra PostgREST filter, so ONE table can register several entries that
   * each measure a slice independently. WARN notices are the case that forced
   * it: five state feeds land in one table on five different cadences, and a
   * single max(notice_date) over the whole table reports the freshest state
   * and hides a stalled one completely — the failure the per-state split
   * exists to catch.
   */
  filter?: string;
}

const HOSTED_MIRRORS: HostedMirror[] = [
  { key: 'usaspending-mirror', table: 'usaspending_contracts', column: 'action_date',
    source: 'USAspending contract awards', category: 'govcon',
    expected_cadence: 'monthly snapshot', cadence_days: 75,
    note: 'files.usaspending.gov publishes ONE monthly delta and its newest award trails the snapshot by ~6 weeks, so ~55 days after a refresh is healthy and ~85 is due. A 45-day threshold here would alarm every month for no reason.' },
  { key: 'zillow-mirror', table: 'zillow_observations', column: 'observation_date',
    source: 'Zillow ZHVI', category: 'housing',
    expected_cadence: 'monthly', cadence_days: 50 },
  // WARN layoff notices — ONE entry per state on purpose. Each state labor
  // department publishes on its own schedule, so a stalled feed is only
  // visible when it is measured alone (fleet #623).
  //
  // Cadence per state is set from its OBSERVED publication rhythm, not a
  // uniform guess: California refreshes twice weekly, Illinois and Ohio run
  // roughly weekly, New York's dashboard updates in bursts, and Texas's
  // Socrata mirror lagged ~2 months at load time — which is normal for it and
  // would alarm constantly on a tighter threshold.
  { key: 'warn-ca', table: 'warn_notices', column: 'notice_date', filter: 'state=eq.CA',
    source: 'California WARN notices (EDD)', category: 'labor',
    expected_cadence: 'twice weekly', cadence_days: 21,
    note: 'EDD publishes a ROLLING ~2-month window, so this state contributes recent notices only and its history does not extend back.' },
  { key: 'warn-il', table: 'warn_notices', column: 'notice_date', filter: 'state=eq.IL',
    source: 'Illinois WARN notices (IDES/IWN)', category: 'labor',
    expected_cadence: 'weekly', cadence_days: 30 },
  { key: 'warn-oh', table: 'warn_notices', column: 'notice_date', filter: 'state=eq.OH',
    source: 'Ohio WARN notices (ODJFS)', category: 'labor',
    expected_cadence: 'weekly', cadence_days: 30 },
  { key: 'warn-ny', table: 'warn_notices', column: 'notice_date', filter: 'state=eq.NY',
    source: 'New York WARN notices (NYSDOL)', category: 'labor',
    expected_cadence: 'weekly, in bursts', cadence_days: 45 },
  { key: 'warn-tx', table: 'warn_notices', column: 'notice_date', filter: 'state=eq.TX',
    source: 'Texas WARN notices (TWC)', category: 'labor',
    expected_cadence: 'irregular Socrata refresh', cadence_days: 120,
    note: 'Texas publishes this through its own open-data portal (data.texas.gov), which trailed the other states by ~2 months as of 2026-08-29 (newest notice 2026-06-23). That is the portal\'s normal rhythm; a 30-day threshold here would report a false stall every week.' },
  { key: 'iso-mirror', table: 'iso_standards', column: 'publication_date',
    source: 'ISO standards catalogue', category: 'standards',
    expected_cadence: 'continuous', cadence_days: 30 },
  { key: 'ocds-mirror', table: 'ocds_releases', column: 'release_date',
    source: 'OCDS procurement releases', category: 'procurement',
    expected_cadence: 'monthly bulk', cadence_days: 45,
    note: 'Measured on release_date, NOT award_date. Two reasons and either alone would decide it: release_date carries three btree indexes while award_date carries none, so ordering 897k rows by award_date is a full sort and the probe timed out at 8s every run; and release_date is when the procurement notice was PUBLISHED, which is the freshness question, while award_date is a business date that can lag or lead the publication. Both currently read 2026-08-05.' },
  { key: 'openfema-mirror', table: 'openfema_disaster_declarations', column: 'declaration_date',
    source: 'OpenFEMA disaster declarations', category: 'gov',
    expected_cadence: 'weekly full replace', cadence_days: 21,
    note: 'Full DELETE + reload weekly, so unlike the append-only datasets a stall here also silently shrinks coverage.' },
  { key: 'augrants-mirror', table: 'au_grant_awards', column: 'approval_date',
    source: 'GrantConnect AU awards', category: 'grants',
    expected_cadence: 'scheduled ingest', cadence_days: 21 },
  // NOT a continuous ingest, which is what the original 45-day cadence assumed.
  // SEC publishes ONE archive per 3-MONTH WINDOW (`01mar2026-31may2026`), so
  // every filing_date in the mirror is pinned to that window and max(filing_date)
  // hosting-claims-ok: internal reasoning for the freshness selector
  // CANNOT be fresher than the window end no matter how often we ingest.
  //
  // Measured 2026-08-12 rather than reasoned about:
  //   newest release        01mar2026-31may2026, published (Last-Modified) 2026-06-04
  //   previous release      01dec2025-28feb2026, published 2026-03-03
  // hosting-claims-ok: worked example in a private comment
  //   our table             filing_date 2026-03-02 .. 2026-05-29, 11,761 rows
  // So publication lands ~3-4 days after the window closes, and the observed lag
  // sawtooths from ~5 days (just after a release) to ~95 (just before the next).
  // 75 days on 2026-08-12 is mid-sawtooth and healthy; SEC had published nothing
  // newer, so there was nothing to ingest.
  //
  // 120 = worst-case window (92) + publication lag (~4) + margin. Tight enough
  // that a genuinely MISSED release trips within one cycle, which is the failure
  // this probe exists to catch; the shape means a shorter number can only ever
  // fire on healthy data.
  { key: 'pcaobformap-mirror', table: 'pcaob_form_ap', column: 'filing_date',
    source: 'PCAOB Form AP auditor-issuer engagements', category: 'finance',
    expected_cadence: 'continuous filings, mirrored weekly', cadence_days: 14 },
  // hosting-claims-ok: internal engineering history, not caller-visible
  // Registered after this table sat 46% loaded for a day with nobody noticing:
  // its ingest failed every 15 minutes on a too-narrow primary key (fleet #624,
  // migration 116), two of five batches committed, and the pack kept answering
  // confidently from the partial table. The failure was loud in pipeline_runs
  // and invisible everywhere a caller would look — which is the gap this
  // registry exists to close.
  { key: 'pcaobinspections-mirror', table: 'pcaob_inspection_reports', column: 'inspection_report_date',
    source: 'PCAOB firm inspection reports', category: 'finance',
    expected_cadence: 'published irregularly through the year, mirrored weekly', cadence_days: 120,
    note: 'Inspection reports appear in clusters rather than steadily — a firm can publish several on one date for different inspection years — so a quiet month is normal and says nothing about staleness; 120 days is the point at which a gap is worth questioning.' },
  { key: 'sec13f-mirror', table: 'sec_13f_submissions', column: 'filing_date',
    source: 'SEC 13F submissions', category: 'finance',
    expected_cadence: 'one archive per 3-month window, published ~4 days after it closes',
    cadence_days: 120 },
  { key: 'freddiemac-mirror', table: 'freddie_mac_pmms', column: 'observation_date',
    source: 'Freddie Mac PMMS mortgage rates', category: 'housing',
    expected_cadence: 'weekly', cadence_days: 14 },
  { key: 'launchlibrary-mirror', table: 'launch_library_mirror', column: 'fetched_at',
    source: 'Launch Library 2', category: 'space',
    expected_cadence: 'daily', cadence_days: 3 },
  { key: 'sec8k-mirror', table: 'sec_8k_events', column: 'enriched_at',
    source: 'SEC 8-K events', category: 'finance',
    expected_cadence: 'daily', cadence_days: 3 },
  // Found by column-name audit AFTER the first pass: these use first_seen /
  // last_seen / fetched_at rather than the created/updated/ingested convention,
  // so an earlier regex sweep missed them and I very nearly filed two of them as
  // "has no freshness column, cannot be probed". They probe fine.
  { key: 'imdb-mirror', table: 'imdb_titles', column: 'n/a', load_prefix: 'imdb-',
    source: 'IMDb non-commercial datasets', category: 'media',
    expected_cadence: 'weekly reload of a historical corpus', cadence_days: 21, archival: true,
    note: 'ARCHIVAL: judged on whether the load still succeeds, never on data age. Two reasons. Its tables carry NO date column at all — information_schema returns zero date/timestamp columns for imdb% — so there is nothing in the data to measure. And a 1927 film is not stale; for a historical corpus old data IS the product, so any age threshold would read red forever and train everyone to ignore the row. cadence_days here bounds how long a LOAD may be absent, not how old the data may be.' },
  { key: 'govauctions-mirror', table: 'auction_lots', column: 'last_seen_at',
    source: 'Government auction lots', category: 'auctions',
    expected_cadence: 'daily scrape', cadence_days: 3,
    note: 'Measured on last_seen_at, NOT closes_at — closes_at is when a lot stops accepting bids and runs to 2046, so measuring it would report a dead scraper as fresh for twenty years.' },
  { key: 'dodcontracts-mirror', table: 'dod_contract_announcements', column: 'announced_on',
    source: 'DoD daily contract announcements ($7.5M+)', category: 'govcon',
    expected_cadence: 'every business day', cadence_days: 5,
    note: 'Measured on announced_on, the date war.gov published the award. 5 days rather than 2 because the source only publishes on business days — a Friday announcement is still the newest row through the weekend, and a long federal holiday weekend stretches that further.' },
  { key: 'gaoprotests-mirror', table: 'gao_bid_protests', column: 'decided_on',
    source: 'GAO bid-protest decisions', category: 'govcon',
    expected_cadence: 'every business day (feed shows only the ~5 newest)', cadence_days: 5,
    note: 'Measured on decided_on. Like dod-contracts, GAO only decides/publishes on business days, and unlike dod-contracts the source feed itself has no real pagination — this table is a rolling accumulation, not a full historical archive, so a healthy crawl still only ever adds ~5 rows/day.' },
  // ARCHIVAL, same shape as imdb below: reginfo_rins is a biannual corpus
  // back to Fall 1995, so a RIN row from 1996 is not stale — it's the product.
  // Judged on whether the monthly LOAD still runs (pipeline_runs), not on row
  // age; cadence_days bounds how long a load may be absent, ~1.5x the 30-day
  // monthly schedule so a genuinely missed cycle trips before the next one.
  { key: 'reginfo-mirror', table: 'reginfo_rins', column: 'n/a', load_prefix: 'reginfo',
    source: 'reginfo.gov Unified Agenda RIN dataset', category: 'govcon',
    expected_cadence: 'biannual editions (April/October), backfill checked monthly', cadence_days: 45,
    archival: true,
    note: 'ARCHIVAL: the source itself only publishes twice a year, and old RINs from 1995 are exactly as valuable as new ones — a data-age threshold would read this as permanently stale. reg_agenda_coverage (in the reginfo pack) reports the actual edition range loaded.' },
  { key: 'govbids-mirror', table: 'procurement_bids', column: 'last_seen',
    source: 'Government procurement bids', category: 'procurement',
    expected_cadence: 'daily scrape', cadence_days: 3,
    note: 'Measured on last_seen, NOT close_date — same forward-looking-deadline trap as the auction dataset.' },
  { key: 'spacex-mirror', table: 'spacex_mirror', column: 'fetched_at',
    source: 'SpaceX launch data', category: 'space',
    expected_cadence: 'daily', cadence_days: 3 },
  { key: 'treasury-mirror', table: 'treasury_fiscal_mirror', column: 'fetched_at',
    source: 'Treasury fiscal data', category: 'economics',
    expected_cadence: 'daily', cadence_days: 3 },
  { key: 'sanctions-mirror', table: 'csl_entries', column: 'last_seen',
    source: 'Consolidated Screening List', category: 'kyb',
    expected_cadence: 'daily', cadence_days: 3,
    note: 'Sanctions screening answers a compliance question, so a silently stale list is the highest-consequence staleness here.' },
];

// An ARCHIVAL corpus is measured by whether its LOAD still runs, not by how old
// its rows are. The imdb mirror is the case that forced this: its tables carry no
// date column at all (verified — information_schema returns zero date/timestamp
// columns for imdb%), so there is nothing in the DATA to measure, and even if
// there were, a film from 1927 is not staleness. pipeline_runs is the signal:
// dataset_name + status + completed_at.
//
// Takes the WEAKEST link — the oldest per-dataset successful load across the
// prefix — so one stalled table cannot hide behind three healthy ones. Reporting
// the max would have made a half-broken corpus look fine, which is the failure
// mode this whole line of work exists to stop.
async function probeArchivalLoad(
  m: HostedMirror, signal: AbortSignal, keys?: ProbeKeys,
): Promise<FreshnessProbeResult> {
  if (!keys?.supabaseUrl || !keys?.supabaseKey) {
    throw new Error('Archival probe is not configured on this deployment — an operator must enable its data credentials.');
  }
  const prefix = m.load_prefix ?? m.table;
  const url = `${keys.supabaseUrl}/rest/v1/pipeline_runs`
    + `?select=dataset_name,completed_at,rows_written`
    + `&status=eq.success&completed_at=not.is.null`
    + `&dataset_name=like.${encodeURIComponent(prefix + '*')}`
    + `&order=completed_at.desc&limit=500`;
  const res = await fetch(url, {
    signal,
    headers: { apikey: keys.supabaseKey, Authorization: `Bearer ${keys.supabaseKey}` },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} reading pipeline_runs for ${prefix}`);
  const rows = (await res.json()) as Array<{ dataset_name: string; completed_at: string; rows_written: number | null }>;
  if (!rows.length) throw new Error(`No successful load ever recorded for ${prefix}* — the archive has never been built`);
  const newestPerDataset = new Map<string, string>();
  for (const r of rows) {
    const prev = newestPerDataset.get(r.dataset_name);
    if (!prev || r.completed_at > prev) newestPerDataset.set(r.dataset_name, r.completed_at);
  }
  const oldest = [...newestPerDataset.entries()].sort((a, b) => a[1].localeCompare(b[1]))[0];
  return {
    newest: new Date(oldest[1]).toISOString(),
    detail: {
      hosted_by_pipeworx: true,
      archival: true,
      measured: 'last SUCCESSFUL load, not data age — this corpus is meant to be old',
      weakest_dataset: oldest[0],
      datasets_tracked: newestPerDataset.size,
      ...(m.note ? { note: m.note } : {}),
    },
  };
}

// PostgREST gives us max() without an RPC: order desc, take one.
async function probeHostedMirror(
  m: HostedMirror, signal: AbortSignal, keys?: ProbeKeys,
): Promise<FreshnessProbeResult> {
  if (!keys?.supabaseUrl || !keys?.supabaseKey) {
    throw new Error('Freshness probe needs gateway-injected credentials');
  }
  const url = `${keys.supabaseUrl}/rest/v1/${m.table}`
    + `?select=${encodeURIComponent(m.column)}`
    + `&${encodeURIComponent(m.column)}=not.is.null`
    + (m.filter ? `&${m.filter}` : '')
    + `&order=${encodeURIComponent(m.column)}.desc&limit=1`;
  const res = await fetch(url, {
    signal,
    headers: { apikey: keys.supabaseKey, Authorization: `Bearer ${keys.supabaseKey}` },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} reading ${m.table}`);
  const rows = (await res.json()) as Array<Record<string, unknown>>;
  const raw = rows?.[0]?.[m.column];
  if (raw == null) throw new Error(`${m.table} returned no rows — EMPTY, not merely stale`);
  const iso = new Date(String(raw).length <= 10 ? `${raw}T00:00:00Z` : String(raw)).toISOString();
  return {
    newest: iso,
    detail: {
      hosted_by_pipeworx: true,
      table: m.table,
      measured_on: m.column,
      healthy_within_days: m.cadence_days,
      ...(m.note ? { note: m.note } : {}),
    },
  };
}


interface FreshnessEntry {
  key: string;
  source: string;
  series: string;
  category: string;
  expected_cadence: string;
  realtime: boolean;
  aliases: string[];
  // True when WE store the data. Drives the 'hosted'/'upstream' selector and,
  // more importantly, is the thing that makes staleness silent: a proxied feed
  // going stale shows up in the response, a hosted one does not.
  hosted?: boolean;
  // How this source is allowed to be judged.
  //   'periodic' (default) — data age against cadence_days, the original model.
  //   'archival'           — a historical corpus where OLD DATA IS THE PRODUCT.
  //                          Judged on whether the LOAD still succeeds, never on
  //                          data age, because an archive is supposed to be old
  //                          and would otherwise read red forever.
  cadence_class?: 'periodic' | 'archival';
  probe: (signal: AbortSignal, keys?: ProbeKeys) => Promise<FreshnessProbeResult>;
}

const PORTWATCH_BASE = 'https://services9.arcgis.com/weJ1QsnbMYJlCHdG/ArcGIS/rest/services';
const KALSHI_BASE = 'https://api.elections.kalshi.com/trade-api/v2';
const KALSHI_UA = 'pipeworx-mcp-pipeworx-catalog/1.0 (+https://pipeworx.io)';

async function probePortwatch(signal: AbortSignal): Promise<FreshnessProbeResult> {
  // Suez (chokepoint1) as the bellwether chokepoint — PortWatch publishes
  // the whole daily layer on the same lag, so any one chokepoint's newest
  // settled day represents the layer's freshness.
  const url = `${PORTWATCH_BASE}/Daily_Chokepoints_Data/FeatureServer/0/query?${new URLSearchParams({
    where: "portid='chokepoint1'",
    outFields: 'date,n_total',
    orderByFields: 'date DESC',
    resultRecordCount: '1',
    f: 'json',
  })}`;
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`HTTP ${res.status} from PortWatch ArcGIS`);
  const body = (await res.json()) as { features?: Array<{ attributes?: { date?: string; n_total?: number } }> };
  const attrs = body.features?.[0]?.attributes;
  if (!attrs?.date) throw new Error('PortWatch returned no rows for chokepoint1');
  // `date` is an esriFieldTypeDateOnly string ("2026-07-19") — pin to UTC midnight.
  return { newest: `${attrs.date}T00:00:00Z`, detail: { chokepoint: 'Suez (chokepoint1)', n_total: attrs.n_total ?? null } };
}

async function probeDigitraffic(signal: AbortSignal): Promise<FreshnessProbeResult> {
  // Digitraffic's AIS endpoint 406s without an explicit Accept-Encoding —
  // it refuses to serve uncompressed responses to clients that don't ask.
  // No `limit` param: this endpoint intermittently 400s on it ("Illegal
  // query parameter name: 'limit'") even though it silently accepts it most
  // of the time — the unfiltered payload is ~40KB and the only field we
  // need (dataUpdatedTime) is top-level regardless of feature count, so
  // dropping the param removes a flaky failure mode for free.
  const res = await fetch('https://meri.digitraffic.fi/api/ais/v1/locations', {
    signal,
    headers: { 'Accept-Encoding': 'gzip', Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from Digitraffic AIS`);
  const body = (await res.json()) as { dataUpdatedTime?: string };
  if (!body.dataUpdatedTime) throw new Error('Digitraffic response missing dataUpdatedTime');
  return { newest: body.dataUpdatedTime };
}

async function probePolymarket(signal: AbortSignal): Promise<FreshnessProbeResult> {
  // Exchange-wide trades tape (no market filter) — the newest fill anywhere
  // on Polymarket is the most honest "how live is this feed" reading;
  // scoping to one market would just measure that market's own liquidity.
  const res = await fetch('https://data-api.polymarket.com/trades?limit=1', {
    signal,
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from Polymarket data-api`);
  const trades = (await res.json()) as Array<{ timestamp?: number; title?: string; slug?: string }>;
  const t = trades?.[0];
  if (!t?.timestamp) throw new Error('Polymarket trades tape returned no rows');
  return { newest: new Date(t.timestamp * 1000).toISOString(), detail: { last_trade_market: t.title ?? t.slug ?? null } };
}

async function probeKalshi(signal: AbortSignal): Promise<FreshnessProbeResult> {
  // Same idea as Polymarket: the unscoped /markets/trades endpoint returns
  // the newest executed trade across the whole exchange, no ticker needed.
  const res = await fetch(`${KALSHI_BASE}/markets/trades?limit=1`, {
    signal,
    headers: { Accept: 'application/json', 'User-Agent': KALSHI_UA },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from Kalshi`);
  const body = (await res.json()) as { trades?: Array<{ created_time?: string; ticker?: string }> };
  const t = body.trades?.[0];
  if (!t?.created_time) throw new Error('Kalshi trades tape returned no rows');
  return { newest: t.created_time, detail: { last_trade_ticker: t.ticker ?? null } };
}

async function probeGdelt(signal: AbortSignal): Promise<FreshnessProbeResult> {
  // GDELT's doc/search API (api.gdeltproject.org) rate-limits hard (~1
  // req/5s per IP, shared globally) and 429s from our egress. The raw
  // file-drop CDN (data.gdeltproject.org) is a different host with no such
  // limit: lastupdate.txt names the most recent 15-minute GDELT v2 export
  // batch, which is what "freshness" actually means for this source.
  const res = await fetch('http://data.gdeltproject.org/gdeltv2/lastupdate.txt', { signal });
  if (!res.ok) throw new Error(`HTTP ${res.status} from GDELT lastupdate.txt`);
  const text = await res.text();
  const m = text.split('\n')[0]?.match(/(\d{14})\.export\.CSV\.zip/);
  if (!m) throw new Error('Could not parse a timestamped export filename out of GDELT lastupdate.txt');
  const ts = m[1];
  const iso = `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)}T${ts.slice(8, 10)}:${ts.slice(10, 12)}:${ts.slice(12, 14)}Z`;
  return {
    newest: iso,
    detail:
      'GDELT names each 15-minute export batch for the end of its window, so this timestamp routinely sits slightly ahead of wall-clock time. The batch is genuinely published (lastupdate.txt only lists files that exist).',
  };
}

async function probeBlsCpi(signal: AbortSignal, keys?: ProbeKeys): Promise<FreshnessProbeResult> {
  // Keyless BLS public API. CPI-U all items (CUUR0000SA0) is monthly; the
  // newest row's `period` (e.g. "M06") is the LAST MONTH COVERED by the
  // release, not the exact publish date — we use the last calendar day of
  // that month as the datapoint timestamp, same convention as treating a
  // monthly series' reference period as its "as of" date.
  const year = new Date().getUTCFullYear();
  const res = await fetch('https://api.bls.gov/publicAPI/v2/timeseries/data/', {
    signal,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // Registration key raises the cap from 25/day-per-IP to 500/day and is what
    // stops this probe reporting the headline US inflation series as
    // unmeasurable. Keyless BLS signals exhaustion with HTTP 200 +
    // REQUEST_NOT_PROCESSED, and because Workers egress from shared rotating
    // IPs the probe succeeded on a fresh IP and failed on a spent one - which
    // read as a flaky upstream rather than as our own quota. A freshness guard
    // that cries wolf gets ignored, and then it cannot be trusted on the day
    // something real breaks. Same root cause as housing-intel (1295cbaa).
    body: JSON.stringify({
      seriesid: ['CUUR0000SA0'],
      startyear: String(year - 1),
      endyear: String(year),
      ...(keys?.bls ? { registrationkey: keys.bls } : {}),
    }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from BLS`);
  const body = (await res.json()) as {
    status?: string;
    Results?: { series?: Array<{ data?: Array<{ year?: string; period?: string; value?: string }> }> };
  };
  if (body.status && body.status !== 'REQUEST_SUCCEEDED') throw new Error(`BLS API status: ${body.status}`);
  const row = body.Results?.series?.[0]?.data?.[0];
  if (!row?.year || !row.period) throw new Error('BLS returned no CPI observations');
  const month = Number(row.period.replace('M', ''));
  if (!Number.isFinite(month) || month < 1 || month > 12) throw new Error(`Unexpected BLS period "${row.period}"`);
  // Day 0 of next month == last day of the reference month (UTC).
  const lastDayOfMonth = new Date(Date.UTC(Number(row.year), month, 0)).toISOString().slice(0, 10);
  return { newest: `${lastDayOfMonth}T00:00:00Z`, detail: { reference_period: `${row.year}-${row.period}`, latest_value: row.value ?? null } };
}


/**
 * NADAC — the weekly pharmacy acquisition cost survey (fleet #618).
 *
 * Probing this one needs two hops, and the second is the whole point. The
 * dataset ID rotates every January, so it is resolved by TITLE first; a probe
 * pinned to a hardcoded id would report a confident lag against last year's
 * file, which is exactly the failure this tool exists to catch.
 *
 * `sorts[0][property]` is the ONLY spelling the datastore API honours — a plain
 * `?sort=` returns HTTP 200 with UNSORTED rows, so a probe written that way
 * reports whatever week happens to be first and looks perfectly healthy.
 */
async function probeNadac(signal: AbortSignal): Promise<FreshnessProbeResult> {
  const base = 'https://data.medicaid.gov/api/1';
  const metaRes = await fetch(`${base}/metastore/schemas/dataset/items?show-reference-ids=false`, { signal });
  if (!metaRes.ok) throw new Error(`HTTP ${metaRes.status} from data.medicaid.gov metastore`);
  const items = (await metaRes.json()) as Array<{ identifier?: string; title?: string }>;
  const newestDataset = (Array.isArray(items) ? items : [])
    .map((d) => ({ id: d.identifier, title: String(d.title ?? ''), year: Number((String(d.title ?? '').match(/\b(20\d{2})\b/) || [])[1]) }))
    .filter((d) => /^NADAC \(National Average Drug Acquisition Cost\)/i.test(d.title) && d.id && d.year)
    .sort((a, b) => b.year - a.year)[0];
  if (!newestDataset) throw new Error('no NADAC dataset found in the data.medicaid.gov metastore');

  const qs = new URLSearchParams({ limit: '1', 'sorts[0][property]': 'effective_date', 'sorts[0][order]': 'desc' });
  const res = await fetch(`${base}/datastore/query/${newestDataset.id}/0?${qs}`, { signal });
  if (!res.ok) throw new Error(`HTTP ${res.status} from the NADAC datastore`);
  const body = (await res.json()) as { results?: Array<{ effective_date?: string; as_of_date?: string }>; count?: number };
  const row = body.results?.[0];
  if (!row?.effective_date) throw new Error('NADAC datastore returned no rows');
  return {
    newest: `${row.effective_date}T00:00:00Z`,
    detail: {
      dataset: newestDataset.title,
      published_as_of: row.as_of_date ?? null,
      rows_in_dataset: body.count ?? null,
      // Worth stating: the newest effective_date is often a small off-cycle
      // CORRECTION file rather than the full weekly publication, so this lag is
      // "newest price of any kind", not "the full week is this fresh".
      note: 'newest effective_date of any NADAC row; small off-cycle correction files share this column with the full weekly file',
    },
  };
}

const FRESHNESS_REGISTRY: FreshnessEntry[] = [
  {
    key: 'portwatch',
    source: 'IMF PortWatch',
    series: 'Daily chokepoint vessel transits (Suez Canal, chokepoint1, as bellwether)',
    category: 'maritime',
    expected_cadence: 'daily, published with a multi-day lag',
    realtime: false,
    aliases: ['portwatch', 'imf portwatch', 'chokepoint', 'chokepoints', 'suez', 'maritime chokepoint', 'imf'],
    probe: probePortwatch,
  },
  {
    key: 'digitraffic',
    source: 'Digitraffic AIS (Finnish Transport Infrastructure Agency)',
    series: 'Live vessel AIS positions in Finnish/Baltic waters',
    category: 'maritime',
    expected_cadence: 'near-real-time (positions stream continuously)',
    realtime: true,
    aliases: ['digitraffic', 'ais', 'digitraffic ais', 'vessel positions', 'baltic ais'],
    probe: probeDigitraffic,
  },
  {
    key: 'polymarket',
    source: 'Polymarket',
    series: 'Executed trades tape (exchange-wide, newest fill)',
    category: 'markets',
    expected_cadence: 'real-time (streams every executed trade)',
    realtime: true,
    aliases: ['polymarket', 'poly market', 'prediction market', 'polymarket odds'],
    probe: probePolymarket,
  },
  {
    key: 'kalshi',
    source: 'Kalshi',
    series: 'Executed trades tape (exchange-wide, newest fill)',
    category: 'markets',
    expected_cadence: 'real-time (streams every executed trade)',
    realtime: true,
    aliases: ['kalshi', 'kalshi odds', 'cftc prediction market'],
    probe: probeKalshi,
  },
  {
    key: 'gdelt',
    source: 'GDELT Project',
    series: 'Global news event export batches (v2 GKG/events CDN)',
    category: 'news',
    expected_cadence: 'every 15 minutes',
    realtime: true,
    aliases: ['gdelt', 'gdelt project', 'global news events', 'gkg'],
    probe: probeGdelt,
  },
  {
    key: 'bls_cpi',
    source: 'US Bureau of Labor Statistics',
    series: 'CPI-U, All Items (CUUR0000SA0)',
    category: 'economics',
    expected_cadence: 'monthly, released ~2-3 weeks after the reference month closes',
    realtime: false,
    aliases: ['bls', 'cpi', 'inflation', 'consumer price index', 'bls cpi'],
    probe: probeBlsCpi,
  },
  {
    key: 'nadac',
    source: 'CMS / Medicaid (data.medicaid.gov)',
    series: 'NADAC — National Average Drug Acquisition Cost',
    category: 'healthcare',
    expected_cadence: 'weekly, with small off-cycle correction files between publications',
    realtime: false,
    aliases: ['nadac', 'drug prices', 'drug price', 'pharmacy acquisition cost', 'acquisition cost', 'drug-prices'],
    probe: probeNadac,
  },
  // Hosted mirrors, generated from HOSTED_MIRRORS so adding a mirror is a data
  // change rather than another hand-written probe. docs/public-data-ingest-program.md
  // requires every newly ingested pack to ship with one of these. (fleet #286)
  ...HOSTED_MIRRORS.map((m): FreshnessEntry => ({
    key: m.key,
    source: m.source,
    series: m.table,
    category: m.category,
    expected_cadence: m.expected_cadence,
    realtime: false,
    // Filter short tokens: the matcher does substring containment BOTH ways, so a
    // 2-char alias matches almost anything. `au_grant_awards` generated the alias
    // 'au', which then swallowed a query for 'govauctions' (gov-AU-ctions).
    aliases: [m.table, m.key.replace('-mirror', ''), m.table.split('_')[0]]
      .filter((a) => a.length >= 5),
    hosted: true,
    cadence_class: m.archival ? 'archival' : 'periodic',
    probe: (signal, keys) => (m.archival ? probeArchivalLoad(m, signal, keys) : probeHostedMirror(m, signal, keys)),
  })),
];

// 'hosted' and 'upstream' are ORIGIN selectors, not domains. They cut ACROSS the
// per-domain categories (govcon, housing, finance...) rather than replacing them,
// because "how are OUR datasets doing" is a different question from "how is
// housing data doing" and both are worth asking. Before this, category:'hosted'
// returned count:0 while 15 such entries sat registered, and the only way to
// answer Bruce's question was to call unfiltered and eyeball the source names.
// (fleet #310)
//
// The selector reads the `hosted` flag, which the HOSTED_MIRRORS mapping sets
// for the whole array — NOT a marker in the caller-visible `source` string.
// Those strings used to carry a suffix naming us as the mirror operator, which
// meant every data_freshness response told callers which datasets we store.
// Removed under fleet #176/#323; the flag already did the work, so the suffix
// was pure disclosure with no function.
const ORIGIN_SELECTORS = new Set(['hosted', 'upstream']);

function matchesFreshnessQuery(entry: FreshnessEntry, source?: string, category?: string): boolean {
  if (category) {
    const c = category.toLowerCase().trim();
    if (ORIGIN_SELECTORS.has(c)) {
      const isHosted = entry.hosted === true;
      if (c === 'hosted' ? !isHosted : isHosted) return false;
    } else if (entry.category.toLowerCase() !== c) {
      return false;
    }
  }
  if (source) {
    const q = source.toLowerCase().trim();
    const hit =
      entry.key.toLowerCase().includes(q) ||
      entry.source.toLowerCase().includes(q) ||
      entry.aliases.some((a) => a.includes(q) || q.includes(a));
    if (!hit) return false;
  }
  return true;
}

async function runFreshnessProbe(entry: FreshnessEntry, keys?: ProbeKeys): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FRESHNESS_PROBE_TIMEOUT_MS);
  const base = {
    source: entry.source,
    series: entry.series,
    category: entry.category,
    expected_cadence: entry.expected_cadence,
    realtime: entry.realtime,
  };
  try {
    const result = await entry.probe(controller.signal, keys);
    const newestMs = Date.parse(result.newest);
    if (!Number.isFinite(newestMs)) throw new Error(`Probe returned an unparseable timestamp: "${result.newest}"`);
    const rawLagSeconds = Math.round((Date.now() - newestMs) / 1000);
    const lagSeconds = Math.max(0, rawLagSeconds);
    // Some upstreams label a batch for the END of its window, so the newest
    // label can sit ahead of wall clock (GDELT does this routinely). Clamping
    // that to 0 silently would report "perfectly fresh" — the exact overstatement
    // this tool exists to prevent — so say when the clamp fired and that the
    // reported lag is a floor rather than a measurement.
    const labelAheadOfClock = rawLagSeconds < 0;
    return {
      ...base,
      newest_datapoint: result.newest,
      observed_lag: {
        _seconds: lagSeconds,
        _days: +(lagSeconds / 86400).toFixed(2),
        ...(labelAheadOfClock
          ? {
              label_ahead_of_clock_seconds: -rawLagSeconds,
              note: 'This source labels its newest batch ahead of wall-clock time, so the datapoint timestamp is in the future and the lag above is a floor (at best this fresh), not a measurement.',
            }
          : {}),
      },
      probe_ok: true,
      ...(result.detail ? { detail: result.detail } : {}),
    };
  } catch (e) {
    const isAbort = (e as Error)?.name === 'AbortError';
    return {
      ...base,
      newest_datapoint: null,
      observed_lag: null,
      probe_ok: false,
      probe_error: isAbort
        ? `probe timed out after ${FRESHNESS_PROBE_TIMEOUT_MS / 1000}s`
        : (e as Error)?.message || 'unknown probe error',
    };
  } finally {
    clearTimeout(timer);
  }
}

async function dataFreshness(source?: string, category?: string, blsKey?: string, supabaseUrl?: string, supabaseKey?: string): Promise<unknown> {
  const entries = FRESHNESS_REGISTRY.filter((e) => matchesFreshnessQuery(e, source, category));
  if (entries.length === 0) {
    return {
      probed_at: new Date().toISOString(),
      count: 0,
      results: [],
      note: 'No curated source matched. Available sources: ' +
        FRESHNESS_REGISTRY.map((e) => e.key).join(', ') +
        '. Available categories: ' +
        Array.from(new Set(FRESHNESS_REGISTRY.map((e) => e.category))).join(', ') + '.',
    };
  }
  // Never let one dead upstream block the rest — every entry probes
  // concurrently and independently, each with its own timeout.
  // Not point-free: Array.map passes (element, index, array), so `map(runFreshnessProbe)`
  // would hand the index in as `keys`. Harmless while the probe took one argument,
  // which is exactly why it is worth fixing at the moment a second one appears.
  const results = await Promise.all(entries.map((e) => runFreshnessProbe(e, { bls: blsKey, supabaseUrl, supabaseKey })));
  return {
    probed_at: new Date().toISOString(),
    count: results.length,
    note: 'Every observed_lag figure was measured by fetching the upstream at call time (probed_at), not read from a static table. Lag can vary between calls — re-run before pricing or settling off a number that matters. expected_cadence is a documented constant describing how often the source publishes; it is not a substitute for observed_lag.',
    results,
  };
}

async function callPackTool(slug: string, tool: string, argsJson?: string): Promise<unknown> {
  if (slug === 'pipeworx-catalog') throw new Error('Cannot call catalog tools recursively');
  const toolArgs = argsJson ? JSON.parse(argsJson) : {};
  const result = (await postJsonRpc(`${GATEWAY}/${slug}/mcp`, 'tools/call', {
    name: tool,
    arguments: toolArgs,
  })) as {
    content: Array<{ type: string; text: string }>;
    _meta?: unknown;
  };

  // Extract the tool response from the JSON-RPC wrapper
  if (result.content?.[0]?.text) {
    try {
      return JSON.parse(result.content[0].text);
    } catch {
      return result.content[0].text;
    }
  }
  return result;
}

export default { tools, callTool } satisfies McpToolExport;
