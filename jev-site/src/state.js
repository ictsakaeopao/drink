// บันทึกสถานะทุกขั้นเป็น JSON และกักงานรอการลงชื่อของคน (HUMAN REVIEW)
import { mkdir, readFile, writeFile, readdir, rename } from 'node:fs/promises';
import { join } from 'node:path';

export const REVIEW_WINDOW_MS = 30 * 60 * 1000; // ระยะการตรวจในเซสชัน (ค่าเริ่มต้น 30 นาที)

export class StateStore {
  constructor(dir) { this.dir = dir; }

  path(id) { return join(this.dir, `${id}.json`); }

  /** เขียนแบบ atomic (tmp → rename) เพื่อไม่ให้ไฟล์ขาดครึ่งเมื่อโปรเซสล่ม */
  async save(task, event) {
    await mkdir(this.dir, { recursive: true });
    task.history = task.history ?? [];
    if (event) task.history.push({ at: new Date().toISOString(), ...event });
    const tmp = `${this.path(task.id)}.tmp`;
    await writeFile(tmp, JSON.stringify(task, null, 2));
    await rename(tmp, this.path(task.id));
    return task;
  }

  async load(id) { return JSON.parse(await readFile(this.path(id), 'utf8')); }

  async all() {
    let files = [];
    try { files = await readdir(this.dir); } catch { return []; }
    return Promise.all(files.filter((f) => f.endsWith('.json')).map((f) => this.load(f.slice(0, -5))));
  }

  /** กัก draft ไว้รอคนลงชื่อ — งานจะไม่ถูกเผยแพร่จนกว่าจะ sign() */
  async hold(task) {
    task.status = 'held_for_signoff';
    task.held_at = new Date().toISOString();
    return this.save(task, { step: 'hold', note: 'กัก draft รอการลงชื่อ' });
  }

  async sign(id, reviewer, approve = true, note = '') {
    const task = await this.load(id);
    if (task.status !== 'held_for_signoff') throw new Error(`งาน ${id} ไม่ได้อยู่ในสถานะรอลงชื่อ (${task.status})`);
    if (!reviewer) throw new Error('ต้องระบุชื่อผู้ลงชื่อ');
    task.status = approve ? 'approved' : 'changes_requested';
    task.signoff = { reviewer, approve, note, at: new Date().toISOString() };
    if (!approve) {
      // ส่งกลับเข้าวงจร: ผลตรวจเดิมไม่ใช้ได้อีก ให้รูทเตอร์ตัดสินใหม่
      task.evidence = { ...task.evidence, fresh: false };
      if (note) task.gaps = { missing: [...(task.gaps?.missing ?? [])], notes: [note] };
    }
    return this.save(task, { step: 'signoff', reviewer, approve, note });
  }

  /** draft ที่ถูกกักเกินระยะการตรวจ → ใช้แจ้งเตือน */
  async overdue(windowMs = REVIEW_WINDOW_MS, now = Date.now()) {
    return (await this.all())
      .filter((t) => t.status === 'held_for_signoff' && now - Date.parse(t.held_at) > windowMs)
      .map((t) => ({ id: t.id, held_minutes: Math.floor((now - Date.parse(t.held_at)) / 60000) }));
  }
}
