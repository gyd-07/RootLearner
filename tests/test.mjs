/*
 * 无头测试：加载构建产物 root-learner.html 里的脚本，用假的 DOM / localStorage 驱动真实事件流，
 * 验证 1) 范围乱序  2) 至少 3 轮 + 错题追加补考（上限 8）  3) 进度重置  4) 既有功能回归
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url)) + path.sep;
const appFile = process.env.APP || dir + '..' + path.sep + 'root-learner.html';
const html = fs.readFileSync(appFile, 'utf8');
const script = html.slice(html.indexOf('<script>') + 8, html.lastIndexOf('</script>'));

let pass = 0, fail = 0;
const ok = (cond, label, extra) => {
  if (cond) { pass++; console.log('  PASS  ' + label); }
  else { fail++; console.log('  FAIL  ' + label + (extra !== undefined ? '  -> ' + extra : '')); }
};

/* ---------- 假 DOM ---------- */
function makeEl(attrs = {}) {
  const el = {
    dataset: attrs, _listeners: {},
    addEventListener(t, fn) { el._listeners[t] = fn; },
    closest(sel) {
      const m = /^\[data-([a-z]+)\]$/.exec(sel);
      if (!m) return null;
      return el.dataset[m[1]] !== undefined ? { dataset: el.dataset } : null;
    },
    tagName: 'BUTTON'
  };
  return el;
}
function parseEls(h) {
  const els = [];
  const re = /<button[^>]*>/g;
  let m;
  while ((m = re.exec(h))) {
    const ds = {};
    const dsRe = /data-([a-z]+)="([^"]*)"/g;
    let d;
    while ((d = dsRe.exec(m[0]))) ds[d[1]] = d[2];
    if (Object.keys(ds).length) els.push(makeEl(ds));
  }
  return els;
}

/* ---------- 装载应用 ---------- */
function loadApp(seedStore) {
  const memStore = seedStore || {};
  const appEl = makeEl();
  appEl.innerHTML = '';
  let ctx;

  const query = () => parseEls(appEl.innerHTML);
  const fakeDoc = {
    _listener: null,
    getElementById: id => (id === 'app' ? appEl : null),
    addEventListener(t, fn) { fakeDoc._listener = fakeDoc._listener || {}; fakeDoc._listener[t] = fn; }
  };
  const sandbox = {
    console,
    JSON, Math, Date, Object, Array, String, Number, Boolean, Set, Map, parseInt, parseFloat, isNaN,
    localStorage: {
      getItem: k => (k in memStore ? memStore[k] : null),
      setItem: (k, v) => { memStore[k] = String(v); },
      removeItem: k => { delete memStore[k]; }
    },
    window: { confirm: () => true },
    document: fakeDoc
  };
  sandbox.globalThis = sandbox;
  ctx = vm.createContext(sandbox);
  vm.runInContext(script, ctx, { filename: 'app.js' });
  // 顶层 const/let 不挂在 vm 上下文对象上，在同一上下文里建一个取值桥
  vm.runInContext(`globalThis.__T = {
    get DB(){ return DB; },
    get S(){ return S; },
    scopeRoots, orderIds, pickNew, ensureOrder, resetRange, resetAll, unlearned, canContinue, mustContinue
  };`, ctx);
  const T = sandbox.__T;

  const click = ds => {
    const el = query().find(e => Object.entries(ds).every(([k, v]) => String(e.dataset[k]) === String(v)));
    if (!el) throw new Error('找不到按钮 ' + JSON.stringify(ds) + '\n当前可点：' + JSON.stringify(query().map(e => e.dataset)));
    appEl._listeners.click({ target: el });
  };
  const key = k => { if (fakeDoc._listener.keydown) fakeDoc._listener.keydown({ key: k, code: k, target: { tagName: 'DIV' }, preventDefault() {} }); };
  return { ctx, T, appEl, click, key, memStore, query };
}

const S = a => a.T.S;
const DB = a => a.T.DB;

/* 学习阶段：翻完所有卡片后进入第一轮（固定每日 10 个，便于断言） */
function studyAll(a) {
  DB(a).set.daily = 10;
  a.click({ act: 'start-new' });
  let guard = 0;
  while (S(a).phase === 'study' && guard++ < 500) {
    if (S(a).idx === S(a).cards.length - 1) a.click({ act: 'begin-test' });
    else a.click({ act: 'next' });
  }
}
/* 驱动整场测试。
 * mode: {wrong: [轮次]}                → 这些轮次故意答错前 2 题，其余答对
 *       {wrong: 'all'}                 → 每轮全部答错（用于测轮数上限）
 * 返回每轮 {round,n,type}
 */
