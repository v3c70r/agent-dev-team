# Product Review — agent-dev-team

> PM Agent 的长期记忆文件（由 `.agent/pm/run.mjs` 每日/每周维护）。
> 本仓库的产品 = **这个 skill 本身**（把任意 GitHub 仓库变成自治多 agent 开发团队）。
> 证据均来自本仓库代码/文档/日志，外部结论均带 URL。

## 1. 产品是什么

可复用的**多 agent 开发团队技能**：`提 issue → /approve → 实现(A) → 独立模型审查(B)
→ 功能测试(C) → 自动合并`，外加 **PM 调研 agent**（产出提案）与 **筛选 agent**
（独立评估提案值不值得做，通过则自动批准）。人类只做两件事：提需求、`/approve`。

## 2. 当前能力清单（已对代码核实）

| 能力 | 说明 |
|---|---|
| Triage | Actions 定时(10min)+ `issue_comment` 即时；`/approve`→`agent-approved`、`/reject`；新 issue 自动 @owner |
| Agent A 实现 | 非交互 pi 会话；建 `agent/<N>` 分支 → 实现 → push → 开 PR；支持修复轮 |
| Agent B 审查 | 独立模型（默认 glm-5.3）；`gh pr diff` + PR 评论；中英双语判定解析 + 英文哨兵；模型不可用时自动回退（`reviewFallback`） |
| Agent C 测试 | 分离式 worktree + **真实** `npm run build` + `npm test`；失败自动回修（`MAX_TEST_FIXES`） |
| 自动合并 | 测试通过 → squash 合并 + 删分支；自审限制降级为"批准记录"评论；分支保护则 `needs_human` |
| PM Agent | 每日 1 次廉价模型会话，**仅在折扣时段**（默认 17:00 UTC / 窗口 16.5–24.5）；产出 `pm-proposal`；配额在代码层硬限（daily/weekly） |
| 筛选 Agent | 独立模型评估提案（VALUE/EFFORT/CONFIDENCE）→ IMPLEMENT 自动批准（周上限 `screenAutoCapWeekly`）/ SPLIT / REJECT；结论 append-only 写入 `docs/proposal-audit.md` 并强制注入 PM 上下文 |
| 自愈 | tmux supervisor 崩溃重启；单 issue 异常不拖垮循环；轮询失败指数退避 |
| 自我提升 | opt-in：模板缺陷自动上报 upstream `[skill-feedback]`（脱敏、每日≤3、无标签权限自动降级） |
| 自检 | `npm run doctor`（人类表格 + `--json`，12 项检查，含真实模型探针）；`validate.mjs` 作为自身 build/test |

## 3. 优势（有证据）

1. **真实生产验证，非 demo**：本仓库自身用同一套 loop 完成 #1/#3/#5/#7（PR #2/#4/#6/#9 已合并）；`state.json` 4 条全 `merged`。
2. **坑固化**：17 条真实事故的修复已进模板 + `validate.mjs` 断言（如 PATH 污染、双语判定、DRIFT 强制同步）。
3. **独立模型审查有效**：审查确实抓到跨切面问题——issue #7 的第 1 轮 review 抓出"误提交 PM 运行时 tmp 文件"与"退出码断言漏场景"（`.agent/logs/issue-7.md`）。
4. **人类介入最少 + 成本可控**：确定性环节零 LLM；PM 只在折扣窗口跑；配额是代码级硬限而非提示词自觉。

## 4. 劣势 / 缺口（按证据强度排序）

