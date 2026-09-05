/* Revision checks intentionally stop at a conflict instead of overwriting another device. */
function usePlannerSync(services, user, weekKey, defaults) {
  const { useEffect, useRef, useState } = React;
  const [view, setView] = useState({ uid: null, data: PlannerData.normalize({}, weekKey, defaults), ready: false, status: 'Loading…' });
  const session = useRef(null);
  const uid = user?.uid || null;
  useEffect(() => {
    const state = { uid, active: true, ready: false, dirty: false, busy: false, version: 0, blocked: false, timer: null };
    session.current = state;
    const publish = () => state.active && setView({ uid, data: state.data || PlannerData.normalize({}, weekKey, defaults), ready: state.ready, status: state.status });
    state.status = 'Loading…';
    publish();
    if (!services || !uid) return () => { state.active = false; };
    const db = services.getFirestore();
    const ref = services.doc(db, 'users', uid, 'planner', 'main');
    const valid = () => state.active && services.auth.currentUser?.uid === uid;
    const accept = snapshot => {
      if (!valid() || snapshot.metadata?.hasPendingWrites || snapshot.metadata?.fromCache || state.dirty || state.busy) return;
      const saved = snapshot.exists() ? snapshot.data() : {};
      if (saved.deleting) { state.ready = false; state.status = 'Account deletion in progress'; publish(); return; }
      state.base = PlannerData.fingerprint(saved);
      state.data = PlannerData.normalize(saved, weekKey, defaults);
      state.ready = true;
      state.status = 'Saved';
      if (saved.revision === undefined || !saved.routineWeeks) {
        state.dirty = true;
        state.version++;
        state.status = 'Saving…';
        state.timer = setTimeout(() => state.save(), 0);
      }
      publish();
    };
    state.save = async () => {
      if (!valid() || !state.ready || !state.dirty || state.busy || state.blocked) return;
      clearTimeout(state.timer);
      state.busy = true;
      state.status = 'Saving…';
      publish();
      const data = PlannerData.clone(state.data), base = state.base, version = state.version;
      try {
        await services.runTransaction(db, async transaction => {
          if (!valid()) throw new Error('session-ended');
          const snapshot = await transaction.get(ref);
          if (!valid()) throw new Error('session-ended');
          const remote = snapshot.exists() ? snapshot.data() : {};
          if (remote.deleting) throw new Error('conflict');
          if (PlannerData.fingerprint(remote) !== base) throw new Error('conflict');
          transaction.set(ref, { ...data, routine: PlannerData.weekBoard(data, weekKey), revision: (remote.revision || 0) + 1, updatedAt: services.serverTimestamp() }, { merge: true });
        });
        if (!valid()) return;
        state.base = PlannerData.fingerprint({ ...data, routine: PlannerData.weekBoard(data, weekKey) });
        state.dirty = version !== state.version;
        state.status = state.dirty ? 'Saving…' : 'Saved';
      } catch (error) {
        if (!valid()) return;
        state.blocked = error.message === 'conflict';
        state.status = state.blocked ? 'Changed on another device — reload to resolve' : 'Couldn’t save — retry when connected';
      } finally {
        state.busy = false;
        publish();
      }
      if (state.dirty && state.status === 'Saving…') state.save();
      else if (!state.dirty && valid()) services.getDocFromServer(ref).then(accept).catch(() => {});
    };
    state.reload = async () => {
      if (state.busy || !valid()) return;
      try {
        const snapshot = await services.getDocFromServer(ref);
        if (!valid()) return;
        state.dirty = false; state.blocked = false;
        accept(snapshot);
      } catch { state.status = 'Couldn’t load — retry when connected'; publish(); }
    };
    const unsubscribe = services.onSnapshot(ref, { includeMetadataChanges: true }, accept, () => {
      if (!valid()) return;
      if (state.blocked) return;
      state.status = state.dirty ? 'Couldn’t save — retry when connected' : 'Couldn’t load — retry when connected';
      publish();
    });
    const loadTimeout = setTimeout(() => {
      if (valid() && !state.ready) { state.status = 'Couldn’t load — check your connection and retry'; publish(); }
    }, 15000);
    const offline = () => {
      if (state.blocked || !valid()) return;
      state.status = state.ready ? 'Couldn’t save — offline; keep this tab open' : 'Couldn’t load — offline';
      publish();
    };
    const online = () => { if (state.dirty) state.save(); else state.reload(); };
    window.addEventListener('online', online);
    window.addEventListener('offline', offline);
    const unload = event => { if (state.dirty) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', unload);
    return () => { state.active = false; clearTimeout(state.timer); clearTimeout(loadTimeout); unsubscribe(); window.removeEventListener('beforeunload', unload); window.removeEventListener('online', online); window.removeEventListener('offline', offline); };
    // The migration anchor belongs to this login session, not the week being viewed.
  }, [services, uid]);
  const change = updater => {
    const state = session.current;
    if (!state?.active || state.uid !== uid || !state.ready || state.blocked) return;
    state.data = updater(state.data);
    state.dirty = true; state.version++;
    state.status = 'Saving…';
    setView({ uid, data: state.data, ready: true, status: state.status });
    clearTimeout(state.timer);
    state.timer = setTimeout(state.save, 600);
  };
  return {
    data: view.uid === uid ? view.data : PlannerData.normalize({}, weekKey, defaults),
    ready: view.uid === uid && view.ready,
    status: view.uid === uid ? view.status : 'Loading…',
    change,
    pending: () => !!session.current?.dirty || !!session.current?.busy,
    retry: () => session.current?.dirty ? session.current.save() : session.current?.reload(),
    reload: () => session.current?.reload(),
    pause: () => { if (session.current) { session.current.blocked = true; clearTimeout(session.current.timer); } },
    resume: () => { if (session.current) session.current.blocked = false; }
  };
}