function driveRounds(a, mode = {}) {
  const wrong = mode.wrong === undefined ? [] : mode.wrong;
  const allWrong = wrong === 'all';
  const sizes = [];
  let guard = 0;
  while (S(a).phase === 'quiz' || S(a).phase === 'roundend') {
    if (guard++ > 40) throw new Error('轮次未收敛（可能死循环）');
    if (S(a).phase === 'roundend') {
      if (!a.T.canContinue()) break;
      a.click({ act: 'next-round' });
      continue;
    }
    const st = S(a);
    sizes.push({ round: st.round, n: st.queue.length, type: st.round <= 3 ? 'all' : 'makeup' });
    const nWrong = allWrong ? st.queue.length : (wrong.includes(st.round) ? Math.min(2, st.queue.length) : 0);
    if (process.env.DBG) console.log('    >> round=' + st.round + ' qlen=' + st.queue.length + ' 答错' + nWrong);
    let i = 0;
    while (S(a).phase === 'quiz') {   // 答完本轮整队
      const q = S(a).q, ci = q.opts.indexOf(q.ans);
      const pick = i < nWrong ? (ci === 0 ? 1 : 0) : ci;
      a.click({ ans: pick }); i++;
      a.click({ act: 'after' });
      if (i > st.queue.length + 2) throw new Error('单轮题目数异常');
    }
  }
  return sizes;
}

/* ================= 1. 乱序 ================= */
console.log('\n[1] 范围乱序');
{
  const store = {};
  const orders = [];
  for (let i = 0; i < 5; i++) {
    const a = loadApp(store);
    orders.push(DB(a).orderPool.join(','));
  }
  ok(new Set(orders).size === 1, '同一范围内乱序顺序被持久化（重复打开顺序不变）', new Set(orders).size);

  const a = loadApp(store);
  const sc = a.T.scopeRoots().map(r => r.id);
  ok(DB(a).orderPool.length === sc.length && new Set(DB(a).orderPool).size === sc.length,
    '乱序池覆盖范围内全部词根且无重复', DB(a).orderPool.length + '/' + sc.length);
  ok(DB(a).orderPool.join(',') !== sc.join(','), '乱序顺序不等于原始 A1,A2,A3 顺序');

  const before = DB(a).orderPool.join(',');
  DB(a).set.to = 'B';
  a.T.ensureOrder();
  const after = DB(a).orderPool.join(',');
  const scB = a.T.scopeRoots().map(r => r.id);
  ok(after !== before && DB(a).orderPool.length === scB.length, '切换字母范围后重新乱序且范围正确', DB(a).orderPool.length + '/' + scB.length);

  const b4 = DB(a).orderPool.join(',');
  a.click({ act: 'reshuffle' });
  ok(DB(a).orderPool.join(',') !== b4, '「重新乱序」按钮改变了顺序');
  ok(new Set(DB(a).orderPool).size === scB.length, '重新乱序后仍无重复与遗漏');

  const a2 = loadApp({});
  DB(a2).set.daily = 5;
  const want = a2.T.orderIds(true).slice(0, 5);
  const got = a2.T.pickNew(5).map(r => r.id);
  ok(JSON.stringify(want) === JSON.stringify(got), '每日新学按乱序顺序抽取', got.join(','));

  // 乱序只打乱顺序，不改变范围内容
  const all = a2.T.scopeRoots().map(r => r.id).sort((x, y) => x - y).join(',');
  const poolSorted = DB(a2).orderPool.slice().sort((x, y) => x - y).join(',');
  ok(all === poolSorted, '乱序池与范围内容一一对应（仅顺序不同）');
}

