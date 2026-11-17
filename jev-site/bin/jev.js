#!/usr/bin/env node
// CLI: jev run <task.json> | status | sign <id> <ชื่อ> [--reject "เหตุผล"] | overdue [นาที] | publish <id>
import { readFile, cp, mkdir } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { StateStore, REVIEW_WINDOW_MS } from '../src/state.js';
import { Dispatcher } from '../src/dispatch.js';

const ROOT = process.env.JEV_HOME ?? resolve('.jev');
const store = new StateStore(join(ROOT, 'state'));
const [cmd, ...args] = process.argv.slice(2);

async function run(files) {
  const d = new Dispatcher({ store, log: console.log }).start();
  for (const f of files) {
    const task = JSON.parse(await readFile(f, 'utf8'));
    task.workspace = join(ROOT, 'work', task.id);
    await mkdir(task.workspace, { recursive: true });
    // seed: คัดลอกไฟล์เว็บไซต์เดิมเข้ามาเป็นจุดเริ่ม (ไม่แตะต้นฉบับ)
    for (const s of task.seed ?? []) await cp(resolve(dirname(f), s), join(task.workspace, s.split('/').pop()));
    await d.submit(task);
  }
  await d.idle();
  await d.stop();
  for (const t of d.done) console.log(`\n${t.id}: ${t.status} (${t.hold_reason ?? t.error}) · ${t.hops} hop · ${t.end_to_end_ms ?? '-'}ms\n  workspace: ${t.workspace}`);
}

const commands = {
  run: () => run(args),
  async status() {
    for (const t of await store.all()) console.log(`${t.id}\t${t.status}\t${t.last_route?.next_worker ?? '-'}\t${t.last_route?.urgency ?? '-'}\thops=${t.hops}`);
  },
  async sign() {
    const [id, reviewer, flag, note = ''] = args;
    const t = await store.sign(id, reviewer, flag !== '--reject', note);
    console.log(`${id} → ${t.status} โดย ${reviewer}`);
    if (t.status === 'changes_requested') console.log('ส่งกลับเข้าวงจรด้วย: jev resume', id);
  },
  async resume() {
    const d = new Dispatcher({ store, log: console.log }).start();
    const t = await store.load(args[0]);
    t.status = 'routing';
    await d.submit(t);
    await d.idle();
    await d.stop();
  },
  async overdue() {
    const win = args[0] ? Number(args[0]) * 60000 : REVIEW_WINDOW_MS;
    const late = await store.overdue(win);
    if (!late.length) return console.log('ไม่มี draft ที่ค้างเกินระยะตรวจ');
    for (const l of late) console.log(`⚠ ${l.id} ถูกกักไว้ ${l.held_minutes} นาที เกินระยะตรวจ ${win / 60000} นาที`);
    process.exitCode = 2;
  },
  async publish() {
    const t = await store.load(args[0]);
    if (t.status !== 'approved') throw new Error(`เผยแพร่ไม่ได้: สถานะ ${t.status} (ต้อง approved ก่อน)`);
    const out = join(ROOT, 'dist', t.id);
    await cp(t.workspace, out, { recursive: true });
    t.status = 'published';
    await store.save(t, { step: 'publish', out });
    console.log(`เผยแพร่แล้ว → ${out}`);
  },
};

if (!commands[cmd]) {
  console.log('ใช้งาน: jev run <task.json...> | status | sign <id> <ชื่อ> [--reject "เหตุผล"] | resume <id> | overdue [นาที] | publish <id>');
  process.exit(cmd ? 1 : 0);
}
commands[cmd]().catch((e) => { console.error('ผิดพลาด:', e.message); process.exit(1); });
