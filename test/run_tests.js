const puppeteer = require('puppeteer-core');
const BASE = process.env.BASE || 'http://localhost:8090';
(async () => {
  const launch = (cam) => puppeteer.launch({
    executablePath: '/usr/bin/google-chrome', headless: 'new',
    args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
      '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
      '--use-file-for-fake-video-capture=/tmp/pwtest/' + cam]
  });
  let browser = await launch('cam.y4m');
  const results = {};
  // ---- 1. harness ----
  {
    const page = await browser.newPage();
    const errs = [];
    page.on('pageerror', e => errs.push('pageerror: ' + e.message));
    page.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
    await page.setViewport({ width: 1640, height: 900, deviceScaleFactor: 1 });
    await page.goto(BASE + '/test/harness.html', { waitUntil: 'load' });
    await page.waitForFunction('window.__harness && window.__harness.done', { timeout: 240000 });
    const h = await page.evaluate(() => { const o = Object.assign({}, window.__harness); return o; });
    await page.screenshot({ path: '/workspace/cqb-sight/test_result.png', fullPage: true });
    results.harness = { ...h, jsErrors: errs };
    await page.close();
  }
  // ---- 2. main app, iPhone-sized viewport, fake camera fed with the test photo ----
  await browser.close();
  for (const [name, vp, cam] of [['portrait_aimed', { width: 390, height: 844 }, 'cam_aim.y4m'], ['landscape_full', { width: 844, height: 390 }, 'cam.y4m']]) {
    browser = await launch(cam);
    const page = await browser.newPage();
    const errs = [];
    page.on('pageerror', e => errs.push('pageerror: ' + e.message));
    page.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
    await page.setViewport({ ...vp, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    await page.goto(BASE + '/', { waitUntil: 'load' });
    await page.waitForFunction(() => /READY/.test(document.getElementById('status').textContent), { timeout: 180000 });
    const statusBefore = await page.$eval('#status', e => e.textContent);
    await page.click('#btn-start');
    await page.waitForFunction(() => document.getElementById('splash').classList.contains('hidden'), { timeout: 20000 });
    await page.click('#btn-run');
    await new Promise(r => setTimeout(r, 6000));
    const live = await page.evaluate(() => ({
      fps: document.getElementById('fps').textContent, persons: document.getElementById('cnt-person').textContent,
      pets: document.getElementById('cnt-pet').textContent, status: document.getElementById('status').textContent,
      video: [document.getElementById('cam').videoWidth, document.getElementById('cam').videoHeight],
      events: [...document.querySelectorAll('#eventlog li')].map(l => l.textContent),
      tensors: tf.memory().numTensors }));
    await page.screenshot({ path: `/workspace/cqb-sight/test/app_${name}.png` });
    await new Promise(r => setTimeout(r, 3000));
    const tensors2 = await page.evaluate(() => tf.memory().numTensors);
    await page.click('#btn-run');
    await new Promise(r => setTimeout(r, 500));
    const summary = await page.evaluate(() => ({
      total: document.getElementById('sum-total').textContent, people: document.getElementById('sum-people').textContent,
      pets: document.getElementById('sum-pets').textContent, avg: document.getElementById('sum-avg').textContent,
      rows: [...document.querySelectorAll('#sum-rows tr')].map(r => r.textContent),
      runsSaved: window.__cqb.loadRuns().length, csv: window.__cqb.toCSV(window.__cqb.loadRuns()).split('\n').slice(0, 4) }));
    await page.screenshot({ path: `/workspace/cqb-sight/test/app_${name}_summary.png` });
    results['app_' + name] = { statusBefore, live, tensorsLater: tensors2, summary, jsErrors: errs };
    await page.close(); await browser.close();
  }
  console.log(JSON.stringify(results, null, 2));
})().catch(e => { console.error(e); process.exit(1); });
