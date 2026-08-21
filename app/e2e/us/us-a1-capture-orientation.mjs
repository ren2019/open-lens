import {
  PHOTOS, checks, deleteDoc, login, openApp, openScanner, waitForCreatedDoc,
} from '../lib/harness.mjs';

const PORTRAIT = { width: 390, height: 844 };
const LANDSCAPE = { width: 844, height: 390 };
const CAPTURE_ELEMENT_SELECTORS = [
  '.camtop .iconbtn', '.liveState', '.modebar', '.cambar label.ghost', '.cambar button.ghost',
  '.shutter', '.lastshot', '.fab',
];
const CAPTURE_ACTION_SELECTORS = [
  '.cambar label.ghost', '.cambar button.ghost', '.shutter', '.lastshot', '.fab',
];
const MODE_CHOICE_SELECTORS = [
  '.modechoice[data-mode="auto"]',
  '.modechoice[data-mode="screen"]',
  '.modechoice[data-mode="document"]',
  '.modechoice[data-mode="whiteboard"]',
  '.modechoice[data-mode="businesscard"]',
];
const DEVICE_STABLE_SELECTORS = [...CAPTURE_ACTION_SELECTORS, ...MODE_CHOICE_SELECTORS];
const MODE_MAPPING_TOLERANCE_PX = 6;
const ACTION_MAPPING_TOLERANCE_PX = 14;
const t = checks('US-A1');

function installStandaloneCameraControls() {
  const nativeMatchMedia = window.matchMedia.bind(window);
  window.matchMedia = query => {
    const result = nativeMatchMedia(query);
    if (query === '(display-mode: standalone)') {
      Object.defineProperty(result, 'matches', { configurable: true, value: true });
    }
    return result;
  };

  let orientationAngle = 0;
  Object.defineProperty(window, 'orientation', {
    configurable: true,
    get: () => orientationAngle,
  });
  window.__setOpenLensOrientationAngle = angle => {
    orientationAngle = angle;
    window.dispatchEvent(new Event('orientationchange'));
  };

  const nativeGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  window.__openLensGetUserMediaCalls = 0;
  navigator.mediaDevices.getUserMedia = (...args) => {
    window.__openLensGetUserMediaCalls++;
    return nativeGetUserMedia(...args);
  };
}

async function waitForCamera(page) {
  await page.waitForFunction(() => {
    const video = document.querySelector('video');
    const stream = video?.srcObject;
    return stream instanceof MediaStream
      && !video.paused
      && stream.getVideoTracks().some(track => track.readyState === 'live');
  });
}

async function setOrientation(page, viewport, angle) {
  await page.evaluate(value => window.__setOpenLensOrientationAngle(value), angle);
  await page.setViewportSize(viewport);
  await page.waitForFunction(({ width, height }) => innerWidth === width && innerHeight === height,
    { width: viewport.width, height: viewport.height });
}

async function captureLayout(page) {
  return page.evaluate(({ selectors, stableSelectors }) => {
    const rectForElement = element => {
      if (!element) return null;
      const box = element.getBoundingClientRect();
      const center = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      return {
        left: box.left, top: box.top, right: box.right, bottom: box.bottom,
        width: box.width, height: box.height,
        visible: box.width > 0 && box.height > 0
          && getComputedStyle(element).visibility !== 'hidden'
          && getComputedStyle(element).display !== 'none',
        reachable: center === element || element.contains(center) || center?.contains(element) === true,
        disabled: element.matches(':disabled'),
        transform: getComputedStyle(element).transform,
        writingMode: getComputedStyle(element).writingMode,
      };
    };
    const rect = selector => rectForElement(document.querySelector(selector));
    const elements = Object.fromEntries(selectors.map(selector => [selector, rect(selector)]));
    const centers = selector => [...document.querySelectorAll(selector)].map(element => {
      const box = element.getBoundingClientRect();
      return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
    });
    return {
      viewport: { width: innerWidth, height: innerHeight },
      view: rect('.viewwrap'),
      modeBar: rect('.modebar'),
      cameraBar: rect('.cambar'),
      queueIndicator: rect('.queueIndicator.on-camera'),
      elements,
      modeChoices: [...document.querySelectorAll('.modechoice')].map(rectForElement),
      stableElements: Object.fromEntries(stableSelectors.map(selector => [selector, rect(selector)])),
      stableCenters: Object.fromEntries(stableSelectors.map(selector => [selector, centers(selector)[0] ?? null])),
      shutterCount: document.querySelectorAll('.shutter').length,
      cameraCount: document.querySelectorAll('.cam').length,
      streamCalls: window.__openLensGetUserMediaCalls,
    };
  }, { selectors: CAPTURE_ELEMENT_SELECTORS, stableSelectors: DEVICE_STABLE_SELECTORS });
}

