# Product Review — agent-dev-team

> PM Agent 的长期记忆文件（由 `.agent/pm/run.mjs` 每日/每周维护）。
> 本仓库的产品 = **这个 skill 本身**（把任意 GitHub 仓库变成自治多 agent 开发团队）。
> 证据来自本仓库代码/文档/日志；外部结论均带 URL。行数上限 180。

## 1. 产品是什么

可复用的**多 agent 开发团队技能**：`提 issue → /approve → 实现(A) → 独立模型审查(B)
→ 功能测试(C) → 自动合并`，外加 **PM 调研 agent**（产提案）与 **筛选 agent**
（独立评估提案值不值得做，通过则自动批准）。人类只做两件事：提需求、`/approve`。

## 2. 当前能力清单（已对代码核实；✅ = 本轮前新交付）

| 能力 | 说明 |
|---|---|
| Triage | Actions 定时(10min) + `issue_comment` 即时；`/approve`→`agent-approved`、`/reject`；新 issue 自动 @owner |
| Agent A 实现 | 非交互 pi 会话；建 `agent/<N>` 分支 → 实现 → push → 开 PR；支持修复轮 |
| Agent B 审查 | 独立模型（默认 glm-5.3）；`gh pr diff` + PR 评论；中英双语判定解析 + 英文哨兵；模型不可用自动回退（`reviewFallback`） |
| Agent C 测试 | 分离式 worktree + 真实构建/测试；失败自动回修（`MAX_TEST_FIXES`） |
| ✅ Agent C 命令可配置 | `AGENT_BUILD_CMD`/`AGENT_TEST_CMD`（空串=跳过），`lib.resolveTesterCommands()` 被 pipeline+doctor 共用（issue #10 → PR #11） |
| 自动合并 | 测试通过 → squash 合并 + 删分支；自审限制降级为"批准记录"评论；分支保护则 `needs_human` |
| PM Agent | 每日 1 次廉价模型会话，**仅折扣时段**（17:00 UTC / 窗口 16.5–24.5）；配额在代码层硬限 |
| 筛选 Agent | 独立模型评估（VALUE/EFFORT/CONFIDENCE）→ IMPLEMENT 自动批准（周上限）/ SPLIT / REJECT；结论 append-only 写入 `docs/proposal-audit.md` 并强制注入 PM 上下文 |
| 自愈 | tmux supervisor 崩溃重启；单 issue 异常不拖垮循环；轮询失败指数退避 |
| 自我提升 | opt-in：模板缺陷自动上报 upstream `[skill-feedback]`（脱敏、每日≤3、无标签权限自动降级） |
| 自检 | `npm run doctor`（表格 + `--json`，12 项，含真实模型探针）；`validate.mjs` 12 组检查作为自身 build/test |

## 3. 优势（有证据）

1. **真实生产验证，非 demo**：本仓库用同一套 loop 完成 #1/#3/#5/#7/#10（PR #2/#4/#6/#9/#11 全部自动合并）；`state.json` 5 条全 `merged`。
2. **坑固化**：17 条真实事故的修复进了模板 + `validate.mjs` 断言（PATH 污染、双语判定、DRIFT 强制同步、硬编码 stack…）。
3. **独立模型审查确实抓到真问题**：issue #7 第 1 轮 review 抓出"误提交 PM 运行时 tmp 文件"与"退出码断言漏场景"（`.agent/logs/issue-7.md`）。
4. **人类介入最少 + 成本可控**：确定性环节零 LLM；PM 只在折扣窗口跑；配额是代码级硬限，不靠模型自觉。
5. **闭环会自我修正**：本仓库已两次由 PM 提案 → 筛选 → 实现 → 审查 → 测试 → 合并走通（#7、#10）。

## 4. 劣势 / 缺口（按证据强度排序）

| # | 缺口 | 证据（文件/事实） |
|---|---|---|
| 1 | **修复轮基于错误分支基线**：`runImplementer()` 每轮都 `git checkout -B <branch> origin/<BASE>` | `templates/pipeline.mjs:111-124`。`-B` 会把**已存在**的分支重置回 base；因 fetch 成功，正确做法的 `catch`（`checkout branch` + `reset --hard origin/<branch>`）是**死代码**。临时仓库实测：重置后 `git push` 因**非快进被拒**。本仓库 #7 的修复轮之所以成功，是 Agent A 在会话内自己与远端分支对账（`logs/issue-7.md:45-48`）——**编排层把自身分支处理外包给了实现 LLM**，多一次非确定步骤 + 额外 token；失败则落入 `needs_human`（与"人类只做两件事"相悖）。 |
| 2 | **状态机计数器失真**：`round`/`fixes` 从未被正确维护 | `pipeline.mjs:374` 写 `round=r+1` 后，`runImplementer`（376→148/150）用 `{round:0,fixes:0}` **整条覆盖**；`fixes` 全局无人递增。实测 `state.json` #7 `round:0`，而日志明确有 1 轮修复 ⇒ 状态机无法记录修复轮次（无度量、无 resume 语义）。 |
| 3 | 并发：Agent A 占主工作区 | `docs/architecture.md`「隔离与并发」；`README.md` 已知限制。同一时刻只能 1 个 issue，且 watcher 运行时不能手动改仓库。 |
| 4 | 无可观测聚合 | 只有逐 issue `state.json` + `.agent/logs/issue-<N>.md`；没有 `stats`/度量（审查发现率、平均轮数、回退次数、needs_human 率）。`docs/architecture.md` 的"共享记忆"表无任何度量介质。 |
| 5 | 发现性/分发 | 安装=手动 `pi install git:...` 或复制模板；无 marketplace/registry。 |
| 6 | MERGED PR 后的收尾未验证 | 合并失败/分支保护路径只有单测外的日志；`finishMerge` 无自动断言。 |

