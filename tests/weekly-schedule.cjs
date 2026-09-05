const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const html = fs.readFileSync(require('node:path').join(__dirname, '../index.html'), 'utf8');
vm.runInThisContext(html.slice(html.indexOf('      function localDateKey'), html.indexOf('      function useToday')));
const prev = localDateKey(addCalendarDays(new Date('2026-08-31T12:00:00'), -7));
assert.equal(prev, '2026-08-24');
assert.equal(localDateKey(addCalendarDays(new Date(prev + 'T12:00:00'), 7)), '2026-08-31');
assert.equal(localDateKey(addCalendarDays(new Date('2026-12-28T12:00:00'), 7)), '2027-01-04');
assert.equal(isoWeekNumber(new Date('2027-01-04T12:00:00')), 1);
assert.equal(currentWeek(new Date(prev + 'T12:00:00')).some(date => localDateKey(date) === '2026-09-05'), false);
const PlannerData = require('../planner-data.js');
let data = { tasks: [], routineWeeks: {}, recurring: {}, notifications: {} };
const context = {
  PlannerData,
  planner: { change: update => { data = update(data); } },
  selectedWeekKey: '2026-08-24'
};
vm.createContext(context);
vm.runInContext(html.slice(html.indexOf('        const editRoutineWeek'), html.indexOf('        const sendTestReminder')), context);
vm.runInContext('saveRoutine("Mon", {id:1,title:"Previous",done:false}, true, "2026-08-24"); saveRoutine("Mon", {id:2,title:"Current",done:false}, true, "2026-08-31"); toggleRoutine("Mon",1);', context);
assert.equal(data.routineWeeks['2026-08-24'].Mon[0].done, true);
assert.equal(data.routineWeeks['2026-08-31'].Mon[0].done, false);
vm.runInContext('deleteRoutine("Mon",1,"2026-08-24")', context);
assert.equal(data.routineWeeks['2026-08-24'].Mon.filter(item => !item.skipped).length, 0);
assert.equal(data.routineWeeks['2026-08-31'].Mon.length, 1);
vm.runInContext('saveRoutine("Tue",{id:"repeat",title:"Biology",details:"Read",done:true,recurring:true},true,"2026-08-24")', context);
assert.equal(PlannerData.weekBoard(data, '2026-08-31').Tue[0].done, false);
assert.equal(PlannerData.weekBoard(data, '2026-08-17').Tue.length, 0);
vm.runInContext('deleteRoutine("Tue","repeat","2026-08-31")', context);
assert.equal(PlannerData.weekBoard(data, '2026-08-31').Tue.filter(item => !item.skipped).length, 0);
assert.equal(PlannerData.weekBoard(data, '2026-09-07').Tue.length, 1);
vm.runInContext('saveRoutine("Tue",{id:"repeat",title:"Biology",details:"Read",done:false,recurring:false},false,"2026-09-07")', context);
assert.equal(PlannerData.weekBoard(data, '2026-09-14').Tue.length, 0);
assert.equal(PlannerData.weekBoard(data, '2026-08-24').Tue[0].done, true);
let id = 10;
const copied = PlannerData.copyWeek(data, '2026-08-24', '2026-08-31', () => ++id);
assert.equal(copied.routineWeeks['2026-08-31'].Mon[0].title, 'Current');
assert.equal(copied.routineWeeks['2026-08-31'].Tue.length, 1, 'skipped recurrence is not duplicated by copy');
const copiedToEmpty = PlannerData.copyWeek(data, '2026-08-24', '2026-09-21', () => ++id);
assert.equal(copiedToEmpty.routineWeeks['2026-09-21'].Tue[0].done, false);
const tasks = [
  {id:1,name:'Biology',due:'2026-09-01',priority:'Low',category:'Study',done:false},
  {id:2,name:'Work',due:'2026-09-02',priority:'High',category:'Work',done:true},
  {id:3,name:'Future',due:'2026-09-09',priority:'Medium',category:'Study',done:false}
];
assert.deepEqual(PlannerData.filterTasks(tasks,{status:'overdue'},'2026-09-05').map(t=>t.id), [1]);
assert.deepEqual(PlannerData.filterTasks(tasks,{category:'Study',sort:'priority'},'2026-09-05').map(t=>t.id), [3,1]);
console.log('PASS: weekly navigation, independent completion, recurrence, stopping/skipping, copying, task filters');
