// A WebSocket being open is insufficient: consumers wait for authenticated readiness.
export function createConnectionLifecycle() {
  const listeners = new Set();
  let state = { ready: false, generation: 0, reason: 'Not connected', mode: 'paused' };
  return {
    get state() { return state; },
    update(value) { state = Object.freeze({ ...state, ...value }); for (const listener of listeners) listener(state); },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  };
}

// Requests cannot hang forever when a socket stays half open. Completion and
// disconnect both clear the deadline, so late packets cannot resolve a new request.
export class PendingRequests extends Map {
  set(id, entry) {
    if (super.has(id)) clearTimeout(super.get(id).deadline);
    entry.deadline = setTimeout(() => {
      if (this.get(id) !== entry) return;
      this.delete(id);
      entry.reject(Error('Operation timed out. A mutation may have completed; refresh before retrying.'));
    }, 30000);
    return super.set(id, entry);
  }
  delete(id) { clearTimeout(this.get(id)?.deadline); return super.delete(id); }
  clear() { for (const entry of this.values()) clearTimeout(entry.deadline); super.clear(); }
}
