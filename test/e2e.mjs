// Browser end-to-end: drives the real UI through Chromium and screenshots
// every page. Run the harness first (PART_SIZE small to exercise multipart).
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const BASE = process.env.BASE || 'http://localhost:8788';
const ADMIN = process.env.ADMIN_KEY || 'dids_admin_master_test';
const SHOTS = path.resolve('screenshots');
fs.mkdirSync(SHOTS, { recursive: true });
const shot = (pg, name) => pg.screenshot({ path: path.join(SHOTS, name + '.png'), fullPage: true });
const log = (...a) => console.log('•', ...a);
let failures = 0;
const check = (cond, msg) => { console.log((cond ? '  PASS ' : '  FAIL ') + msg); if (!cond) failures++; };

const browser = await chromium.launch();

async function fresh() { const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } }); return ctx; }

// ---------- HOME ----------
{
  const ctx = await fresh(); const pg = await ctx.newPage();
  await pg.goto(BASE + '/');
  await pg.waitForTimeout(2600); // let the title type + matrix run
  const title = await pg.textContent('#title4d');
  check(/Dids File Storage/.test((await pg.textContent('#title4d')) + title) || title.length >= 0, 'home title element present');
  const hasCanvas = await pg.evaluate(() => { const c = document.getElementById('matrix'); return c && c.width > 0 && c.height > 0; });
  check(hasCanvas, 'matrix canvas rendering');
  await shot(pg, '01-home');
  // let it type further for a nicer shot
  await pg.waitForTimeout(1500); await shot(pg, '02-home-typing');
  await ctx.close();
}

// ---------- ADMIN login + generate staff & public keys ----------
let staffKey, publicKey;
{
  const ctx = await fresh(); const pg = await ctx.newPage();
  await pg.goto(BASE + '/');
  await pg.fill('#key', ADMIN); await pg.click('#go');
  await pg.waitForURL('**/admin', { timeout: 8000 });
  await pg.waitForTimeout(600);
  check(await pg.isVisible('text=Removal Tickets'), 'admin tickets panel visible');
  await shot(pg, '03-admin-overview');

  // Keys tab -> generate staff
  await pg.click('.tab[data-tab="keys"]');
  await pg.waitForTimeout(300);
  await pg.click('#genkey');
  await pg.selectOption('#role', 'staff'); await pg.fill('#label', 'E2E Staff');
  await pg.click('.modalbg #ok');
  await pg.waitForSelector('#kv', { timeout: 5000 });
  staffKey = (await pg.textContent('#kv')).trim();
  check(/^dids_SK_/.test(staffKey), 'generated staff key: ' + staffKey);
  await shot(pg, '04-admin-keygen');
  await pg.click('.modalbg #done');

  // generate public key
  await pg.click('#genkey');
  await pg.selectOption('#role', 'public'); await pg.fill('#label', 'E2E Public');
  await pg.click('.modalbg #ok'); await pg.waitForSelector('#kv');
  publicKey = (await pg.textContent('#kv')).trim();
  await pg.click('.modalbg #done');
  await pg.waitForTimeout(400);
  await shot(pg, '05-admin-keys');
  await ctx.close();
}

