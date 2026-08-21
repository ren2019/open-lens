import { checks, login, openApp, openScanner } from '../lib/harness.mjs';

const PORTRAIT = { width: 390, height: 844 };
const LANDSCAPE = { width: 844, height: 390 };
const CAPTURE_ELEMENT_SELECTORS = [
  '.camtop .iconbtn', '.liveState', '.modebar', '.cambar label.ghost', '.cambar button.ghost',
  '.shutter', '.lastshot', '.fab',
];
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
  return page.evaluate(selectors => {
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
      cameraBarCenters: centers('.cambar > *'),
      modeCenters: centers('.modechoice'),
      shutterCount: document.querySelectorAll('.shutter').length,
      cameraCount: document.querySelectorAll('.cam').length,
      streamCalls: window.__openLensGetUserMediaCalls,
    };
  }, CAPTURE_ELEMENT_SELECTORS);
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

function normalizedPositions(points, axis, viewport) {
  const size = axis === 'x' ? viewport.width : viewport.height;
  return points.map(point => point[axis] / size);
}

function positionsMatch(first, second, tolerance) {
  return first.length === second.length
    && first.every((value, index) => Math.abs(value - second[index]) <= tolerance);
}

function strictlyIncreasing(values) {
  return values.every((value, index) => index === 0 || value > values[index - 1]);
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

function viewMatches(first, second) {
  return ['left', 'top', 'width', 'height'].every(key => Math.abs(first[key] - second[key]) <= 0.5);
}

const rotated = await openCapture(PORTRAIT);
try {
  const { page } = rotated;
  const portrait = await captureLayout(page);
  const portraitCameraPositions = normalizedPositions(portrait.cameraBarCenters, 'x', portrait.viewport);
  const portraitModePositions = normalizedPositions(portrait.modeCenters, 'x', portrait.viewport);

  t.check('竖屏 Capture 取景区域占可用视口高度至少 60%',
    portrait.view.height / portrait.viewport.height >= 0.6,
    `${portrait.view.height.toFixed(1)}/${portrait.viewport.height}`);
  t.check('竖屏手动快门位于可见可触达边界内',
    isVisibleReachableInsideViewport(portrait, portrait.elements['.shutter']), '', 'US-A2');
  t.check('竖屏相册入口位于可见可触达边界内',
    isVisibleReachableInsideViewport(portrait, portrait.elements['.cambar label.ghost']), '', 'US-A4');

  await setOrientation(page, LANDSCAPE, 90);
  const landscapeRight = await captureLayout(page);
  const rightCameraPositions = normalizedPositions(landscapeRight.cameraBarCenters, 'y', landscapeRight.viewport);
  const rightModePositions = normalizedPositions(landscapeRight.modeCenters, 'y', landscapeRight.viewport);
  t.check('竖屏进入后旋转横屏时取景区域占可用视口高度至少 60%',
    landscapeRight.view.height / landscapeRight.viewport.height >= 0.6,
    `${landscapeRight.view.height.toFixed(1)}/${landscapeRight.viewport.height}`);
  t.check('横屏检测模式逐项可见可触达且保持可读',
    landscapeRight.modeChoices.length === 5
      && landscapeRight.modeChoices.every(box => isVisibleReachableInsideViewport(landscapeRight, box)
        && !box.disabled && box.transform === 'none'));
  t.check('横屏相册入口可见可触达',
    isVisibleReachableInsideViewport(landscapeRight, landscapeRight.elements['.cambar label.ghost']), '', 'US-A4');
  t.check('横屏手动快门可见可触达',
    isVisibleReachableInsideViewport(landscapeRight, landscapeRight.elements['.shutter']), '', 'US-A2');
  t.check('横屏连拍、最近一页和完成均保留在可见边界内',
    ['.cambar button.ghost', '.lastshot', '.fab']
      .every(selector => isVisibleReachableInsideViewport(landscapeRight, landscapeRight.elements[selector])), '', 'US-A3');
  t.check('横屏状态避开采集控制轨',
    landscapeRight.queueIndicator?.visible
      && !overlaps(landscapeRight.queueIndicator, landscapeRight.cameraBar), '', 'US-F3');
  t.check('检测模式从竖屏横向次序稳定映射为横屏纵向次序',
    strictlyIncreasing(portraitModePositions) && strictlyIncreasing(rightModePositions)
      && positionsMatch(portraitModePositions, rightModePositions, 0.12),
    JSON.stringify({ portraitModePositions, rightModePositions }));
  t.check('采集动作从竖屏横向次序稳定映射为横屏纵向次序',
    strictlyIncreasing(portraitCameraPositions) && strictlyIncreasing(rightCameraPositions)
      && positionsMatch(portraitCameraPositions, rightCameraPositions, 0.12),
    JSON.stringify({ portraitCameraPositions, rightCameraPositions }),
    'US-A3');

  await setOrientation(page, LANDSCAPE, -90);
  const landscapeLeft = await captureLayout(page);
  t.check('相反横屏方向将两条控制轨保持在对应设备侧且不覆盖取景',
    landscapeLeft.cameraBar.right <= landscapeLeft.modeBar.left + 0.5
      && landscapeLeft.modeBar.right <= landscapeLeft.view.left + 0.5
      && landscapeRight.view.right <= landscapeRight.modeBar.left + 0.5
      && landscapeRight.modeBar.right <= landscapeRight.cameraBar.left + 0.5,
    JSON.stringify({
      left: { view: landscapeLeft.view, modeBar: landscapeLeft.modeBar, cameraBar: landscapeLeft.cameraBar },
      right: { view: landscapeRight.view, modeBar: landscapeRight.modeBar, cameraBar: landscapeRight.cameraBar },
    }));

  const baselines = { right: landscapeRight, left: landscapeLeft };
  const repeatedLayouts = [];
  for (let round = 0; round < 3; round++) {
    await setOrientation(page, PORTRAIT, 0);
    repeatedLayouts.push({ side: 'portrait', layout: await captureLayout(page) });
    const side = round % 2 === 0 ? 'right' : 'left';
    await setOrientation(page, LANDSCAPE, side === 'right' ? 90 : -90);
    repeatedLayouts.push({ side, layout: await captureLayout(page) });
  }
  t.check('连续三次往返旋转无累积偏移或重复控件',
    repeatedLayouts.every(({ side, layout }) => layout.cameraCount === 1 && layout.shutterCount === 1
      && layout.modeChoices.length === 5
      && (side === 'portrait' || viewMatches(layout.view, baselines[side].view))), '', 'US-A3');
  t.check('连续三次往返旋转不重启 camera stream',
    repeatedLayouts.every(({ layout }) => layout.streamCalls === 1), '', 'US-A1');

  await setOrientation(page, LANDSCAPE, 90);
  await page.locator('.shutter').click();
  await page.locator('.crop').waitFor();
  await page.locator('button:has-text("提交")').click();
  await page.locator('.cam').waitFor();
  await waitForCamera(page);
  await page.locator('.lastshot:not(:disabled)').waitFor();
  t.check('完成一页后最近一页与完成动作可触达',
    await page.locator('.lastshot').isEnabled() && await page.locator('.fab').isEnabled(), '', 'US-A3');
  await page.locator('.lastshot').click();
  await page.getByRole('dialog', { name: '最近一页预览' }).waitFor();
  t.check('最近一页入口打开可读 Page 预览',
    await page.getByRole('img', { name: '最近一页 Scan 预览' }).isVisible(), '', 'US-A3');
  await page.getByRole('button', { name: '关闭最近一页预览' }).click();
  await page.locator('.fab').click();
  await page.locator('.pedit').waitFor();
  t.check('横屏完成动作结束会话并进入最近 Page', await page.locator('.pedit').isVisible(), '', 'US-A3');
} finally {
  await rotated.browser.close();
}

const directLandscape = await openCapture(LANDSCAPE, -90);
try {
  const layout = await captureLayout(directLandscape.page);
  t.check('主屏 PWA 直接横屏进入 Capture 时布局和 camera stream 一次就绪',
    layout.view.height / layout.viewport.height >= 0.6
      && layout.streamCalls === 1
      && layout.cameraBar.right <= layout.modeBar.left + 0.5
      && layout.modeBar.right <= layout.view.left + 0.5
      && allElementsInsideViewport(layout, CAPTURE_ELEMENT_SELECTORS)
      && layout.queueIndicator?.visible
      && !overlaps(layout.queueIndicator, layout.cameraBar),
    JSON.stringify({ view: layout.view, viewport: layout.viewport, streamCalls: layout.streamCalls }),
    'US-H1');
} finally {
  await directLandscape.browser.close();
}

t.finish();