/* ================= 2. 轮次 ================= */
console.log('\n[2] 测试轮数：基本 3 轮 + 错题追加补考（上限 8）');
{
  // 全对：恰好考满 3 轮全部卡片
  const a = loadApp({});
  studyAll(a);
  const sizes = driveRounds(a, {});
  ok(sizes.length === 3, '全部答对时考满 3 轮后结束', JSON.stringify(sizes));
  ok(sizes.every(s => s.n === 10 && s.type === 'all'), '第 1/2/3 轮都覆盖全部卡片（10 张）', JSON.stringify(sizes.map(s => s.n)));
  ok(!a.T.canContinue(), '第 3 轮全对后没有下一轮');

  // 前两轮错、第 3 轮全对 → 正好 3 轮结束（第 3 轮全考，错题已被覆盖）
  const b = loadApp({});
  studyAll(b);
  const s2 = driveRounds(b, { wrong: [1, 2] });
  ok(s2.length === 3, '第 1、2 轮有错题但第 3 轮全对 → 3 轮结束', JSON.stringify(s2.map(s => s.round + ':' + s.n)));
  ok(s2.every(s => s.n === 10), '第 1~3 轮均覆盖全部卡片', JSON.stringify(s2.map(s => s.n)));

  // 第 3 轮仍有错题 → 追加第 4 轮，且第 4 轮只考第 3 轮错题
  const c = loadApp({});
  studyAll(c);
  const s3 = driveRounds(c, { wrong: [3] });
  ok(s3.length === 4, '第 3 轮有错题 → 追加第 4 轮补考', JSON.stringify(s3.map(s => s.round + ':' + s.n)));
  ok(s3[0].n === s3[1].n && s3[1].n === s3[2].n && s3[2].n === 10, '前 3 轮都是全部卡片（10 题）', JSON.stringify(s3.map(s => s.n)));
  ok(s3[3].n === 2 && s3[3].type === 'makeup', '第 4 轮只考上一轮错题（2 题）', JSON.stringify(s3[3]));

  // 补考轮又错 → 继续追加（5 题 → 只考上一轮错题）
  const d = loadApp({});
  studyAll(d);
  const s4 = driveRounds(d, { wrong: [3, 4] });
  ok(s4.length === 5, '第 4 轮补考又错 → 第 5 轮继续补考', JSON.stringify(s4.map(s => s.round + ':' + s.n)));
  ok(s4[4].n === 2, '第 5 轮只考第 4 轮的 2 个错题', JSON.stringify(s4[4]));

  // 极端：每轮全部答错 → 最多 8 轮后停止
  const e = loadApp({});
  studyAll(e);
  const s5 = driveRounds(e, { wrong: 'all' });
  ok(s5.length === 8, '每轮都有错题时最多考 8 轮', JSON.stringify(s5.map(s => s.round)));
  ok(s5[3].n === 10 && s5[7].n === 10, '全错时补考轮仍覆盖上一轮全部错题', JSON.stringify(s5.map(s => s.n)));
  ok(!e.T.canContinue(), '第 8 轮后不再追加（达到上限）');

  // 每轮题目顺序重新乱序
  const f = loadApp({});
  studyAll(f);
  const order1 = [];
  while (S(f).phase === 'quiz') { const q = S(f).q; order1.push(q.id); const ci = q.opts.indexOf(q.ans); f.click({ ans: ci }); f.click({ act: 'after' }); }
  f.click({ act: 'next-round' });
  const order2 = [];
  while (S(f).phase === 'quiz') { const q = S(f).q; order2.push(q.id); const ci = q.opts.indexOf(q.ans); f.click({ ans: ci }); f.click({ act: 'after' }); }
  ok(order1.slice().sort((x, y) => x - y).join(',') === order2.slice().sort((x, y) => x - y).join(','),
    '第 2 轮与第 1 轮覆盖同一批卡片');
  ok(order1.join(',') !== order2.join(','), '每轮题目顺序都重新乱序');
}

