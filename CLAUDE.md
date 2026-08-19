# Open-Lens

自托管的文档扫描系统,替代已退役的 Microsoft Lens。手机浏览器(iOS Safari PWA)采集并处理图像,云服务器归档并向 AI agent 开放数据访问。

- Spec:`docs/spec/user-stories.md`(范围已对齐)+ GitHub Issues(spec 类)
- 决策:`docs/adr/0001-0006`;经验:`docs/lessons-*.md`
- **UI 基准**:`prototype/app-ui-prototype.html` 变体 A(暗场相机优先)——app 的视觉与交互开发以它为准;新增页面/组件先看原型的令牌与结构,不要另起风格
- 术语表:根 `CONTEXT.md`(Scan/Page/Original/Capture/Edge Detection/Enhancement/Outfit)

## 发布规则

**完善的自动化端到端测试是每次版本发布的必须项。**

- 用例按 US 编号组织(`docs/spec/user-stories.md` 为准),断言名带 US 前缀(如 `US-B1: ...`),保证 drift-audit 可对账;
- 发布(打 tag / 部署 / milestone 关闭)前:e2e 全绿 + 检测器回归集不回退(`node spike/eval-run.js photos-batch/label`,screen mIoU 基线 0.960);
- 新 US 落地的同一批提交必须带对应 e2e 用例;未覆盖的 US 显式记欠账,不许静默缺失;
- 断言必须验证真实结果,恒真断言(`pass(x, true)`)视为无效覆盖。

## Agent skills

### Issue tracker

GitHub Issues(`ren2019/open-lens`),`gh` CLI 操作,标题惯例 `[分类] 标题`。See `docs/agents/issue-tracker.md`.

### Triage labels

默认五件套,不改名:`needs-triage` / `needs-info` / `ready-for-agent` / `ready-for-human` / `wontfix`。See `docs/agents/triage-labels.md`.

### Domain docs

Single-context:根 `CONTEXT.md` + `docs/adr/`。See `docs/agents/domain.md`.
