// worker 4 ชนิด ตรงกับ 4 คิว: plan, build, revise, review
// ทุก worker ทำงานใน workspace ของงาน (ไม่แตะไฟล์จริงจนกว่าคนลงชื่อแล้ว publish)
import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const slug = (p) => (p === 'home' ? 'index' : p);
const fileOf = (page) => `${slug(page)}.html`;

async function htmlFiles(dir) {
  try { return (await readdir(dir)).filter((f) => f.endsWith('.html')); } catch { return []; }
}

/** PLAN — ล็อกสเปก (sitemap) และคำนวณหน้าที่ขาด */
export async function plan(task) {
  const pages = task.goal.pages ?? ['home'];
  const existing = new Set(await htmlFiles(task.workspace));
  task.spec = { sitemap: pages.map((p) => ({ page: p, file: fileOf(p) })), brand: task.goal.brand ?? {} };
  task.notes = { ...task.notes, cutoff: true };
  task.gaps = { missing: pages.filter((p) => !existing.has(fileOf(p))) };
  return `ล็อก sitemap ${pages.length} หน้า, ขาด ${task.gaps.missing.length}`;
}

function shell({ title, description, brand, sitemap, body }) {
  const nav = sitemap.map((s) => `<a href="${s.file}">${s.page}</a>`).join(' ');
  return `<!DOCTYPE html>
<html lang="th">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="description" content="${description}">
  <title>${title} | ${brand.name ?? ''}</title>
  <style>body{margin:0;font-family:Tahoma,"Noto Sans Thai",sans-serif;color:#15324a;line-height:1.7}
  header,main,footer{width:min(1120px,92%);margin:0 auto}nav{display:flex;gap:16px;padding:16px 0}
  a{color:${brand.color ?? '#087fce'}}</style>
</head>
<body>
  <header><nav aria-label="เมนูหลัก">${nav}</nav></header>
  <main>
${body}
  </main>
  <footer><p>© ${brand.name ?? ''} ${brand.phone ? `· <a href="tel:${brand.phone.replace(/\D/g, '')}">${brand.phone}</a>` : ''}</p></footer>
</body>
</html>
`;
}

/** BUILD — สร้างหน้าที่ขาดจาก content brief ทีละหน้า */
export async function build(task) {
  await mkdir(task.workspace, { recursive: true });
  const content = task.goal.content ?? {};
  const built = [];
  for (const page of task.gaps.missing) {
    const c = content[page] ?? { title: page, description: '', body: `<h1>${page}</h1>` };
    const html = shell({ ...c, brand: task.spec.brand, sitemap: task.spec.sitemap });
    await writeFile(join(task.workspace, fileOf(page)), html);
    built.push(fileOf(page));
  }
  task.gaps = { missing: [] };
  task.evidence = { ...task.evidence, fresh: false };
  return `สร้าง ${built.join(', ')}`;
}

/** REVIEW — ตรวจคุณภาพเว็บไซต์ (อ่านอย่างเดียว) */
export async function audit(html, file, siblings) {
  const issues = [];
  const add = (rule, severity, fixable, detail) => issues.push({ file, rule, severity, fixable, detail });
  if (!/<html[^>]*\blang=/i.test(html)) add('html-lang', 'high', true, 'ไม่มี lang บน <html>');
  if (!/<meta[^>]+name=["']viewport/i.test(html)) add('viewport', 'high', true, 'ไม่มี meta viewport');
  if (!/<title>[^<]+<\/title>/i.test(html)) add('title', 'high', false, 'ไม่มี <title>');
  const desc = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i);
  if (!desc || !desc[1].trim()) add('meta-description', 'medium', true, 'meta description ว่างหรือไม่มี');
  for (const img of html.match(/<img\b[^>]*>/gi) ?? []) {
    if (!/\balt=/i.test(img)) add('img-alt', 'high', true, `รูปไม่มี alt: ${img.slice(0, 60)}`);
  }
  const ids = new Set([...html.matchAll(/\bid=["']([^"']+)["']/g)].map((m) => m[1]));
  for (const [, href] of html.matchAll(/href=["']([^"']+)["']/g)) {
    if (href.startsWith('#') && href.length > 1 && !ids.has(href.slice(1))) add('broken-anchor', 'medium', false, `ลิงก์ ${href} ไม่มีปลายทาง`);
    if (/^[\w-]+\.html$/.test(href) && !siblings.includes(href)) add('broken-link', 'critical', false, `ลิงก์ไป ${href} ที่ไม่มีอยู่`);
    if (href.startsWith('tel:') && !/^tel:\+?\d{9,12}$/.test(href)) add('tel-format', 'medium', false, `เบอร์โทรผิดรูปแบบ ${href}`);
  }
  if ((html.match(/<h1\b/gi) ?? []).length !== 1) add('single-h1', 'medium', false, 'ควรมี <h1> หน้าละ 1 อัน');
  return issues;
}

export async function review(task) {
  const files = await htmlFiles(task.workspace);
  const issues = [];
  for (const f of files) issues.push(...(await audit(await readFile(join(task.workspace, f), 'utf8'), f, files)));
  // หน้าที่อยู่ใน sitemap แต่หายจาก workspace → ส่งกลับไป build
  const missing = (task.spec?.sitemap ?? []).filter((s) => !files.includes(s.file)).map((s) => s.page);
  task.gaps = { missing };
  task.evidence = { fresh: true, issues, checked_files: files.length };
  const blocking = issues.filter((i) => ['critical', 'high'].includes(i.severity));
  task.ready = missing.length === 0 && blocking.length === 0 && !issues.some((i) => i.fixable);
  return `ตรวจ ${files.length} ไฟล์ พบ ${issues.length} ปัญหา (บล็อก ${blocking.length})`;
}

/** REVISE — แก้ปัญหาที่แก้อัตโนมัติได้ */
const FIXES = {
  'html-lang': (h) => h.replace(/<html(?![^>]*\blang=)/i, '<html lang="th"'),
  viewport: (h) => h.replace(/<head>/i, '<head>\n  <meta name="viewport" content="width=device-width, initial-scale=1.0">'),
  'meta-description': (h, t) => {
    const text = t.goal.brand?.tagline ?? t.goal.brand?.name ?? 'เว็บไซต์';
    const cleaned = h.replace(/<meta[^>]+name=["']description["'][^>]*>\s*/i, '');
    return cleaned.replace(/<\/title>/i, `</title>\n  <meta name="description" content="${text}">`);
  },
  'img-alt': (h) => h.replace(/<img\b(?![^>]*\balt=)/gi, '<img alt=""'),
};

export async function revise(task) {
  const byFile = {};
  for (const i of task.evidence.issues.filter((x) => x.fixable)) (byFile[i.file] ??= new Set()).add(i.rule);
  let n = 0;
  for (const [file, rules] of Object.entries(byFile)) {
    const p = join(task.workspace, file);
    let html = await readFile(p, 'utf8');
    for (const r of rules) { html = FIXES[r](html, task); n++; }
    await writeFile(p, html);
  }
  task.evidence = { ...task.evidence, fresh: false, issues: task.evidence.issues.filter((i) => !i.fixable) };
  return `แก้ ${n} กฎใน ${Object.keys(byFile).length} ไฟล์`;
}

export const WORKERS = { plan, build, revise, review };
