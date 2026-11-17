#!/usr/bin/env node
// CLI: jev run <task.json...> | status | sign <id> <ชื่อ> [--reject "เหตุผล"] | resume <id>
//      | overdue [นาที] | publish <id> | serve [พอร์ต]
import { resolve, join } from 'node:path';
import { StateStore, REVIEW_WINDOW_MS } from '../src/state.js';
import { runFiles, resume, publish } from '../src/ops.js';
import { createDashboard } from '../src/server.js';

const ROOT = process.env.JEV_HOME ?? resolve('.jev');
const store = new StateStore(join(ROOT, 'state'));
const [cmd, ...args] = process.argv.slice(2);

const commands = {
  async run() {
    for (const t of await runFiles(ROOT, store, args, console.log)) {
      console.log(`\n${t.id}: ${t.status} (${t.hold_reason ?? t.error}) · ${t.hops} hop · ${t.end_to_end_ms ?? '-'}ms\n  workspace: ${t.workspace}`);
    }
  },
  async status() {
    for (const t of await store.all()) console.log(`${t.id}\t${t.status}\t${t.last_route?.next_worker ?? '-'}\t${t.last_route?.urgency ?? '-'}\thops=${t.hops}`);
  },
  async sign() {
    const [id, reviewer, flag, note = ''] = args;
    const reject = flag === '--reject';
    if (reject && !note.trim()) throw new Error('ตีกลับต้องระบุเหตุผล');
    const t = await store.sign(id, reviewer, !reject, note);
    console.log(`${id} → ${t.status} โดย ${reviewer}`);
    if (reject) console.log(`ส่งกลับเข้าวงจรด้วย: jev resume ${id}`);
  },
  async resume() {
    const t = await resume(store, args[0], console.log);
    console.log(`${t.id}: ${t.status} (${t.hold_reason ?? t.error})`);
  },
  async overdue() {
    const win = args[0] ? Number(args[0]) * 60000 : REVIEW_WINDOW_MS;
    const late = await store.overdue(win);
    if (!late.length) return console.log('ไม่มี draft ที่ค้างเกินระยะตรวจ');
    for (const l of late) console.log(`⚠ ${l.id} ถูกกักไว้ ${l.held_minutes} นาที เกินระยะตรวจ ${win / 60000} นาที`);
    process.exitCode = 2;
  },
  async publish() {
    console.log(`เผยแพร่แล้ว → ${await publish(ROOT, store, args[0])}`);
  },
  async serve() {
    const port = Number(args[0] ?? process.env.PORT ?? 4173);
    const host = process.env.HOST ?? '127.0.0.1'; // ค่าเริ่มต้นเปิดเฉพาะเครื่องตัวเอง
    createDashboard({ root: ROOT, store, log: console.log })
      .listen(port, host, () => console.log(`แดชบอร์ด Human Review: http://${host}:${port}`));
  },
};

if (!commands[cmd]) {
  console.log('ใช้งาน: jev run <task.json...> | status | sign <id> <ชื่อ> [--reject "เหตุผล"] | resume <id> | overdue [นาที] | publish <id> | serve [พอร์ต]');
  process.exit(cmd ? 1 : 0);
}
commands[cmd]().catch((e) => { console.error('ผิดพลาด:', e.message); process.exit(1); });
