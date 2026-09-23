// Interpreter-side runtime for workflow scripts. This source runs INSIDE @opencode/codemode, so it
// must stay within the codemode JS subset (no classes, `this`, getters, globalThis, Object.freeze).
// Host functions cannot receive or return functions, which is why parallel/pipeline/budget live
// here rather than on the host. Host globals it relies on (all provided by the engine):
//   __agent(prompt, opts) -> Promise<value>      __phase(title)     __log(message)
//   __workflow(nameOrRef, args, hasArgs) -> Promise<value>   __budget_total() -> number|null
//   __budget_spent() -> number
// Every host global is optional: missing ones fail with a clear error only when used.

/** Maximum list length accepted by parallel()/pipeline() (P31). */
export const MAX_FANOUT_ITEMS = 4096

// Keep this a plain template without interpolation other than the constant, so line counting in
// sandbox.ts stays trivial.
export const PRELUDE = `// workflow prelude v1
const __wf_host = (name) => {
  const fn = { __agent: typeof __agent === 'function' ? __agent : undefined, __phase: typeof __phase === 'function' ? __phase : undefined, __log: typeof __log === 'function' ? __log : undefined, __workflow: typeof __workflow === 'function' ? __workflow : undefined, __budget_total: typeof __budget_total === 'function' ? __budget_total : undefined, __budget_spent: typeof __budget_spent === 'function' ? __budget_spent : undefined }[name];
  if (typeof fn !== 'function') throw new Error(name.slice(2) + '() is not available in this workflow host');
  return fn;
};
const __wf_checkList = (fnName, list) => {
  if (!Array.isArray(list)) throw new TypeError(fnName + '() expects an array as its first argument, got ' + (list === null ? 'null' : typeof list));
  if (list.length > ${MAX_FANOUT_ITEMS}) throw new RangeError(fnName + '() received ' + list.length + ' items; the limit is ${MAX_FANOUT_ITEMS} per call. Split the list into batches of at most ${MAX_FANOUT_ITEMS}.');
};
const __wf_settle = async (entry) => {
  try {
    if (typeof entry === 'function') return await entry();
    return await entry;
  } catch (e) {
    return null;
  }
};
const parallel = async (thunks) => {
  __wf_checkList('parallel', thunks);
  return await Promise.all(thunks.map((t) => __wf_settle(t)));
};
const pipeline = async (items, ...stages) => {
  __wf_checkList('pipeline', items);
  for (let s = 0; s < stages.length; s++) {
    if (typeof stages[s] !== 'function') throw new TypeError('pipeline() stage ' + (s + 1) + ' is not a function');
  }
  const runItem = async (item, index) => {
    let value = item;
    for (const stage of stages) {
      try {
        value = await stage(value, item, index);
      } catch (e) {
        return null;
      }
    }
    return value;
  };
  return await Promise.all(items.map((item, index) => runItem(item, index)));
};
const agent = (prompt, opts) => __wf_host('__agent')(prompt, opts === undefined || opts === null ? {} : opts);
const workflow = (...wfCall) => __wf_host('__workflow')(wfCall[0], wfCall.length > 1 ? wfCall[1] : null, wfCall.length > 1 && wfCall[1] !== undefined);
const phase = (title) => { __wf_host('__phase')(String(title)); };
const log = (...parts) => {
  __wf_host('__log')(parts.map((p) => typeof p === 'string' ? p : JSON.stringify(p)).join(' '));
};
const __wf_total = typeof __budget_total === 'function' ? __budget_total() : null;
const budget = {
  total: typeof __wf_total === 'number' ? __wf_total : null,
  spent: () => typeof __budget_spent === 'function' ? __budget_spent() : 0,
  remaining: () => {
    if (budget.total === null) return Infinity;
    return Math.max(0, budget.total - budget.spent());
  },
};
`
