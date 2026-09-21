# Architecture

## 组件

| 组件 | 位置 | 职责 | 是否需要 LLM |
|---|---|---|---|
| Triage | `.github/workflows/issue-agent.yml`（Actions，定时+评论事件） | 轮询新 issue、通知 owner、`/approve`→打标签、`/reject`→关闭 | 否（确定性） |
| Agent A | `.agent/pipeline.mjs` → `prompts/implementer.md`；本机 pi | 读 issue → 建分支 → 实现 → push → 开 PR | 是 |
| Agent B | 同上 → `prompts/reviewer.md`；**独立模型/会话** | `gh pr diff` → PR 评论 → `RESULT: APPROVE/REQUEST_CHANGES` | 是 |
| Agent C | 同上 → `runTester()` | 分离 worktree + 真实构建/测试 → 通过则合并 | 否 |
| PM Agent | `.agent/pm/run.mjs` + `pm/prompt.md`；定时 | 竞品调研 → `docs/product-review.md` + `pm-proposal` issue | 是 |
| Supervisor | `.agent/supervisor.sh`, `.agent/pm/supervisor.sh` | tmux 常驻、崩溃自愈、注入 env | 否 |

## 为什么这样分工

- **确定性部分不要用 LLM**：轮询、打标签、跑测试、合并这些必须可预测、可重试。
  用 Actions + 脚本做，成本为零且不会"发挥"。
- **LLM 只做必须理解语义的部分**：实现、审查、产品研判。
- **审查用不同厂商模型**：同一模型审查自己的产出容易自我确认；
  换模型能显著提高发现真实问题的概率（实践中 GLM 审查确实抓到了 i18n 完整性、
  XSS 转义、数据结构一致性等跨切面问题）。
- **人类只在两处介入**：提需求、`/approve`。这是成本/风险的最佳平衡点。

## 状态机

```
(issue opened)
      │  Actions triage
      ▼
  agent-seen ──/approve──▶ agent-approved ──/reject──▶ agent-rejected (终态)
                                   │  watcher 30s 内接手
                                   ▼
   implementing ─▶ pr_open ─▶ reviewing ⇄(REQUEST_CHANGES ≤N 轮) ─▶ approved
                                                 │                    │
                                                 └─ 超轮数 → needs_human│
                                                                      ▼
                                                        C 测试通过 → merged
                                                        C 失败 ≤M 次 → A 修 → 重测
                                                        C 超次    → failed
```

持久化在 `.agent/state.json`（本地，gitignored）。终态：
`merged` / `failed` / `needs_human` / `rejected`。

## 共享记忆

| 介质 | 内容 | 谁能读 |
|---|---|---|
| **PR 评论** | A/B 的完整讨论（改了什么、为什么、结论） | 人、A、B |
| `.agent/logs/issue-<N>.md` | 每轮动作、模型、判定、输出摘要 | 人（排障） |
| `docs/product-review.md` | PM 的长期产品认知（能力/优势/劣势/竞品） | 人、PM（跨天累积） |
| `.agent/state.json` | 状态机 | 流水线 |

把讨论放在 PR 评论里是刻意的：**免费获得持久化、可审计、可人工接管的对话记录**。

## 隔离与并发

- **Agent C 用独立 worktree**：不污染主工作区，也不与 agent 分支冲突。
- **PM 用独立 worktree**：从 `origin/<base>` 拉取，不干扰实现流水线。
- **但 Agent A 在主工作区工作**：因此必须遵守"watcher 运行时不要手动改文件"。
  若要多任务并行，应改为每个 issue 一个 worktree（模板未默认开启，属于已知扩展点）。

## 成本模型

| 环节 | 成本 |
|---|---|
| Triage / Agent C / 合并 | 0（Actions + 本地脚本） |
| Agent A 实现 | 1 次强模型会话（可能多轮修复） |
| Agent B 审查 | 每轮 1 次会话（独立模型；轮数上限可配） |
| PM | 每日 1 次廉价模型会话，且**只在折扣时段**执行 |

降本手段：`MAX_REVIEW_ROUNDS`、`TEST_SKIP`、PM 的 `PM_DAILY_CAP`/`PM_WEEKLY_CAP`、
审查模型选更便宜的档位。
