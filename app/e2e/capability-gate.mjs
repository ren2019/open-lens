// E2E(US-H3):冷启动能力门。只改浏览器暴露的 Web API 特性,不设置 UA。
// 运行: node app/e2e/capability-gate.mjs(需要 app dev server 在跑)
import { chromium } from 'playwright';

const BASE = process.env.OL_BASE || 'http://localhost:5173';
let failed = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  ${extra}` : ''}`);
  if (!ok) failed++;
};

const browser = await chromium.launch({ args: [
  '--no-sandbox', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
] });

async function openWith(init) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
  });
  if (init) await context.addInitScript(init);
  const page = await context.newPage();
  await page.route('**/opencv.js', route => route.fulfill({ status: 404, body: '' }));
  page.setDefaultTimeout(15000);
  await page.goto(BASE, { waitUntil: 'commit' });
  await page.waitForFunction(() => (document.getElementById('app')?.children.length || 0) > 0);
  return { context, page };
}

const hardCases = [
  ['secure context', () => {
    Object.defineProperty(window, 'isSecureContext', { configurable: true, value: false });
  }],
  ['getUserMedia', () => {
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: undefined });
  }],
  ['WebAssembly', () => {
    Object.defineProperty(globalThis, 'WebAssembly', { configurable: true, value: undefined });
  }],
];
for (const [name, init] of hardCases) {
  const single = await openWith(init);
  await single.page.locator('.capabilityGate').waitFor();
  check(`US-H3: 单项缺失 ${name} 即阻断`,
    await single.page.locator('input.textField').count() === 0
      && await single.page.locator('.problem').count() === 1);
  await single.context.close();
}

// 硬能力任一缺失都必须在 token 前阻断;一次同时移除三项以核对三条出路。
const hard = await openWith(() => {
  Object.defineProperty(window, 'isSecureContext', { configurable: true, value: false });
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: undefined });
  Object.defineProperty(globalThis, 'WebAssembly', { configurable: true, value: undefined });
});
await hard.page.locator('.capabilityGate').waitFor();
const hardText = await hard.page.locator('.capabilityGate').innerText();
check('US-H3: 硬能力缺失挡在 token 之前',
  await hard.page.locator('input.textField').count() === 0,
  `problems=${await hard.page.locator('.problem').count()}`);
check('US-H3: 阻断页给出 HTTPS / 升级 iOS 出路',
  hardText.includes('HTTPS') && hardText.includes('getUserMedia') && hardText.includes('WebAssembly') && hardText.includes('升级 iOS'));
await hard.page.screenshot({ path: '/tmp/ol-h3-hard.png', fullPage: true });
await hard.context.close();

// OPFS 是软能力:缺失仍可输入 token,但待传角标旁必须常显“仅会话”。
const soft = await openWith(() => {
  Object.defineProperty(navigator.storage, 'getDirectory', { configurable: true, value: undefined });
});
await soft.page.locator('input.textField').waitFor();
const queueText = await soft.page.locator('.queueIndicator').innerText();
check('US-H3: OPFS 缺失仍放行', await soft.page.locator('input.textField').isVisible());
check('US-H3: OPFS 降级提示紧邻待传计数常显',
  queueText.includes('待上传 0 个文档') && queueText.includes('仅会话') && queueText.includes('关闭会丢失'), queueText);

const guideText = await soft.page.locator('.installGuide').innerText();
check('US-H3: 未装主屏时提示 7 天风险与添加路径',
  guideText.includes('7 天') && guideText.includes('添加到主屏幕'));
await soft.page.screenshot({ path: '/tmp/ol-h3-soft.png', fullPage: true });
await soft.page.locator('.installClose').click();
check('US-H3: 安装引导可关闭', await soft.page.locator('.installGuide').count() === 0);
await soft.context.close();

// display-mode:standalone 是唯一判断输入之一;主屏模式不再展示安装引导。
const installed = await openWith(() => {
  const nativeMatchMedia = window.matchMedia.bind(window);
  window.matchMedia = query => {
    const result = nativeMatchMedia(query);
    if (query === '(display-mode: standalone)')
      Object.defineProperty(result, 'matches', { configurable: true, value: true });
    return result;
  };
});
await installed.page.locator('input.textField').waitFor();
check('US-H3: standalone 特性为真时不提示安装', await installed.page.locator('.installGuide').count() === 0);
await installed.context.close();

const iosStandalone = await openWith(() => {
  Object.defineProperty(navigator, 'standalone', { configurable: true, value: true });
});
await iosStandalone.page.locator('input.textField').waitFor();
check('US-H3: navigator.standalone 特性为真时不提示安装', await iosStandalone.page.locator('.installGuide').count() === 0);
await iosStandalone.context.close();

await browser.close();
console.log(failed ? `E2E DONE (${failed} FAILED)` : 'E2E DONE');
process.exit(failed ? 1 : 0);
