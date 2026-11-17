# JEV agent-router สำหรับการสร้างเว็บไซต์

แปลงแนวคิด JEV agent-router (เดิมใช้กับงานวิจัย/เขียนบทความ) มาเป็นระบบสร้างเว็บไซต์
ทุกงานเดินผ่านเส้นทางที่ตรวจสอบได้ตั้งแต่วางแผนจนเผยแพร่ และไม่มีหน้าไหนขึ้นจริงถ้ายังไม่มีคนลงชื่อ

```
task.json ─► ROUTER (JEV-1.13.0) ─► GATE ≥ 0.85 ─► DISPATCH (8 workers / 4 คิว)
                 ▲                                      │
                 └──────────── ผลจาก worker ◄───────────┘
                                                        │ ตรวจผ่าน / ความมั่นใจต่ำ / วนเกิน
                                                        ▼
                                         HUMAN REVIEW (กักรอลงชื่อ) ─► publish
```

## การจับคู่จากระบบเดิม

| ระบบวิจัยเดิม | ระบบสร้างเว็บไซต์ | ความหมาย |
|---|---|---|
| research | **plan** | ล็อก sitemap, brand, content brief |
| write | **build** | สร้างหน้าที่ยังขาดจากเทมเพลต |
| revise | **revise** | แก้ปัญหาที่แก้อัตโนมัติได้ (lang, viewport, meta description, alt) |
| review | **review** | ตรวจคุณภาพแบบอ่านอย่างเดียว (SEO, a11y, ลิงก์เสีย, รูปแบบเบอร์โทร, h1) |
| `goal.intent` | `goal.intent` | `new_site` · `add_page` · `fix` · `launch` |
| `notes.cutoff` | สเปกถูกล็อกแล้ว | ยังไม่ล็อก → plan |
| `evidence.fresh` | ผลตรวจตรงกับไฟล์ล่าสุด | ไฟล์เปลี่ยนหลังตรวจ → review |
| `gaps.missing` | หน้าที่อยู่ใน sitemap แต่ยังไม่มีไฟล์ | มีหน้าขาด → build |

## ROUTER: 3 คำถามต่อ hop

`route(task)` (`src/router.js`) เป็นฟังก์ชันบริสุทธิ์ ไม่มี I/O และคืนค่า

- `next_worker` — หนึ่งใน `plan | build | revise | review`
- `urgency` — `low | medium | high | critical` คิดจากเส้นตาย (≤4 ชม. = critical, ≤24 = high, ≤72 = medium) และความรุนแรงของปัญหาที่ตรวจพบ ถ้าเว็บล่ม (`site_down`) จะเป็น critical ทันที
- `safe_to_run` — `yes` เมื่อผ่านเกต หรือเมื่องานถูกส่งไป review ซึ่งอ่านอย่างเดียว

นอกจากนี้ยังคืน `confidence`, `reason` และ `latency_ms` ที่วัดจริง โดยการทดสอบกำหนดว่าต้องไม่เกิน 4ms ต่อ hop

ลำดับการตัดสินใจ: สเปกยังไม่ล็อก → **plan** · มีหน้าขาด → **build** · ผลตรวจไม่สด → **review** · มีปัญหาที่แก้อัตโนมัติได้ → **revise** · นอกนั้น → **review** รอบสุดท้าย

## GATE ≥ 0.85

ความมั่นใจเริ่มที่ 1.0 และจะถูกหักเมื่อ intent ไม่รู้จัก, สัญญาณไม่ครบ, สัญญาณขัดกันเอง (เช่น `fix` แต่ยังมีหน้าขาด หรือ `launch` แต่สเปกยังไม่ล็อก) หรือวนเกิน 8 hop
ถ้าต่ำกว่า 0.85 งานทุกชนิดจะถูกส่งไป **review** แทน และหลังตรวจแล้วจะถูกกักรอคนตัดสินโดยระบุเหตุผลว่า `low_confidence`

## DISPATCH

ค่าเริ่มต้นมี 8 workers แบ่งเป็นคิวละ 2 ตัว (`DEFAULT_POOL` ใน `src/dispatch.js` ซึ่งปรับได้) แต่ละคิวเรียงงานตาม urgency จากมากไปน้อย ถ้า urgency เท่ากันจะทำตามลำดับที่เข้ามา
งานเดียวกันวิ่งทีละ hop ส่วนงานคนละชิ้นวิ่งขนานกันได้ เพดานอยู่ที่ 12 hop ต่องาน

## HUMAN REVIEW

- ระบบจะ **กัก** draft (`held_for_signoff`) ไว้เมื่อเกิดกรณีใดกรณีหนึ่ง: ตรวจผ่านครบ, ความมั่นใจต่ำ หรือวนเกินเพดาน
- `publish` ทำงานได้เฉพาะงานที่สถานะเป็น `approved` เท่านั้น
- ทุกขั้นถูกเขียนลง `.jev/state/<id>.json` แบบ atomic (เขียนไฟล์ tmp แล้ว rename) พร้อมประวัติครบ ถ้าโปรเซสล่ม ข้อมูลก็ไม่หาย
- ถ้าลงชื่อแบบ `--reject` ผลตรวจจะถูกตั้งเป็นไม่สด แล้วส่งงานกลับเข้าวงจรด้วย `resume`
- `jev overdue [นาที]` แจ้ง draft ที่ถูกกักนานเกินระยะตรวจ (ค่าเริ่มต้น 30 นาที) และ exit code 2 จึงเอาไปต่อกับ cron หรือ CI ได้

## ใช้งาน

```bash
cd jev-site
npm test                                   # ทดสอบ 9 ชุด
node bin/jev.js run tasks/drink-site.json  # ต่อยอดเว็บน้ำดื่ม: เพิ่ม products/delivery/contact
node bin/jev.js status
node bin/jev.js sign drink-site "ชื่อผู้ตรวจ"            # อนุมัติ
node bin/jev.js sign drink-site "ชื่อ" --reject "แก้ราคา"  # ตีกลับ แล้ว: node bin/jev.js resume drink-site
node bin/jev.js overdue 30
node bin/jev.js publish drink-site         # → .jev/dist/drink-site/
```

`seed` ใน task จะคัดลอกไฟล์เว็บเดิม (`../index.html`) เข้า workspace ของงาน ระบบจึงไม่แตะต้นฉบับ
ไม่มี dependency ภายนอก ใช้ Node ≥ 20
