# Architecture

## 组件

| 组件 | 位置 | 职责 | 是否需要 LLM |
|---|---|---|---|
| Triage | `.github/workflows/issue-agent.yml`（Actions，定时+评论事件） | 轮询新 issue、通知 owner、`/approve`→打标签、`/reject`→关闭、**`auto-approve` 标签→直接批准（周上限）** | 否（确定性） |
| Agent A | `.agent/pipeline.mjs` → `prompts/implementer.md`；本机 pi | 读 issue → 建分支 → 实现 → push → 开 PR | 是 |
| Agent B | 同上 → `prompts/reviewer.md`；**独立模型/会话** | `gh pr diff` → PR 评论 → `RESULT: APPROVE/REQUEST_CHANGES` | 是 |
| Agent C | 同上 → `runTester()` | 分离 worktree + 真实构建/测试 → 通过则合并 | 否 |
| PM Agent | `.agent/pm/run.mjs` + `pm/prompt.md`；定时 | 竞品调研 → `docs/product-review.md` + `pm-proposal` issue | 是 |
| **依赖闸门** | `pipeline.mjs` 的 `parseDependencies()` | 正文 `Depends on: #N` → 前置未关闭则不开工（每 5 分钟复查，解除后自动开工） | 否 |
| **筛选 Agent** | `.agent/pm/screen.mjs` + `pm/screener.md`；定时 | 独立评估提案价值与 scope（结合 A/B/C 能力边界）→ 通过则自动批准，否则关闭并写入 `docs/proposal-audit.md`（REJECT/SPLIT） | 是 |
| **审计记忆** | `docs/proposal-audit.md`（筛选器 append-only 拥有） | REJECT=禁止重提；SPLIT=按拆分方案小范围重提；每轮强制注入 PM 上下文包 | 否 |
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
  agent-seen ──/approve──▶ agent-approved
             └─auto-approve─▶ agent-approved (自动, 周上限) ──/reject──▶ agent-rejected (终态)
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
`merged` / `failed` / `needs_human` / `rejected` —— 其中 `needs_human` / `failed` 的
**人工恢复入口**见下节。

### 终态的恢复转移（issue #19）

`needs_human` / `failed` 是**失败终态**：watch 循环按 `lib.selectPendingIssues()` 跳过它们
（重试必须是**显式人工动作**，不是自动循环）。人类修好根因后用一个确定性命令把条目
复位到可续跑状态：

```
needs_human ─┐                        ┌─ 有 pr  → pr_open（从审查/测试继续）
             ├─ npm run agent:retry ─┤
failed      ─┘   --issue <N>          └─ 无 pr  → new（从头实现）

merged   ─ retry → 拒绝（不可逆）        exit 2，state.json 不动
rejected ─ retry → 拒绝（否决优先）      exit 2，state.json 不动
blocked  ─ retry → 拒绝（等依赖，不是失败；依赖关闭后自动接手）
pr_open  ─ retry → 拒绝（无需重试）
```

判定是纯函数 `lib.retryReset(prev)`（pipeline 与 validate 共用，避免两份逻辑漂移）：
保留 `pr`/`branch`/`round`/`fixes`，`retries+1`、`retriedAt`、`previousStatus` 留痕，
旧 `error` 移入 `lastError` 后清空。每次重试都会写 `.agent/logs/issue-<N>.md` 并在 issue 上
留一条评论 —— **可审计、可度量**（为将来的 `stats` 打基础）。

`retry` **绝不绕过 `/reject`**：与 `--force` 不同，它在写状态**之前**先读 issue 标签，
带 `agent-rejected` 直接 exit 2；读不到标签也 fail-closed（同合并读回的原则，lesson #24）。
`npm run agent:retry -- --list` 列出全部卡住的条目，让「哪些卡住了」可发现。

修复轮（review `REQUEST_CHANGES` 或 C 测试失败）由 `lib.prepareImplementerBranch()` 准备分支：
`origin/<branch>` 已存在则 `checkout <branch>` + `reset --hard origin/<branch>`（**基于 PR 现有分支**
继续提交），否则才从 `origin/<base>` 新开分支 —— harness 绝不在 base 上提交修复。
`state.json` 的 `round`（审查轮）与 `fixes`（测试修复轮）经 `lib.mergeIssueState()` **合并**写入，
不会被实现轮覆盖（lesson #19）。

合并是**不可逆**动作，以 PR 的**真实状态**为准：`finishMerge()` 在
`gh pr merge --delete-branch` 之后读回 `gh pr view --json state,mergedAt,headRefName`，
再用 `lib.classifyMergeAttempt()` 分流 —— 命令报错但 `state=MERGED` 仍记 `merged`
（detached HEAD 下 `--delete-branch` 会「先合并、后报错」），合并前会 best-effort 切回 `BASE`；
读不到状态则 fail-closed（`needs_human`）；合并成功后尽力清理残留的远程分支（lesson #24）。

## 模型路由与冷却（issue #25）