| # | 缺口 | 证据（文件/事实） |
|---|---|---|
| 1 | **实现层假设 npm**：Agent C 只跑 `npm run build`/`npm test` | `templates/pipeline.mjs:229-230` 硬编码；且 `scripts/doctor.mjs:188-198` 要求 `package.json` 且 scripts 含 `build`+`test`，否则 **fail**；`SKILL.md:39-43` 规定"任何 preflight 失败都不继续安装" ⇒ **非 npm 仓库（Python/Go/Rust）、或无 build/test 脚本的 Node 仓库根本无法安装**。`docs/lessons.md` #17 已确立"模板默认值不得把作者环境当成所有仓库的真相"，但当时只修了**评论文案**（`validate.mjs:99`），未修**实际执行的命令**；issue #5 日志把"未从 package.json 推导命令"列为已接受的取舍。 |
| 2 | 并发：Agent A 占主工作区 | `docs/architecture.md`「隔离与并发」；`README.md` 已知限制。同一时刻只能处理 1 个 issue，且 watcher 运行时不能手动改仓库。 |
| 3 | **修复轮的分支基线可疑**：`runImplementer()` 每轮都 `git checkout -B <branch> origin/<BASE>` | `templates/pipeline.mjs:120-126`。实测该 git 序列会把本地分支重置回 base（丢弃上一轮实现），随后的 `git push` 因非快进而**被拒**；catch 分支（正确做法：checkout 分支 + reset --hard origin/分支）在 fetch 成功时是死代码。issue #7 的修复轮实际"成功"，说明当前靠 LLM 自己在会话里 `git pull`/rebase 恢复——**未被自动测试覆盖**。旁证：`runImplementer()` 用 `{round:0,...}` 覆盖 state 条目（`pipeline.mjs:139`），导致 `state.json` 中 #7 的 `round=0`，而日志明确记录发生过 1 轮修复。 |
| 4 | 无可观测聚合 | 只有逐 issue 的 `state.json` 与 `.agent/logs/issue-<N>.md`；没有 `stats`/度量（审查发现率、平均轮数、回退次数、needs_human 率）。`docs/architecture.md` 的"共享记忆"表里没有任何度量介质。 |
| 5 | 发现性/分发 | `README.md` 安装=手动 `pi install git:...` 或复制模板；无 marketplace/registry。 |
| 6 | 无测试仓库只能 build | `SKILL.md:41`；`docs/architecture.md` 成本模型。 |

## 5. 竞争格局（本轮调研，带 URL）

- **直接/相邻**：OpenHands（原 OpenDevin，MIT，自托管 + BYOK）、SWE-agent（研究向，产出 patch）、
  Devin（托管）、GitHub Copilot coding agent、CodeRabbit（审查机器人）、aider（CLI）。
  https://airesponsibly.substack.com/p/open-source-ai-coding-agents-a-survey ·
  https://kanopylabs.com/blog/devin-vs-openhands-vs-swe-agent-autonomous-coding
- **语言无关是行业默认**：SWE-rebench V2 自我定位为 "language-agnostic…synthesizes per-repository
  install and test procedures"（https://arxiv.org/html/2602.23866v1）；OpenHands 支持 AGENTS.md
  类仓库级指引（https://arxiv.org/html/2511.03690v1）。
- **"测试命令可配置"是被验证的需求**：aider 提供 `--test-cmd` / `--auto-test` 与按语言的
  `--lint-cmd`（https://aider.chat/docs/usage/lint-test.html ·
  https://aider.chat/docs/config/options.html）。同类工具的同类抱怨真实存在：某 coding-agent
  项目的用户明确指出其 verify 检测"只认识 Go/npm/pytest/cargo"
  （https://github.com/agent-fox-dev/agentkit-go/issues/91）。
- **可观测性是标配**：Copilot usage metrics / impact dashboard
  （https://docs.github.com/en/copilot/how-tos/administer-copilot/view-usage-and-adoption）、
  CodeRabbit 的 per-PR 指标导出（https://docs.coderabbit.ai/guides/dashboard）。
- **差异化（仍然成立）**：本地常驻（无云依赖/无 vendor lock-in）+ **多厂商模型分工**
  （实现/审查/筛选不同模型，独立视角）+ **PM 调研 + 独立筛选闭环** + 人类仅两处介入 +
  自带"事故→模板规则"的教训库。

## 6. 待调研问题

- 修复轮基线（缺口 #3）是否真的会产出错误的 PR diff？若把修复轮起点固定在 `origin/agent/<N>`，
  多轮成本与成功率如何变化？（下一次可用"日志回放"验证）
- 度量（缺口 #4）的最小可用形态：从 `state.json` + logs 聚合出哪些指标最能证明"独立模型审查"的价值？
- Agent A 迁到 per-issue worktree（缺口 #2）的最小可独立验证步骤是什么？
- 非 npm 仓库被排除（缺口 #1）对可寻址用户规模的实际影响如何量化？

## 已评估但不建议（本轮）

- **全量并发改造（per-issue worktree for Agent A）**：方向正确但一个 PR 装不下，且
  `processIssue`/`runImplementer` 的分支与状态语义会大改 → 应先做缺口 #1 或 #3 这类小步。
- **只翻译文档（#8 方向）**：已被筛选器 REJECT（无证据、不是已识别杠杆），不再提。
- **加 Web 仪表盘**：收益不如"成本为零的文本聚合"，且要引入前端依赖，超出"确定性环节零成本"原则。
- **把 metrics/stats（缺口 #4）与命令可配置（缺口 #1）合成一条**：范围过大、验收标准混杂 → 本轮只提 #1。
  度量留作下一轮候选（若本轮提案通过并实现，再单独立项）。
