// Run: npm test   (no Odoo or Netlify needed: storage and Odoo are mocked)
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

const mem = {};
globalThis.__STORE__ = { get: async (k) => (mem[k] ? JSON.parse(mem[k]) : null), setJSON: async (k, v) => { mem[k] = JSON.stringify(v); } };
Object.assign(process.env, { AUTH_SECRET: 'test-secret-test-secret-123', ADMIN_USER: 'boss', ADMIN_PASS: 'bosspass123', ODOO_URL: 'https://x.odoo.com', ODOO_API_KEY: 'k', ODOO_DB: 'x' });

const FUEL = [1, 'Fuel Station'], TYRE = [2, 'Tyres'], calls = [];
const ODOO = {
  'res.company': () => [{ id: 1, name: 'Fuel Station' }, { id: 2, name: 'Tyres' }],
  'sale.order': (b) => b.domain[0][1] === '='
    ? [{ name: 'S1', partner_id: [10, 'Ravi'], company_id: FUEL, amount_total: 1000 }, { name: 'S2', partner_id: [11, 'Anand'], company_id: TYRE, amount_total: 500 }]
    : [{ name: 'S3', partner_id: [10, 'Ravi'], company_id: FUEL, amount_total: 700 }],
  'purchase.order': () => [{ name: 'P1', partner_id: [12, 'IOC'], company_id: FUEL, amount_total: 300 }],
  'account.move.line': () => [
    { company_id: FUEL, balance: -1000, account_type: 'income' }, { company_id: FUEL, balance: 600, account_type: 'expense_direct_cost' },
    { company_id: TYRE, balance: -500, account_type: 'income' }],
  'account.move': () => [
    { name: 'INV/1', partner_id: [13, 'Kaveri'], company_id: FUEL, invoice_date_due: '2026-11-01', amount_residual: 2500 },
    { name: 'INV/2', partner_id: [14, 'Selvam'], company_id: TYRE, invoice_date_due: '2026-11-05', amount_residual: 900 }],
};
globalThis.fetch = async (url, init) => {
  const m = String(url).match(/\/json\/2\/([^/]+)\/(.+)$/), body = JSON.parse(init.body);
  calls.push({ model: m[1], method: m[2], auth: init.headers.Authorization });
  return new Response(JSON.stringify(ODOO[m[1]](body)), { status: 200, headers: { 'content-type': 'application/json' } });
};

const { default: api } = await import('../netlify/functions/api.mjs');
const call = async (path, method = 'GET', body, token) => {
  const r = await api(new Request('http://localhost/api/' + path, { method, headers: { 'content-type': 'application/json', ...(token && { authorization: 'Bearer ' + token }) }, body: body ? JSON.stringify(body) : undefined }));
  return { status: r.status, json: await r.json() };
};
const login = async (u, p) => (await call('login', 'POST', { username: u, password: p })).json.token;
let boss, priya, karthik;

test('login: first login bootstraps admin, bad credentials rejected', async () => {
  const ok = await call('login', 'POST', { username: 'boss', password: 'bosspass123' });
  assert.equal(ok.status, 200); assert.equal(ok.json.user.role, 'admin'); boss = ok.json.token;
  assert.equal((await call('login', 'POST', { username: 'boss', password: 'wrong' })).status, 401);
  assert.equal((await call('login', 'POST', { username: 'nobody', password: 'x' })).status, 401);
  assert.ok(!mem.users.includes('bosspass123'), 'password must be stored hashed');
});

test('auth: missing, tampered and expired tokens are rejected', async () => {
  assert.equal((await call('tasks')).status, 401);
  assert.equal((await call('tasks', 'GET', null, boss.slice(0, -2) + 'xx')).status, 401);
  const p = Buffer.from(JSON.stringify({ u: 'boss', exp: Date.now() - 1000 })).toString('base64url');
  const s = crypto.createHmac('sha256', process.env.AUTH_SECRET).update(p).digest('base64url');
  assert.equal((await call('tasks', 'GET', null, p + '.' + s)).status, 401);
});

