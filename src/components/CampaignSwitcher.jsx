// Compact campaign dropdown, meant for the Map toolbar (see MapView.jsx).
// The richer campaign manager (create/rename/delete) lives in its own card
// at the top of Settings — this is just "switch, or go there".
import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { waitForPendingSaves } from '../lib/pendingSaves.js';

// Shared by this dropdown and the Campaigns card in Settings, so both switch
// the same way: flip the active campaign in the registry, then reload so
// every view mounts fresh against the new database — there's no per-view
// "campaign changed" plumbing to keep in sync otherwise. Returns false (and
// skips the reload) if `id` was already the active campaign.
//
// Before reloading it waits for every save still in flight — an autosave
// from the view you just left (it flushes as it unmounts), or a campaign
// rename — because a reload would otherwise cut them off. See pendingSaves.js.
export async function switchCampaign(id) {
  await waitForPendingSaves();
  const changed = await api.campaigns.switchTo(id);
  if (!changed) return false;
  await waitForPendingSaves();
  window.location.reload();
  return true;
}

const MANAGE_VALUE = '__manage__';

// `onManage`, when given, adds a "Manage campaigns…" entry that hands off to
// Settings instead of switching — left out where the host has no way to
// change tabs.
export default function CampaignSwitcher({ onManage, className = '' }) {
  const [list, setList] = useState(null);
  const [activeId, setActiveId] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    Promise.all([api.campaigns.list(), api.campaigns.active()])
      .then(([campaignList, active]) => {
        if (cancelled) return;
        setList(campaignList);
        setActiveId(active._id);
      })
      .catch((e) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) return <span className="status-text campaign-switcher-error" title={error}>⚠ campaigns</span>;
  if (!list || !activeId) return null; // still loading — the toolbar just doesn't show it yet

  function onChange(e) {
    const value = e.target.value;
    if (value === MANAGE_VALUE) {
      e.target.value = activeId; // snap the select back before handing off
      onManage?.();
      return;
    }
    setActiveId(value); // optimistic — a reload follows almost immediately anyway
    switchCampaign(value).catch((err) => setError(err.message));
  }

  return (
    <select className={`btn campaign-switcher ${className}`} value={activeId} onChange={onChange} title="Switch campaign">
      {list.map((c) => (
        <option key={c._id} value={c._id}>{c.name}</option>
      ))}
      {onManage && <option value={MANAGE_VALUE}>Manage campaigns…</option>}
    </select>
  );
}
