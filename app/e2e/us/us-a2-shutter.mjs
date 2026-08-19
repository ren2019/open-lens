import { canvasHash, checks, login, openApp, openScanner } from '../lib/harness.mjs';

const t = checks('US-A2');
const session = await openApp();
try {
  const { page } = session;
  await login(page);
  await openScanner(page);
  const camera = await page.waitForFunction(() => {
    const video = document.querySelector('video');
    const stream = video?.srcObject;
    if (!(stream instanceof MediaStream) || video.paused || !video.videoWidth) return null;
    return { width: video.videoWidth, height: video.videoHeight, live: stream.getVideoTracks().some(track => track.readyState === 'live') };
  }).then(handle => handle.jsonValue());
  t.check('fake camera 视频轨已就绪', camera.live && camera.width > 0 && camera.height > 0,
    `${camera.width}x${camera.height}`);

  await page.locator('.shutter').click();
  await page.locator('.crop').waitFor();
  const canvas = page.locator('.crop canvas').first();
  await page.waitForFunction(() => document.querySelector('.crop canvas')?.width > 0);
  const frozen = await canvas.evaluate(canvas => ({ width: canvas.width, height: canvas.height }));
  t.check('按快门后冻结帧进入拍后裁剪', frozen.width > 0 && frozen.height > 0
    && await canvasHash(canvas) !== 0, `${frozen.width}x${frozen.height}`);
} finally {
  await session.browser.close();
}
t.finish();