function isVisibleReachableInsideViewport(layout, box) {
  return !!box && box.visible && box.reachable
    && box.left >= -0.5 && box.top >= -0.5
    && box.right <= layout.viewport.width + 0.5
    && box.bottom <= layout.viewport.height + 0.5;
}

function allElementsInsideViewport(layout, selectors) {
  return selectors.every(selector => isVisibleReachableInsideViewport(layout, layout.elements[selector]));
}

function portraitCenterInLandscape(center, portraitViewport, landscapeViewport, angle) {
  const u = center.x / portraitViewport.width;
  const v = center.y / portraitViewport.height;
  return angle === 90
    ? { x: (1 - v) * landscapeViewport.width, y: u * landscapeViewport.height }
    : { x: v * landscapeViewport.width, y: (1 - u) * landscapeViewport.height };
}

function deviceCoordinateErrors(portrait, landscape, angle, selectors) {
  return Object.fromEntries(selectors.map(selector => {
    const expected = portraitCenterInLandscape(
      portrait.stableCenters[selector], portrait.viewport, landscape.viewport, angle,
    );
    const actual = landscape.stableCenters[selector];
    return [selector, {
      dx: Number(Math.abs(actual.x - expected.x).toFixed(1)),
      dy: Number(Math.abs(actual.y - expected.y).toFixed(1)),
    }];
  }));
}

function errorsWithin(errors, tolerancePx) {
  return Object.values(errors).every(({ dx, dy }) => dx <= tolerancePx && dy <= tolerancePx);
}

function controlsRemainReadable(layout, selectors) {
  return selectors.every(selector => layout.stableElements[selector]?.transform === 'none'
    && layout.stableElements[selector]?.writingMode === 'horizontal-tb');
}

function overlaps(first, second) {
  return first.left < second.right && first.right > second.left
    && first.top < second.bottom && first.bottom > second.top;
}

async function openCapture(viewport, angle = 0) {
  const session = await openApp({
    viewport,
    initScript: installStandaloneCameraControls,
    isMobile: true,
    hasTouch: true,
  });
  await login(session.page);
  await session.page.evaluate(value => window.__setOpenLensOrientationAngle(value), angle);
  await openScanner(session.page);
  await waitForCamera(session.page);
  return session;
}

async function tapCenter(page, target) {
  const locator = page.locator(target).first();
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  if (!box) throw new Error(`touch target has no box: ${target}`);
  await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
}

function viewMatches(first, second) {
  return ['left', 'top', 'width', 'height'].every(key => Math.abs(first[key] - second[key]) <= 0.5);
}

