// Every save that's still on its way to the database, so something about to
// reload the window (switching campaign) can wait for them all to land first
// instead of guessing how long a write takes. Autosave (useAutosave.js) and
// the campaign rename box register their writes here.

const pending = new Set();

// Registers a save and hands the same promise back, so callers can write
// `await trackSave(api.update(...))` without changing what they await.
export function trackSave(promise) {
  pending.add(promise);
  const done = () => pending.delete(promise);
  promise.then(done, done);
  return promise;
}

// Resolves once every save registered so far has finished, whether it
// succeeded or failed — a failed save has already shown its own error.
export async function waitForPendingSaves() {
  while (pending.size) {
    await Promise.allSettled([...pending]);
  }
}