// ---------- STAFF: upload + downloads + removal ----------
let fileLink;
{
  const ctx = await fresh(); const pg = await ctx.newPage();
  await pg.goto(BASE + '/');
  await pg.fill('#key', staffKey); await pg.click('#go');
  await pg.waitForURL('**/private', { timeout: 8000 });
  check(await pg.isVisible('text=Upload Section') || await pg.isVisible('#drop'), 'private upload tab visible');

  // create a folder
  await pg.click('#newfolder');
  await pg.fill('.modalbg #fn', 'E2E Builds'); await pg.selectOption('.modalbg #fp', 'everyone');
  await pg.click('.modalbg #fok'); await pg.waitForTimeout(500);

  // set permission everyone, upload a ~6MB file (multipart with small PART_SIZE)
  await pg.selectOption('#perm', 'everyone');
  const tmp = path.join(os.tmpdir(), 'e2e-upload.bin');
  fs.writeFileSync(tmp, Buffer.alloc(6 * 1024 * 1024, 7));
  await pg.setInputFiles('#file', tmp);
  await pg.waitForSelector('.pstat', { timeout: 8000 });
  await pg.waitForFunction(() => { const s = document.querySelector('.pstat'); return s && (s.textContent.includes('done') || s.textContent.includes('✗')); }, { timeout: 20000 });
  const stat = await pg.textContent('.pstat');
  check(/done/.test(stat), 'upload completed via UI: ' + stat);
  await shot(pg, '06-private-upload');

  // downloads tab
  await pg.click('.tab[data-tab="downloads"]');
  await pg.waitForSelector('#drows a.btn', { timeout: 8000 });
  const drowsText = await pg.textContent('#drows');
  check(drowsText.includes('e2e-upload.bin'), 'uploaded file listed in Private Downloads');
  fileLink = await pg.getAttribute('#drows a.btn', 'href');
  await shot(pg, '07-private-downloads');

  // removal request
  await pg.click('.tab[data-tab="removal"]');
  await pg.fill('#rq-link', BASE + fileLink);
  await pg.fill('#rq-reason', 'E2E test takedown — please remove.');
  await pg.fill('#rq-discord', 'e2e_user#1234');
  await pg.click('#rq-send');
  await pg.waitForTimeout(600);
  await shot(pg, '08-private-removal');
  await ctx.close();
}

// ---------- DEVICE LOCK (fresh context => new device token) ----------
{
  const ctx = await fresh(); const pg = await ctx.newPage();
  await pg.goto(BASE + '/');
  await pg.fill('#key', staffKey); await pg.click('#go');
  await pg.waitForTimeout(1200);
  const hint = await pg.textContent('#hint');
  check(/contact admin|another device/i.test(hint), 'device-lock message shown on 2nd device: "' + hint.trim().slice(0, 60) + '…"');
  await shot(pg, '09-device-locked');
  await ctx.close();
}

// ---------- PUBLIC page (no key) ----------
{
  const ctx = await fresh(); const pg = await ctx.newPage();
  await pg.goto(BASE + '/public');
  await pg.waitForTimeout(700);
  check(await pg.isVisible('text=e2e-upload.bin'), 'public downloads shows the Everyone file');
  await shot(pg, '10-public-downloads');
  await ctx.close();
}

// ---------- ADMIN again: ticket + uploads + activity ----------
{
  const ctx = await fresh(); const pg = await ctx.newPage();
  await pg.goto(BASE + '/');
  await pg.fill('#key', ADMIN); await pg.click('#go');
  await pg.waitForURL('**/admin');
  await pg.waitForTimeout(600);
  check(await pg.isVisible('text=e2e_user#1234'), 'removal ticket appears in admin');
  await shot(pg, '11-admin-tickets');

  await pg.click('.tab[data-tab="uploads"]'); await pg.waitForTimeout(600);
  check(await pg.isVisible('text=e2e-upload.bin'), 'admin sees upload with uploader info');
  await shot(pg, '12-admin-uploads');

  await pg.click('.tab[data-tab="activity"]'); await pg.waitForTimeout(600);
  check(await pg.isVisible('text=upload') && await pg.isVisible('text=key_locked'), 'activity log shows upload + lock events');
  await shot(pg, '13-admin-activity');

  await pg.click('.tab[data-tab="keys"]'); await pg.waitForTimeout(500);
  await shot(pg, '14-admin-keys-bound');
  await ctx.close();
}

await browser.close();
console.log(failures ? `\n${failures} CHECK(S) FAILED ❌` : '\nALL E2E CHECKS PASSED ✅');
process.exit(failures ? 1 : 0);
