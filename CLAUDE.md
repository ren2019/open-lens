# Open-Lens

自托管的文档扫描系统,替代已退役的 Microsoft Lens。手机浏览器(iOS Safari PWA)采集并处理图像,云服务器归档并向 AI agent 开放数据访问。

- Spec:`docs/spec/user-stories.md`(范围已对齐)+ GitHub Issues(spec 类)
- 决策:`docs/adr/0001-0006`;经验:`docs/lessons-*.md`
- 术语表:根 `CONTEXT.md`(Scan/Page/Original/Capture/Edge Detection/Enhancement/Outfit)

## Agent skills

### Issue tracker

GitHub Issues(`ren2019/open-lens`),`gh` CLI 操作,标题惯例 `[分类] 标题`。See `docs/agents/issue-tracker.md`.

### Triage labels

默认五件套,不改名:`needs-triage` / `needs-info` / `ready-for-agent` / `ready-for-human` / `wontfix`。See `docs/agents/triage-labels.md`.

### Domain docs

Single-context:根 `CONTEXT.md` + `docs/adr/`。See `docs/agents/domain.md`.
