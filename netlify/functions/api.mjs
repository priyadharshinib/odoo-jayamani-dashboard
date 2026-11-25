// One function: login, roles, Odoo data, tasks/reminders, users. Storage: Netlify Blobs.
import { getStore } from '@netlify/blobs';
import crypto from 'node:crypto';
const E = process.env, S = () => globalThis.__STORE__ || getStore('dash'); // __STORE__ lets tests swap in memory
// Role -> which tabs/data it may use. Edit here to change roles.
const PERM = {
  admin:   ['sales', 'pre', 'purch', 'credit', 'tasks', 'users'],
  manager: ['sales', 'pre', 'purch', 'credit', 'tasks'],
  staff:   ['sales', 'pre', 'credit', 'tasks'],
};
const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json' } });
const eq = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
const sign = (p) => crypto.createHmac('sha256', E.AUTH_SECRET).update(p).digest('base64url');
const mint = (u) => { const p = Buffer.from(JSON.stringify({ u, exp: Date.now() + 12 * 36e5 })).toString('base64url'); return p + '.' + sign(p); };
const hash = (pw, salt = crypto.randomBytes(16).toString('hex')) => salt + ':' + crypto.scryptSync(pw, salt, 32).toString('hex');
const check = (pw, h) => eq(hash(pw, h.split(':')[0]), h);
const getUsers = async () => (await S().get('users', { type: 'json' })) || {};
const getTasks = async () => (await S().get('tasks', { type: 'json' })) || [];
const pub = (n, u) => ({ username: n, name: u.name, role: u.role, companies: u.companies || [], perms: PERM[u.role] });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Odoo Online rate-limits API calls (HTTP 429): wait and retry a few times.
const odoo = async (model, method, body) => {
  for (let i = 1; ; i++) {
    const r = await fetch(`${E.ODOO_URL}/json/2/${model}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `bearer ${E.ODOO_API_KEY}`, ...(E.ODOO_DB && { 'X-Odoo-Database': E.ODOO_DB }) },
      body: JSON.stringify(body),
    });
    if (r.status === 429 && i < 4) { const ra = r.headers.get('retry-after'); await sleep(ra !== null ? Number(ra) * 1000 : 2000 * i); continue; }
    if (!r.ok) throw new Error(`${model}.${method} ${r.status}: ${(await r.text()).slice(0, 200)}`);
    return r.json();
  }
};
// Fewer Odoo calls: company list cached 10 min, each day's result cached 60 s, queries run one after another.
let COMP = null; const CACHE = new Map();
const companies = async () => { if (!COMP || Date.now() - COMP.t > 6e5) COMP = { t: Date.now(), v: await odoo('res.company', 'search_read', { domain: [], fields: ['name'] }) }; return COMP.v; };
const seq = async (fns) => { const out = []; for (const f of fns) { out.push(await f()); await sleep(250); } return out; };
const utc = (d) => d.toISOString().slice(0, 19).replace('T', ' ');

async function dashData(me, date) {
  const key = [date, me.role, (me.companies || []).join(',')].join('|'), hit = CACHE.get(key);
  if (hit && Date.now() - hit.t < 6e4) return hit.v;
  const can = (k) => PERM[me.role].includes(k);
  const s = new Date(`${date}T00:00:00+05:30`), e = new Date(s.getTime() + 864e5);
  const range = (f) => [[f, '>=', utc(s)], [f, '<', utc(e)]];
  const cos = await companies();
  const cname = Object.fromEntries(cos.map((c) => [c.id, c.name]));
  const context = { allowed_company_ids: cos.map((c) => c.id) };
  const co = (v) => cname[Array.isArray(v) ? v[0] : v] || '', nm = (v) => (Array.isArray(v) ? v[1] : v) || '';
  const q = (m, domain, fields, order = 'id desc') => odoo(m, 'search_read', { domain, fields, context, limit: 2000, order });
  const F = ['name', 'partner_id', 'company_id', 'amount_total'];
  const [sales, pre, purch, credit] = await seq([
    () => can('sales') ? q('sale.order', [['state', '=', 'sale'], ...range('date_order')], F) : [],
    () => can('pre') ? q('sale.order', [['state', 'in', ['draft', 'sent', 'sale']], ...range('commitment_date')], F) : [],
    () => can('purch') ? q('purchase.order', [['state', 'in', ['purchase', 'done']], ...range('date_order')], F) : [],
    () => can('credit') ? q('account.move', [['move_type', '=', 'out_invoice'], ['state', '=', 'posted'], ['payment_state', 'in', ['not_paid', 'partial']]],
      ['name', 'partner_id', 'company_id', 'invoice_date_due', 'amount_residual'], 'invoice_date_due asc') : [],
  ]);
  const rows = (a) => a.map((o) => ({ name: o.name, partner: nm(o.partner_id), company: co(o.company_id), amount: o.amount_total }));
  const ok = (r) => !me.companies?.length || me.companies.includes(r.company);
  const v = {
    date, companies: cos.map((c) => c.name).filter((n) => ok({ company: n })),
    sales: rows(sales).filter(ok), pre: rows(pre).filter(ok), purch: rows(purch).filter(ok), 
    credit: credit.map((o) => ({ id: o.id, name: o.name, partner: nm(o.partner_id), company: co(o.company_id), amount: o.amount_residual, due: o.invoice_date_due })).filter(ok),
  };
  CACHE.set(key, { t: Date.now(), v });
  return v;
}

export default async (req) => {
  const url = new URL(req.url), path = url.pathname.replace(/^\/api\//, '').split('/'), m = req.method;
  const body = ['POST', 'PATCH'].includes(m) ? await req.json().catch(() => ({})) : {};
  try {
    const users = await getUsers();
    if (path[0] === 'login') {
      if (!Object.keys(users).length && body.username === E.ADMIN_USER && body.password === E.ADMIN_PASS) {
        users[E.ADMIN_USER] = { name: 'Admin', role: 'admin', companies: [], pw: hash(E.ADMIN_PASS) };
        await S().setJSON('users', users);
      }
      const u = users[body.username];
      if (!u || !check(String(body.password || ''), u.pw)) return J({ error: 'Wrong username or password' }, 401);
      return J({ token: mint(body.username), user: pub(body.username, u) });
    }
    const [p, sg] = (req.headers.get('authorization') || '').replace('Bearer ', '').split('.');
    if (!p || !sg || !eq(sg, sign(p))) return J({ error: 'Please sign in' }, 401);
    const { u: uname, exp } = JSON.parse(Buffer.from(p, 'base64url'));
    if (exp < Date.now() || !users[uname]) return J({ error: 'Please sign in' }, 401);
    const me = { ...users[uname], username: uname }, boss = me.role !== 'staff';

    if (path[0] === 'data') return J(await dashData(me, url.searchParams.get('date') || new Date(Date.now() + 19800000).toISOString().slice(0, 10)));

    if (path[0] === 'invoice') {
      if (!PERM[me.role].includes('credit')) return J({ error: 'Not allowed' }, 403);
      const id = Number(path[1]); if (!id) return J({ error: 'Bad invoice id' }, 400);
      const [move] = await odoo('account.move', 'read', { ids: [id], fields: ['name', 'partner_id', 'company_id', 'invoice_date', 'invoice_date_due', 'amount_untaxed', 'amount_tax', 'amount_total', 'amount_residual'] });
      if (!move) return J({ error: 'Invoice not found' }, 404);
      const cn = Array.isArray(move.company_id) ? move.company_id[1] : (await companies()).find((c) => c.id === move.company_id)?.name;
      if (me.companies?.length && !me.companies.includes(cn)) return J({ error: 'Not allowed' }, 403);
      await sleep(250);
      const lines = await odoo('account.move.line', 'search_read', { domain: [['move_id', '=', id], ['display_type', '=', 'product']], fields: ['name', 'quantity', 'price_unit', 'price_subtotal'], order: 'sequence, id' });
      return J({ move: { ...move, company_id: cn }, lines });
    }

    if (path[0] === 'tasks') {
      let t = await getTasks();
      if (m === 'GET') return J(me.role === 'staff' ? t.filter((x) => x.assignee === uname || x.by === uname) : t);
      if (m === 'POST') {
        if (!body.title || !body.due) return J({ error: 'Title and due time are required' }, 400);
        t.push({ id: crypto.randomUUID(), title: String(body.title).slice(0, 200), type: body.type || 'Task', ref: body.ref || '', company: body.company || '',
          note: String(body.note || '').slice(0, 500), due: body.due, assignee: boss ? body.assignee || uname : uname, by: uname, status: 'open' });
      } else {
        const x = t.find((i) => i.id === path[1]);
        if (!x || !(boss || x.assignee === uname || x.by === uname)) return J({ error: 'Not allowed' }, 403);
        if (m === 'PATCH') x.status = body.status === 'done' ? 'done' : 'open';
        if (m === 'DELETE') { if (!boss && x.by !== uname) return J({ error: 'Not allowed' }, 403); t = t.filter((i) => i !== x); }
      }
      await S().setJSON('tasks', t); return J({ ok: 1 });
    }

    if (path[0] === 'users') {
      if (m === 'GET') return J(me.role === 'admin' ? Object.entries(users).map(([n, x]) => pub(n, x)) : Object.entries(users).map(([n, x]) => ({ username: n, name: x.name })));
      if (me.role !== 'admin') return J({ error: 'Admins only' }, 403);
      if (m === 'POST') {
        const n = String(body.username || '').trim().toLowerCase();
        if (!/^[a-z0-9._-]{3,30}$/.test(n) || !PERM[body.role]) return J({ error: 'Invalid username or role' }, 400);
        if (!users[n] && String(body.password || '').length < 8) return J({ error: 'Password needs 8+ characters' }, 400);
        users[n] = { name: body.name || n, role: body.role, companies: body.companies || [], pw: body.password ? hash(body.password) : users[n].pw };
      } else if (m === 'DELETE') {
        if (path[1] === uname) return J({ error: 'You cannot delete yourself' }, 400);
        delete users[path[1]];
      }
      await S().setJSON('users', users); return J({ ok: 1 });
    }
    return J({ error: 'Not found' }, 404);
  } catch (err) { return J({ error: String(err.message || err) }, 500); }
};
export const config = { path: '/api/*' };
