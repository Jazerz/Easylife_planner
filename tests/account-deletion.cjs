const fs = require('node:fs'), vm = require('node:vm'), assert = require('node:assert/strict');
const path = require('node:path');
async function main() {
  let writes = [], cleaned = [], deleted = [], fail = false;
  class HttpsError extends Error { constructor(code,message) { super(message);this.code=code; } }
  const root = { set:async data=>writes.push(data), listCollections:async()=>['planner','settings'] };
  const db = {doc:()=>root,recursiveDelete:async collection=>{if(fail)throw Error('unavailable');cleaned.push(collection);}};
  const context = {
    exports:{}, require:name=>{
      if(name==='firebase-admin/app')return {initializeApp(){}};
      if(name==='firebase-admin/auth')return {getAuth:()=>({deleteUser:async uid=>deleted.push(uid)})};
      if(name==='firebase-admin/firestore')return {getFirestore:()=>db,FieldValue:{}};
      if(name==='firebase-functions/params')return {defineSecret:()=>({}),defineString:()=>({})};
      if(name==='firebase-functions/v2/https')return {onCall:(options,handler)=>handler||options,HttpsError};
      if(name==='firebase-functions/v2/scheduler')return {onSchedule:(options,handler)=>handler};
      throw Error(name);
    }
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../functions/index.js'),'utf8'),context);
  const remove=context.exports.deletePlannerAccount;
  await assert.rejects(remove({}),error=>error.code==='unauthenticated');
  await assert.rejects(remove({auth:{uid:'alice',token:{auth_time:0}}}),error=>error.code==='failed-precondition');
  assert.equal(writes.length,0);
  const request={auth:{uid:'alice',token:{auth_time:Date.now()/1000}}};
  fail=true;
  await assert.rejects(remove(request),error=>error.code==='internal');
  assert.equal(writes[0].deleting,true);
  assert.equal(deleted.length,0,'Auth remains available to retry failed cleanup');
  fail=false;
  await remove(request);
  assert.deepEqual(cleaned,['planner','settings']);
  assert.deepEqual(deleted,['alice']);
  console.log('PASS: deletion auth/recent-login guards, data cleanup, retained tombstone, failure/retry');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
