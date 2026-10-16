# Product Review — agent-dev-team

> PM Agent 的长期记忆文件（由 `.agent/pm/run.mjs` 每日/每周维护）。
> 本仓库的产品 = **这个 skill 本身**（把任意 GitHub 仓库变成自治多 agent 开发团队）。
> 证据来自本仓库代码/文档/日志；外部结论均带 URL。行数上限 180。

## 1. 产品是什么

可复用的**多 agent 开发团队技能**：`提 issue → /approve → 实现(A) → 独立模型审查(B)
→ 功能测试(C) → 自动合并`，外加 **PM 调研 agent**（产提案）与 **筛选 agent**
（独立评估提案值不值得做，通过则自动批准）。人类只做两件事：提需求、`/approve`
（另可选"可信 agent 免人工门禁"的自动批准标签）。

## 2. 当前能力清单（已对代码核实；✅ = 最近新增）

| 能力 | 说明 |
|---|---|
| Triage | Actions 定时(10min) + `issue_comment` 即时；`/approve`/`/reject` 标签**互斥**；新 issue 自动 @owner；内联脚本有语法/未定义 helper 守卫（validate 提取+包裹后执行）✅ |
| 依赖门禁 | issue 可写 `Depends on: #N`；未完成则置 `blocked` 不实现 ✅ |
| 可信自动批准 | 特定标签的 trusted-agent issue 可跳过人工 `/approve`（周上限）✅ |
| Agent A 实现 | 非交互 pi 会话；**首轮**从 `origin/<base>` 开分支，**修复轮**基于 `origin/agent/<N>`（`lib.prepareImplementerBranch()`） |
| Agent B 审查 | 独立模型（默认 glm-5.3）；双语判定 + 英文哨兵；模型不可用自动回退；**可选独立 reviewer 账号**（`reviewerGhUser`，默认**未启用**=单账号模式）✅ |
| Agent C 测试 | 分离式 worktree + 真实构建/测试；`AGENT_BUILD_CMD`/`AGENT_TEST_CMD` 可配置；失败自动回修 |
| 状态机 | `.agent/state.json`；`round`/`fixes` 正确记录；终态 `merged/failed/needs_human/rejected` |
| 自动合并 | `gh pr merge --squash --delete-branch` + 合并前复查 `/reject`（fail-closed）；分支保护则 `needs_human` |
| PM / 筛选 | PM 每日折扣时段产提案；筛选 agent 独立评估 → 自动批准/SPLIT/REJECT；审计 append-only 写入 `docs/proposal-audit.md` 并强制注入 PM 上下文 |
| 自愈 | tmux supervisor 崩溃重启；单 issue 异常不拖垮循环；轮询失败指数退避 |
| 自我提升 | opt-in：模板缺陷自动上报 upstream `[skill-feedback]` |
| 自检 | `npm run doctor`（表格 + `--json`，含真实模型探针、**pipeline↔lib 导出一致性检查**✅）；`validate.mjs` 14 组检查（含临时真 git 仓库集成断言） |

## 3. 优势（有证据）

1. **真实生产验证，非 demo**：本仓库用同一套 loop 完成 #1/#3/#5/#7/#10/#12/#14（PR #2/#4/#6/#9/#11/#13/#15）。PM 提案连续 4 次通过筛选 → 自动实现 → 合并。
2. **多轮审查真的挡得住阻塞问题**：#14 的 PR #15 首轮被 Agent B 判 `REQUEST_CHANGES`，指出"运行中 `/reject` 仍会被自动合并"（合并不可逆），修复轮补齐 `finishMerge` 守卫后通过 —— 这正是"独立模型审查"的价值。
3. **闭环会自我改进**：#12 修的"修复轮基线"让 #14 的多轮修复得以正常进行。
4. **坑固化**：20 条事故（含新增：workflow helper 重命名打挂全部 triage、半拷贝升级导致 watcher 崩溃循环、`gh auth switch` 是全局状态）都有代码/文档守卫。
5. **人类介入点极少**：确定性环节零 LLM；PM 只在折扣窗口跑；配额代码级硬限。

## 4. 劣势 / 缺口（按证据强度排序）