/* ================= 3. 重置 ================= */
console.log('\n[3] 进度重置');
{
  const a = loadApp({});
  studyAll(a);
  // 第 1 轮故意答错 1 题，第 2、3 轮全对，然后结束会话
  let wrongId = null;
  for (const rnd of [1, 2, 3]) {
    while (S(a).phase === 'quiz') {
      const q = S(a).q, ci = q.opts.indexOf(q.ans);
      const makeWrong = (rnd === 1 && wrongId === null);
      if (makeWrong) wrongId = q.id;
      a.click({ ans: makeWrong ? (ci === 0 ? 1 : 0) : ci });
      a.click({ act: 'after' });
    }
    if (S(a).phase === 'roundend' && a.T.canContinue()) a.click({ act: 'next-round' });
  }
  a.click({ act: 'finish' });
  ok(Object.keys(DB(a).rec).length === 10, '学习后产生 10 条记录', Object.keys(DB(a).rec).length);
  ok(DB(a).rec[wrongId].no === 1 && DB(a).rec[wrongId].level === 0,
    '本轮答错过的卡片记录错误次数且等级归零', JSON.stringify(DB(a).rec[wrongId]));
  const cleanId = Object.keys(DB(a).rec).find(id => id !== String(wrongId));
  ok(DB(a).rec[cleanId].ok === 1 && DB(a).rec[cleanId].level === 1,
    '全部答对的卡片等级 +1', JSON.stringify(DB(a).rec[cleanId]));

  DB(a).rec[9001] = { level: 3, first: 0, last: 0, next: 0, ok: 9, no: 0 }; // 伪造范围外记录
  const beforeOrder = DB(a).orderPool.join(',');
  const n = a.T.resetRange();
  ok(n === 10, '按范围重置清除了 10 条记录', n);
  ok(Object.keys(DB(a).rec).length === 1 && !!DB(a).rec[9001], '范围外记录不受影响');
  ok(DB(a).orderPool.join(',') !== beforeOrder, '范围重置后重新乱序');
  ok(a.T.unlearned().length === 342, '重置后当前范围内卡片回到「未学」状态', a.T.unlearned().length);

  a.T.resetAll();
  ok(Object.keys(DB(a).rec).length === 0, '清空全部进度后记录为 0');
  ok(a.T.unlearned().length === 342, '清空全部后所有卡片均为未学');

  a.click({ nav: 'records' });
  const h = a.appEl.innerHTML;
  ok(h.includes('data-act="reset-scope"') && h.includes('data-act="reset-all"'), '「学习记录」页有按范围重置与清空全部两个入口');
  a.click({ nav: 'home' });
  ok(a.appEl.innerHTML.includes('data-act="reset-scope"'), '首页也提供按范围重置入口');
}

/* ================= 4. 既有功能回归 ================= */
console.log('\n[4] 既有功能回归');
{
  const a = loadApp({});
  const h = a.appEl.innerHTML;
  ok(h.includes('背诵范围与每日数量') && h.includes('每日背诵个数'), '首页范围/每日数量选择器仍在');
  ok(h.includes('A–R · 342 词根 · 819 单词'), '标题统计正确');
  ok(a.query().some(e => e.dataset.daily === '10'), '每日数量快捷按钮仍在');
  ok(h.includes('基本 3 轮'), '首页流程说明显示基本 3 轮');
  ok(!h.includes('data-scope'), '已移除旧的「第二轮范围」开关');

  studyAll(a);
  const types = new Set();
  let guard = 0;
  while (S(a).phase === 'quiz' && guard++ < 100) {
    const q = S(a).q;
    types.add(q.type);
    ok(q.opts.length === 4, '每题 4 个选项：' + q.type, q.opts.length);
    ok(q.opts.includes(q.ans) && new Set(q.opts).size === 4, '选项含正确答案且无重复：' + q.type);
    a.click({ ans: q.opts.indexOf(q.ans) });
    a.click({ act: 'after' });
  }
  ok(types.size >= 1, '题型可正常生成', [...types].join(' / '));
  a.click({ act: 'finish' });
  ok(S(a).phase === 'done' && a.appEl.innerHTML.includes('本次完成'), '结束后显示完成小结');
}

/* ================= 5. 复习计划与掌握等级 ================= */
console.log('\n[5] 复习计划');
{
  const a = loadApp({});
  studyAll(a);
  const s = driveRounds(a, []);
  a.click({ act: 'finish' });
  const lv = Object.values(DB(a).rec)[0].level;
  ok(s.length === 3 && lv === 1, '3 轮全对后等级为 1（艾宾浩斯 1 天）', lv);
  a.click({ nav: 'plan' });
  ok(a.appEl.innerHTML.includes('未来 7 天复习量'), '复习计划页正常渲染');
  a.click({ nav: 'records' });
  ok(a.appEl.innerHTML.includes('学习记录'), '学习记录页正常渲染');

  // 键盘流：空格翻面、数字答题、回车下一题
  const b = loadApp({});
  b.click({ act: 'start-new' });
  b.key('Space');
  ok(S(b).revealed === true, '空格键可翻面');
  b.key('ArrowRight');
  ok(S(b).idx === 1 && S(b).revealed === false, '方向键可切换卡片并复位翻面');
}

console.log('\n===== 结果：' + pass + ' passed, ' + fail + ' failed =====');
process.exit(fail ? 1 : 0);
