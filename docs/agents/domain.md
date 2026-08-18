# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Before exploring, read these

- **`CONTEXT.md`** at the repo root — 术语表(Scan/Page/Original/Capture/Edge Detection/Enhancement/Outfit)。
- **`docs/adr/`** — read ADRs that touch the area you're about to work in (0001-0006 已有)。

If any of these files don't exist, **proceed silently**. Don't flag their absence; don't suggest creating them upfront.

## File structure

Single-context repo:

```
/
├── CONTEXT.md
├── docs/adr/
│   ├── 0001-mobile-first-processing.md
│   └── ...
├── docs/spec/user-stories.md
├── docs/lessons-*.md
├── app/        # 手机端 PWA (Vue 3 + Vite)
├── server/     # Fastify + better-sqlite3
└── spike/      # 验证性原型与评测工具(检测器、eval、批量标注)
```

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in `CONTEXT.md`. Don't drift to synonyms the glossary explicitly avoids.

If the concept you need isn't in the glossary yet, that's a signal — either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0007 (event-sourced orders) — but worth reopening because…_