const since = Date.now();
const createdDocIds = [];
const rotated = await openCapture(PORTRAIT);
try {
  const { page } = rotated;
  const portrait = await captureLayout(page);

  t.check('竖屏 Capture 取景区域占可用视口高度至少 60%',
    portrait.view.height / portrait.viewport.height >= 0.6,
    `${portrait.view.height.toFixed(1)}/${portrait.viewport.height}`);
  t.check('竖屏手动快门位于可见可触达边界内',
    isVisibleReachableInsideViewport(portrait, portrait.elements['.shutter']), '', 'US-A2');
  t.check('竖屏相册入口位于可见可触达边界内',
    isVisibleReachableInsideViewport(portrait, portrait.elements['.cambar label.ghost']), '', 'US-A4');

  await setOrientation(page, LANDSCAPE, 90);
  const landscapePlus90 = await captureLayout(page);
  const plus90ActionErrors = deviceCoordinateErrors(
    portrait, landscapePlus90, 90, CAPTURE_ACTION_SELECTORS,
  );
  const plus90ModeErrors = deviceCoordinateErrors(
    portrait, landscapePlus90, 90, MODE_CHOICE_SELECTORS,
  );
  t.check('竖屏进入后旋转横屏时取景区域占可用视口高度至少 60%',
    landscapePlus90.view.height / landscapePlus90.viewport.height >= 0.6,
    `${landscapePlus90.view.height.toFixed(1)}/${landscapePlus90.viewport.height}`);
  t.check('横屏检测模式逐项可见可触达且保持可读',
    landscapePlus90.modeChoices.length === 5
      && landscapePlus90.modeChoices.every(box => isVisibleReachableInsideViewport(landscapePlus90, box)
        && !box.disabled)
      && controlsRemainReadable(landscapePlus90, MODE_CHOICE_SELECTORS));
  t.check('横屏相册入口可见可触达',
    isVisibleReachableInsideViewport(landscapePlus90, landscapePlus90.elements['.cambar label.ghost']), '', 'US-A4');
  t.check('横屏手动快门可见可触达',
    isVisibleReachableInsideViewport(landscapePlus90, landscapePlus90.elements['.shutter']), '', 'US-A2');
  t.check('横屏连拍、最近一页和完成均保留在可见边界内',
    ['.cambar button.ghost', '.lastshot', '.fab']
      .every(selector => isVisibleReachableInsideViewport(landscapePlus90, landscapePlus90.elements[selector])), '', 'US-A3');
  t.check('横屏状态避开采集控制轨',
    landscapePlus90.queueIndicator?.visible
      && !overlaps(landscapePlus90.queueIndicator, landscapePlus90.cameraBar), '', 'US-F3');
  t.check('+90° 检测模式中心遵循设备坐标映射且文字保持可读',
    errorsWithin(plus90ModeErrors, MODE_MAPPING_TOLERANCE_PX)
      && controlsRemainReadable(landscapePlus90, MODE_CHOICE_SELECTORS),
    JSON.stringify(plus90ModeErrors));
  t.check('+90° 采集动作中心遵循设备坐标映射且图标文字保持可读',
    errorsWithin(plus90ActionErrors, ACTION_MAPPING_TOLERANCE_PX)
      && controlsRemainReadable(landscapePlus90, CAPTURE_ACTION_SELECTORS),
    JSON.stringify(plus90ActionErrors),
    'US-A3');

  await setOrientation(page, LANDSCAPE, -90);
  const landscapeMinus90 = await captureLayout(page);
  const minus90ActionErrors = deviceCoordinateErrors(
    portrait, landscapeMinus90, -90, CAPTURE_ACTION_SELECTORS,
  );
  const minus90ModeErrors = deviceCoordinateErrors(
    portrait, landscapeMinus90, -90, MODE_CHOICE_SELECTORS,
  );
  t.check('两个横屏方向将控制轨映射到对应设备侧且不覆盖取景',
    landscapePlus90.cameraBar.right <= landscapePlus90.modeBar.left + 0.5
      && landscapePlus90.modeBar.right <= landscapePlus90.view.left + 0.5
      && landscapeMinus90.view.right <= landscapeMinus90.modeBar.left + 0.5
      && landscapeMinus90.modeBar.right <= landscapeMinus90.cameraBar.left + 0.5,
    JSON.stringify({
      plus90: {
        view: landscapePlus90.view, modeBar: landscapePlus90.modeBar, cameraBar: landscapePlus90.cameraBar,
      },
      minus90: {
        view: landscapeMinus90.view, modeBar: landscapeMinus90.modeBar, cameraBar: landscapeMinus90.cameraBar,
      },
    }));
  t.check('-90° 检测模式中心按反向次序遵循设备坐标映射且文字保持可读',
    errorsWithin(minus90ModeErrors, MODE_MAPPING_TOLERANCE_PX)
      && controlsRemainReadable(landscapeMinus90, MODE_CHOICE_SELECTORS),
    JSON.stringify(minus90ModeErrors));
  t.check('-90° 采集动作中心按反向次序遵循设备坐标映射且图标文字保持可读',
    errorsWithin(minus90ActionErrors, ACTION_MAPPING_TOLERANCE_PX)
      && controlsRemainReadable(landscapeMinus90, CAPTURE_ACTION_SELECTORS),
    JSON.stringify(minus90ActionErrors),
    'US-A3');

  const baselines = { 90: landscapePlus90, '-90': landscapeMinus90 };
  const repeatedLayouts = [];
  for (let round = 0; round < 3; round++) {
    await setOrientation(page, PORTRAIT, 0);
    repeatedLayouts.push({ angle: 0, layout: await captureLayout(page) });
    const angle = round % 2 === 0 ? 90 : -90;
    await setOrientation(page, LANDSCAPE, angle);
    repeatedLayouts.push({ angle, layout: await captureLayout(page) });
  }
  t.check('连续三次往返旋转无累积偏移或重复控件',
    repeatedLayouts.every(({ angle, layout }) => layout.cameraCount === 1 && layout.shutterCount === 1
      && layout.modeChoices.length === 5
      && (angle === 0 || viewMatches(layout.view, baselines[angle].view))), '', 'US-A3');
  t.check('连续三次往返旋转不重启 camera stream',
    repeatedLayouts.every(({ layout }) => layout.streamCalls === 1), '', 'US-A1');

  await setOrientation(page, LANDSCAPE, 90);
  await tapCenter(page, '.modechoice[data-mode="document"]');
  await page.waitForFunction(() => document.querySelector('.modechoice[data-mode="document"]')?.getAttribute('aria-pressed') === 'true');
  t.check('横屏触控可切换检测模式并更新选中状态',
    await page.locator('.modechoice[data-mode="document"]').getAttribute('aria-pressed') === 'true');

  await tapCenter(page, '.cambar button.ghost');
  await page.waitForFunction(() => document.querySelector('.cambar button.ghost .hint')?.textContent === '单拍');
  t.check('横屏触控可从连拍切换到单拍',
    await page.locator('.cambar button.ghost .hint').innerText() === '单拍', '', 'US-A3');
  await tapCenter(page, '.cambar button.ghost');
  await page.waitForFunction(() => document.querySelector('.cambar button.ghost .hint')?.textContent === '连拍');

  const fileChooserPromise = page.waitForEvent('filechooser');
  await tapCenter(page, '.cambar label.ghost');
  const fileChooser = await fileChooserPromise;
  await fileChooser.setFiles(PHOTOS.second);
  await page.locator('.crop').waitFor();
  t.check('横屏触控相册入口触发原生 file chooser 并进入处理流程',
    await page.locator('.crop').isVisible(), '', 'US-A4');
  await tapCenter(page, 'button:has-text("提交")');
  await page.locator('.cam').waitFor();
  await waitForCamera(page);

  await tapCenter(page, '.shutter');
  await page.locator('.crop').waitFor();
  t.check('横屏触控手动快门进入拍后检测流程', await page.locator('.crop').isVisible(), '', 'US-A2');
  await tapCenter(page, 'button:has-text("提交")');
  await page.locator('.cam').waitFor();
  await waitForCamera(page);
  await page.locator('.lastshot:not(:disabled)').waitFor();
  t.check('完成一页后最近一页与完成动作可触达',
    await page.locator('.lastshot').isEnabled() && await page.locator('.fab').isEnabled(), '', 'US-A3');
  await tapCenter(page, '.lastshot');
  await page.getByRole('dialog', { name: '最近一页预览' }).waitFor();
  t.check('最近一页入口打开可读 Page 预览',
    await page.getByRole('img', { name: '最近一页 Scan 预览' }).isVisible(), '', 'US-A3');
  const previewDialog = page.getByRole('dialog', { name: '最近一页预览' });
  const previewClose = page.getByRole('button', { name: '关闭最近一页预览' });
  t.check('最近一页 modal 打开后焦点进入弹窗',
    await previewClose.evaluate(element => document.activeElement === element), '', 'US-A3');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Enter');
  t.check('最近一页 modal 的键盘焦点不会落到背景完成按钮',
    await previewDialog.isVisible()
      && await page.locator('.cam').isVisible()
      && !await page.locator('.fab').evaluate(element => document.activeElement === element), '', 'US-A3');
  await page.keyboard.press('Escape');
  await previewDialog.waitFor({ state: 'hidden' });
  t.check('关闭最近一页 modal 后焦点恢复到触发按钮',
    await page.locator('.lastshot').evaluate(element => document.activeElement === element), '', 'US-A3');

  await tapCenter(page, '.fab');
  await page.locator('.pedit').waitFor();
  t.check('横屏完成动作结束会话并进入最近 Page', await page.locator('.pedit').isVisible(), '', 'US-A3');
  const archived = await waitForCreatedDoc(since, doc => doc.pageCount === 2);
  createdDocIds.push(archived.id);
  t.check('横屏触控完成后两页文档已归档再结束测试', archived.pageCount === 2, archived.id, 'US-A3');
} finally {
  await rotated.browser.close();
  await Promise.all(createdDocIds.map(deleteDoc));
}

const directLandscape = await openCapture(LANDSCAPE, -90);
try {
  const layout = await captureLayout(directLandscape.page);
  t.check('主屏 PWA 直接横屏进入 Capture 时布局和 camera stream 一次就绪',
    layout.view.height / layout.viewport.height >= 0.6
      && layout.streamCalls === 1
      && layout.view.right <= layout.modeBar.left + 0.5
      && layout.modeBar.right <= layout.cameraBar.left + 0.5
      && allElementsInsideViewport(layout, CAPTURE_ELEMENT_SELECTORS)
      && layout.queueIndicator?.visible
      && !overlaps(layout.queueIndicator, layout.cameraBar),
    JSON.stringify({ view: layout.view, viewport: layout.viewport, streamCalls: layout.streamCalls }),
    'US-H1');
} finally {
  await directLandscape.browser.close();
}

t.finish();
