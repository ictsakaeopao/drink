import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StateStore } from '../src/state.js';
import { createDashboard } from '../src/server.js';

let server, base, root, store;

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'jev-srv-'));
  store = new StateStore(join(root, 'state'));
  const workspace = join(root, 'work', 'site');
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, 'index.html'), '<html lang="th"><head><meta name="viewport" content="x"><meta name="description" content="d"><title>t</title></head><body><h1>x</h1></body></html>');
  await writeFile(join(root, 'secret.html'), 'SECRET');
  await store.save({ id: 'site', workspace, goal: { intent: 'add_page' }, spec: { sitemap: [{ page: 'home', file: 'index.html' }] },
    notes: { cutoff: true }, evidence: { fresh: true, issues: [] }, gaps: { missing: [] }, hops: 3 });
  await store.hold(await store.load('site'));
  server = createDashboard({ root, store, windowMs: 0 }).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const post = (path, body) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });

test('หน้าแดชบอร์ดและรายการงาน พร้อมธงค้างเกินระยะ', async () => {
  assert.match(await (await fetch(base + '/')).text(), /JEV Human Review/);
  const { tasks } = await (await fetch(base + '/api/tasks')).json();
  assert.equal(tasks[0].id, 'site');
  assert.equal(tasks[0].status, 'held_for_signoff');
  assert.equal(tasks[0].overdue, true);
});

test('พรีวิวเสิร์ฟไฟล์ใน workspace แบบ sandbox และกันการหลุดโฟลเดอร์', async () => {
  const ok = await fetch(base + '/preview/site/index.html');
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('content-security-policy'), 'sandbox allow-scripts');
  assert.equal((await fetch(base + '/preview/site/..%2F..%2Fsecret.html')).status, 403);
  assert.equal((await fetch(base + '/preview/..%2Fx/index.html')).status, 400);
  assert.equal((await fetch(base + '/preview/nope/index.html')).status, 404);
});

test('เผยแพร่ก่อนอนุมัติไม่ได้; ตีกลับต้องมีเหตุผล; อนุมัติแล้วเผยแพร่ได้', async () => {
  assert.equal((await post('/api/tasks/site/publish')).status, 400);
  const noReason = await post('/api/tasks/site/sign', { reviewer: 'ก', approve: false });
  assert.equal(noReason.status, 400);
  assert.equal((await post('/api/tasks/site/sign', { reviewer: '', approve: true })).status, 400);
  const signed = await (await post('/api/tasks/site/sign', { reviewer: 'สมหญิง', approve: true })).json();
  assert.equal(signed.status, 'approved');
  const pub = await (await post('/api/tasks/site/publish')).json();
  assert.equal(pub.status, 'published');
  await access(join(root, 'dist', 'site', 'index.html'));
});
