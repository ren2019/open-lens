import { API, AUTH, checks, login, openApp } from '../lib/harness.mjs';

const t = checks('US-G3');
const session = await openApp();
try {
  const missing = await fetch(`${API}/api/docs`);
  const wrong = await fetch(`${API}/api/docs`, { headers: { Authorization: 'Bearer wrong-token' } });
  const valid = await fetch(`${API}/api/docs`, { headers: AUTH });
  t.check('无 token 的 API 请求返回 401', missing.status === 401, `status=${missing.status}`);
  t.check('错误 token 的 API 请求返回 401', wrong.status === 401, `status=${wrong.status}`);
  t.check('正确 token 通过 gate 并进入主页', valid.ok);
  await login(session.page);
  t.check('token 登录后的主页提供扫描入口', await session.page.locator('button:has-text("开始扫描")').isVisible());
} finally {
  await session.browser.close();
}
t.finish();
