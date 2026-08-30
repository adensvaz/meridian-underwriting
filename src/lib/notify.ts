// Outbound webhooks — Slack, Microsoft Teams, or a generic JSON endpoint.
//
// The rules this file exists to enforce, in priority order:
//
//   1. A webhook must never break underwriting. Delivery is fire-and-forget
//      behind a short timeout, every failure is caught and logged, and nothing
//      in here throws into a request path. A dead Slack workspace is a log
//      line, not an outage.
//
//   2. Nothing leaves the server unless an operator configured a URL. No
//      MERIDIAN_WEBHOOK_URL means no request is constructed and no socket is
//      opened — not a request to a default endpoint, not a no-op POST.
//
//   3. A Slack channel is a wider audience than a deal's owner. The default
//      detail level therefore carries the deal name, its status, the
//      pass/fail verdict and a link back into Meridian — and no figures.
//      Sending numbers is opt-in, per deployment, via MERIDIAN_WEBHOOK_DETAIL.
//
// Configuration (read from process.env directly; src/lib/env.ts is owned
// elsewhere, so these are documented here instead):
//
//   MERIDIAN_WEBHOOK_URL          Destination. Unset = the feature is off.
//   MERIDIAN_WEBHOOK_DETAIL       summary (default) | metrics | full
//   MERIDIAN_WEBHOOK_EVENTS       all (default) | threshold
//   MERIDIAN_WEBHOOK_TIMEOUT_MS   Delivery timeout, default 5000, max 15000.
//   MERIDIAN_WEBHOOK_DSCR_MIN     DSCR covenant, default 1.25. Empty = off.
//   MERIDIAN_WEBHOOK_NET_YIELD_MIN Net yield target. Unset = off.
//   MERIDIAN_PUBLIC_URL           Base URL used to build deal links.

// ------------------------------------------------------------------ config --

export type WebhookFlavour = "slack" | "teams" | "generic";
export type WebhookDetail = "summary" | "metrics" | "full";

export interface WebhookTarget {
  url: string;
  flavour: WebhookFlavour;
}

function envString(key: string): string {
  const raw = process.env[key];
  return typeof raw === "string" ? raw.trim() : "";
}

function envNumber(key: string, fallback: number | null): number | null {
  const raw = envString(key);
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Detects the destination's dialect from its host. Slack and Teams both accept
 * a bare JSON body but render nothing useful from one, so the payload is shaped
 * per host rather than sent blind.
 */
export function detectFlavour(url: string): WebhookFlavour {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return "generic";
  }
  if (host === "slack.com" || host.endsWith(".slack.com")) return "slack";
  if (
    host.endsWith("webhook.office.com") ||
    host.endsWith(".office.com") ||
    host.endsWith(".office365.com") ||
    host.endsWith(".outlook.com") ||
    host.endsWith(".logic.azure.com")
  ) {
    return "teams";
  }
  return "generic";
}

/**
 * The configured destination, or null. Null means "do nothing at all" — every
 * caller in this file treats it as a hard stop, which is what makes
 * "confidential figures never reach an unconfigured endpoint" true by
 * construction rather than by remembering to check.
 */
export function webhookTarget(raw: string = envString("MERIDIAN_WEBHOOK_URL")): WebhookTarget | null {
  if (!raw) return null;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    console.error("[notify] MERIDIAN_WEBHOOK_URL is not a valid URL — webhooks are disabled");
    return null;
  }
  // Only HTTP(S). file:, data: and friends are not delivery channels.
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    console.error(`[notify] MERIDIAN_WEBHOOK_URL must be http(s), got ${parsed.protocol} — webhooks are disabled`);
    return null;
  }
  return { url: parsed.toString(), flavour: detectFlavour(parsed.toString()) };
}

export function webhookDetail(): WebhookDetail {
  const raw = envString("MERIDIAN_WEBHOOK_DETAIL").toLowerCase();
  if (raw === "metrics" || raw === "full") return raw;
  return "summary";
}

function timeoutMs(): number {
  const configured = envNumber("MERIDIAN_WEBHOOK_TIMEOUT_MS", 5000) ?? 5000;
  return Math.min(Math.max(configured, 250), 15_000);
}

function publicBaseUrl(): string {
  const configured = envString("MERIDIAN_PUBLIC_URL");
  if (configured) return configured.replace(/\/+$/, "");
  const port = envString("PORT") || "4100";
  return `http://localhost:${port}`;
}

export function dealLink(dealId: string): string {
  return `${publicBaseUrl()}/app#/deals/${encodeURIComponent(dealId)}/review`;
}

// ------------------------------------------------------------------- events --

/**
 * Structurally compatible with FlagResult / BenchmarkResult from the engine, so
 * a caller can hand over `result.flags` and `result.benchmarks` untouched
 * without this module depending on the engine's types.
 */