| # | 缺口 | 证据（文件/事实） |
|---|---|---|
| 1 | **合并结果以"命令退出码"为准，而非 PR 真实状态** → 误报失败 + 状态机背离 | 决定性证据：issue #14 的评论写着"❌ 自动合并失败…`gh pr merge 15 --squash --delete-branch` could not determine current branch: failed to run git: not on any branch"，但 `gh pr view 15` 显示 **`mergedAt`=2026-10-11T17:23:32Z**，而日志的 `状态: needs_human (merge blocked)` 在 **17:23:34.707Z** —— **合并已经成功，只是随后的本地收尾步骤失败**；远程 `agent/14` 分支至今残留（`git ls-remote --heads origin`）；`state.json` #14 = `needs_human` 而 issue 已 CLOSED。代码：`templates/pipeline.mjs:578-586`（catch 里直接判失败→`needs_human`）。根因链：`gh pr merge --delete-branch` **同时删本地与远程分支**（`gh pr merge --help`），删本地分支需要"当前分支"，detached HEAD 时报 `ErrNotOnAnyBranch`（cli/cli#1889），而 `processIssue` 的 finally 只在 `startBranch !== 'HEAD'` 时恢复分支（`pipeline.mjs:384-390`）⇒ 一旦工作区 detached 就永久 detached。**这不是孤例**：同类项目有完全相同的 bug（https://github.com/topij/agentic-dev-kit/issues/196 · https://github.com/aleskalfas/project-kit/issues/878 · cli/cli#2833）。 |
| 2 | 更新不会热加载：watcher 跑的是**启动时的代码** | supervisor 只在进程崩溃时重启（`templates/supervisor.sh`）。证据：issue #14 于 10-11 运行时，日志里的实现轮**没有** #13（10-10 合并）新增的"首轮/修复轮"标记，Agent A 还不得不手动修复被旧逻辑重置的分支（`.agent/logs/issue-14.md`）⇒ 已合并的改进要等人工重启才生效。 |
| 3 | 并发：Agent A 占主工作区 | `docs/architecture.md`「隔离与并发」；`README.md` 已知限制。 |
| 4 | `needs_human` 是死胡同 | 无自动重试、无外发通知、无"重试入口"命令；缺口 #1 的误判正是典型（本可自动恢复）。 |
| 5 | 无可观测聚合 | 无 `stats`（审查轮数、回退次数、needs_human 率、耗时）。`docs/lessons.md` 条目编号出现**重复**（两个 17、两个 18、两个 19），说明文档纪律也在退化。 |
| 6 | 发现性/分发 | 安装=手动 `pi install git:...`；无 marketplace/registry。 |

（已修复：非 npm 仓库无法安装 → #10/PR #11；修复轮基线 + 状态计数覆盖 → #12/PR #13；`/reject` 取消不生效 → #14/PR #15。）

## 5. 竞争格局（累计调研，带 URL）

- **直接/相邻**：OpenHands、SWE-agent、Devin、GitHub Copilot coding agent、CodeRabbit、aider。
  https://airesponsibly.substack.com/p/open-source-ai-coding-agents-a-survey ·
  https://kanopylabs.com/blog/devin-vs-openhands-vs-swe-agent-autonomous-coding
- **"退出码 ≠ 成功"是自动化领域的公认陷阱**：https://dev.to/jeremy_longshore/exit-0-is-not-success-automation-assurance-that-verifies-outcomes-2a4n ·
  Airflow PR 的教训"trust a confirmed terminal state over an unobserved exit code"（https://github.com/apache/airflow/pull/73142）·
  Reddit 运营者共识"verify by reading back the actual state, not trusting the agent's confirmation"（https://www.reddit.com/r/AI_Agents/comments/1u0bp9v/）。→ 正对缺口 #1。
- **PR 合并的幂等/复核已成模式**：merge-queue 入场"readback + head-drift fail-closed"（https://github.com/HomericIntelligence/Hephaestus/pull/3027）·
  "the pull request's merged state is a source fact the machine re-reads on every refresh"（https://github.com/SeriousJul/my-little-software-factory/issues/171）。
- **迭代修复必须落在 PR 分支上**：Copilot cloud agent 默认 push 到 PR 分支（https://docs.github.com/en/copilot/how-tos/use-copilot-agents/cloud-agent/make-changes-to-an-existing-pr）；OpenHands `skills/iterate`（https://github.com/OpenHands/extensions/tree/main/skills/iterate）。
- **标签驱动的取消要移除触发标签**：https://github.com/jeffwlawson/agent-workflows/issues/259 · https://github.com/Osasuwu/jarvis/issues/1936（→ #14 已对齐）。
- **可观测性是标配**：Copilot usage metrics（https://docs.github.com/en/copilot/how-tos/administer-copilot/view-usage-and-adoption）、CodeRabbit per-PR 指标（https://docs.coderabbit.ai/guides/dashboard）。→ 仍缺（§4 #5）。
- **差异化（仍成立）**：本地常驻（无云依赖/lock-in）+ **多厂商模型分工** + **PM 调研 + 独立筛选闭环** + 人类仅两处介入 + "事故→模板规则"的教训库。

## 6. 待调研问题

- 缺口 #2（更新不热加载）该用"master 变更检测 → 优雅重启"还是"每次轮询前重新 import"？后者对长跑进程更贴切。
- 缺口 #1 修好后，是否还需要"合并已成功但收尾失败"的**幂等重放**（读回状态 → 补做分支清理）？
- 度量（§4 #5）最小可用形态：从 `state.json` + logs 聚合哪些指标最能证明"独立模型审查"的价值？
- Agent A 迁到 per-issue worktree（§4 #3）的最小可独立验证步骤？

## 已评估但不建议（累计）

- **全量并发改造（per-issue worktree for Agent A）**：方向正确但一个 PR 装不下。
- **只翻译文档（#8 方向）**：已被筛选器 REJECT，不再提。
- **Web 仪表盘**：不如零成本文本聚合。
- **metrics/stats（§4 #5）**：连续第四轮推迟——今天 #1 有**实测事故 + 时间戳级证据**，且"合并已成功却被判失败"会影响每一次运行；度量是增益，不是正确性。
- **只修 lessons.md 重复编号**：单独立项太琐碎；并入 #1 的实现（同一文件）顺带修正。
- **把缺口 #1 拆成"只改 detached 处理"或"只加读回复核"**：两者缺一不可——只处理 detached 仍会在其它 gh 失败模式下误判；只读回复核则远程分支会永久残留（现状即如此）。
