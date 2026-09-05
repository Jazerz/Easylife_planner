/* Shared planner data operations. No credentials or network access in this module. */
(function (root) {
  const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const blankBoard = () => Object.fromEntries(days.map(day => [day, []]));
  const clone = value => JSON.parse(JSON.stringify(value));
  const board = value => Object.fromEntries(days.map(day => [day, (value?.[day] || []).map((item, index) =>
    typeof item === 'string' ? { id: day + '-' + index, title: item, details: '', done: false } :
    { ...item, details: item.details || '', done: !!item.done })]));
  function normalize(saved, week, defaults) {
    return {
      tasks: (saved.tasks || []).map(task => ({ ...task, description: task.description || '', subtasks: task.subtasks || [] })),
      routineWeeks: saved.routineWeeks ? Object.fromEntries(Object.entries(saved.routineWeeks).map(([key, value]) => [key, board(value)])) :
        (saved.routine ? { [week]: board(saved.routine) } : {}),
      recurring: saved.recurring || {},
      notifications: { ...defaults, ...saved.notifications }
    };
  }
  // Include legacy routine data so an older browser cannot silently overwrite a newer edit.
  function fingerprint(data) {
    function sorted(value) {
      if (Array.isArray(value)) return value.map(sorted);
      if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])]));
      return value;
    }
    return JSON.stringify(sorted({ tasks: data.tasks || [], routine: data.routine || {}, routineWeeks: data.routineWeeks || {}, recurring: data.recurring || {}, notifications: data.notifications || {} }));
  }
  function weekBoard(data, week) {
    const result = board(data.routineWeeks[week]);
    days.forEach(day => { result[day] = result[day].filter(item => !item.recurring || !data.recurring[item.id]?.endWeek || week < data.recurring[item.id].endWeek); });
    Object.entries(data.recurring || {}).forEach(([id, entry]) => {
      if (entry.startWeek <= week && (!entry.endWeek || week < entry.endWeek) && !result[entry.day].some(item => String(item.id) === id)) {
        result[entry.day].push({ id, title: entry.title, details: entry.details || '', done: false, recurring: true });
      }
    });
    return result;
  }
  function copyWeek(data, from, to, idFactory) {
    const source = weekBoard(data, from);
    const target = weekBoard(data, to);
    days.forEach(day => source[day].filter(item => !item.skipped).forEach(item => {
      if (item.recurring && target[day].some(existing => existing.id === item.id)) return;
      target[day].push({ ...item, id: idFactory(), done: false, recurring: false });
    }));
    return { ...data, routineWeeks: { ...data.routineWeeks, [to]: target } };
  }
  function filterTasks(tasks, { search = '', status = 'all', category = 'all', sort = 'due' }, today) {
    const priority = { High: 0, Medium: 1, Low: 2 };
    return tasks.filter(task => task.name.toLowerCase().includes(search.toLowerCase()) &&
      (category === 'all' || task.category === category) &&
      (status === 'all' || status === 'done' && task.done || status === 'open' && !task.done ||
        status === 'overdue' && !task.done && task.due && task.due < today))
      .sort((a, b) => sort === 'name' ? a.name.localeCompare(b.name) :
        sort === 'priority' ? (priority[a.priority] ?? 3) - (priority[b.priority] ?? 3) :
          (a.due || '9999').localeCompare(b.due || '9999'));
  }
  const api = { days, blankBoard, clone, normalize, fingerprint, weekBoard, copyWeek, filterTasks };
  if (typeof module !== 'undefined') module.exports = api;
  else root.PlannerData = api;
})(typeof window !== 'undefined' ? window : globalThis);