export interface NotifyFlag {
  id: string;
  severity: string;
  title: string;
  detail?: string;
  metric?: string;
}

export interface NotifyBenchmark {
  key: string;
  label: string;
  value: unknown;
  status: string;
}

export interface UnderwritingEvent {
  dealId: string;
  dealName: string;
  /** Deal lifecycle status, e.g. "underwritten". */
  status: string;
  currency?: string;
  community?: string | null;
  modelName?: string | null;
  runId?: string | null;
  /** Every computed key → value. Only ever sent at detail levels above summary. */
  values?: Record<string, unknown>;
  flags?: NotifyFlag[];
  benchmarks?: NotifyBenchmark[];
}

export interface ThresholdCheck {
  key: string;
  label: string;
  comparator: "min" | "max";
  threshold: number;
  value: number;
  passed: boolean;
}

export type Verdict = "pass" | "fail" | "review";

export interface ThresholdOutcome {
  verdict: Verdict;
  /** Human-readable, deliberately figure-free, safe at every detail level. */
  reasons: string[];
  checks: ThresholdCheck[];
}

function numeric(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Decides whether the deal cleared the firm's bar.
 *
 * Three sources, in order of authority:
 *   1. explicit covenant/target thresholds from the environment,
 *   2. the model's own benchmarks (good / warn / bad),
 *   3. the model's deterministic risk flags.
 *
 * The model's own definitions come first conceptually — a firm that customised
 * its benchmarks has already told us where its bar is — and the environment
 * thresholds exist for the covenants that live in a loan agreement rather than
 * in an underwriting template.
 */
export function evaluateThresholds(event: UnderwritingEvent): ThresholdOutcome {
  const values = event.values ?? {};
  const checks: ThresholdCheck[] = [];
  const reasons: string[] = [];

  const dscrMin = envNumber("MERIDIAN_WEBHOOK_DSCR_MIN", 1.25);
  const dscr = numeric(values.dscr);
  if (dscrMin !== null && dscr !== null) {
    checks.push({
      key: "dscr",
      label: "DSCR",
      comparator: "min",
      threshold: dscrMin,
      value: dscr,
      passed: dscr >= dscrMin,
    });
  }

  const yieldMin = envNumber("MERIDIAN_WEBHOOK_NET_YIELD_MIN", null);
  const netYield = numeric(values.net_yield);
  if (yieldMin !== null && netYield !== null) {
    checks.push({
      key: "net_yield",
      label: "Net yield",
      comparator: "min",
      threshold: yieldMin,
      value: netYield,
      passed: netYield >= yieldMin,
    });
  }

  for (const check of checks) {
    if (!check.passed) {
      reasons.push(
        check.comparator === "min"
          ? `${check.label} is below the configured threshold`
          : `${check.label} is above the configured threshold`,
      );
    }
  }

  let failed = checks.some((c) => !c.passed);
  let review = false;

  for (const benchmark of event.benchmarks ?? []) {
    if (benchmark.status === "bad") {
      failed = true;
      reasons.push(`${benchmark.label} is outside the model's benchmark band`);
    } else if (benchmark.status === "warn") {
      review = true;
    }
  }

  for (const flag of event.flags ?? []) {
    if (flag.severity === "red") {
      failed = true;
      reasons.push(flag.title);
    } else if (flag.severity === "amber") {
      review = true;
    }
  }

  const verdict: Verdict = failed ? "fail" : review ? "review" : "pass";
  if (!reasons.length) {
    reasons.push(
      verdict === "pass"
        ? "Cleared every threshold and benchmark"
        : "Flagged for review — see the deal in Meridian",
    );
  }
  // De-duplicate: a covenant breach usually trips a benchmark and a flag too,
  // and three lines saying the same thing reads like noise in a channel.
  return { verdict, reasons: [...new Set(reasons)], checks };
}

/**
 * `MERIDIAN_WEBHOOK_EVENTS=threshold` limits delivery to the cases a deal desk
 * actually wants pinged about: a breach, or a deal that cleared an explicitly
 * configured target. The default sends every completed underwriting.
 */
export function shouldNotify(outcome: ThresholdOutcome): boolean {
  if (envString("MERIDIAN_WEBHOOK_EVENTS").toLowerCase() !== "threshold") return true;
  if (outcome.verdict === "fail") return true;
  return outcome.checks.length > 0 && outcome.checks.every((c) => c.passed);
}

// ----------------------------------------------------------------- payloads --

const VERDICT_TEXT: Record<Verdict, string> = {
  pass: "Passed",
  fail: "Failed",
  review: "Needs review",
};

const VERDICT_EMOJI: Record<Verdict, string> = {
  pass: "✅",
  fail: "⛔",
  review: "⚠️",
};

const VERDICT_COLOUR: Record<Verdict, string> = {
  pass: "2E7D32",
  fail: "C62828",
  review: "EF6C00",
};

/** Ratios and percentages — meaningful without disclosing the money. */
const METRIC_KEYS = ["dscr", "gross_yield", "net_yield", "cash_on_cash", "levered_irr", "irr"];

function formatMetric(key: string, value: number): string {
  if (key === "dscr") return `${value.toFixed(2)}×`;
  return `${(value * 100).toFixed(2)}%`;
}

interface Fact {
  label: string;
  value: string;
}

function facts(event: UnderwritingEvent, outcome: ThresholdOutcome, detail: WebhookDetail): Fact[] {
  const rows: Fact[] = [
    { label: "Deal", value: event.dealName },
    { label: "Status", value: event.status },
    { label: "Verdict", value: VERDICT_TEXT[outcome.verdict] },
  ];
  if (detail === "summary") return rows;

  if (event.modelName) rows.push({ label: "Model", value: event.modelName });
  if (event.community) rows.push({ label: "Community", value: event.community });

  const values = event.values ?? {};
  for (const key of METRIC_KEYS) {
    const value = numeric(values[key]);
    if (value === null) continue;
    rows.push({ label: labelFor(key), value: formatMetric(key, value) });
  }

  if (detail === "full") {
    const currency = event.currency ?? "AED";
    for (const key of ["purchase_price", "noi", "annual_rent", "total_equity", "annual_debt_service"]) {
      const value = numeric(values[key]);
      if (value === null) continue;
      rows.push({
        label: labelFor(key),
        value: `${currency} ${Math.round(value).toLocaleString("en-US")}`,
      });
    }
  }
  return rows;
}

function labelFor(key: string): string {
  const map: Record<string, string> = {
    dscr: "DSCR",
    gross_yield: "Gross yield",
    net_yield: "Net yield",
    cash_on_cash: "Cash on cash",
    levered_irr: "Levered IRR",
    irr: "IRR",
    purchase_price: "Purchase price",
    noi: "NOI",
    annual_rent: "Annual rent",
    total_equity: "Equity",
    annual_debt_service: "Debt service",
  };
  return map[key] ?? key.replace(/_/g, " ");
}

export function buildPayload(
  event: UnderwritingEvent,
  outcome: ThresholdOutcome,
  flavour: WebhookFlavour,
  detail: WebhookDetail,
): Record<string, unknown> {
  const link = dealLink(event.dealId);
  const rows = facts(event, outcome, detail);
  const headline = `${VERDICT_EMOJI[outcome.verdict]} ${event.dealName} — underwriting ${VERDICT_TEXT[outcome.verdict].toLowerCase()}`;

  if (flavour === "slack") {
    // `text` is mandatory: it is what Slack shows in a notification and in any
    // surface that cannot render blocks. `blocks` is the rich rendering.
    return {
      text: headline,
      blocks: [
        { type: "section", text: { type: "mrkdwn", text: `*${headline}*` } },
        {
          type: "section",
          fields: rows.map((f) => ({ type: "mrkdwn", text: `*${f.label}*\n${f.value}` })),
        },
        {
          type: "section",
          text: { type: "mrkdwn", text: outcome.reasons.map((r) => `• ${r}`).join("\n") },
        },
        {
          type: "actions",
          elements: [
            {
              type: "button",
              text: { type: "plain_text", text: "Open in Meridian" },
              url: link,
            },
          ],
        },
      ],
    };
  }

  if (flavour === "teams") {
    return {
      "@type": "MessageCard",
      "@context": "https://schema.org/extensions",
      summary: headline,
      themeColor: VERDICT_COLOUR[outcome.verdict],
      title: headline,
      sections: [
        {
          facts: rows.map((f) => ({ name: f.label, value: f.value })),
          text: outcome.reasons.join("<br>"),
        },
      ],
      potentialAction: [
        { "@type": "OpenUri", name: "Open in Meridian", targets: [{ os: "default", uri: link }] },
      ],
    };
  }

  // Generic: a plain, stable JSON document. No presentation, no vendor shape.
  const payload: Record<string, unknown> = {
    event: "deal.underwritten",
    verdict: outcome.verdict,
    reasons: outcome.reasons,
    deal: { id: event.dealId, name: event.dealName, status: event.status },
    link,
    sentAt: new Date().toISOString(),
  };
  if (detail !== "summary") {
    payload.deal = {
      ...(payload.deal as Record<string, unknown>),
      community: event.community ?? null,
      currency: event.currency ?? null,
      modelName: event.modelName ?? null,
      runId: event.runId ?? null,
    };
    payload.thresholds = outcome.checks;
    payload.metrics = Object.fromEntries(rows.map((f) => [f.label, f.value]));
  }
  return payload;
}

// ---------------------------------------------------------------- delivery --

export interface WebhookResult {
  ok: boolean;
  /** false when there is no configured destination — not a failure. */
  attempted: boolean;
  status?: number;
  error?: string;
  durationMs: number;
  flavour?: WebhookFlavour;
}

/**
 * The only place in this module that opens a socket. It resolves, always: a
 * refused connection, a timeout, a 500 and a malformed URL all come back as
 * `{ ok: false }`. Nothing here rejects, so no caller can be broken by it.
 */
export async function post(
  target: WebhookTarget,
  body: unknown,
  options: { timeoutMs?: number } = {},
): Promise<WebhookResult> {
  const started = Date.now();
  const limit = options.timeoutMs ?? timeoutMs();
  try {
    const res = await fetch(target.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": "Meridian-Webhook/1",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(limit),
      redirect: "manual",
    });
    // Drain the body so the socket is released promptly; the content is of no
    // interest to us beyond the status code.
    await res.text().catch(() => "");
    const ok = res.status >= 200 && res.status < 300;
    if (!ok) {
      console.error(`[notify] webhook returned HTTP ${res.status} from ${safeHost(target.url)}`);
    }
    return {
      ok,
      attempted: true,
      status: res.status,
      durationMs: Date.now() - started,
      flavour: target.flavour,
      error: ok ? undefined : `HTTP ${res.status}`,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[notify] webhook delivery to ${safeHost(target.url)} failed: ${message}`);
    return {
      ok: false,
      attempted: true,
      error: message,
      durationMs: Date.now() - started,
      flavour: target.flavour,
    };
  }
}

function safeHost(url: string): string {
  // Never log the full URL: a Slack hook URL is a bearer credential.
  try {
    return new URL(url).host;
  } catch {
    return "(invalid url)";
  }
}

/** Awaited delivery, for the operator's test route. Never rejects. */
export async function deliverUnderwritingResult(
  event: UnderwritingEvent,
  options: { force?: boolean; timeoutMs?: number } = {},
): Promise<WebhookResult> {
  const started = Date.now();
  try {
    const target = webhookTarget();
    if (!target) return { ok: false, attempted: false, durationMs: 0, error: "No webhook URL configured" };

    const outcome = evaluateThresholds(event);
    if (!options.force && !shouldNotify(outcome)) {
      return { ok: true, attempted: false, durationMs: Date.now() - started };
    }

    const detail = webhookDetail();
    return await post(target, buildPayload(event, outcome, target.flavour, detail), options);
  } catch (err) {
    // Building a payload should not be able to throw, but if it ever does it
    // must not escape into an underwriting request.
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[notify] webhook dispatch aborted: ${message}`);
    return { ok: false, attempted: false, error: message, durationMs: Date.now() - started };
  }
}

