"use client";

import { useCallback, useEffect, useState } from "react";
import {
  adminFetch,
  adminGet,
  adminPost,
  type AdminAuth,
  readAdminAuth,
} from "../lib/adminApi";
import { AdminConnectBar } from "../components/AdminConnectBar";

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
