// Isolated browser test: all Firebase operations use in-memory fixtures.
// Usage: NODE_PATH=<directory containing playwright> node tests/browser-smoke.cjs
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const root = path.join(__dirname, '..');
let html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const start = html.indexOf('      const firebaseReady =');
const end = html.indexOf('      const initialTasks', start);
html = html.slice(0, start) + `
      const testUser = { uid:'test', email:'test@example.invalid', displayName:'Test User', getIdToken:async()=>'' };
      window.testDB = {revision:1,tasks:[{id:'task',name:'Biology',priority:'High',category:'Study',due:'2026-09-01',done:false,subtasks:[]}],routineWeeks:{'2026-08-31':{Mon:[{id:'r1',title:'Read',details:'',done:true}]}},recurring:{},notifications:{}};
      let testListener, testAuthListener;
      const testSnapshot = () => ({exists:()=>true,data:()=>structuredClone(window.testDB),metadata:{}});
      const testAuth = {currentUser:testUser};
      window.testCalls = [];
      const firebaseReady = Promise.resolve({
        auth:testAuth, functions:{}, getFirestore:()=>({}), doc:()=>({}),
        onAuthStateChanged:(auth,callback)=>{testAuthListener=callback;queueMicrotask(()=>callback(auth.currentUser));return ()=>{};},
        onSnapshot:(ref,options,callback)=>{testListener=callback;queueMicrotask(()=>callback(testSnapshot()));return ()=>{};},
        getDocFromServer:async()=>testSnapshot(), serverTimestamp:()=>123,
        runTransaction:async(db,callback)=>{let data;await callback({get:async()=>testSnapshot(),set:(ref,value)=>{data=value;}});window.testDB={...window.testDB,...structuredClone(data)};testListener(testSnapshot());},
        signOut:async()=>{testAuth.currentUser=null;testAuthListener(null);},
        updateProfile:async(user,changes)=>Object.assign(user,changes),
        sendPasswordResetEmail:async(auth,email)=>window.testCalls.push(['reset',email]),
        EmailAuthProvider:{credential:(email,password)=>({email,password})},
        reauthenticateWithCredential:async(user,credential)=>{if(credential.password!=='correct-password')throw {code:'auth/invalid-credential'};},
        httpsCallable:(functions,name)=>async()=>{window.testCalls.push([name]);return {data:{deleted:true}};}
      });
  ` + html.slice(end);
async function main() {
  const browser = await chromium.launch({channel:'msedge',headless:true});
  try {
    const page = await browser.newPage({viewport:{width:1280,height:900}});
    const errors = [];
    page.on('pageerror', error => { errors.push(error.message); console.error('Browser error:',error.message); });
    page.on('requestfailed', request => console.error('Request failed:',request.url(),request.failure()?.errorText));
    await page.clock.install({time:new Date('2026-09-05T12:00:00+07:00')});
    await page.route('http://localhost:4179/**', route => {
      const pathname = new URL(route.request().url()).pathname;
      const content = pathname === '/' ? html : fs.readFileSync(path.join(root, path.basename(pathname)), 'utf8');
      return route.fulfill({status:200,contentType:pathname==='/'?'text/html':'text/javascript',body:content});
    });
    await page.goto('http://localhost:4179/', {waitUntil:'networkidle',timeout:60000});
    await page.clock.runFor(1500);
    await page.getByText('Good morning, Test User!').waitFor({timeout:30000});
    await page.getByRole('button',{name:'Next week',exact:true}).click();
    await page.getByRole('button',{name:'Copy last week',exact:true}).click();
    await page.clock.runFor(1000);
    assert.equal(await page.evaluate(()=>window.testDB.routineWeeks['2026-09-07'].Mon[0].done),false);
    await page.getByRole('button',{name:'This week',exact:true}).click();
    await page.getByRole('row').filter({hasText:'Biology'}).click();
    await page.getByLabel('Task priority',{exact:true}).selectOption('Low');
    await page.getByLabel('Task due date',{exact:true}).fill('2026-09-10');
    await page.getByLabel('Task category',{exact:true}).selectOption('Personal');
    await page.clock.runFor(1000);
    assert.equal(await page.evaluate(()=>window.testDB.tasks[0].due),'2026-09-10');
    assert.equal(await page.evaluate(()=>window.testDB.tasks[0].priority),'Low');
    await page.locator('aside').last().getByRole('button').first().click();
    await page.getByLabel('Task status',{exact:true}).selectOption('overdue');
    await page.getByText('No tasks match these filters.').waitFor();
    await page.getByRole('button',{name:'Settings',exact:true}).first().click();
    await page.getByLabel('Display name',{exact:true}).fill('New Name');
    await page.getByRole('button',{name:'Save profile',exact:true}).click();
    await page.getByText('Profile updated.').waitFor();
    await page.getByRole('button',{name:'Send password reset email',exact:true}).click();
    assert.equal(await page.evaluate(()=>window.testCalls[0][0]),'reset');
    await page.getByRole('button',{name:'Delete account',exact:true}).click();
    await page.getByLabel('Current password',{exact:true}).fill('wrong-password');
    await page.getByLabel('Type DELETE to confirm',{exact:true}).fill('DELETE');
    await page.getByRole('button',{name:'Permanently delete account',exact:true}).click();
    await page.getByText('The password is incorrect.').waitFor();
    assert.equal(await page.evaluate(()=>window.testCalls.some(call=>call[0]==='deletePlannerAccount')),false);
    await page.getByLabel('Current password',{exact:true}).fill('correct-password');
    await page.getByRole('button',{name:'Permanently delete account',exact:true}).click();
    await page.getByText('Your planner is private',{exact:true}).waitFor();
    assert.equal(await page.evaluate(()=>window.testCalls.some(call=>call[0]==='deletePlannerAccount')),true);
    assert.deepEqual(errors,[]);
    console.log('PASS browser: weekly copying, task editing/filtering, profile, password reset, deletion confirmation and wrong password');
  } finally { await browser.close(); }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
