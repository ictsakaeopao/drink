import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { route, GATE } from '../src/router.js';
import { audit } from '../src/workers.js';
import { StateStore } from '../src/state.js';
import { Dispatcher } from '../src/dispatch.js';

const base = (o = {}) => ({
  goal: { intent: 'new_site' }, notes: { cutoff: true }, evidence: { fresh: true, issues: [] }, gaps: { missing: [] }, ...o,
});

test('รูท 4 แบบตามสัญญาณ', () => {
  assert.equal(route(base({ notes: { cutoff: false } })).next_worker, 'plan');
  assert.equal(route(base({ gaps: { missing: ['about'] } })).next_worker, 'build');
  assert.equal(route(base({ evidence: { fresh: false } })).next_worker, 'review');
  assert.equal(route(base({ evidence: { fresh: true, issues: [{ fixable: true, severity: 'medium' }] } })).next_worker, 'revise');
  assert.equal(route(base()).next_worker, 'review');
});

test('GATE: ความมั่นใจต่ำกว่า 0.85 ถูกส่งไปรีวิว และไม่อนุญาตให้รันงานเขียน', () => {
  const d = route(base({ goal: { intent: 'whatever' }, gaps: { missing: ['about'] } }));
  assert.ok(d.confidence < GATE);
  assert.equal(d.gate_passed, false);
  assert.equal(d.next_worker, 'review');
  assert.equal(d.safe_to_run, 'yes'); // review อ่านอย่างเดียว
  const ok = route(base({ gaps: { missing: ['about'] } }));
  assert.equal(ok.gate_passed, true);
  assert.equal(ok.safe_to_run, 'yes');
});

test('urgency low → critical', () => {
  const now = Date.parse('2026-01-01T00:00:00Z');
  const at = (h) => new Date(now + h * 3.6e6).toISOString();
  assert.equal(route(base(), now).urgency, 'low');
  assert.equal(route(base({ deadline: at(48) }), now).urgency, 'medium');
  assert.equal(route(base({ deadline: at(12) }), now).urgency, 'high');
  assert.equal(route(base({ deadline: at(2) }), now).urgency, 'critical');
  assert.equal(route(base({ site_down: true }), now).urgency, 'critical');
});

test('router เร็วกว่า 4ms ต่อ hop', () => {
  for (let i = 0; i < 1000; i++) assert.ok(route(base()).latency_ms < 4);
});

test('audit จับปัญหาหลัก', async () => {
  const html = '<html><head><title>x</title></head><body><img src="a.png"><a href="#nope">x</a><a href="gone.html">y</a></body></html>';
  const rules = (await audit(html, 'index.html', ['index.html'])).map((i) => i.rule).sort();
  assert.deepEqual(rules, ['broken-anchor', 'broken-link', 'html-lang', 'img-alt', 'meta-description', 'single-h1', 'viewport']);
});

async function setup(seedHtml) {
  const dir = await mkdtemp(join(tmpdir(), 'jev-'));
  const workspace = join(dir, 'work');
  const store = new StateStore(join(dir, 'state'));
  if (seedHtml) {
    const { mkdir } = await import('node:fs/promises');
    await mkdir(workspace, { recursive: true });
    await writeFile(join(workspace, 'index.html'), seedHtml);
  }
  return { dir, workspace, store };
}

test('เส้นทางเต็ม: plan → build → review → revise → review → กักรอลงชื่อ → อนุมัติ', async () => {
  const seed = '<html><head><title>Home</title></head><body><h1>Hi</h1><img src="a.png"></body></html>';
  const { workspace, store } = await setup(seed);
  const task = {
    id: 't1', workspace,
    goal: { intent: 'add_page', pages: ['home', 'about'], brand: { name: 'B', tagline: 'ดีที่สุด' },
      content: { about: { title: 'About', description: 'เกี่ยวกับเรา', body: '<h1>About</h1>' } } },
    notes: { cutoff: false }, evidence: { fresh: false }, gaps: { missing: [] },
  };
  const d = new Dispatcher({ store }).start();
  await d.submit(task);
  await d.idle();
  await d.stop();

  const saved = await store.load('t1');
  const steps = saved.history.filter((h) => h.step !== 'route').map((h) => h.step);
  assert.deepEqual(steps, ['plan', 'build', 'review', 'revise', 'review', 'hold']);
  assert.equal(saved.status, 'held_for_signoff');
  const fixed = await readFile(join(workspace, 'index.html'), 'utf8');
  assert.match(fixed, /lang="th"/);
  assert.match(fixed, /alt=""/);
  assert.match(fixed, /name="description" content="ดีที่สุด"/);

  await assert.rejects(store.sign('t1', ''), /ชื่อผู้ลงชื่อ/);
  const signed = await store.sign('t1', 'สมชาย');
  assert.equal(signed.status, 'approved');
  await assert.rejects(store.sign('t1', 'สมชาย'), /ไม่ได้อยู่ในสถานะรอลงชื่อ/);
});

test('ปัญหาที่แก้อัตโนมัติไม่ได้ + intent ไม่ชัด → กักด้วย low_confidence', async () => {
  const { workspace, store } = await setup('<html lang="th"><head><meta name="viewport" content="x"><meta name="description" content="d"><title>t</title></head><body><h1>x</h1></body></html>');
  const task = { id: 't2', workspace, goal: { intent: '???', pages: ['home'] }, notes: { cutoff: true }, evidence: { fresh: false }, gaps: { missing: [] } };
  const d = new Dispatcher({ store }).start();
  await d.submit(task);
  await d.idle();
  await d.stop();
  const saved = await store.load('t2');
  assert.equal(saved.hold_reason, 'low_confidence');
});

test('dispatch ดึงงานตาม urgency ก่อนลำดับเข้า', async () => {
  const { store } = await setup();
  const order = [];
  const slow = async (t) => { order.push(t.id); t.ready = true; return 'ok'; };
  const d = new Dispatcher({ store, pool: { plan: 0, build: 0, revise: 0, review: 1 }, workers: { review: slow } });
  const now = Date.now();
  await d.submit({ id: 'low', ...base({ evidence: { fresh: false } }) });
  await d.submit({ id: 'crit', ...base({ evidence: { fresh: false }, site_down: true }) });
  await d.submit({ id: 'high', ...base({ evidence: { fresh: false }, deadline: new Date(now + 3.6e6 * 10).toISOString() }) });
  d.start();
  await d.idle();
  await d.stop();
  assert.deepEqual(order, ['crit', 'high', 'low']);
});

test('แจ้งเตือน draft ที่ถูกกักเกินระยะตรวจ', async () => {
  const { store } = await setup();
  await store.hold({ id: 'old' });
  const t = await store.load('old');
  t.held_at = new Date(Date.now() - 45 * 60000).toISOString();
  await store.save(t);
  await store.hold({ id: 'new' });
  const late = await store.overdue(30 * 60000);
  assert.deepEqual(late.map((l) => l.id), ['old']);
});
