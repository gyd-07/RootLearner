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
function loadApp(seedStore, opts = {}) {
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
    localStorage: opts.throwStore
      ? {
          getItem(){ throw new Error('storage disabled'); },
          setItem(){ throw new Error('storage disabled'); },
          removeItem(){ throw new Error('storage disabled'); }
        }
      : {
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
    scopeRoots, orderIds, pickNew, ensureOrder, resetRange, resetAll, unlearned, canContinue, mustContinue,
    startSession, newRoundCount, save, today, addDays, rolloverSchedule, shiftSchedule
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
    sizes.push({ round: st.round, n: st.queue.length, type: st.round <= st.baseRounds ? 'all' : 'makeup' });
    const nWrong = allWrong ? st.queue.length : (wrong.includes(st.round) ? Math.min(2, st.queue.length) : 0);
    if (process.env.DBG) console.log('    >> round=' + st.round + ' qlen=' + st.queue.length + ' 答错' + nWrong);
    let i = 0;
    while (S(a).phase === 'quiz') {   // 答完本轮整队
      const q = S(a).q, ci = q.opts.indexOf(q.ans);
      if(mode.seen) (mode.seen[q.id] || (mode.seen[q.id] = [])).push(q.key);
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

  // 前两轮错、第 3 轮全对 → 早期错题仍须追加补考
  const b = loadApp({});
  studyAll(b);
  const s2 = driveRounds(b, { wrong: [1, 2] });
  ok(s2.length === 4, '第 1、2 轮有错题但第 3 轮全对 → 仍追加第 4 轮补考', JSON.stringify(s2.map(s => s.round + ':' + s.n)));
  ok(s2.slice(0, 3).every(s => s.n === 10), '第 1~3 轮均覆盖全部卡片', JSON.stringify(s2.map(s => s.n)));
  ok(s2[3].type === 'makeup' && s2[3].n >= 2 && s2[3].n <= 4, '第 4 轮覆盖前两轮留下的全部待补考错题', JSON.stringify(s2[3]));

  // 复习第 1 轮答错的卡片，第 2、3 轮答对也不能提前移出待补考列表
  const review = loadApp({});
  review.T.startSession(review.T.scopeRoots().slice(0, 3).map(r => r.id), 'review');
  while(S(review).phase === 'study'){
    if(S(review).idx === S(review).cards.length - 1) review.click({ act: 'begin-test' });
    else review.click({ act: 'next' });
  }
  let earlyWrong = null;
  const laterRounds = new Set();
  for(let round = 1; round <= 3; round++){
    while(S(review).phase === 'quiz'){
      const q = S(review).q, ci = q.opts.indexOf(q.ans);
      const makeWrong = round === 1 && earlyWrong === null;
      if(makeWrong) earlyWrong = q.id;
      if(round > 1 && q.id === earlyWrong) laterRounds.add(round);
      review.click({ ans: makeWrong ? (ci === 0 ? 1 : 0) : ci });
      review.click({ act: 'after' });
    }
    if(round < 3) review.click({ act: 'next-round' });
  }
  ok(earlyWrong !== null && laterRounds.size === 2, '回归场景确实包含第 1 轮答错、第 2/3 轮答对');
  ok(S(review).retry.length === 1 && S(review).retry[0] === earlyWrong,
    '后续基础轮答对不会清除第 1 轮留下的待补考错题', JSON.stringify(S(review).retry));
  ok(S(review).roundWrong.length === 0 && review.T.canContinue(),
    '复习第 3 轮全对后仍因早期错题进入补考');
  ok(review.appEl.innerHTML.includes('本次仍有 1 个待补考错题') && review.appEl.innerHTML.includes('补考（1 题）'),
    '轮次结果页显示全部待补考错题数量');
  review.click({ act: 'next-round' });
  ok(S(review).round === 4 && S(review).queue.length === 1 && S(review).q.id === earlyWrong,
    '复习第 4 轮只重练早期答错的卡片', JSON.stringify(S(review).queue));
  const reviewAnswer = S(review).q.opts.indexOf(S(review).q.ans);
  review.click({ ans: reviewAnswer });
  review.click({ act: 'after' });
  ok(S(review).retry.length === 0 && !review.T.canContinue(),
    '补考答对后移出待补考列表且不再追加轮次');

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

  const g = loadApp({});
  DB(g).set.newRounds = 1;
  studyAll(g);
  const s6 = driveRounds(g, {});
  ok(s6.length === 1 && S(g).baseRounds === 1, '新学轮数设为 1 时全对只考 1 轮', JSON.stringify(s6));

  const h = loadApp({});
  DB(h).set.newRounds = 5;
  studyAll(h);
  const s7 = driveRounds(h, { wrong: [5] });
  ok(s7.length === 6 && s7.slice(0, 5).every(s => s.type === 'all') && s7[5].n === 2,
    '新学轮数设为 5 时先考 5 轮全部卡片再补考错题', JSON.stringify(s7.map(s => s.round + ':' + s.n)));

  const i = loadApp({});
  DB(i).set.newRounds = 1;
  i.T.startSession([i.T.scopeRoots()[0].id], 'review');
  while(S(i).phase === 'study'){
    if(S(i).idx === S(i).cards.length - 1) i.click({ act: 'begin-test' });
    else i.click({ act: 'next' });
  }
  const sr = driveRounds(i, {});
  ok(sr.length === 3 && S(i).baseRounds === 3, '新学轮数设置不影响固定 3 轮的复习', JSON.stringify(sr));

  const saved = {};
  const j = loadApp(saved);
  DB(j).set.newRounds = 5;
  j.T.save();
  const j2 = loadApp(saved);
  ok(DB(j2).set.newRounds === 5 && j2.appEl.innerHTML.includes('<option value="5" selected>5 轮</option>'),
    '新学轮数设置持久化并在首页保持选中');

  const k = loadApp({});
  ok(k.T.newRoundCount(0) === 1 && k.T.newRoundCount(99) === 8 && k.T.newRoundCount('bad') === 3,
    '新学轮数越界钳制到 1/8，非法值回退默认 3');

  const u = loadApp({});
  DB(u).set.newRounds = 8;
  const oneWordRoot = u.T.scopeRoots().find(r => r.words.length === 1);
  u.T.startSession([oneWordRoot.id], 'new');
  u.click({ act: 'begin-test' });
  const seen = {};
  const s8 = driveRounds(u, { wrong: 'all', seen });
  const keys = seen[oneWordRoot.id];
  ok(s8.length === 8 && keys.length === 8 && new Set(keys).size === 8,
    '只有一个例词的词根连续 8 轮也不重复题目', JSON.stringify(keys));
  ok(new Set(keys.map(key => key.split(':')[0])).size === 8, '8 种题型均参与跨轮次去重');
}

/* ================= 3. 重置 ================= */
console.log('\n[3] 进度重置');
{
  const a = loadApp({});
  studyAll(a);
  // 第 1 轮故意答错 1 题，第 2、3 轮全对，第 4 轮补考通过后结束会话
  let wrongId = null;
  for (const rnd of [1, 2, 3, 4]) {
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
  ok(h.includes('A–R · 342 词根 · 814 单词'), '标题统计正确');
  ok(a.query().some(e => e.dataset.daily === '10'), '每日数量快捷按钮仍在');
  ok(h.includes('id="new-rounds"') && h.includes('新学按首页设置考 3 轮'), '首页提供新学轮数选择并默认显示 3 轮');
  ok(h.includes('共 8 种') && h.includes('跨轮次不重复'), '首页说明 8 种题型与跨轮次题目去重');
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

/* ================= 6. 边界与异常 ================= */
console.log('\n[6] 边界与异常');
{
  // localStorage 内容损坏 → 回退默认空进度，页面正常渲染
  const a = loadApp({ 'rootLearner.v1': '{broken json' });
  ok(Object.keys(DB(a).rec).length === 0, 'localStorage 内容损坏时回退默认空进度', JSON.stringify(DB(a).rec));
  ok(a.appEl.innerHTML.includes('背诵范围与每日数量'), '存储损坏时首页仍正常渲染');

  // localStorage 抛异常（被浏览器禁用）→ 降级内存并提示
  const b = loadApp({}, { throwStore: true });
  ok(b.appEl.innerHTML.includes('浏览器禁用了本地存储'), 'localStorage 被禁用时显示降级提示');
  b.click({ act: 'start-new' });
  ok(S(b).phase === 'study', '内存降级下学习流程仍可用');

  // 范围倒置：起始字母 > 结束字母 → 按字母序自动纠正
  const c = loadApp({});
  DB(c).set.from = 'C'; DB(c).set.to = 'A';
  ok(c.T.scopeRoots().length === 80, '起始>结束仍按字母序取范围（A–C 共 80 词根）', c.T.scopeRoots().length);

  // 每日数量越界 → 钳制到 1..999
  const d = loadApp({});
  DB(d).set.daily = 0; d.click({ nav: 'home' });
  ok(d.appEl.innerHTML.includes('value="1"'), '每日数量 0 被钳制为 1');
  DB(d).set.daily = 5000; d.click({ nav: 'home' });
  ok(d.appEl.innerHTML.includes('value="999"'), '每日数量 5000 被钳制为 999');
}

/* ================= 7. 三模块入口与单词拼写 ================= */
console.log('\n[7] 三模块入口与单词拼写');
{
  const markLearned = (app, target) => {
    let count = 0;
    for(const r of app.T.scopeRoots()){
      if(count >= target) break;
      DB(app).rec[r.id] = {level:0};
      count += r.words.length;
    }
    return count;
  };

  const a = loadApp({});
  const h = a.appEl.innerHTML;
  ok(h.includes('class="modules"'), '首页使用三模块并列布局');
  ok(h.includes('data-act="start-new"') && h.includes('data-act="start-review"') && h.includes('data-act="start-spelling"'),
    '新学、复习、拼写测试三个入口均存在');
  ok(!h.includes('data-act="start-today"'), '旧的合并式今日学习入口已移除');

  a.click({ act: 'start-spelling' });
  ok(S(a) === null && a.appEl.innerHTML.includes('当前范围还没有已学单词'), '没有已学词根时不开始拼写测试并提示先新学');

  markLearned(a, 5);
  DB(a).set.daily = 5;
  a.click({ nav: 'home' });
  const beforeRec = JSON.stringify(DB(a).rec);
  a.click({ act: 'start-spelling' });
  ok(S(a).phase === 'spelling' && S(a).spellQueue.length === 5, '拼写测试按每日数量抽取 5 个单词', S(a).spellQueue.length);
  ok(S(a).spellQueue.every(item => DB(a).rec[item.r.id]), '默认抽题只包含已学词根的单词');
  ok(a.appEl.innerHTML.includes('id="spell-input"') && a.appEl.innerHTML.includes(S(a).spellQueue[0].w.senses[0].cn),
    '拼写页显示中文释义与输入框');

  S(a).spellInput = '   ';
  a.click({ act: 'spell-submit' });
  ok(!S(a).spellAnswered, '空白拼写不判定、不前进');

  let item = S(a).spellQueue[S(a).spellIdx];
  S(a).spellInput = '  ' + item.w.w.toUpperCase() + '  ';
  a.click({ act: 'spell-submit' });
  ok(S(a).spellAnswered && S(a).spellOk && S(a).spellRight === 1, '忽略首尾空格与大小写判定拼写正确');
  a.click({ act: 'spell-next' });
  ok(S(a).spellIdx === 1 && !S(a).spellAnswered && S(a).spellInput === '', '下一题重置输入与答题状态');

  item = S(a).spellQueue[S(a).spellIdx];
  S(a).spellInput = 'definitely-wrong';
  a.click({ act: 'spell-submit' });
  ok(!S(a).spellOk && S(a).spellWrong.length === 1 && a.appEl.innerHTML.includes('正确答案：' + item.w.w),
    '拼错时记录错题并显示正确拼写');

  while(S(a).phase === 'spelling'){
    if(!S(a).spellAnswered){
      S(a).spellInput = S(a).spellQueue[S(a).spellIdx].w.w;
      a.click({ act: 'spell-submit' });
    }
    a.click({ act: 'spell-next' });
  }
  ok(S(a).phase === 'done' && S(a).spellRight === 4 && S(a).spellWrong.length === 1, '整组完成后统计 4 对 1 错', S(a).spellRight);
  ok(a.appEl.innerHTML.includes('拼写测试完成') && a.appEl.innerHTML.includes(item.w.w), '结果页显示完成统计与拼错单词');
  ok(JSON.stringify(DB(a).rec) === beforeRec, '拼写测试不创建或修改复习记录');

  a.click({ act: 'spell-again' });
  ok(S(a).phase === 'spelling' && S(a).spellIdx === 0 && S(a).spellRight === 0, '再测一组重置本次统计');

  const b = loadApp({});
  const learnedCount = markLearned(b, 1);
  DB(b).set.daily = 5;
  b.click({ nav: 'home' });
  ok(learnedCount < 5 && b.appEl.innerHTML.includes('已学单词不足设定的 5 个') && b.appEl.innerHTML.includes('data-act="start-spelling-fill"'),
    '已学单词不足时显示数量提示和补入未学按钮');
  b.click({ act: 'start-spelling' });
  ok(S(b).spellQueue.length === learnedCount && S(b).spellQueue.every(item => DB(b).rec[item.r.id]),
    '数量不足时只测已学模式不补入未学单词');

  const c = loadApp({});
  const fillLearnedCount = markLearned(c, 1);
  DB(c).set.daily = 5;
  c.click({ nav: 'home' });
  const fillBeforeRec = JSON.stringify(DB(c).rec);
  c.click({ act: 'start-spelling-fill' });
  ok(S(c).spellQueue.length === 5 && S(c).spellQueue.filter(item => DB(c).rec[item.r.id]).length === fillLearnedCount,
    '补入未学模式保留全部已学单词并补足设定题数');
  ok(S(c).spellQueue.some(item => !DB(c).rec[item.r.id]) && S(c).spellFill, '补入未学模式确实包含未学词根单词');
  ok(JSON.stringify(DB(c).rec) === fillBeforeRec, '补入未学单词不会把未学词根标记为已学');
}

/* ================= 7.5 总复习大闯关 ================= */
console.log('\n[7.5] 总复习大闯关');
{
  const a = loadApp({});
  const locked = a.appEl.innerHTML.match(/<button[^>]*data-act="start-challenge"[^>]*>/);
  ok(locked && locked[0].includes('disabled'), '当前范围未全部学完时闯关入口锁定');
  a.click({ act: 'start-challenge' });
  ok(S(a) === null && a.appEl.innerHTML.includes('请先完成当前范围的全部新学'),
    '未解锁时即使触发入口也不会创建学习记录或开始闯关');

  DB(a).set.from = 'A'; DB(a).set.to = 'A'; DB(a).set.newRounds = 8;
  a.click({ nav: 'home' });
  const roots = a.T.scopeRoots(), ids = new Set(roots.map(r=>r.id)), t = a.T.today();
  roots.forEach(r=>{
    DB(a).rec[r.id] = {level:1, first:a.T.addDays(t,-10), last:a.T.addDays(t,-1), next:a.T.addDays(t,15), ok:1, no:0};
  });
  const beforeCount = Object.keys(DB(a).rec).length;
  a.click({ nav: 'home' });
  const unlocked = a.appEl.innerHTML.match(/<button[^>]*data-act="start-challenge"[^>]*>/);
  ok(unlocked && !unlocked[0].includes('disabled') && a.appEl.innerHTML.includes('已解锁'),
    '当前范围全部学完后闯关入口解锁');
  ok(a.appEl.innerHTML.includes('开始复习（0 张卡片）') && a.appEl.innerHTML.includes('不受到期日限制'),
    '全部卡片均未到期时仍可明确进入总复习');

  a.click({ act: 'start-challenge' });
  ok(S(a).mode === 'challenge' && S(a).phase === 'study' && S(a).cards.length === roots.length,
    '闯关按普通复习的翻卡阶段开始并覆盖整个范围');
  ok(S(a).cards.every(id=>ids.has(id) && DB(a).rec[id]) && Object.keys(DB(a).rec).length === beforeCount,
    '闯关不混入范围外或未学词根，也不创建额外学习记录');
  ok(S(a).baseRounds === 3, '闯关固定三轮，不受新学轮数设置影响');
  ok(a.appEl.innerHTML.includes('总复习大闯关 · 翻面复习'), '翻卡阶段显示闯关标题');

  let guard = 0;
  while(S(a).phase === 'study' && guard++ < 500){
    if(S(a).idx === S(a).cards.length-1) a.click({ act: 'begin-test' });
    else a.click({ act: 'next' });
  }
  const rounds = driveRounds(a);
  ok(rounds.length === 3 && rounds.every(r=>r.type === 'all' && r.n === roots.length),
    '闯关前三轮均覆盖范围内全部卡片', JSON.stringify(rounds));
  a.click({ act: 'finish' });
  ok(S(a).phase === 'done' && a.appEl.innerHTML.includes('总复习大闯关完成') && a.appEl.innerHTML.includes('再闯一次'),
    '闯关完成页显示专属结果与再次挑战入口');
  ok(roots.every(r=>DB(a).rec[r.id].level === 2 && DB(a).rec[r.id].last === t && DB(a).rec[r.id].next === a.T.addDays(t,2)),
    '闯关全对后按普通复习规则提升等级并更新复习计划');
  a.click({ act: 'challenge-again' });
  ok(S(a).mode === 'challenge' && S(a).phase === 'study' && S(a).cards.length === roots.length,
    '再闯一次重新覆盖当前范围全部词根');
}

/* ================= 8. 词库完整性与旧进度迁移 ================= */
console.log('\n[8] 词库完整性与旧进度迁移');
{
  const a = loadApp({});
  const roots = a.T.scopeRoots();
  const wordCount = roots.reduce((n, r) => n + r.words.length, 0);
  const ids = roots.map(r => r.id);
  const letterNums = roots.map(r => r.letter + ':' + r.num);
  const wordsOf = r => r.words.map(w => w.w);

  ok(roots.length === 342 && wordCount === 814, '词库规模为 342 词根组 / 814 单词', roots.length + '/' + wordCount);
  ok(new Set(ids).size === ids.length, '词根 id 全部唯一');
  ok(new Set(letterNums).size === letterNums.length, '字母段内编号全部唯一');
  ok(roots.every(r => r.forms.length > 0 && r.words.length > 0), '每个词根都有词形和至少一个例词');

  const aug = roots.find(r => r.id === 26);
  ok(aug.forms.includes('aug') && ['augment', 'augmentation'].every(w => wordsOf(aug).includes(w)) &&
    !roots.some(r => r.id === 27 || r.forms.includes('sep')), 'augment 与 augmentation 同归 aug，错误 sep 卡片已删除');

  const glaci = roots.find(r => r.id === 146);
  const gress = roots.find(r => r.id === 154);
  ok(!wordsOf(glaci).includes('progress') && wordsOf(gress).includes('progress'), 'progress 已从 glaci 移至 gress');

  const forms = roots.flatMap(r => r.forms);
  ok(['crux', 'fabul', 'genit'].every(f => forms.includes(f)) &&
    ['curx', 'fabal', 'genif'].every(f => !forms.includes(f)), 'curx/fabal/genif 三个词根拼写已纠正');

  const removed = ['encumber', 'facetious', 'preface', 'nostrum', 'outrage'];
  ok(roots.every(r => wordsOf(r).every(w => !removed.includes(w))), '五个无合适现有词根卡片的错配例词已移除');

  const neg = roots.find(r => r.id === 251);
  const lect = roots.find(r => r.id === 193);
  ok(!wordsOf(neg).includes('neglect') && wordsOf(lect).includes('neglect'), 'neglect 已从 neg=deny 移至 lect/lig=choose/gather');

  const parEqual = roots.find(r => r.id === 278);
  const parere = roots.find(r => r.id === 343);
  ok(['parent', 'multiparous'].every(w => !wordsOf(parEqual).includes(w) && wordsOf(parere).includes(w)) &&
    parere.meaningEn === 'to give birth', 'parent/multiparous 已从 par=equal 拆至 parere=give birth');

  const trailing = [];
  roots.forEach(r => r.words.forEach(w => w.senses.forEach(s => {
    if(/[，,;；：:、]$/.test(s.cn)) trailing.push(r.id + ':' + w.w);
  })));
  ok(trailing.length === 0, '中文释义没有多余末尾标点', trailing.join(','));

  const legacyStore = {
    'rootLearner.v1': JSON.stringify({
      rec: {27: {level: 2, next: 123, ok: 4, no: 1}},
      set: {from: 'A', to: 'R', daily: 20, newRounds: 3},
      orderKey: 'A~R', orderPool: [27]
    })
  };
  const legacy = loadApp(legacyStore);
  ok(DB(legacy).rec[26] && DB(legacy).rec[26].level === 2 && !DB(legacy).rec[27], '只有旧 rec27 时迁移为 aug 的 rec26');
  const persisted = JSON.parse(legacyStore['rootLearner.v1']);
  ok(persisted.rec[26] && persisted.rec[26].level === 2 && !persisted.rec[27], '迁移后的学习记录立即持久化');
  ok(DB(legacy).orderPool.length === roots.length && !DB(legacy).orderPool.includes(27), '旧乱序队列中的无效 id27 被重新生成');

  const both = loadApp({
    'rootLearner.v1': JSON.stringify({
      rec: {26: {level: 4}, 27: {level: 1}},
      set: {from: 'A', to: 'R', daily: 20, newRounds: 3},
      orderKey: null, orderPool: []
    })
  });
  ok(DB(both).rec[26].level === 4 && !DB(both).rec[27], 'rec26/rec27 同时存在时保留 aug 原进度并移除旧记录');
}

/* ================= 9. 漏复习自动顺延 ================= */
console.log('\n[9] 漏复习自动顺延');
{
  const day = offset => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() + offset);
    return d.getTime();
  };
  const record = (last, next) => ({level:1, first:day(-10), last, next, ok:1, no:0});
  const seed = (rec, checked, withChecked = true) => {
    const db = {
      rec, set:{from:'A', to:'R', daily:20, newRounds:3},
      orderKey:null, orderPool:[]
    };
    if(withChecked) db.scheduleChecked = checked;
    return {'rootLearner.v1':JSON.stringify(db)};
  };

  const todayApp = loadApp(seed({1:record(day(-1), day(0))}, day(-1)));
  ok(DB(todayApp).rec[1].next === day(0), '今天到期的卡片不会提前判为漏复习');

  const oneStore = seed({
    1:record(day(-2), day(-1)),
    2:record(day(-2), day(2))
  }, day(-2));
  const one = loadApp(oneStore);
  ok(DB(one).rec[1].next === day(0) && DB(one).rec[2].next === day(3),
    '漏复习 1 天后，到期与未来的全部计划都顺延 1 天');
  ok(one.appEl.innerHTML.includes('检测到 1 天有复习计划但未完成'), '首页提示本次自动顺延天数');

  const twoStore = seed({
    1:record(day(-3), day(-2)),
    2:record(day(-3), day(2))
  }, day(-3));
  const two = loadApp(twoStore);
  ok(DB(two).rec[1].next === day(0) && DB(two).rec[2].next === day(4),
    '连续漏复习 2 天后，全部计划顺延 2 天并保持间隔');
  const beforeReload = Object.values(DB(two).rec).map(r => r.next);
  const reopened = loadApp(twoStore);
  ok(Object.values(DB(reopened).rec).every((r, i) => r.next === beforeReload[i]),
    '同一天重复打开不会重复顺延');

  const noPlan = loadApp(seed({1:record(day(-3), day(2))}, day(-3)));
  ok(DB(noPlan).rec[1].next === day(2) && DB(noPlan).scheduleChecked === day(-1),
    '没有到期计划的过去日期不造成顺延，但仍记录已检查日期');

  const legacy = loadApp(seed({1:record(day(-3), day(-2))}, 0, false));
  ok(DB(legacy).rec[1].next === day(0) && DB(legacy).scheduleChecked === day(-1),
    '旧数据按最后完成学习日期补齐漏复习顺延');

  const uncommitted = loadApp(seed({1:record(0, day(-40))}, 0, false));
  ok(DB(uncommitted).rec[1].next === day(-40),
    '从未完成测试的旧卡片不猜测漏复习天数');

  const manualStore = seed({
    1:record(day(-1), day(0)),
    2:record(day(-1), day(4))
  }, day(-1));
  const manual = loadApp(manualStore);
  manual.click({nav:'plan'});
  ok(manual.appEl.innerHTML.includes('data-act="shift-2"'), '复习计划页提供手动顺延 2 天入口');
  manual.click({act:'shift-2'});
  const persisted = JSON.parse(manualStore['rootLearner.v1']);
  ok(DB(manual).rec[1].next === day(2) && DB(manual).rec[2].next === day(6) &&
    persisted.rec[1].next === day(2) && persisted.rec[2].next === day(6),
    '手动顺延 2 天覆盖全部卡片并立即持久化');
}

console.log('\n===== 结果：' + pass + ' passed, ' + fail + ' failed =====');
process.exit(fail ? 1 : 0);
