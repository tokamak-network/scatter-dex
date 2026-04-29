"use client";

import { useCallback, useEffect, useState } from "react";
import {
  adminFetch,
  adminGet,
  adminPost,
  adminPut,
  type AdminAuth,
  readAdminAuth,
} from "../lib/adminApi";
import { AdminConnectBar } from "../components/AdminConnectBar";
import { formatRelative } from "../lib/format";

type AuthState = AdminAuth | null;

export default function RuntimePage() {
  const [auth, setAuth] = useState<AuthState>(null);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    setAuth(readAdminAuth());
    setHydrated(true);
  }, []);

  return (
    <div className="space-y-8">
      <header>
        <h1 className="text-2xl font-semibold">Runtime controls</h1>
        <p className="mt-1 text-sm text-[var(--color-text-muted)]">
          Operate <em>your own</em> relayer process — pause/resume, fee
          updates, drain queue, sanctions list, profile metadata. Hits the
          relayer&apos;s <code className="font-mono">/api/admin/*</code>{" "}
          endpoints (the backend keeps that naming). Your admin key and URL
          stay in <code className="font-mono">sessionStorage</code> for this
          tab only; requests go directly from your browser to the relayer.
        </p>
      </header>

      <AdminConnectBar auth={auth} onAuth={setAuth} />

      {hydrated && auth ? (
        <ConnectedSections auth={auth} />
      ) : (
        <div className="rounded-xl border border-dashed border-[var(--color-border-strong)] bg-[var(--color-surface)] p-8 text-center text-sm text-[var(--color-text-muted)]">
          Enter your relayer URL and admin key above to load the runtime
          sections. Nothing is persisted to disk.
        </div>
      )}
    </div>
  );
}

function ConnectedSections({ auth }: { auth: NonNullable<AuthState> }) {
  const [refreshTick, setRefreshTick] = useState(0);
  const refresh = useCallback(() => setRefreshTick((n) => n + 1), []);

  return (
    <div className="space-y-6">
      <StatusSection auth={auth} refreshTick={refreshTick} onChange={refresh} />
      <FeeSection auth={auth} refreshTick={refreshTick} onChange={refresh} />
      <DrainSection auth={auth} onChange={refresh} />
      <ProfileSection auth={auth} />
      <SanctionsSection auth={auth} />
      <WebhookSection auth={auth} />
      <ClaimThresholdsSection auth={auth} />
      <CrossRelayerSection auth={auth} />
      <LogsSection auth={auth} />
    </div>
  );
}

interface StatusBody {
  paused: boolean;
  relayerAddress: string;
  feeBps: number;
  ethBalance: string;
  maxGasPriceGwei: number;
  authorizeOrders: { pending: number; matched: number; total: number };
  stats: {
    totalOrders: number;
    settledOrders: number;
    successRate: number;
    avgSettleTimeMs: number;
    uptimeSince: string | number;
  };
  pendingTxs: number;
}

function StatusSection({
  auth,
  refreshTick,
  onChange,
}: {
  auth: NonNullable<AuthState>;
  refreshTick: number;
  onChange: () => void;
}) {
  const fetcher = useCallback(
    (signal: AbortSignal) =>
      adminGet<StatusBody>(auth, "/api/admin/status", signal),
    [auth.url, auth.key],
  );
  const { data, error, loading } = useAdmin(fetcher, [refreshTick]);
  const [acting, setActing] = useState<null | "pause" | "resume">(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const onToggle = async () => {
    if (!data) return;
    const next = data.paused ? "resume" : "pause";
    setActing(next);
    setActionError(null);
    try {
      await adminPost(auth, `/api/admin/${next}`);
      onChange();
    } catch (e) {
      setActionError((e as Error).message);
    } finally {
      setActing(null);
    }
  };

  return (
    <Panel
      title="Status"
      eyebrow="GET /api/admin/status"
      action={
        data ? (
          <button
            onClick={onToggle}
            disabled={!!acting}
            className={`rounded-md px-3 py-1.5 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-60 ${
              data.paused
                ? "bg-[var(--color-success)] hover:opacity-90"
                : "bg-[var(--color-warning)] hover:opacity-90"
            }`}
          >
            {acting === "pause"
              ? "Pausing…"
              : acting === "resume"
              ? "Resuming…"
              : data.paused
              ? "Resume relayer"
              : "Pause relayer"}
          </button>
        ) : null
      }
    >
      {loading && <p className="text-sm text-[var(--color-text-muted)]">Loading…</p>}
      {error && <ErrorLine text={error} />}
      {actionError && <ErrorLine text={actionError} />}
      {data && (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Cell
            label="Paused"
            value={data.paused ? "Yes" : "No"}
            tone={data.paused ? "warn" : "ok"}
          />
          <Cell label="Fee" value={`${data.feeBps} bps`} />
          <Cell
            label="ETH balance"
            value={`${formatEth(data.ethBalance)} ETH`}
          />
          <Cell label="Pending txs" value={String(data.pendingTxs)} />
          <Cell
            label="Authorize orders"
            value={`${data.authorizeOrders.pending} pending / ${data.authorizeOrders.matched} matched`}
          />
          <Cell
            label="Settled"
            value={`${data.stats.settledOrders} of ${data.stats.totalOrders}`}
          />
          <Cell
            label="Avg settle"
            value={`${Math.round(data.stats.avgSettleTimeMs)} ms`}
          />
          <Cell
            label="Max gas"
            value={`${data.maxGasPriceGwei} gwei`}
          />
        </div>
      )}
    </Panel>
  );
}

function FeeSection({
  auth,
  refreshTick,
  onChange,
}: {
  auth: NonNullable<AuthState>;
  refreshTick: number;
  onChange: () => void;
}) {
  const fetcher = useCallback(
    (signal: AbortSignal) =>
      adminGet<{ feeBps: number }>(auth, "/api/admin/status", signal).then((s) => ({
        feeBps: s.feeBps,
      })),
    [auth.url, auth.key],
  );
  const { data } = useAdmin(fetcher, [refreshTick]);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  useEffect(() => {
    if (data) setDraft(String(data.feeBps));
  }, [data]);

  const onSave = async () => {
    const trimmed = draft.trim();
    if (trimmed.length === 0) {
      setError("Enter a fee in bps before saving.");
      return;
    }
    const n = Number(trimmed);
    if (!Number.isInteger(n) || n < 0 || n > 10_000) {
      setError("feeBps must be an integer between 0 and 10000.");
      return;
    }
    setSaving(true);
    setError(null);
    setOk(null);
    try {
      const body = await adminFetch<{ oldFeeBps: number; newFeeBps: number }>(
        auth,
        "/api/admin/fee",
        { method: "PUT", body: { feeBps: n } },
      );
      setOk(`Updated ${body.oldFeeBps} → ${body.newFeeBps} bps.`);
      onChange();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Panel title="Fee" eyebrow="PUT /api/admin/fee">
      <div className="flex flex-wrap items-center gap-3">
        <input
          type="number"
          min={0}
          max={10_000}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          className="w-32 rounded-md border border-[var(--color-border-strong)] bg-white px-3 py-2 text-sm"
        />
        <span className="text-sm text-[var(--color-text-muted)]">bps</span>
        <button
          onClick={onSave}
          disabled={saving || !data || draft === String(data.feeBps)}
          className="rounded-md bg-[var(--color-primary)] px-3 py-1.5 text-sm font-medium text-white hover:bg-[var(--color-primary-hover)] disabled:cursor-not-allowed disabled:opacity-60"
        >
          {saving ? "Saving…" : "Update fee"}
        </button>
      </div>
      {error && <ErrorLine text={error} />}
      {ok && (
        <p className="mt-3 rounded-md bg-[var(--color-success-soft)] px-3 py-2 text-xs text-[var(--color-success)]">
          {ok}
        </p>
      )}
    </Panel>
  );
}

function DrainSection({
  auth,
  onChange,
}: {
  auth: NonNullable<AuthState>;
  onChange: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [draining, setDraining] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const onDrain = async () => {
    setDraining(true);
    setError(null);
    try {
      const body = await adminPost<{ authorizeOrdersCancelled: number }>(
        auth,
        "/api/admin/drain",
      );
      setResult(`Cancelled ${body.authorizeOrdersCancelled} authorize orders.`);
      setConfirming(false);
      onChange();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setDraining(false);
    }
  };

  return (
    <Panel title="Drain pending queue" eyebrow="POST /api/admin/drain">
      <p className="mb-3 text-sm text-[var(--color-text-muted)]">
        Cancels every pending authorize order in the relayer&apos;s queue.
        Useful before maintenance or before requesting exit on the registry.
        Already-submitted settlement txs are not affected.
      </p>
      {!confirming ? (
        <button
          onClick={() => {
            setResult(null);
            setError(null);
            setConfirming(true);
          }}
          className="rounded-md border border-[var(--color-warning)] bg-white px-3 py-1.5 text-sm font-medium text-[var(--color-warning)] hover:bg-[var(--color-warning-soft)]"
        >
          Drain queue…
        </button>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={onDrain}
            disabled={draining}
            className="rounded-md bg-[var(--color-warning)] px-3 py-1.5 text-sm font-medium text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {draining ? "Draining…" : "Confirm — drain"}
          </button>
          <button
            onClick={() => setConfirming(false)}
            disabled={draining}
            className="rounded-md border border-[var(--color-border-strong)] bg-white px-3 py-1.5 text-sm font-medium hover:bg-[var(--color-bg)]"
          >
            Cancel
          </button>
        </div>
      )}
      {error && <ErrorLine text={error} />}
      {result && (
        <p className="mt-3 rounded-md bg-[var(--color-success-soft)] px-3 py-2 text-xs text-[var(--color-success)]">
          {result}
        </p>
      )}
    </Panel>
  );
}

interface ProfileBody {
  name?: string;
  description?: string;
  logoUrl?: string;
  contact?: string;
  socialX?: string;
  website?: string;
}

const PROFILE_FIELDS: Array<{
  key: keyof ProfileBody;
  label: string;
  hint: string;
  multiline?: boolean;
}> = [
  { key: "name", label: "Display name", hint: "Up to 64 chars" },
  {
    key: "description",
    label: "Description",
    hint: "Up to 280 chars",
    multiline: true,
  },
  { key: "website", label: "Website", hint: "https/http/ipfs URL, ≤ 256 chars" },
  { key: "logoUrl", label: "Logo URL", hint: "https/http/ipfs URL, ≤ 256 chars" },
  { key: "contact", label: "Contact", hint: "Email or handle, ≤ 256 chars" },
  { key: "socialX", label: "X handle", hint: "Without @, ≤ 64 chars" },
];

function ProfileSection({ auth }: { auth: NonNullable<AuthState> }) {
  const fetcher = useCallback(
    (signal: AbortSignal) => adminGet<ProfileBody>(auth, "/api/admin/profile", signal),
    [auth.url, auth.key],
  );
  const { data, error: loadError } = useAdmin(fetcher, []);
  const [draft, setDraft] = useState<ProfileBody>({});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  useEffect(() => {
    if (data) setDraft(data);
  }, [data]);

  const onSave = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      await adminFetch<ProfileBody>(auth, "/api/admin/profile", {
        method: "PATCH",
        body: draft,
      });
      setSavedAt(Date.now());
    } catch (e) {
      setSaveError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Panel title="Profile metadata" eyebrow="PATCH /api/admin/profile">
      {loadError && <ErrorLine text={loadError} />}
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {PROFILE_FIELDS.map((f) => (
          <FieldInput
            key={f.key}
            label={f.label}
            hint={f.hint}
            multiline={f.multiline}
            value={draft[f.key] ?? ""}
            onChange={(v) => setDraft((d) => ({ ...d, [f.key]: v }))}
          />
        ))}
      </div>
      <div className="mt-4 flex items-center gap-3">
        <button
          onClick={onSave}
          disabled={saving}
          className="rounded-md bg-[var(--color-primary)] px-3 py-1.5 text-sm font-medium text-white hover:bg-[var(--color-primary-hover)] disabled:cursor-not-allowed disabled:opacity-60"
        >
          {saving ? "Saving…" : "Save profile"}
        </button>
        {savedAt && (
          <span className="text-xs text-[var(--color-success)]">
            Saved at {new Date(savedAt).toLocaleTimeString()}.
          </span>
        )}
      </div>
      {saveError && <ErrorLine text={saveError} />}
    </Panel>
  );
}

interface SanctionsBody {
  count: number;
  entries: Array<{ pubKeyAx: string; pubKeyAy: string }>;
}

function SanctionsSection({ auth }: { auth: NonNullable<AuthState> }) {
  const [tick, setTick] = useState(0);
  const fetcher = useCallback(
    (signal: AbortSignal) => adminGet<SanctionsBody>(auth, "/api/admin/sanctions", signal),
    [auth.url, auth.key],
  );
  const { data, error: loadError } = useAdmin(fetcher, [tick]);
  const [ax, setAx] = useState("");
  const [ay, setAy] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onAdd = async () => {
    if (!ax.trim() || !ay.trim()) {
      setError("Both pubKeyAx and pubKeyAy are required.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await adminFetch(auth, "/api/admin/sanctions", {
        method: "POST",
        body: { entries: [{ pubKeyAx: ax.trim(), pubKeyAy: ay.trim() }] },
      });
      setAx("");
      setAy("");
      setTick((n) => n + 1);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const onRemove = async (e: { pubKeyAx: string; pubKeyAy: string }) => {
    setBusy(true);
    setError(null);
    try {
      await adminFetch(auth, "/api/admin/sanctions", {
        method: "DELETE",
        body: { entries: [e] },
      });
      setTick((n) => n + 1);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel
      title="Sanctions blocklist"
      eyebrow="GET / POST / DELETE /api/admin/sanctions"
    >
      <p className="mb-3 text-sm text-[var(--color-text-muted)]">
        Operator-local EdDSA pubkey blocklist. Orders signed by a listed key
        are rejected before settlement. Distinct from the on-chain{" "}
        <code className="font-mono">SanctionsList</code> contract, which
        blocks EVM addresses.
      </p>

      {loadError && <ErrorLine text={loadError} />}

      <div className="grid grid-cols-1 gap-2 md:grid-cols-[1fr_1fr_auto]">
        <input
          type="text"
          value={ax}
          onChange={(e) => setAx(e.target.value)}
          placeholder="pubKeyAx (decimal or 0x-hex)"
          className="rounded-md border border-[var(--color-border-strong)] bg-white px-3 py-2 text-sm font-mono"
        />
        <input
          type="text"
          value={ay}
          onChange={(e) => setAy(e.target.value)}
          placeholder="pubKeyAy (decimal or 0x-hex)"
          className="rounded-md border border-[var(--color-border-strong)] bg-white px-3 py-2 text-sm font-mono"
        />
        <button
          onClick={onAdd}
          disabled={busy || !ax || !ay}
          className="rounded-md bg-[var(--color-primary)] px-3 py-2 text-sm font-medium text-white hover:bg-[var(--color-primary-hover)] disabled:cursor-not-allowed disabled:opacity-60"
        >
          Add
        </button>
      </div>
      {error && <ErrorLine text={error} />}

      <div className="mt-5">
        <div className="mb-2 text-xs uppercase tracking-wider text-[var(--color-text-subtle)]">
          {data ? `${data.count} entries` : "Loading…"}
        </div>
        {data && data.entries.length === 0 && (
          <p className="text-sm text-[var(--color-text-muted)]">
            No sanctioned pubkeys yet.
          </p>
        )}
        {data && data.entries.length > 0 && (
          <div className="overflow-hidden rounded-md border border-[var(--color-border)]">
            <table className="w-full text-xs">
              <thead className="bg-[var(--color-bg)] text-[var(--color-text-subtle)]">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">pubKeyAx</th>
                  <th className="px-3 py-2 text-left font-medium">pubKeyAy</th>
                  <th className="px-3 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {data.entries.map((e) => (
                  <tr key={`${e.pubKeyAx}-${e.pubKeyAy}`} className="border-t border-[var(--color-border)]">
                    <td className="px-3 py-2 font-mono">{shortHex(e.pubKeyAx)}</td>
                    <td className="px-3 py-2 font-mono">{shortHex(e.pubKeyAy)}</td>
                    <td className="px-3 py-2 text-right">
                      <button
                        onClick={() => onRemove(e)}
                        disabled={busy}
                        className="rounded border border-[var(--color-border-strong)] px-2 py-0.5 text-xs hover:bg-[var(--color-warning-soft)] disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        Remove
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Panel>
  );
}

interface WebhookStatusBody {
  configured: boolean;
  health: { state: "healthy" | "degraded" | null; at: number | null };
  recent: Array<{
    type: string;
    severity: "info" | "warn" | "critical";
    text: string;
    payload?: Record<string, unknown>;
    emittedAt: number;
    delivery:
      | { ok: true; status: number }
      | { ok: false; reason: string }
      | null;
  }>;
}

function WebhookSection({ auth }: { auth: NonNullable<AuthState> }) {
  const [tick, setTick] = useState(0);
  const fetcher = useCallback(
    (signal: AbortSignal) =>
      adminGet<WebhookStatusBody>(auth, "/api/admin/webhook", signal),
    [auth.url, auth.key],
  );
  const { data, error, loading } = useAdmin(fetcher, [tick]);
  const [testing, setTesting] = useState(false);
  const [testError, setTestError] = useState<string | null>(null);
  const [lastTestAt, setLastTestAt] = useState<number | null>(null);

  const onTest = async () => {
    setTesting(true);
    setTestError(null);
    try {
      await adminPost(auth, "/api/admin/webhook/test", {
        text: `Manual test from /runtime at ${new Date().toLocaleString()}`,
      });
      setLastTestAt(Date.now());
      setTick((n) => n + 1);
    } catch (e) {
      setTestError((e as Error).message);
    } finally {
      setTesting(false);
    }
  };

  return (
    <Panel
      title="Webhook alerts"
      eyebrow="GET /api/admin/webhook · POST /api/admin/webhook/test"
      action={
        data?.configured ? (
          <button
            onClick={onTest}
            disabled={testing}
            className="rounded-md bg-[var(--color-primary)] px-3 py-1.5 text-sm font-medium text-white hover:bg-[var(--color-primary-hover)] disabled:cursor-not-allowed disabled:opacity-60"
          >
            {testing ? "Sending…" : "Send test alert"}
          </button>
        ) : null
      }
    >
      <p className="mb-4 text-sm text-[var(--color-text-muted)]">
        Optional outbound webhook for health transitions and other
        significant events. Set <code className="font-mono">WEBHOOK_URL</code>{" "}
        in the relayer&apos;s <code className="font-mono">.env</code>; the URL
        itself is never echoed back to this UI. The send-test button below
        emits a synthetic <code className="font-mono">info</code> alert so you
        can verify the channel is wired before relying on it.
      </p>

      {loading && !data && (
        <p className="text-sm text-[var(--color-text-muted)]">Loading…</p>
      )}
      {error && <ErrorLine text={error} />}

      {data && (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
            <Cell
              label="Configured"
              value={data.configured ? "Yes" : "No"}
              tone={data.configured ? "ok" : "warn"}
            />
            <Cell
              label="Last health probe"
              value={data.health.state ?? "—"}
              tone={
                data.health.state === "healthy"
                  ? "ok"
                  : data.health.state === "degraded"
                  ? "warn"
                  : undefined
              }
            />
            <Cell
              label="Probed at"
              value={data.health.at ? formatRelative(data.health.at) : "—"}
            />
          </div>

          {!data.configured && (
            <p className="mt-4 rounded-md bg-[var(--color-warning-soft)] px-3 py-2 text-xs text-[var(--color-warning)]">
              No <code className="font-mono">WEBHOOK_URL</code> set on the
              relayer. Set it and restart to enable alerting; this section
              still shows recent attempts (each will record a{" "}
              <code className="font-mono">webhook URL not configured</code>{" "}
              failure until it is wired).
            </p>
          )}

          {testError && <ErrorLine text={testError} />}
          {lastTestAt && !testError && (
            <p className="mt-3 rounded-md bg-[var(--color-success-soft)] px-3 py-2 text-xs text-[var(--color-success)]">
              Test alert dispatched at {new Date(lastTestAt).toLocaleTimeString()} —
              check your channel and the table below.
            </p>
          )}

          <div className="mt-5">
            <div className="mb-2 text-xs uppercase tracking-wider text-[var(--color-text-subtle)]">
              Recent alerts ({data.recent.length})
            </div>
            {data.recent.length === 0 ? (
              <p className="text-sm text-[var(--color-text-muted)]">
                No alerts attempted yet.
              </p>
            ) : (
              <div className="overflow-hidden rounded-md border border-[var(--color-border)]">
                <table className="w-full text-xs">
                  <thead className="bg-[var(--color-bg)] text-[var(--color-text-subtle)]">
                    <tr>
                      <th className="px-3 py-2 text-left font-medium">When</th>
                      <th className="px-3 py-2 text-left font-medium">Type</th>
                      <th className="px-3 py-2 text-left font-medium">Severity</th>
                      <th className="px-3 py-2 text-left font-medium">Text</th>
                      <th className="px-3 py-2 text-left font-medium">Delivery</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.recent.map((a, i) => (
                      <tr
                        key={`${a.emittedAt}-${a.type}-${i}`}
                        className="border-t border-[var(--color-border)]"
                      >
                        <td className="px-3 py-2 text-[var(--color-text-muted)]">
                          {formatRelative(a.emittedAt)}
                        </td>
                        <td className="px-3 py-2 font-mono">{a.type}</td>
                        <td className="px-3 py-2">
                          <SeverityPill severity={a.severity} />
                        </td>
                        <td className="px-3 py-2">{a.text}</td>
                        <td className="px-3 py-2">
                          <DeliveryPill delivery={a.delivery} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </Panel>
  );
}

function SeverityPill({
  severity,
}: {
  severity: "info" | "warn" | "critical";
}) {
  const cls =
    severity === "critical"
      ? "bg-[var(--color-warning-soft)] text-[var(--color-warning)]"
      : severity === "warn"
      ? "bg-[var(--color-warning-soft)] text-[var(--color-warning)]"
      : "bg-[var(--color-success-soft)] text-[var(--color-success)]";
  return (
    <span className={`inline-block rounded px-2 py-0.5 text-[10px] font-semibold uppercase ${cls}`}>
      {severity}
    </span>
  );
}

function DeliveryPill({
  delivery,
}: {
  delivery: WebhookStatusBody["recent"][number]["delivery"];
}) {
  if (delivery === null) {
    return <span className="text-[var(--color-text-subtle)]">in flight</span>;
  }
  if (delivery.ok) {
    return (
      <span className="text-[var(--color-success)]">
        ok ({delivery.status})
      </span>
    );
  }
  return (
    <span className="text-[var(--color-warning)]" title={delivery.reason}>
      failed: {delivery.reason.slice(0, 40)}
    </span>
  );
}

interface LogRecord {
  ts: string;
  level: "debug" | "info" | "warn" | "error";
  mod: string;
  msg: string;
  meta?: Record<string, unknown>;
}

interface LogsBody {
  records: LogRecord[];
  config: {
    level: "debug" | "info" | "warn" | "error";
    bufferCap: number;
    bufferSize: number;
  };
}

type LogLevelFilter = "all" | "debug" | "info" | "warn" | "error";

interface PeerStatRow {
  peer: string;
  sent: number;
  received: number;
  settled: number;
  rejected: number;
  errored: number;
  lastAt: number | null;
}

interface TradeOfferRow {
  id: number;
  direction: "sent" | "received";
  peer_relayer: string;
  status: string;
  tx_hash: string | null;
  reason: string | null;
  created_at: number;
}

const PEER_STATS_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

function CrossRelayerSection({ auth }: { auth: NonNullable<AuthState> }) {
  const [tick, setTick] = useState(0);

  const peersFetcher = useCallback(
    (signal: AbortSignal) => {
      const since = Date.now() - PEER_STATS_WINDOW_MS;
      return adminGet<{ peers: PeerStatRow[] }>(
        auth,
        `/api/admin/peer-stats?since=${since}`,
        signal,
      );
    },
    [auth.url, auth.key],
  );
  const offersFetcher = useCallback(
    (signal: AbortSignal) =>
      adminGet<{ rows: TradeOfferRow[] }>(
        auth,
        `/api/admin/trade-offers?limit=20`,
        signal,
      ),
    [auth.url, auth.key],
  );

  const peersState = useAdmin(peersFetcher, [tick]);
  const offersState = useAdmin(offersFetcher, [tick]);

  return (
    <Panel
      title="Cross-relayer"
      eyebrow="GET /api/admin/peer-stats · /api/admin/trade-offers"
      action={
        <button
          onClick={() => setTick((n) => n + 1)}
          disabled={peersState.loading || offersState.loading}
          className="rounded-md border border-[var(--color-border-strong)] bg-white px-3 py-1.5 text-xs font-medium hover:bg-[var(--color-bg)] disabled:cursor-not-allowed disabled:opacity-60"
        >
          Refresh
        </button>
      }
    >
      <p className="mb-4 text-sm text-[var(--color-text-muted)]">
        Cross-relayer trade offers persist in <code className="font-mono">trade_offers</code>;
        this section surfaces who you've matched with, the per-peer
        settled / rejected / error split, and the most recent
        offers. Empty when running solo (no shared orderbook).
      </p>

      {peersState.error && <ErrorLine text={peersState.error} />}
      {offersState.error && <ErrorLine text={offersState.error} />}

      <div>
        <div className="mb-2 text-xs uppercase tracking-wider text-[var(--color-text-subtle)]">
          Peers (last 7 days)
        </div>
        {!peersState.data ? (
          <p className="text-sm text-[var(--color-text-muted)]">Loading…</p>
        ) : peersState.data.peers.length === 0 ? (
          <p className="text-sm text-[var(--color-text-muted)]">
            No cross-relayer activity yet. Either no shared orderbook is
            configured (set <code className="font-mono">SHARED_ORDERBOOK_URL</code>)
            or no peers have matched in the last 7 days.
          </p>
        ) : (
          <div className="overflow-hidden rounded-md border border-[var(--color-border)]">
            <table className="w-full text-xs">
              <thead className="bg-[var(--color-bg)] text-[var(--color-text-subtle)]">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">Peer</th>
                  <th className="px-3 py-2 text-right font-medium">Sent</th>
                  <th className="px-3 py-2 text-right font-medium">Received</th>
                  <th className="px-3 py-2 text-right font-medium">Settled</th>
                  <th className="px-3 py-2 text-right font-medium">Success%</th>
                  <th className="px-3 py-2 text-right font-medium">Rejected</th>
                  <th className="px-3 py-2 text-right font-medium">Error</th>
                  <th className="px-3 py-2 text-left font-medium">Last</th>
                </tr>
              </thead>
              <tbody>
                {peersState.data.peers.map((p) => {
                  const total = p.sent + p.received;
                  const successPct =
                    total > 0 ? Math.round((p.settled / total) * 100) : 0;
                  return (
                    <tr key={p.peer} className="border-t border-[var(--color-border)]">
                      <td className="px-3 py-2 font-mono">{shortHex(p.peer)}</td>
                      <td className="px-3 py-2 text-right font-mono">{p.sent}</td>
                      <td className="px-3 py-2 text-right font-mono">{p.received}</td>
                      <td className="px-3 py-2 text-right font-mono">{p.settled}</td>
                      <td className="px-3 py-2 text-right font-mono">
                        {total > 0 ? `${successPct}%` : "—"}
                      </td>
                      <td className="px-3 py-2 text-right font-mono">{p.rejected}</td>
                      <td className="px-3 py-2 text-right font-mono">{p.errored}</td>
                      <td className="px-3 py-2 text-[var(--color-text-muted)]">
                        {p.lastAt ? formatRelative(p.lastAt) : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="mt-5">
        <div className="mb-2 text-xs uppercase tracking-wider text-[var(--color-text-subtle)]">
          Recent trade offers
        </div>
        {!offersState.data ? (
          <p className="text-sm text-[var(--color-text-muted)]">Loading…</p>
        ) : offersState.data.rows.length === 0 ? (
          <p className="text-sm text-[var(--color-text-muted)]">
            No trade offers recorded.
          </p>
        ) : (
          <div className="overflow-hidden rounded-md border border-[var(--color-border)]">
            <table className="w-full text-xs">
              <thead className="bg-[var(--color-bg)] text-[var(--color-text-subtle)]">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">When</th>
                  <th className="px-3 py-2 text-left font-medium">Direction</th>
                  <th className="px-3 py-2 text-left font-medium">Peer</th>
                  <th className="px-3 py-2 text-left font-medium">Status</th>
                  <th className="px-3 py-2 text-left font-medium">Tx / Reason</th>
                </tr>
              </thead>
              <tbody>
                {offersState.data.rows.map((r) => (
                  <tr key={r.id} className="border-t border-[var(--color-border)]">
                    <td className="px-3 py-2 text-[var(--color-text-muted)]">
                      {formatRelative(r.created_at)}
                    </td>
                    <td className="px-3 py-2">{r.direction}</td>
                    <td className="px-3 py-2 font-mono">{shortHex(r.peer_relayer)}</td>
                    <td className="px-3 py-2">
                      <OfferStatusPill status={r.status} />
                    </td>
                    <td className="px-3 py-2 font-mono text-[var(--color-text-muted)]">
                      {r.tx_hash
                        ? shortHex(r.tx_hash)
                        : r.reason
                        ? r.reason
                        : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Panel>
  );
}

function OfferStatusPill({ status }: { status: string }) {
  const cls =
    status === "settled"
      ? "bg-[var(--color-success-soft)] text-[var(--color-success)]"
      : status === "rejected"
      ? "bg-[var(--color-bg)] text-[var(--color-text-muted)]"
      : "bg-[var(--color-warning-soft)] text-[var(--color-warning)]";
  return (
    <span
      className={`inline-block rounded px-2 py-0.5 text-[10px] font-semibold uppercase ${cls}`}
    >
      {status}
    </span>
  );
}

function LogsSection({ auth }: { auth: NonNullable<AuthState> }) {
  const [levelFilter, setLevelFilter] = useState<LogLevelFilter>("all");
  const [modFilter, setModFilter] = useState("");
  const [tick, setTick] = useState(0);

  const fetcher = useCallback(
    (signal: AbortSignal) => {
      const params = new URLSearchParams();
      params.set("limit", "200");
      if (levelFilter !== "all") params.set("level", levelFilter);
      if (modFilter.trim()) params.set("mod", modFilter.trim());
      return adminGet<LogsBody>(
        auth,
        `/api/admin/logs?${params.toString()}`,
        signal,
      );
    },
    [auth.url, auth.key, levelFilter, modFilter],
  );
  const { data, error, loading } = useAdmin(fetcher, [tick]);

  return (
    <Panel
      title="Logs"
      eyebrow="GET /api/admin/logs"
      action={
        <button
          onClick={() => setTick((n) => n + 1)}
          disabled={loading}
          className="rounded-md border border-[var(--color-border-strong)] bg-white px-3 py-1.5 text-xs font-medium hover:bg-[var(--color-bg)] disabled:cursor-not-allowed disabled:opacity-60"
        >
          {loading ? "Refreshing…" : "Refresh"}
        </button>
      }
    >
      <p className="mb-3 text-sm text-[var(--color-text-muted)]">
        Recent structured log records from the relayer&apos;s in-memory ring
        buffer (capped per <code className="font-mono">LOG_BUFFER_SIZE</code>,
        default 500). Stdout still emits the same JSON-line records for any
        external sink you wire up.
      </p>

      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-1">
          <span className="text-xs uppercase tracking-wider text-[var(--color-text-subtle)]">
            Level
          </span>
          {(["all", "debug", "info", "warn", "error"] as const).map((l) => (
            <button
              key={l}
              onClick={() => setLevelFilter(l)}
              className={
                levelFilter === l
                  ? "rounded-full bg-[var(--color-primary)] px-3 py-1 text-xs font-medium text-white"
                  : "rounded-full border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1 text-xs text-[var(--color-text-muted)] hover:border-[var(--color-border-strong)]"
              }
            >
              {l}
            </button>
          ))}
        </div>
        <input
          type="text"
          value={modFilter}
          onChange={(e) => setModFilter(e.target.value)}
          placeholder="mod filter (e.g. settlement-worker)"
          aria-label="Module filter"
          className="min-w-[220px] flex-1 rounded-md border border-[var(--color-border-strong)] bg-white px-3 py-1.5 text-sm font-mono"
        />
      </div>

      {error && <ErrorLine text={error} />}
      {data && data.records.length === 0 && (
        <p className="mt-4 text-sm text-[var(--color-text-muted)]">
          No records match the current filter. Buffer holds {data.config.bufferSize} of
          up to {data.config.bufferCap} entries; minimum level{" "}
          <code className="font-mono">{data.config.level}</code>.
        </p>
      )}
      {data && data.records.length > 0 && (
        <div className="mt-4 overflow-hidden rounded-md border border-[var(--color-border)]">
          <table className="w-full text-xs">
            <thead className="bg-[var(--color-bg)] text-[var(--color-text-subtle)]">
              <tr>
                <th className="px-3 py-2 text-left font-medium">Time</th>
                <th className="px-3 py-2 text-left font-medium">Level</th>
                <th className="px-3 py-2 text-left font-medium">Mod</th>
                <th className="px-3 py-2 text-left font-medium">Message</th>
                <th className="px-3 py-2 text-left font-medium">Meta</th>
              </tr>
            </thead>
            <tbody>
              {data.records.map((r, i) => (
                <tr
                  key={`${r.ts}-${r.mod}-${i}`}
                  className="border-t border-[var(--color-border)] align-top"
                >
                  <td className="px-3 py-2 font-mono text-[var(--color-text-muted)]">
                    {new Date(r.ts).toLocaleTimeString()}
                  </td>
                  <td className="px-3 py-2">
                    <LevelPill level={r.level} />
                  </td>
                  <td className="px-3 py-2 font-mono">{r.mod}</td>
                  <td className="px-3 py-2">{r.msg}</td>
                  <td className="px-3 py-2 font-mono text-[var(--color-text-subtle)]">
                    {r.meta ? JSON.stringify(r.meta) : ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {data && (
        <p className="mt-2 text-xs text-[var(--color-text-subtle)]">
          Showing {data.records.length} of {data.config.bufferSize} records · buffer cap{" "}
          {data.config.bufferCap} · min level{" "}
          <code className="font-mono">{data.config.level}</code>
        </p>
      )}
    </Panel>
  );
}

function LevelPill({ level }: { level: LogRecord["level"] }) {
  const cls =
    level === "error"
      ? "bg-[var(--color-warning-soft)] text-[var(--color-warning)]"
      : level === "warn"
      ? "bg-[var(--color-warning-soft)] text-[var(--color-warning)]"
      : level === "debug"
      ? "bg-[var(--color-bg)] text-[var(--color-text-subtle)]"
      : "bg-[var(--color-success-soft)] text-[var(--color-success)]";
  return (
    <span className={`inline-block rounded px-2 py-0.5 text-[10px] font-semibold uppercase ${cls}`}>
      {level}
    </span>
  );
}

interface ClaimThresholdsBody {
  tokens: string[];
  thresholds: Record<string, string>;
  probes: Record<
    string,
    { state: "below" | "ready"; balanceWei: string; thresholdWei: string; at: number }
  >;
}

function ClaimThresholdsSection({ auth }: { auth: NonNullable<AuthState> }) {
  const [tick, setTick] = useState(0);
  const fetcher = useCallback(
    (signal: AbortSignal) =>
      adminGet<ClaimThresholdsBody>(auth, "/api/admin/claim-thresholds", signal),
    [auth.url, auth.key],
  );
  const { data, error, loading } = useAdmin(fetcher, [tick]);
  // Pending edits — keyed by lowercase token. Cleared on save success.
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // The persisted threshold for a token is the source of truth; the
  // input shows either the in-progress draft or the saved value.
  const inputValue = (token: string): string => {
    const lc = token.toLowerCase();
    if (lc in drafts) return drafts[lc];
    return data?.thresholds[lc] ?? "0";
  };

  const dirty = Object.keys(drafts).length > 0;

  const onSave = async () => {
    if (!data) return;
    // Send the whole map so the backend's "replace" semantics give
    // us a single round-trip. Merge drafts onto the saved map first.
    const merged: Record<string, string> = { ...data.thresholds };
    for (const [k, v] of Object.entries(drafts)) merged[k] = v;
    setSaving(true);
    setSaveError(null);
    try {
      await adminPut(auth, "/api/admin/claim-thresholds", { thresholds: merged });
      setDrafts({});
      setTick((n) => n + 1);
    } catch (e) {
      setSaveError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Panel
      title="Claim reminders"
      eyebrow="GET/PUT /api/admin/claim-thresholds"
      action={
        dirty ? (
          <button
            onClick={onSave}
            disabled={saving}
            className="rounded-md bg-[var(--color-primary)] px-3 py-1.5 text-sm font-medium text-white hover:bg-[var(--color-primary-hover)] disabled:opacity-60"
          >
            {saving ? "Saving…" : "Save thresholds"}
          </button>
        ) : null
      }
    >
      <p className="mb-4 text-sm text-[var(--color-text-muted)]">
        Per-token FeeVault claim threshold. The relayer fires a{" "}
        <code className="font-mono text-xs">claim_ready</code> webhook when the
        accrued balance crosses your threshold, and a{" "}
        <code className="font-mono text-xs">claim_settled</code> info webhook
        once the balance drops back (you just claimed). Tracked tokens come
        from the <code className="font-mono text-xs">FEE_CLAIM_TOKENS</code>{" "}
        env var on the relayer.
      </p>

      {loading && <p className="text-sm text-[var(--color-text-muted)]">Loading…</p>}
      {error && <ErrorLine text={error} />}

      {data && data.tokens.length === 0 && (
        <div className="rounded-md border border-dashed border-[var(--color-border-strong)] bg-[var(--color-bg)] p-4 text-sm text-[var(--color-text-muted)]">
          No tokens are configured. Set{" "}
          <code className="font-mono text-xs">FEE_CLAIM_TOKENS</code> on the
          relayer (comma-separated 0x addresses) and restart to start
          tracking.
        </div>
      )}

      {data && data.tokens.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-[10px] uppercase tracking-wider text-[var(--color-text-subtle)]">
              <tr>
                <th className="py-2 pr-3">Token</th>
                <th className="py-2 pr-3 text-right">Claimable (wei)</th>
                <th className="py-2 pr-3 text-right">Threshold (wei)</th>
                <th className="py-2 pr-3">State</th>
                <th className="py-2">Last probe</th>
              </tr>
            </thead>
            <tbody>
              {data.tokens.map((token) => {
                const lc = token.toLowerCase();
                const probe = data.probes[lc];
                return (
                  <tr key={lc} className="border-t border-[var(--color-border)]">
                    <td className="py-2 pr-3 font-mono text-xs">{token}</td>
                    <td className="py-2 pr-3 text-right font-mono text-xs">
                      {probe?.balanceWei ?? "—"}
                    </td>
                    <td className="py-2 pr-3 text-right">
                      <input
                        type="text"
                        inputMode="numeric"
                        pattern="[0-9]*"
                        value={inputValue(token)}
                        onChange={(e) => {
                          const v = e.target.value;
                          // Only accept digits or empty (treated as 0 on save).
                          if (v !== "" && !/^[0-9]+$/.test(v)) return;
                          setDrafts((d) => ({ ...d, [lc]: v === "" ? "0" : v }));
                        }}
                        className="w-44 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 text-right font-mono text-xs focus:border-[var(--color-primary)] focus:outline-none"
                      />
                    </td>
                    <td className="py-2 pr-3">
                      {probe ? (
                        <span
                          className={
                            probe.state === "ready"
                              ? "rounded bg-[var(--color-warning-soft)] px-2 py-0.5 text-xs text-[var(--color-warning)]"
                              : "rounded bg-[var(--color-bg)] px-2 py-0.5 text-xs text-[var(--color-text-muted)]"
                          }
                        >
                          {probe.state}
                        </span>
                      ) : (
                        <span className="text-xs text-[var(--color-text-subtle)]">—</span>
                      )}
                    </td>
                    <td className="py-2 text-xs text-[var(--color-text-muted)]">
                      {probe ? formatRelative(probe.at) : "Awaiting first probe"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {saveError && <ErrorLine text={saveError} />}
    </Panel>
  );
}

function Panel({
  title,
  eyebrow,
  action,
  children,
}: {
  title: string;
  eyebrow?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          {eyebrow && (
            <div className="text-[10px] font-mono uppercase tracking-wider text-[var(--color-text-subtle)]">
              {eyebrow}
            </div>
          )}
          <h2 className="font-semibold">{title}</h2>
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

function Cell({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "ok" | "warn";
}) {
  const valueClass =
    tone === "warn"
      ? "text-[var(--color-warning)]"
      : tone === "ok"
      ? "text-[var(--color-success)]"
      : "text-[var(--color-text)]";
  return (
    <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-3">
      <div className="text-[10px] uppercase tracking-wider text-[var(--color-text-subtle)]">
        {label}
      </div>
      <div className={`mt-1 font-mono text-sm font-medium ${valueClass}`}>
        {value}
      </div>
    </div>
  );
}

function FieldInput({
  label,
  hint,
  multiline,
  value,
  onChange,
}: {
  label: string;
  hint: string;
  multiline?: boolean;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <label className={`block text-sm ${multiline ? "md:col-span-2" : ""}`}>
      <span className="font-medium">{label}</span>
      <span className="ml-2 text-xs text-[var(--color-text-subtle)]">{hint}</span>
      {multiline ? (
        <textarea
          rows={3}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="mt-1 w-full rounded-md border border-[var(--color-border-strong)] bg-white px-3 py-2 text-sm"
        />
      ) : (
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="mt-1 w-full rounded-md border border-[var(--color-border-strong)] bg-white px-3 py-2 text-sm"
        />
      )}
    </label>
  );
}

function ErrorLine({ text }: { text: string }) {
  return (
    <p className="mt-3 rounded-md bg-[var(--color-warning-soft)] px-3 py-2 text-xs text-[var(--color-warning)]">
      {text}
    </p>
  );
}

function useAdmin<T>(
  fetcher: (signal: AbortSignal) => Promise<T>,
  deps: React.DependencyList,
) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    fetcher(controller.signal)
      .then((d) => {
        if (!controller.signal.aborted) setData(d);
      })
      .catch((e) => {
        if (controller.signal.aborted) return;
        setError((e as Error).message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetcher, ...deps]);

  return { data, error, loading };
}

function formatEth(weiStr: string): string {
  try {
    const wei = BigInt(weiStr);
    const whole = wei / 10n ** 18n;
    const frac = (wei % 10n ** 18n) / 10n ** 14n;
    return `${whole}.${frac.toString().padStart(4, "0")}`;
  } catch {
    return weiStr;
  }
}

function shortHex(s: string): string {
  if (s.length <= 14) return s;
  return `${s.slice(0, 8)}…${s.slice(-6)}`;
}
