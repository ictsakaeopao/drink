// การกระทำที่ CLI และแดชบอร์ดใช้ร่วมกัน
import { readFile, cp, mkdir } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { Dispatcher } from './dispatch.js';

export const ID_RE = /^[\w-]{1,64}$/;

export function assertId(id) {
  if (!ID_RE.test(id ?? '')) throw new Error(`รหัสงานไม่ถูกต้อง: ${id}`);
  return id;
}

async function drive(store, tasks, log) {
  const d = new Dispatcher({ store, log }).start();
  for (const t of tasks) await d.submit(t);
  await d.idle();
  await d.stop();
  return d.done;
}

/** โหลด task.json, เตรียม workspace (คัดลอก seed), แล้วรันจนถูกกัก */
export async function runFiles(root, store, files, log = () => {}) {
  const tasks = [];
  for (const f of files) {
    const task = JSON.parse(await readFile(f, 'utf8'));
    assertId(task.id);
    task.workspace = join(root, 'work', task.id);
    await mkdir(task.workspace, { recursive: true });
    for (const s of task.seed ?? []) await cp(resolve(dirname(f), s), join(task.workspace, s.split('/').pop()));
    tasks.push(task);
  }
  return drive(store, tasks, log);
}

export async function resume(store, id, log = () => {}) {
  const t = await store.load(assertId(id));
  if (t.status !== 'changes_requested') throw new Error(`resume ได้เฉพาะงานที่ถูกตีกลับ (ตอนนี้: ${t.status})`);
  t.status = 'routing';
  delete t.ready;
  t.started_at = Date.now(); // วัดเวลาเฉพาะรอบนี้ ไม่นับช่วงที่รอคนลงชื่อ
  return (await drive(store, [t], log))[0];
}

export async function publish(root, store, id) {
  const t = await store.load(assertId(id));
  if (t.status !== 'approved') throw new Error(`เผยแพร่ไม่ได้: สถานะ ${t.status} (ต้อง approved ก่อน)`);
  const out = join(root, 'dist', t.id);
  await cp(t.workspace, out, { recursive: true });
  t.status = 'published';
  await store.save(t, { step: 'publish', out });
  return out;
}
