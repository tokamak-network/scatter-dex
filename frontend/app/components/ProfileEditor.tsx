"use client";

import { useState } from "react";
import { User, Loader2, CheckCircle2, AlertCircle, Eye, EyeOff } from "lucide-react";
import type { RelayerProfile } from "../lib/useRelayers";

const FIELDS: Array<{ key: keyof Omit<RelayerProfile, "updatedAt">; label: string; placeholder: string; multiline?: boolean }> = [
  { key: "name",        label: "Display name",  placeholder: "Acme Relayer" },
  { key: "description", label: "Description",   placeholder: "Trustless settlement relayer for ZK orders.", multiline: true },
  { key: "logoUrl",     label: "Logo URL",      placeholder: "https://… or ipfs://…" },
  { key: "website",     label: "Website",       placeholder: "https://acme.example" },
  { key: "socialX",     label: "X handle",      placeholder: "acmerelayer" },
  { key: "contact",     label: "Contact",       placeholder: "ops@acme.example" },
];

export default function ProfileEditor() {
  const [url, setUrl] = useState("");
  const [adminKey, setAdminKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [profile, setProfile] = useState<RelayerProfile>({});
  const [busy, setBusy] = useState<"idle" | "loading" | "saving">("idle");
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const baseUrl = url.replace(/\/+$/, "");

  const load = async () => {
    if (!baseUrl || !adminKey) {
      setMsg({ kind: "err", text: "URL and admin key are required" });
      return;
    }
    setBusy("loading");
    setMsg(null);
    try {
      const res = await fetch(`${baseUrl}/api/admin/profile`, {
        headers: { "x-admin-key": adminKey },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: RelayerProfile = await res.json();
      setProfile(data);
      setMsg({ kind: "ok", text: "Loaded current profile" });
    } catch (e) {
      setMsg({ kind: "err", text: e instanceof Error ? e.message : "Load failed" });
    } finally {
      setBusy("idle");
    }
  };

  const save = async () => {
    if (!baseUrl || !adminKey) {
      setMsg({ kind: "err", text: "URL and admin key are required" });
      return;
    }
    setBusy("saving");
    setMsg(null);
    try {
      // Server sets updatedAt; strip the cached one so the client never
      // overrides it.
      const patch: RelayerProfile = { ...profile };
      delete patch.updatedAt;
      const res = await fetch(`${baseUrl}/api/admin/profile`, {
        method: "PATCH",
        headers: { "x-admin-key": adminKey, "content-type": "application/json" },
        body: JSON.stringify(patch),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
      setProfile(body);
      setMsg({ kind: "ok", text: "Saved" });
    } catch (e) {
      setMsg({ kind: "err", text: e instanceof Error ? e.message : "Save failed" });
    } finally {
      setBusy("idle");
    }
  };

  const setField = (k: keyof RelayerProfile, v: string) => setProfile((p) => ({ ...p, [k]: v }));

  return (
    <div className="bg-surface-container rounded-xl border border-outline-variant/15 p-5">
      <div className="flex items-center gap-2 mb-4">
        <User className="w-4 h-4 text-primary" />
        <h2 className="text-sm font-bold text-on-surface">Relayer profile</h2>
        <span className="text-[10px] text-on-surface-variant/40">
          Operator-set name, logo, and links shown on the dashboard.
        </span>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-4">
        <label className="text-xs">
          <span className="block text-on-surface-variant/60 mb-1">Relayer URL</span>
          <input
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="http://localhost:3001"
            className="w-full px-3 py-2 rounded-lg bg-surface border border-outline-variant/30 text-on-surface text-xs font-mono focus:outline-none focus:border-primary/50"
          />
        </label>
        <label className="text-xs">
          <span className="block text-on-surface-variant/60 mb-1">x-admin-key</span>
          <div className="relative">
            <input
              type={showKey ? "text" : "password"}
              value={adminKey}
              onChange={(e) => setAdminKey(e.target.value)}
              autoComplete="off"
              className="w-full px-3 py-2 pr-9 rounded-lg bg-surface border border-outline-variant/30 text-on-surface text-xs font-mono focus:outline-none focus:border-primary/50"
            />
            <button
              type="button"
              onClick={() => setShowKey((v) => !v)}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-on-surface-variant/50 hover:text-on-surface-variant"
              aria-label={showKey ? "Hide admin key" : "Show admin key"}
            >
              {showKey ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
            </button>
          </div>
        </label>
      </div>

      <div className="flex gap-2 mb-4">
        <button
          onClick={load}
          disabled={busy !== "idle"}
          className="px-3 py-1.5 rounded-lg bg-surface border border-outline-variant/30 text-xs text-on-surface hover:bg-surface-bright/50 transition-colors disabled:opacity-50 inline-flex items-center gap-1"
        >
          {busy === "loading" && <Loader2 className="w-3 h-3 animate-spin" />}
          Load current
        </button>
        <button
          onClick={save}
          disabled={busy !== "idle"}
          className="px-3 py-1.5 rounded-lg bg-primary text-on-primary text-xs font-semibold hover:bg-primary/90 transition-colors disabled:opacity-50 inline-flex items-center gap-1"
        >
          {busy === "saving" && <Loader2 className="w-3 h-3 animate-spin" />}
          Save
        </button>
        {msg && (
          <span
            role="status"
            aria-live="polite"
            className={`inline-flex items-center gap-1 text-xs ${
              msg.kind === "ok" ? "text-green-600" : "text-red-500"
            }`}
          >
            {msg.kind === "ok" ? <CheckCircle2 className="w-3.5 h-3.5" /> : <AlertCircle className="w-3.5 h-3.5" />}
            {msg.text}
          </span>
        )}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {FIELDS.map((f) => (
          <label key={f.key} className={`text-xs ${f.multiline ? "md:col-span-2" : ""}`}>
            <span className="block text-on-surface-variant/60 mb-1">{f.label}</span>
            {f.multiline ? (
              <textarea
                value={profile[f.key] ?? ""}
                onChange={(e) => setField(f.key, e.target.value)}
                placeholder={f.placeholder}
                rows={2}
                className="w-full px-3 py-2 rounded-lg bg-surface border border-outline-variant/30 text-on-surface text-xs focus:outline-none focus:border-primary/50"
              />
            ) : (
              <input
                type="text"
                value={profile[f.key] ?? ""}
                onChange={(e) => setField(f.key, e.target.value)}
                placeholder={f.placeholder}
                className="w-full px-3 py-2 rounded-lg bg-surface border border-outline-variant/30 text-on-surface text-xs focus:outline-none focus:border-primary/50"
              />
            )}
          </label>
        ))}
      </div>

      {profile.updatedAt && (
        <div className="mt-3 text-[10px] text-on-surface-variant/40">
          Last updated: {new Date(profile.updatedAt * 1000).toLocaleString()}
        </div>
      )}
    </div>
  );
}