（已修复：非 npm 仓库无法安装 —— 原缺口 #1，见 §2 ✅ 与 issue #10。）

## 5. 竞争格局（累计调研，带 URL）

- **直接/相邻**：OpenHands（原 OpenDevin，MIT，自托管 + BYOK）、SWE-agent（研究向，出 patch）、Devin（托管）、GitHub Copilot coding agent、CodeRabbit、aider（CLI）。
  https://airesponsibly.substack.com/p/open-source-ai-coding-agents-a-survey ·
  https://kanopylabs.com/blog/devin-vs-openhands-vs-swe-agent-autonomous-coding
- **迭代修复必须落在 PR 分支上（行业一致做法）**：GitHub Copilot cloud agent 默认"pushes commits directly to the pull request's branch"
  （https://docs.github.com/en/copilot/how-tos/use-copilot-agents/cloud-agent/make-changes-to-an-existing-pr）；
  OpenHands 有专门的 `skills/iterate`：把一个 PR "drive through CI, code review and QA until merge-ready"
  （https://github.com/OpenHands/extensions/tree/main/skills/iterate）。
  同类 harness 把"agent 在 base 上提交 + 非快进被静默搁置"列为**必修 bug**
  （https://github.com/jwulf/c8ctl-plugin-nano/issues/231 ·
  https://github.com/integry/propr/issues/2736）。
- **语言无关 + 命令可配置是默认**：aider `--test-cmd`/`--auto-test`（https://aider.chat/docs/usage/lint-test.html）；
  SWE-rebench V2 自称 language-agnostic（https://arxiv.org/html/2602.23866v1）；某 agent 工具用户点名"verify 只认 Go/npm/pytest/cargo"是缺陷（https://github.com/agent-fox-dev/agentkit-go/issues/91）。→ 本仓库已用 #10 对齐。
- **可观测性是标配**：Copilot usage metrics 仪表盘（https://docs.github.com/en/copilot/how-tos/administer-copilot/view-usage-and-adoption）、CodeRabbit per-PR 指标导出（https://docs.coderabbit.ai/guides/dashboard）。→ 本仓库仍缺（§4 #4）。
- **差异化（仍成立）**：本地常驻（无云依赖、无 vendor lock-in）+ **多厂商模型分工**（实现/审查/筛选不同模型）+ **PM 调研 + 独立筛选闭环** + 人类仅两处介入 + "事故→模板规则"的教训库。

## 6. 待调研问题

- 度量（§4 #4）最小可用形态：从 `state.json` + logs 聚合哪些指标最能证明"独立模型审查"的价值？
- Agent A 迁到 per-issue worktree（§4 #3）的最小可独立验证步骤是什么？
- 修复轮/测试修复轮的**边际成本**：每轮各花多少 token？能否量化"修复轮越少越好"？
- `needs_human` 之后人对 issue 的处理是否会被自动重试？（当前需人工；无外发通知）

## 已评估但不建议（累计）

- **全量并发改造（per-issue worktree for Agent A）**：方向正确但一个 PR 装不下，`processIssue`/`runImplementer` 的分支与状态语义会大改 → 先做 §4 #1/#2 这类小步。
- **只翻译文档（#8 方向）**：已被筛选器 REJECT（零证据、非已识别杠杆），不再提。
- **Web 仪表盘**：收益不如"零成本的文本聚合"，且引入前端依赖，违背"确定性环节零成本"。
- **今天未选 metrics/stats（§4 #4）**：价值真实但优先级低于"修复轮正确性"——度量先建立在一个记录正确的状态机上才有意义（§4 #2）。留作下一轮首选候选。
- **把 §4 #1 与 #2 拆成两条 issue**：同一根因（`runImplementer` 每轮都按"首轮"处理）且同一处代码，拆开反而制造冲突 → 本轮合并为一条。
