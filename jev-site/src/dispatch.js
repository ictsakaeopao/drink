// DISPATCH — 8 workers กระจายใน 4 คิว ดึงงานตามความเร่งด่วน
import { route, QUEUES, urgencyRank } from './router.js';
import { WORKERS } from './workers.js';

export const DEFAULT_POOL = { plan: 2, build: 2, revise: 2, review: 2 }; // รวม 8
const MAX_HOPS = 12;

export class Dispatcher {
  constructor({ store, pool = DEFAULT_POOL, workers = WORKERS, log = () => {} }) {
    this.store = store;
    this.pool = pool;
    this.workers = workers;
    this.log = log;
    this.queues = Object.fromEntries(QUEUES.map((q) => [q, []]));
    this.waiting = Object.fromEntries(QUEUES.map((q) => [q, []]));
    this.inflight = 0;
    this.done = [];
    this.stopped = false;
    this.idleResolvers = [];
  }

  /** ใส่งานเข้าคิวตามผลรูท; เรียงด้วย urgency (สูงก่อน) แล้วตามลำดับเข้า */
  async submit(task) {
    task.hops = task.hops ?? 0;
    task.status = 'routing';
    task.started_at = task.started_at ?? Date.now();
    const decision = route(task);
    task.last_route = decision;
    await this.store.save(task, { step: 'route', ...decision });
    this.log(`[${task.id}] hop ${task.hops} → ${decision.next_worker} (${decision.urgency}, conf ${decision.confidence}, safe=${decision.safe_to_run}) ${decision.reason}`);
    const q = this.queues[decision.next_worker];
    q.push({ task, decision, seq: (this.seq = (this.seq ?? 0) + 1) });
    q.sort((a, b) => urgencyRank(b.decision.urgency) - urgencyRank(a.decision.urgency) || a.seq - b.seq);
    this.inflight++;
    this.waiting[decision.next_worker].shift()?.();
  }

  async #take(queue) {
    while (!this.stopped) {
      const job = this.queues[queue].shift();
      if (job) return job;
      await new Promise((r) => this.waiting[queue].push(r));
    }
    return null;
  }

  async #loop(queue, n) {
    const name = `${queue}-${n}`;
    for (;;) {
      const job = await this.#take(queue);
      if (!job) return;
      await this.#run(name, queue, job);
      this.inflight--;
      if (this.inflight === 0) this.idleResolvers.splice(0).forEach((r) => r());
    }
  }

  async #run(name, queue, { task, decision }) {
    task.hops++;
    task.status = `running:${queue}`;
    let note;
    try {
      note = await this.workers[queue](task);
    } catch (err) {
      task.status = 'failed';
      task.error = String(err?.message ?? err);
      await this.store.save(task, { step: queue, worker: name, error: task.error });
      this.done.push(task);
      return;
    }
    await this.store.save(task, { step: queue, worker: name, note });
    this.log(`[${task.id}]   ${name}: ${note}`);

    // เงื่อนไขกักรอคนลงชื่อ: ตรวจผ่านครบ, ความมั่นใจต่ำแม้ตรวจแล้ว, หรือวนเกินกำหนด
    const finishedReview = queue === 'review';
    const lowConfidence = finishedReview && !decision.gate_passed;
    if ((finishedReview && task.ready) || lowConfidence || task.hops >= MAX_HOPS) {
      // low_confidence มาก่อน: แม้ตรวจผ่าน ผู้ลงชื่อต้องรู้ว่ารูทเตอร์ไม่มั่นใจในเป้าหมาย
      task.hold_reason = lowConfidence ? 'low_confidence' : task.ready ? 'ready' : 'max_hops';
      task.end_to_end_ms = Date.now() - task.started_at;
      await this.store.hold(task);
      this.log(`[${task.id}] ⏸ กักรอลงชื่อ (${task.hold_reason}) หลัง ${task.hops} hop, ${task.end_to_end_ms}ms`);
      this.done.push(task);
      return;
    }
    await this.submit(task);
  }

  start() {
    this.loops = Object.entries(this.pool).flatMap(([q, n]) =>
      Array.from({ length: n }, (_, i) => this.#loop(q, i + 1)));
    return this;
  }

  /** รอจนไม่มีงานค้างในทุกคิว */
  idle() {
    return this.inflight === 0 ? Promise.resolve() : new Promise((r) => this.idleResolvers.push(r));
  }

  async stop() {
    this.stopped = true;
    QUEUES.forEach((q) => this.waiting[q].splice(0).forEach((r) => r()));
    await Promise.all(this.loops ?? []);
  }
}
