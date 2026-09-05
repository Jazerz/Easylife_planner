const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const PlannerData = require('../planner-data.js');
const source = fs.readFileSync(path.join(__dirname, '../planner-sync.js'), 'utf8');
const clone = PlannerData.clone;
const snapshot = data => ({ exists: () => data !== undefined, data: () => clone(data), metadata: {} });
function harness(database, uid = 'alice') {
  let slots = [], cursor = 0, effects = [], listeners = [], api, user = { uid }, fail = false, gate;
  let timerId = 0;
  const timers = new Map();
  const sdk = {
    auth: { currentUser: user },
    getFirestore: () => database,
    doc: (_, ...parts) => parts[1],
    serverTimestamp: () => 123,
    onSnapshot: (ref, options, accept) => { listeners.push({ref, accept}); return () => { listeners = listeners.filter(entry => entry.accept !== accept); }; },
    getDocFromServer: async ref => { if (fail) throw Error('offline'); return snapshot(database[ref]); },
    runTransaction: async (_, action) => {
      if (fail) throw Error('offline');
      let write;
      await action({ get: async ref => { if (gate) await gate; return snapshot(database[ref]); }, set: (ref, data) => { write = {ref, data}; } });
      if (write) database[write.ref] = { ...database[write.ref], ...clone(write.data) };
    }
  };
  const context = vm.createContext({
    PlannerData, setTimeout: fn => { timers.set(++timerId, fn); return timerId; }, clearTimeout: id => timers.delete(id),
    window: { addEventListener() {}, removeEventListener() {} },
    React: {
      useState: initial => { const index = cursor++; if (!(index in slots)) slots[index] = initial; return [slots[index], value => { slots[index] = typeof value === 'function' ? value(slots[index]) : value; }]; },
      useRef: value => { const index = cursor++; return slots[index] ||= { current: value }; },
      useEffect: (fn, deps) => { const index = cursor++; if (!slots[index] || deps.some((dep, i) => slots[index].deps[i] !== dep)) effects.push(() => { slots[index]?.cleanup?.(); slots[index] = {deps, cleanup: fn()}; }); }
    }
  });
  vm.runInContext(source, context);
  const render = () => { cursor = 0; api = context.usePlannerSync(sdk, user, '2026-08-31', {}); while (effects.length) effects.shift()(); return api; };
  render(); render();
  return {
    get api() { return render(); },
    emit() { listeners.forEach(entry => entry.accept(snapshot(database[entry.ref]))); },
    setOffline(value) { fail = value; },
    switchUser(value) { user = {uid: value}; sdk.auth.currentUser = user; render(); render(); },
    gate(value) { gate = value; }
  };
}
async function main() {
  const data = { revision: 1, tasks: [{id:1,name:'Original'}], routineWeeks: {}, notifications: {} };
  const db = { alice: clone(data), bob: {...clone(data), tasks: [{id:2,name:'Bob'}]} };
  const a = harness(db);
  a.api.change(value => ({...value, tasks: []}));
  assert.equal(a.api.ready, false, 'edits blocked before load');
  a.emit();
  assert.equal(a.api.ready, true);
  a.api.change(value => ({...value, tasks: [{id:1,name:'Alice edit'}]}));
  a.setOffline(true);
  await a.api.retry();
  assert.match(a.api.status, /Couldn’t save/);
  assert.equal(a.api.data.tasks[0].name, 'Alice edit', 'failed saves retain draft');
  assert.equal(db.alice.tasks[0].name, 'Original');
  a.setOffline(false);
  await a.api.retry();
  assert.equal(db.alice.tasks[0].name, 'Alice edit');
  assert.equal(a.api.status, 'Saved');
  const b = harness(db); b.emit();
  a.api.change(value => ({...value, tasks: [{id:1,name:'Device A'}]}));
  b.api.change(value => ({...value, tasks: [{id:1,name:'Device B'}]}));
  await a.api.retry(); await b.api.retry();
  assert.match(b.api.status, /Changed on another device/);
  assert.equal(db.alice.tasks[0].name, 'Device A');
  assert.equal(b.api.data.tasks[0].name, 'Device B');
  await b.api.reload();
  assert.equal(b.api.data.tasks[0].name, 'Device A');
  let release;
  a.gate(new Promise(resolve => { release = resolve; }));
  a.api.change(value => ({...value, tasks: [{id:1,name:'Stale write'}]}));
  const pending = a.api.retry();
  a.switchUser('bob'); release(); await pending;
  assert.equal(a.api.ready, false);
  assert.equal(a.api.data.tasks.length, 0, 'old data hidden before Bob loads');
  a.emit();
  assert.equal(a.api.data.tasks[0].name, 'Bob');
  assert.equal(db.alice.tasks[0].name, 'Device A', 'old session cannot write after its read');
  assert.equal(db.bob.tasks[0].name, 'Bob');
  const legacyDb = { alice: { tasks: [], routine: {Mon:[{id:3,title:'Legacy',done:true}]} } };
  const legacy = harness(legacyDb); legacy.emit(); await legacy.api.retry();
  assert.equal(legacyDb.alice.routineWeeks['2026-08-31'].Mon[0].title, 'Legacy');
  assert.equal(legacyDb.alice.revision, 1);
  console.log('PASS: load guard, failed save/retry, two-device conflict, draft recovery, session isolation, legacy migration');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