/**
 * The call site inside the request path. Synchronous, returns immediately, and
 * cannot throw or reject — the underwriting response is already on its way out
 * while this is still in flight.
 */
export function notifyUnderwritingComplete(event: UnderwritingEvent): void {
  try {
    if (!webhookTarget()) return; // no destination, no request, no cost
    void deliverUnderwritingResult(event).catch((err: unknown) => {
      console.error("[notify] unreachable: delivery rejected", err);
    });
  } catch (err) {
    console.error("[notify] could not schedule webhook delivery", err);
  }
}

/**
 * A ping the operator can fire from the admin route. Carries no deal data at
 * all, so verifying a destination never discloses a live deal to it.
 */
export async function sendTestPing(context: { organization?: string; by?: string } = {}): Promise<WebhookResult> {
  const target = webhookTarget();
  if (!target) return { ok: false, attempted: false, durationMs: 0, error: "No webhook URL configured" };

  const text = "Meridian webhook test — if you can read this, delivery works.";
  const detail = webhookDetail();
  const body =
    target.flavour === "slack"
      ? {
          text,
          blocks: [{ type: "section", text: { type: "mrkdwn", text: `*${text}*` } }],
        }
      : target.flavour === "teams"
        ? {
            "@type": "MessageCard",
            "@context": "https://schema.org/extensions",
            summary: text,
            themeColor: VERDICT_COLOUR.pass,
            title: "Meridian webhook test",
            sections: [{ text }],
          }
        : {
            event: "webhook.test",
            message: text,
            organization: context.organization ?? null,
            requestedBy: context.by ?? null,
            detailLevel: detail,
            sentAt: new Date().toISOString(),
          };

  return post(target, body);
}

/**
 * A bare JSON POST to an operator-configured endpoint, used for password-reset
 * delivery. Same guarantees: never rejects, short timeout, failures logged.
 * The URL is never taken from user input.
 */
export async function deliverJson(rawUrl: string, body: unknown): Promise<WebhookResult> {
  const target = webhookTarget(rawUrl);
  if (!target) return { ok: false, attempted: false, durationMs: 0, error: "No delivery URL configured" };
  return post(target, body);
}
