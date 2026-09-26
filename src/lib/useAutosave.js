// Shared autosave for the per-item editors (Notes, Places, Combos, Recap).
//
// Without this, typing only changes React state — nothing persists until the
// player remembers to hit Save. Switching tabs, picking a different item, or
// just closing the app mid-edit threw the words away. This hook debounces a
// save shortly after a change and flushes immediately whenever the edit is
// about to become unreachable: switching to a different document, the view
// unmounting (tab switch), the window losing focus, the tab hiding, or the
// page unloading.
//
// Usage: call once per render with the *current* item's id and a plain
// snapshot of just the fields you want persisted (not the whole document —
// e.g. a session's recap only autosaves {title, summary}, never `activity`).
//
//   const autosave = useAutosave({
//     id: selected?._id ?? null,
//     snapshot: selected && { title: selected.title, content: selected.content },
//     onSave: (id, snap) => api.update('notes', id, snap),
//     onSaved: (id, updated) => patchLocal(id, { updatedAt: updated.updatedAt })
//   });
//
// `onSaved` should only copy back fields the player couldn't have changed
// since the save started (updatedAt is the safe one) — copying the whole
// server doc back can revert something typed while the request was in
// flight.
import { useEffect, useRef, useState } from 'react';

function sameFields(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function useAutosave({ id, snapshot, onSave, onSaved, delay = 600 }) {
  const [status, setStatus] = useState('');

  const idRef = useRef(id);
  // The most recently rendered snapshot for whichever id `idRef` currently
  // points at. Only updated in-place while `id` stays the same (see the
  // guard below) — while `id` itself is changing this render, this still
  // holds the OLD document's last value, which the id-switch effect below
  // needs in order to flush it before rebinding to the new one.
  const snapshotRef = useRef(snapshot);
  const baselineRef = useRef(snapshot); // last-saved (or last-loaded) snapshot
  const deletedRef = useRef(new Set());
  const timerRef = useRef(null);
  const retryRef = useRef(null);
  const retryCountRef = useRef(0);

  const onSaveRef = useRef(onSave);
  const onSavedRef = useRef(onSaved);
  onSaveRef.current = onSave;
  onSavedRef.current = onSaved;

  if (idRef.current === id) {
    snapshotRef.current = snapshot;
  }

  function clearDebounce() {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
  }

  function clearRetry() {
    if (retryRef.current) clearTimeout(retryRef.current);
    retryRef.current = null;
  }

  // Saves whatever is pending for the currently-bound id, if anything
  // actually differs from the last-saved snapshot. Safe to call any number
  // of times (a no-op when there's nothing dirty) and safe to call from an
  // unmount cleanup or a window event — everything it reads comes from refs,
  // never from a closure captured at render time, so it can't act on stale
  // data.
  async function flush() {
    clearDebounce();
    clearRetry();
    const flushId = idRef.current;
    const current = snapshotRef.current;
    const baseline = baselineRef.current;
    if (flushId == null || current == null) return;
    if (deletedRef.current.has(flushId)) return; // don't resurrect a deleted doc
    if (sameFields(current, baseline)) return; // nothing to save — don't bump updatedAt for no reason
    if (!onSaveRef.current) return;
    await save(flushId, current);
  }

  // Writes one exact snapshot for one id. Kept separate from flush so a
  // failed save retries *that* document even if the player has since opened
  // another one — flush would pick up the new id and drop the old edits.
  async function save(flushId, current) {
    setStatus('Saving…');
    try {
      const updated = await onSaveRef.current(flushId, current);
      if (deletedRef.current.has(flushId)) return; // deleted while the save was in flight
      retryCountRef.current = 0;
      // After a switch the baseline belongs to the newly opened document;
      // overwriting it here would make that one look edited and re-save it.
      if (idRef.current === flushId) baselineRef.current = current;
      onSavedRef.current?.(flushId, updated, current);
      setStatus('Saved ✓');
      setTimeout(() => setStatus((s) => (s === 'Saved ✓' ? '' : s)), 1500);
    } catch (e) {
      if (deletedRef.current.has(flushId)) return;
      retryCountRef.current += 1;
      if (retryCountRef.current > 5) {
        setStatus(`Couldn't save: ${e.message}`);
        return;
      }
      setStatus('Couldn’t save — retrying');
      retryRef.current = setTimeout(() => {
        retryRef.current = null;
        // Still on the same document: flush picks up anything typed since.
        if (idRef.current === flushId) flush();
        else save(flushId, current);
      }, 3000);
    }
  }

  // Switching to a different document: flush whatever was pending under the
  // OLD id first (using its own baseline/snapshot, captured above), then
  // adopt the new id's own current value as the fresh baseline — so merely
  // opening a document is never itself treated as an edit.
  useEffect(() => {
    if (idRef.current !== id) {
      flush();
      idRef.current = id;
      snapshotRef.current = snapshot;
      baselineRef.current = snapshot;
      retryCountRef.current = 0;
      clearDebounce();
      clearRetry();
      setStatus('');
    }
    // flush/snapshot intentionally excluded: this effect only reacts to `id`
    // changing, and always reads the latest snapshot via snapshotRef.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // Debounce: (re)start the timer whenever the current snapshot differs from
  // the baseline. Skipped while `id` is mid-switch — the effect above handles
  // that case by flushing immediately instead.
  useEffect(() => {
    if (id == null || idRef.current !== id) return;
    if (sameFields(snapshot, baselineRef.current)) return;
    clearDebounce();
    timerRef.current = setTimeout(flush, delay);
    return clearDebounce;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, JSON.stringify(snapshot), delay]);

  // Flush on unmount (tab switch away from this view) and whenever the
  // window loses focus, the tab is hidden, or the page is about to close —
  // all the ways an edit can otherwise vanish unsaved.
  useEffect(() => {
    function onFlushEvent() {
      flush();
    }
    window.addEventListener('blur', onFlushEvent);
    window.addEventListener('beforeunload', onFlushEvent);
    document.addEventListener('visibilitychange', onFlushEvent);
    return () => {
      window.removeEventListener('blur', onFlushEvent);
      window.removeEventListener('beforeunload', onFlushEvent);
      document.removeEventListener('visibilitychange', onFlushEvent);
      flush();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Call right before (or right after starting) removing the document, so a
  // debounce timer or an in-flight save that lands afterwards can't recreate
  // it via an update call.
  function markDeleted(deletedId) {
    deletedRef.current.add(deletedId);
    clearDebounce();
    clearRetry();
    if (idRef.current === deletedId) setStatus('');
  }

  // Rolls back a markDeleted call whose delete request actually failed (a
  // transient SQLite/IPC error, not "already gone"). Without this, calling
  // markDeleted up front — needed so a debounced save in flight can't
  // recreate a doc that's about to be removed — would otherwise permanently
  // disable autosave for that id if the removal itself never went through.
  function unmarkDeleted(deletedId) {
    deletedRef.current.delete(deletedId);
  }

  // For a field that was saved through some OTHER call than this hook's own
  // onSave (e.g. an AI-generated summary, written straight away rather than
  // debounced) — merges just those field(s) into the baseline so autosave
  // doesn't immediately re-save the same value again, without marking fields
  // it didn't touch (e.g. a still-unsaved title) as saved too.
  function markSaved(partialBaseline) {
    if (idRef.current == null) return;
    baselineRef.current = { ...baselineRef.current, ...partialBaseline };
  }

  return { status, flush, markDeleted, unmarkDeleted, markSaved };
}
