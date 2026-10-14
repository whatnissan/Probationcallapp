const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

// 2026-10-13. Two faults in the county-wide numbers:
// 1. The answered-calls denominator was one unpaged select. Supabase caps a
//    select at 1000 rows without an error; it returned 1,000 of 2,261, so
//    every county rate was about double (9.7% served for a true 4.7%).
// 2. Two exclusion sets: weekday rates excluded only the demo account, the
//    gap range excluded admins, demo, dev and internal accounts.

function extract(name) {
  const start = server.indexOf('async function ' + name + '(');
  assert.ok(start >= 0, name + ' should exist');
  let depth = 0;
  for (let i = server.indexOf('{', start); i < server.length; i++) {
    if (server[i] === '{') depth++;
    else if (server[i] === '}' && --depth === 0) return server.slice(start, i + 1);
  }
  throw new Error('unbalanced ' + name);
}

test('selectAllRows reads every page, not the first 1000', async () => {
  const ctx = vm.createContext({});
  vm.runInContext(extract('selectAllRows'), ctx);
  const total = 2261, calls = [];
  const build = () => ({ range: async (from, to) => { calls.push([from, to]); return { data: Array.from({ length: Math.max(0, Math.min(to, total - 1) - from + 1) }, (_, i) => from + i), error: null }; } });
  const rows = await ctx.selectAllRows(build);
  assert.strictEqual(rows.length, 2261, 'all rows');
  assert.deepStrictEqual(calls, [[0, 999], [1000, 1999], [2000, 2999]]);
  assert.strictEqual(new Set(rows).size, 2261, 'no row twice');
  await assert.rejects(ctx.selectAllRows(() => ({ range: async () => ({ data: null, error: { message: 'boom' } }) })), /boom/, 'a failed page is an error, never a short answer');
});

test('the county statistics page through every row, in a stable order', () => {
  const fn = extract('computeSystemStats');
  assert.strictEqual((fn.match(/selectAllRows\(function\(\)/g) || []).length, 2, 'tests and answered calls are both paged');
  assert.ok(!/await supabase\.from\('call_history'\)[\s\S]{0,120}\.in\('result', \['MUST_TEST', 'NO_TEST'\]\);/.test(fn), 'no unpaged denominator');
  assert.strictEqual((fn.match(/\.order\('created_at', \{ ascending: true \}\)\.order\('id', \{ ascending: true \}\)/g) || []).length, 2, 'ordered, so pages cannot overlap');
  assert.match(extract('countyIntervalPool'), /selectAllRows\(function\(\)/);
});

test('one exclusion set for every county-wide number', () => {
  const ex = extract('countyPoolExcludedIds');
  assert.match(ex, /p\.is_admin === true \|\| p\.is_demo === true \|\| \(email && isDev\(email\)\) \|\| internal\.indexOf\(email\) >= 0/);
  assert.match(extract('computeSystemStats'), /await countyPoolExcludedIds\(\)/, 'weekday rates and the county average');
  assert.match(extract('countyIntervalPool'), /var excluded = await countyPoolExcludedIds\(\);/, 'the gap range');
  assert.ok(!/\.eq\('is_demo', true\)[\s\S]{0,200}demoIds\[d\.id\] = true/.test(extract('computeSystemStats')), 'no demo-only set left');
  // No schedule filter: dormant, paused and moved accounts all count.
  assert.ok(!/user_schedules/.test(extract('computeSystemStats') + extract('countyIntervalPool')), 'pools read results, not schedules');
});