- 每个角色一个模型：A=`IMPL_*`（默认 pi 默认）、B=`REVIEW_*`（独立厂商）+ `REVIEW_FALLBACK_*`、
  筛选=`SCREEN_*`；`describeModel()` 是唯一的人类可读命名口。
- **模型不可用是「有截止时间的事实」**：额度/限流错误里的重置时间被 `lib.parseModelResetAt()`
  解析成 `{ until, kind }`（UTC 解释 + 钳制 `[now+5min, now+7d]`；解析不出 → `now + MODEL_COOLDOWN_MIN`，
  默认 30 分钟），落到 `.agent/model-health.json`（原子写、gitignored、`MODEL_HEALTH_FILE` 可覆盖）。
- `runReviewRound()` **先查健康**（`lib.shouldUsePrimary()`）再调模型：冷却中**一次也不调**主模型，
  直接走回退并记一行 `B: 主模型冷却中（至 <until>，kind=<kind>）…`；主模型成功即删除该条目。
  **安全边界**：没有配置 `reviewFallback*` 时 `shouldUsePrimary()` 恒 `true` —— 跳过主模型
  等于没有模型可用。
- **一次中断只上报一次**：PR 警告按 `state.json` 的 `modelWarned: { "<model>": "<YYYY-MM-DD>" }`
  每条 PR 每天一次；`reportGap()` 发送前先查上游 24h 内是否已有同标题 `[skill-feedback]`
  （旧行为只有「每日 ≤3 条」总量上限，于是 #23/#24 是两条同标题噪声）。
- **如实记账**：`runReviewRound()` 返回 `{ verdict, out, source, model, fallback }`，日志的 `model=`
  取实际使用值；approve 时写 `state[issue].reviewedBy`（+`reviewedViaFallback`），
  合并评论写明 `审查模型：<model>`，回退时标注「（回退）」—— 这是「独立模型审查」这个卖点
  的唯一可追溯证据。
- 保证是结构性的：`scripts/validate.mjs` 17a 用 #23 的**真实报错原文**断言解析结果与
  `shouldUsePrimary` 真值表；17b 断言「健康检查先于主模型 `runPi(`」、成功后删条目、
  `modelWarned`/`reviewedBy`/`reportGap` 去重确实存在；17c 用假 `pi`（计数）+ 假 `gh` +
  临时 `MODEL_HEALTH_FILE` 跑**真实** pipeline：第 1 轮写条目/1 条警告/1 条反馈，
  第 2 轮主模型 **0 次调用**、无重复评论与反馈，冷却到期后条目被自动删除。

## 出站正文与日志的凭据防线（issue #21）

事故前提：GitHub push protection / secret scanning 会吊销**已推送**的令牌 —— 不能
“发错了再删”，只能**发送前**拦住（docs/lessons.md #28）。因此所有**代码可控**的
出口分两类处理，实现只住在 `lib.mjs` 一份：

| 出口 | 规则 | helper |
|---|---|---|
| issue/PR 评论、PR 正文、`pr review --body`（agent 自己撰写） | **硬拦截**（`throw`，不发） | `assertNoSecrets()` |
| 上游 `[skill-feedback]` 的 title+body（跨仓库） | 脱敏后发送 + 附“已脱敏 N 处” | `redactSecrets()` |
| 筛选判定评论 / `issue edit --body`（审计通道） | 脱敏后发送（判定不能丢） | `redactSecrets()` |
| `docs/proposal-audit.md`（`git commit` + `push` 到 BASE，**进提交历史**） | 脱敏后写入（最硬的出口） | `redactSecrets()` 在 `one()` |
| 本地日志 `.agent/logs/issue-<N>.md`、`pm/logs/screen-*.md` | 落盘前脱敏（`log()` 单点收口） | `redactSecrets()` |
| `retry --list` / `review --pr` 尾输出 / `--check` / `status` JSON（终端） | 终端也是出口（tmux / CI 日志 / 截图） | `formatRetryList()` 内部 + `console.log(redactSecrets(...))` |
| 所有诊断输出（`console.warn/error` 的 `e.message` / stack） | **模块级单一收口**：`sh()` 把 stderr 原文拼进 `e.message`，不得裸打终端 | pipeline 的 `cwarn()` / `cerr()`（validate 7e-2 禁裸 `console.warn/error`） |

为什么不是一个函数：全拦会把审计记录（筛选判定、上游反馈）一并丢掉 → 审计断链；
全脱敏又会让 agent 自己写的正文带着凭据继续流动。按“这条通道能不能丢”二分。

保证是**结构性**的：`scripts/validate.mjs` 7e 要求每个 `'--body'` 调用点同一行出现
`assertNoSecrets(` 或 `redactSecrets(`，且提示词文件不得再出现 `--body "` 示范；
7d/7f 用离线 import + 假 `gh` 跑真实 pipeline 验证“脱敏后不含完整令牌 / 二次脱敏不变 /
`assertNoSecrets(redactSecrets(x))` 放行”。
已知边界：模型自己在 bash 里跑的 `gh` 调用不在代码控制内（只靠提示词约束）。

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
