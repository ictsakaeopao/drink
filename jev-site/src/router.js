// JEV-1.13.0 router สำหรับงานสร้างเว็บไซต์
// ตอบ 3 คำถามต่อ hop: next_worker, urgency, safe_to_run
//
// สัญญาณขาเข้า (แปลงจากระบบงานวิจัยเดิม):
//   goal.intent    — เป้าหมายของงาน: "new_site" | "add_page" | "fix" | "launch"
//   notes.cutoff   — สเปก (sitemap + brief) ถูกล็อกแล้วหรือยัง  (เดิม: ตัดรับโน้ต)
//   evidence.fresh — ผลตรวจ (audit) ล่าสุดตรงกับไฟล์ปัจจุบันหรือไม่  (เดิม: หลักฐานใหม่)
//   gaps.missing   — หน้า/ส่วนที่ยังไม่มีในเว็บไซต์  (เดิม: ช่องว่างของเนื้อหา)

export const VERSION = 'JEV-1.13.0';
export const QUEUES = ['plan', 'build', 'revise', 'review'];
export const URGENCY = ['low', 'medium', 'high', 'critical'];
export const GATE = 0.85;

const INTENTS = new Set(['new_site', 'add_page', 'fix', 'launch']);

/** เลือกคิวถัดไปจากสัญญาณ พร้อมเหตุผล */
function pickWorker({ intent, cutoff, fresh, missing, issues }) {
  if (!cutoff) return ['plan', 'สเปกยังไม่ล็อก ต้องวาง sitemap/brief ก่อน'];
  if (missing.length > 0) return ['build', `ยังขาด ${missing.length} หน้า: ${missing.join(', ')}`];
  if (!fresh) return ['review', 'ไฟล์เปลี่ยนหลังการตรวจครั้งล่าสุด ต้องตรวจใหม่'];
  if (issues.some((i) => i.fixable)) return ['revise', `พบปัญหาที่แก้อัตโนมัติได้ ${issues.filter((i) => i.fixable).length} รายการ`];
  return ['review', intent === 'launch' ? 'พร้อมเสนอเผยแพร่ ส่งให้คนลงชื่อ' : 'ครบถ้วน ส่งตรวจรอบสุดท้าย'];
}

/** ความมั่นใจของการรูท: ลดลงเมื่อสัญญาณขาดหรือขัดกันเอง */
function confidenceOf(task, s) {
  let c = 1;
  const why = [];
  if (!INTENTS.has(s.intent)) { c -= 0.3; why.push(`goal.intent ไม่รู้จัก (${s.intent ?? 'ว่าง'})`); }
  if (task.notes?.cutoff === undefined) { c -= 0.1; why.push('ไม่ระบุ notes.cutoff'); }
  if (task.evidence?.fresh === undefined) { c -= 0.1; why.push('ไม่ระบุ evidence.fresh'); }
  if (!Array.isArray(task.gaps?.missing)) { c -= 0.1; why.push('ไม่ระบุ gaps.missing'); }
  if (s.intent === 'fix' && s.missing.length > 0) { c -= 0.2; why.push('intent=fix แต่ยังมีหน้าที่ขาด'); }
  if (s.intent === 'launch' && !s.cutoff) { c -= 0.2; why.push('intent=launch แต่สเปกยังไม่ล็อก'); }
  if ((task.hops ?? 0) >= 8) { c -= 0.25; why.push('วนรูทเกิน 8 hop'); }
  return { confidence: Math.max(0, Math.round(c * 100) / 100), why };
}

/** ความเร่งด่วน: จากเส้นตายและความรุนแรงของปัญหาที่ตรวจพบ */
function urgencyOf(task, now) {
  const issues = task.evidence?.issues ?? [];
  if (task.site_down || issues.some((i) => i.severity === 'critical')) return 'critical';
  const hours = task.deadline ? (Date.parse(task.deadline) - now) / 3.6e6 : Infinity;
  if (hours <= 4) return 'critical';
  if (hours <= 24 || issues.some((i) => i.severity === 'high')) return 'high';
  if (hours <= 72 || issues.length > 0) return 'medium';
  return 'low';
}

/**
 * route(task) → { next_worker, urgency, safe_to_run, confidence, gate_passed, reason, latency_ms }
 * ฟังก์ชันบริสุทธิ์ ไม่มี I/O จึงใช้เวลาระดับไมโครวินาทีต่อ hop
 */
export function route(task, now = Date.now()) {
  const t0 = performance.now();
  const s = {
    intent: task.goal?.intent,
    cutoff: Boolean(task.notes?.cutoff),
    fresh: Boolean(task.evidence?.fresh),
    missing: task.gaps?.missing ?? [],
    issues: task.evidence?.issues ?? [],
  };
  let [next_worker, reason] = pickWorker(s);
  const { confidence, why } = confidenceOf(task, s);
  const gate_passed = confidence >= GATE;
  if (!gate_passed) {
    next_worker = 'review';
    reason = `ความมั่นใจ ${confidence} < ${GATE}: ${why.join('; ')} → ส่งรีวิว`;
  }
  const urgency = urgencyOf(task, now);
  // review อ่านอย่างเดียว จึงรันได้เสมอ; plan/build/revise รันอัตโนมัติได้เมื่อผ่านเกต
  const safe_to_run = gate_passed || next_worker === 'review' ? 'yes' : 'no';
  return {
    router: VERSION,
    next_worker,
    urgency,
    safe_to_run,
    confidence,
    gate_passed,
    reason,
    latency_ms: Math.round((performance.now() - t0) * 1000) / 1000,
  };
}

export const urgencyRank = (u) => URGENCY.indexOf(u);
