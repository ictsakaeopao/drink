// แดชบอร์ด HUMAN REVIEW — ดูงาน, พรีวิวหน้าเว็บ, ลงชื่ออนุมัติ/ตีกลับ, เผยแพร่
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, resolve, sep, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REVIEW_WINDOW_MS } from './state.js';
import { assertId, resume, publish } from './ops.js';

const UI = fileURLToPath(new URL('./dashboard.html', import.meta.url));
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml' };

function send(res, code, body, type = 'application/json; charset=utf-8') {
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(type.startsWith('application/json') ? JSON.stringify(body) : body);
}

async function readJson(req) {
  let raw = '';
  for await (const c of req) { raw += c; if (raw.length > 1e5) throw new Error('payload ใหญ่เกินไป'); }
  return raw ? JSON.parse(raw) : {};
}

function summary(t, windowMs, now) {
  const heldMs = t.status === 'held_for_signoff' && t.held_at ? now - Date.parse(t.held_at) : 0;
  return {
    id: t.id,
    status: t.status,
    intent: t.goal?.intent,
    hold_reason: t.hold_reason,
    hops: t.hops,
    end_to_end_ms: t.end_to_end_ms,
    route: t.last_route,
    pages: (t.spec?.sitemap ?? []).map((s) => s.file),
    issues: t.evidence?.issues ?? [],
    signoff: t.signoff,
    held_minutes: Math.floor(heldMs / 60000),
    overdue: heldMs > windowMs,
    history: t.history ?? [],
  };
}

export function createDashboard({ root, store, windowMs = REVIEW_WINDOW_MS, log = () => {} }) {
  const busy = new Set(); // กันกดซ้ำระหว่างงานเดียวกันกำลังรัน

  async function handle(req, res) {
    const url = new URL(req.url, 'http://local');
    const parts = url.pathname.split('/').filter(Boolean);

    if (req.method === 'GET' && url.pathname === '/') return send(res, 200, await readFile(UI, 'utf8'), TYPES['.html']);

    if (req.method === 'GET' && url.pathname === '/api/tasks') {
      const now = Date.now();
      const tasks = (await store.all()).map((t) => summary(t, windowMs, now))
        .sort((a, b) => Number(b.overdue) - Number(a.overdue) || a.id.localeCompare(b.id));
      return send(res, 200, { window_minutes: windowMs / 60000, tasks });
    }

    // /preview/:id/:file — เสิร์ฟไฟล์จาก workspace ของงาน ห้ามออกนอกโฟลเดอร์
    if (req.method === 'GET' && parts[0] === 'preview' && parts.length === 3) {
      const t = await store.load(assertId(parts[1]));
      const base = resolve(t.workspace);
      const file = resolve(base, decodeURIComponent(parts[2]));
      if (!file.startsWith(base + sep)) return send(res, 403, { error: 'ไม่อนุญาต' });
      const type = TYPES[extname(file)];
      if (!type) return send(res, 415, { error: 'ชนิดไฟล์ไม่รองรับ' });
      // sandbox ผ่าน CSP: พรีวิวรันสคริปต์ได้ แต่แตะ origin ของแดชบอร์ดไม่ได้
      res.setHeader('content-security-policy', 'sandbox allow-scripts');
      return send(res, 200, await readFile(file), type);
    }

    if (req.method === 'POST' && parts[0] === 'api' && parts[1] === 'tasks' && parts.length === 4) {
      const id = assertId(parts[2]);
      const action = parts[3];
      if (busy.has(id)) return send(res, 409, { error: 'งานนี้กำลังดำเนินการอยู่' });
      busy.add(id);
      try {
        if (action === 'sign') {
          const { reviewer, approve, note } = await readJson(req);
          if (!approve && !note?.trim()) throw new Error('ตีกลับต้องระบุเหตุผล');
          const t = await store.sign(id, reviewer?.trim(), Boolean(approve), note?.trim() ?? '');
          log(`[dashboard] ${id} → ${t.status} โดย ${reviewer}`);
          return send(res, 200, { status: t.status });
        }
        if (action === 'resume') {
          const t = await resume(store, id, log);
          return send(res, 200, { status: t.status, hold_reason: t.hold_reason });
        }
        if (action === 'publish') return send(res, 200, { status: 'published', out: await publish(root, store, id) });
        return send(res, 404, { error: 'ไม่รู้จักคำสั่ง' });
      } finally {
        busy.delete(id);
      }
    }
    send(res, 404, { error: 'ไม่พบ' });
  }

  return createServer((req, res) => {
    handle(req, res).catch((e) => {
      const code = e.code === 'ENOENT' ? 404 : 400;
      send(res, code, { error: code === 404 ? 'ไม่พบ' : e.message });
    });
  });
}