test('users: admin manages users, others cannot, validation works', async () => {
  const mkU = (b, t = boss) => call('users', 'POST', b, t);
  assert.equal((await mkU({ username: 'priya', name: 'Priya', password: 'priyapass1', role: 'staff', companies: ['Fuel Station'] })).status, 200);
  assert.equal((await mkU({ username: 'karthik', name: 'Karthik', password: 'karthik123', role: 'manager' })).status, 200);
  assert.equal((await mkU({ username: 'a b', password: 'longenough1', role: 'staff' })).status, 400);
  assert.equal((await mkU({ username: 'newguy', password: 'short', role: 'staff' })).status, 400);
  assert.equal((await mkU({ username: 'newguy', password: 'longenough1', role: 'god' })).status, 400);
  priya = await login('priya', 'priyapass1'); karthik = await login('karthik', 'karthik123');
  assert.equal((await mkU({ username: 'x1x', password: 'longenough1', role: 'admin' }, karthik)).status, 403);
  assert.equal((await mkU({ username: 'x1x', password: 'longenough1', role: 'admin' }, priya)).status, 403);
  const list = (await call('users', 'GET', null, boss)).json;
  assert.equal(list.length, 3); assert.ok(list.every((u) => !('pw' in u)));
  const names = (await call('users', 'GET', null, priya)).json;
  assert.ok(names.every((u) => !('role' in u) && !('pw' in u)));
  assert.equal((await call('users/boss', 'DELETE', null, boss)).status, 400);
});

test('data: admin/manager see everything with correct maths', async () => {
  const d = (await call('data?date=2026-11-23', 'GET', null, karthik)).json;
  assert.equal(d.sales.length, 2); assert.equal(d.pre.length, 1); assert.equal(d.purch[0].amount, 300);
  const f = d.profit.find((x) => x.company === 'Fuel Station');
  assert.deepEqual([f.income, f.expense], [1000, 600]);
  assert.equal(d.credit[0].amount, 2500); assert.equal(d.credit[0].due, '2026-11-01');
  assert.equal(calls[0].auth, 'bearer k');
});

test('data: staff is limited by role and by company', async () => {
  calls.length = 0;
  const d = (await call('data?date=2026-11-23', 'GET', null, priya)).json;
  assert.deepEqual(d.companies, ['Fuel Station']);
  assert.deepEqual(d.sales.map((x) => x.name), ['S1']);
  assert.deepEqual(d.credit.map((x) => x.name), ['INV/1']);
  assert.deepEqual([d.profit, d.purch], [[], []]);
  assert.ok(!calls.some((c) => ['purchase.order', 'account.move.line'].includes(c.model)), 'staff must not trigger profit/purchase queries');
});

test('tasks: creation rules, visibility and permissions', async () => {
  assert.equal((await call('tasks', 'POST', { title: '', due: '2026-11-24T10:00' }, priya)).status, 400);
  await call('tasks', 'POST', { title: 'Staff task', due: '2026-11-24T10:00', assignee: 'karthik' }, priya);
  await call('tasks', 'POST', { title: 'For priya', due: '2026-11-24T11:00', assignee: 'priya', type: 'Collection', ref: 'INV/1' }, karthik);
  await call('tasks', 'POST', { title: 'For karthik', due: '2026-11-24T12:00', assignee: 'karthik' }, karthik);
  const all = (await call('tasks', 'GET', null, boss)).json, byT = (t) => all.find((x) => x.title === t);
  assert.equal(all.length, 3); assert.equal(byT('Staff task').assignee, 'priya', 'staff can only assign to self');
  const mine = (await call('tasks', 'GET', null, priya)).json.map((x) => x.title).sort();
  assert.deepEqual(mine, ['For priya', 'Staff task']);
  assert.equal((await call('tasks/' + byT('For priya').id, 'PATCH', { status: 'done' }, priya)).status, 200);
  assert.equal((await call('tasks/' + byT('For karthik').id, 'PATCH', { status: 'done' }, priya)).status, 403);
  assert.equal((await call('tasks/' + byT('For priya').id, 'DELETE', null, priya)).status, 403);
  assert.equal((await call('tasks/' + byT('For priya').id, 'DELETE', null, karthik)).status, 200);
  assert.equal((await call('tasks/' + byT('Staff task').id, 'DELETE', null, priya)).status, 200);
});

test('odoo 429: retries then succeeds', async () => {
  const real = globalThis.fetch; let n = 0;
  globalThis.fetch = async (u, i) => (n++ === 0 ? new Response('Too Many Requests', { status: 429, headers: { 'retry-after': '0' } }) : real(u, i));
  const r = await call('data?date=2026-11-24', 'GET', null, karthik);
  globalThis.fetch = real;
  assert.equal(r.status, 200); assert.equal(r.json.sales.length, 2); assert.ok(n > 1);
});

test('odoo: repeated refresh is served from cache', async () => {
  calls.length = 0;
  await call('data?date=2026-11-24', 'GET', null, karthik);
  assert.equal(calls.length, 0, 'second identical request must not hit Odoo');
});

test('unknown route returns 404', async () => {
  assert.equal((await call('nothing', 'GET', null, boss)).status, 404);
});
