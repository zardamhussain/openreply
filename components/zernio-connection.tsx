"use client";

'use client';

import { useI18n } from "@/lib/i18n/provider";
import { useCallback, useEffect, useState } from 'react';
import { zernioLink } from '@/lib/zernio-links';

type ZernioAccount = { id: string; username: string; platformUserId: string; connected?: boolean };

export type ConnectionData = {
  id: string;
  label?: string | null;
  profileId?: string | null;
  webhookReady?: boolean;
  profiles: { id: string; name: string }[];
  accounts: ZernioAccount[];
  threadsAccounts: ZernioAccount[];
};

type ConnectionList = { configured: boolean; connections: ConnectionData[] };

// What the user is editing for one connection.
export type Draft = { label: string; profileId: string };

type Act = (args: { path?: string; method: string; body?: unknown }) => Promise<void>;

/**
 * One Zernio connection: its own name, profile, webhook and accounts.
 *
 * A workspace can hold several connections, so each one is a card the user
 * can name. Without a name the cards are told apart by position, which is
 * useless once there is more than one.
 */
export function ZernioConnectionCard({
  connection,
  draft,
  busy,
  onDraftChange,
  onAct,
}: {
  connection: ConnectionData;
  draft: Draft;
  busy: boolean;
  onDraftChange: (draft: Draft) => void;
  onAct: Act;
}) {
  const { t } = useI18n();
  const profileName = connection.profiles.find(p => p.id === connection.profileId)?.name;
  // The name the user gave it wins, then the Zernio profile name, then a
  // plain fallback.
  const title = draft.label.trim() || profileName || t("Zernio connection");
  const connectedCount =
    connection.accounts.filter(a => a.connected).length +
    connection.threadsAccounts.filter(a => a.connected).length;

  return (
    <div className="rounded-xl border border-border p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-sm font-semibold">{title}</p>
        <p className="text-xs">
          {connection.webhookReady ? t("Webhook ready") : t("Setup needed")}
          {connectedCount > 0 ? ` · ${t("{count} connected", { count: connectedCount })}` : ''}
        </p>
      </div>

      <form className="mt-3 space-y-3" onSubmit={e => { e.preventDefault(); void onAct({ method: 'PUT', body: { connectionId: connection.id, profileId: draft.profileId, label: draft.label } }); }}>
        <div>
          <label htmlFor={`zernio-label-${connection.id}`} className="block text-sm font-medium">{t("Connection name")}</label>
          <input id={`zernio-label-${connection.id}`} value={draft.label} onChange={e => onDraftChange({ ...draft, label: e.target.value })} placeholder={t("e.g. photogpt")} maxLength={120} className="mt-1 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground" />
          <p className="mt-1 text-xs leading-5">{t("A name for you to recognise this key. Only you see it.")}</p>
        </div>
        <div>
          <label htmlFor={`zernio-profile-${connection.id}`} className="block text-sm font-medium">{t("Zernio profile")}</label>
          <select id={`zernio-profile-${connection.id}`} value={draft.profileId} onChange={e => onDraftChange({ ...draft, profileId: e.target.value })} required className="mt-1 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground"><option value="">{t("Select a profile")}</option>{connection.profiles.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
          {!connection.profiles.length && <p className="mt-1 text-sm">{t("Create a profile in Zernio, then refresh this page.")}</p>}
        </div>
        <button disabled={busy || !draft.profileId} className="bg-accent px-4 py-3 text-sm font-medium text-white transition-colors hover:bg-accent-hover disabled:opacity-50">{busy ? t("Configuring…") : connection.webhookReady && draft.profileId === connection.profileId ? t("Repair webhook connection") : t("Save profile and configure webhook")}</button>
      </form>

      {connection.webhookReady && <>
        <div className="mt-4 space-y-2 border-t border-border pt-4">
          <p className="text-sm font-medium">{t("Instagram accounts")}</p>
          {connection.accounts.map(a => <div key={a.id} className="flex flex-wrap items-center justify-between gap-3 text-sm"><span>@{a.username}</span><button disabled={busy || a.connected} onClick={() => void onAct({ path: 'accounts', method: 'POST', body: { connectionId: connection.id, accountId: a.id, platform: 'instagram' } })} className="rounded-lg border border-border bg-surface px-3 py-2 text-foreground disabled:opacity-50">{a.connected ? t("Connected") : t("Use in OpenReply")}</button></div>)}
          {!connection.accounts.length && <p className="text-sm">{t("No Instagram account in this profile yet.")}</p>}
          <button disabled={busy} onClick={() => void onAct({ path: 'connect', method: 'POST', body: { connectionId: connection.id, platform: 'instagram' } })} className="rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground disabled:opacity-50">{t("Connect an Instagram account")}</button>
          <p className="text-xs leading-5">{t("After connecting Instagram, return here and select it for OpenReply. Keep Zernio automations off for these campaigns to avoid sending twice.")}</p>
        </div>
        <div className="mt-4 space-y-2 border-t border-border pt-4">
          <p className="text-sm font-medium">{t("Threads accounts")}</p>
          {connection.threadsAccounts.map(a => <div key={a.id} className="flex flex-wrap items-center justify-between gap-3 text-sm"><span>@{a.username}</span><button disabled={busy || a.connected} onClick={() => void onAct({ path: 'accounts', method: 'POST', body: { connectionId: connection.id, accountId: a.id, platform: 'threads' } })} className="rounded-lg border border-border bg-surface px-3 py-2 text-foreground disabled:opacity-50">{a.connected ? t("Connected") : t("Use in OpenReply")}</button></div>)}
          {!connection.threadsAccounts.length && <p className="text-sm">{t("No Threads account is connected to this Zernio profile yet.")}</p>}
          <button disabled={busy} onClick={() => void onAct({ path: 'connect', method: 'POST', body: { connectionId: connection.id, platform: 'threads' } })} className="rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground disabled:opacity-50">{t("Connect a Threads account")}</button>
          <p className="text-xs leading-5">{t("A Threads campaign answers a comment with a public reply. Keep Zernio automations off for these campaigns to avoid sending twice.")}</p>
        </div>
      </>}

      <button disabled={busy} onClick={() => { if (confirm(t("Remove the Zernio key and this OpenReply webhook? Disconnect its Instagram accounts from OpenReply first."))) void onAct({ method: 'DELETE', body: { connectionId: connection.id } }); }} className="mt-4 text-xs underline underline-offset-4 disabled:opacity-50">{t("Remove Zernio connection")}</button>
    </div>
  );
}

export function ZernioConnection({ canManage }: { canManage: boolean }) {
  const { t } = useI18n();
  const [data, setData] = useState<ConnectionList | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [adding, setAdding] = useState(false);
  // The name and the profile belong to one connection, so both are kept per
  // connection id.
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});

  const applyConnections = useCallback((connections: ConnectionData[]) => {
    setData({ configured: connections.length > 0, connections });
    setDrafts(current => {
      const next = { ...current };
      for (const connection of connections) {
        if (next[connection.id] === undefined) {
          next[connection.id] = {
            label: connection.label ?? '',
            profileId: connection.profileId ?? '',
          };
        }
      }
      return next;
    });
  }, []);

  const refresh = useCallback(async () => {
    const response = await fetch('/api/zernio/settings', { cache: 'no-store' });
    const result = await response.json();
    if (!result.success) throw new Error(result.error);
    applyConnections(result.data.connections ?? []);
  }, [applyConnections]);

  useEffect(() => {
    if (!canManage) return;
    void fetch('/api/zernio/settings', { cache: 'no-store' })
      .then(r => r.json())
      .then(result => {
        if (!result.success) throw new Error(result.error);
        applyConnections(result.data.connections ?? []);
      })
      .catch(e => setError(e instanceof Error ? e.message : "Could not load connection."));
  }, [canManage, applyConnections]);

  async function act({ path = 'settings', method, body }: { path?: string; method: string; body?: unknown }) {
    setBusy(true); setError('');
    try {
      const response = await fetch(`/api/zernio/${path}`, { method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
      const result = await response.json();
      if (!result.success) throw new Error(result.error);
      setApiKey('');
      if (result.data?.authUrl) { window.location.assign(result.data.authUrl); return; }
      if (path === 'accounts') { window.location.reload(); return; }
      setAdding(false);
      await refresh();
    } catch (e) { setError(e instanceof Error ? e.message : t("Could not update connection.")); }
    finally { setBusy(false); }
  }

  const connections = data?.connections ?? [];

  return (
    <section id="zernio-connection" className="panel rounded p-4 sm:p-6" aria-labelledby="zernio-heading">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h2 id="zernio-heading" className="text-base font-semibold">{t("Zernio connection")}</h2>
        <p className="flex flex-wrap gap-x-4 text-sm">
          <a className="underline underline-offset-4" href={zernioLink({ path: '/signup', placement: 'settings-signup' })} target="_blank" rel="noopener noreferrer">{t("Get a Zernio API key")}</a>
          <a className="underline underline-offset-4" href={zernioLink({ path: '/pricing', placement: 'settings-pricing' })} target="_blank" rel="noopener noreferrer">{t("View pricing")}</a>
        </p>
      </div>
      <p className="mt-4 text-sm leading-6">{t("Connect Instagram and Threads accounts through Zernio. OpenReply registers the webhook and runs your campaigns on your own infrastructure.")}</p>
      {!canManage ? <p className="mt-4 text-sm">{t("Ask your workspace owner or admin to configure Zernio.")}</p> : <>
        {error && <p role="alert" className="mt-4 rounded border border-error/30 bg-surface p-3 text-sm text-error">{error === "Could not load connection." ? t("Could not load connection.") : error}</p>}

        <div className="mt-5 space-y-4">
          {connections.map(connection => (
            <ZernioConnectionCard
              key={connection.id}
              connection={connection}
              draft={drafts[connection.id] ?? { label: '', profileId: '' }}
              busy={busy}
              onDraftChange={draft => setDrafts(current => ({ ...current, [connection.id]: draft }))}
              onAct={act}
            />
          ))}

          {adding && <div className="rounded-xl border border-border p-4">
            <p className="text-sm font-semibold">{t("Add a Zernio connection")}</p>
            <form className="mt-3 space-y-3" onSubmit={e => { e.preventDefault(); void act({ method: 'POST', body: { apiKey } }); }}>
              <div>
                <label className="block text-sm font-medium" htmlFor="zernio-api-key">{t("Zernio API key")}</label>
                <input id="zernio-api-key" type="password" autoComplete="off" value={apiKey} onChange={e => setApiKey(e.target.value)} required className="mt-1 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground" />
                <p className="mt-1 text-xs leading-5">{t("Use an unrestricted, read-write key with Inbox access. OpenReply registers a webhook for this workspace. The key is encrypted and never shown again.")}</p>
              </div>
              <div className="flex flex-wrap gap-3">
                <button disabled={busy || !apiKey} className="bg-accent px-4 py-3 text-sm font-medium text-white transition-colors hover:bg-accent-hover disabled:opacity-50">{busy ? t("Saving…") : t("Save API key")}</button>
                <button type="button" onClick={() => setAdding(false)} className="rounded-xl border border-border bg-surface px-4 py-3 text-sm font-medium text-foreground">{t("Cancel")}</button>
              </div>
            </form>
          </div>}

          {connections.length === 0 && !adding && <div className="rounded-xl border border-border p-4">
            <p className="text-sm font-semibold">{t("Add a Zernio connection")}</p>
            <p className="mt-1 text-sm">{t("Save a Zernio API key to connect Instagram and Threads accounts through Zernio.")}</p>
            <form className="mt-3 space-y-3" onSubmit={e => { e.preventDefault(); void act({ method: 'POST', body: { apiKey } }); }}>
              <div>
                <label className="block text-sm font-medium" htmlFor="zernio-api-key-first">{t("Zernio API key")}</label>
                <input id="zernio-api-key-first" type="password" autoComplete="off" value={apiKey} onChange={e => setApiKey(e.target.value)} required className="mt-1 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground" />
                <p className="mt-1 text-xs leading-5">{t("Use an unrestricted, read-write key with Inbox access. OpenReply registers a webhook for this workspace. The key is encrypted and never shown again.")}</p>
              </div>
              <button disabled={busy || !apiKey} className="bg-accent px-4 py-3 text-sm font-medium text-white transition-colors hover:bg-accent-hover disabled:opacity-50">{busy ? t("Saving…") : t("Save API key")}</button>
            </form>
          </div>}

          {connections.length > 0 && !adding && <button disabled={busy} onClick={() => setAdding(true)} className="rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground disabled:opacity-50">{t("Add a Zernio connection")}</button>}
        </div>
      </>}
    </section>
  );
}
