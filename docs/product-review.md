# Product Review — agent-dev-team

> PM Agent 的长期记忆文件（由 `.agent/pm/run.mjs` 每日/每周维护）。
> 本仓库的产品 = **这个 skill 本身**（把任意 GitHub 仓库变成自治多 agent 开发团队）。
> 证据来自本仓库代码/文档/日志；外部结论均带 URL。行数上限 180。

## 1. 产品是什么

可复用的**多 agent 开发团队技能**：`提 issue → /approve → 实现(A) → 独立模型审查(B)
→ 功能测试(C) → 自动合并`，外加 **PM 调研 agent**（产提案）与 **筛选 agent**
（独立评估提案值不值得做，通过则自动批准）。人类只做两件事：提需求、`/approve`。

## 2. 当前能力清单（已对代码核实；✅ = 最近交付）

| 能力 | 说明 |
|---|---|
| Triage | Actions 定时(10min) + `issue_comment` 即时；`/approve`→`agent-approved`、`/reject`→`agent-rejected`；新 issue 自动 @owner |
| Agent A 实现 | 非交互 pi 会话；**首轮**从 `origin/<base>` 开分支，**修复轮**基于 `origin/agent/<N>`（`lib.prepareImplementerBranch()`）✅ |
| Agent B 审查 | 独立模型（默认 glm-5.3）；`gh pr diff` + PR 评论；中英双语判定解析 + 英文哨兵；模型不可用自动回退 |
| Agent C 测试 | 分离式 worktree + 真实构建/测试；命令可配置 `AGENT_BUILD_CMD`/`AGENT_TEST_CMD`（空串=跳过）✅；失败自动回修 |
| 状态机 | `.agent/state.json`；`round`（审查轮）/`fixes`（测试修复轮）**被正确记录**（`lib.mergeIssueState()` 合并写入）✅ |
| 自动合并 | 测试通过 → squash 合并 + 删分支；自审限制降级为"批准记录"评论；分支保护则 `needs_human` |
| PM Agent | 每日 1 次廉价模型会话，**仅折扣时段**（17:00 UTC / 窗口 16.5–24.5）；配额代码级硬限 |
| 筛选 Agent | 独立模型评估 → IMPLEMENT 自动批准（周上限）/ SPLIT / REJECT；结论 append-only 写 `docs/proposal-audit.md` 并强制注入 PM 上下文 |
| 自愈 | tmux supervisor 崩溃重启；单 issue 异常不拖垮循环；轮询失败指数退避 |
| 自我提升 | opt-in：模板缺陷自动上报 upstream `[skill-feedback]` |
| 自检 | `npm run doctor`（表格 + `--json`，12 项，含真实模型探针）；`validate.mjs` 13 组检查（含临时真 git 仓库集成断言） |

## 3. 优势（有证据）

1. **真实生产验证，非 demo**：本仓库用同一套 loop 完成 #1/#3/#5/#7/#10/#12（PR #2/#4/#6/#9/#11/#13 全部自动合并）；`state.json` 6 条全 `merged`。
2. **闭环能自我改进**：PM 提案 → 独立筛选 → 自动批准 → 实现 → 独立审查 → 测试 → 合并，**已连续 3 天走通**（#7/#10/#12），且每次都带自动化断言（validate check 11/12/13）。
3. **坑固化**：18 条真实事故的修复进模板 + `validate.mjs` 断言；新坑会写成"现象→根因→修复→教训"（如 lesson #18 修复轮基线）。
4. **人类介入最少 + 成本可控**：确定性环节零 LLM；PM 只在折扣窗口跑；配额是代码级硬限。
5. **独立模型审查确实抓到真问题**：issue #7 第 1 轮 review 抓出"误提交 PM 运行时 tmp 文件"与"退出码断言漏场景"。

## 4. 劣势 / 缺口（按证据强度排序）

| # | 缺口 | 证据（文件/事实） |
|---|---|---|
| 1 | **`/reject` 的"取消"承诺不成立**：已批准（尤其**筛选器自动批准**）后再 `/reject`，实现照旧发生 | `templates/issue-agent.yml:72-80` 的 reject 分支只 `ensureLabel('agent-rejected')`，**从不移除 `agent-approved`**；而 watcher 完全按标签取活：`pipeline.mjs:90-92`（`--label=agent-approved`）与 `pipeline.mjs:519-524`（pending 过滤只看 `state.status`）。`'rejected'` 状态在全仓库**只被读、从未被写**（`pipeline.mjs:336,523`）⇒ 该终态不可达。而产品自己承诺了取消：workflow 的批准评论写着"若想取消，回复 `/reject`"（`issue-agent.yml:89`），reject 评论写"本 issue 将不再被 agent 接管"（:77），`README.md:8` 写"`/reject` → 关闭"。`screenAutoApprove` 默认开 ⇒ 用户对自动批准说"不"是目前最常见的取消诉求。 |
| 2 | 并发：Agent A 占主工作区 | `docs/architecture.md`「隔离与并发」；`README.md` 已知限制。同一时刻只能 1 个 issue，且 watcher 运行时不能手动改仓库。 |
| 3 | 无可观测聚合 | 只有逐 issue `state.json` + `.agent/logs/issue-<N>.md`；无 `stats`（审查轮数、回退次数、needs_human 率、耗时）。`round`/`fixes` 已可信（缺口已修），但没人聚合。 |
| 4 | 合并收尾路径无自动断言 | `finishMerge` 的分支保护/合并失败分支只写日志与评论；`needs_human` 后无重试、无外发通知（人必须自己去看）。 |
| 5 | 发现性/分发 | 安装=手动 `pi install git:...` 或复制模板；无 marketplace/registry。 |

（已修复：原 #1"非 npm 仓库无法安装" → issue #10/PR #11；原 #2"修复轮基于 base + 状态计数被覆盖" → issue #12/PR #13。）

## 5. 竞争格局（累计调研，带 URL）

- **直接/相邻**：OpenHands（原 OpenDevin，MIT，自托管 + BYOK）、SWE-agent（研究向，出 patch）、Devin（托管）、GitHub Copilot coding agent、CodeRabbit、aider（CLI）。
  https://airesponsibly.substack.com/p/open-source-ai-coding-agents-a-survey ·
  https://kanopylabs.com/blog/devin-vs-openhands-vs-swe-agent-autonomous-coding
- **迭代修复必须落在 PR 分支上（行业一致做法）**：Copilot cloud agent 默认"pushes commits directly to the pull request's branch"（https://docs.github.com/en/copilot/how-tos/use-copilot-agents/cloud-agent/make-changes-to-an-existing-pr）；OpenHands `skills/iterate` 把 PR "drive through CI, code review and QA until merge-ready"（https://github.com/OpenHands/extensions/tree/main/skills/iterate）。"agent 在 base 上提交 + 非快进被静默搁置"被同类 harness 列为必修 bug（https://github.com/jwulf/c8ctl-plugin-nano/issues/231 · https://github.com/integry/propr/issues/2736）。→ 本仓库已用 #12 对齐。
- **标签驱动的 worker：取消语义是已知难点**：取消必须**真正移除触发标签**，否则 stale label 会留下"已取消但仍在跑"的假象（https://github.com/jeffwlawson/agent-workflows/issues/259 · https://github.com/Osasuwu/jarvis/issues/1936）。→ 正对缺口 #1。也支持"取消要有明确终态并可观测"。
- **可观测性是标配**：Copilot usage metrics 仪表盘（https://docs.github.com/en/copilot/how-tos/administer-copilot/view-usage-and-adoption）、CodeRabbit per-PR 指标导出（https://docs.coderabbit.ai/guides/dashboard）。→ 本仓库仍缺（§4 #3）。
- **语言无关 + 命令可配置是默认**：aider `--test-cmd`（https://aider.chat/docs/usage/lint-test.html）；SWE-rebench V2 自称 language-agnostic（https://arxiv.org/html/2602.23866v1）。
- **差异化（仍成立）**：本地常驻（无云依赖、无 vendor lock-in）+ **多厂商模型分工** + **PM 调研 + 独立筛选闭环** + 人类仅两处介入 + "事故→模板规则"的教训库。

## 6. 待调研问题

- 缺口 #1 修复后，是否还需要"**实现已开始**时取消"的语义（中断/回滚到已知状态）？
- 度量（§4 #3）最小可用形态：从 `state.json` + logs 聚合哪些指标最能证明"独立模型审查"的价值？
- Agent A 迁到 per-issue worktree（§4 #2）的最小可独立验证步骤？
- `needs_human` 之后是否有自动重试的价值（还是应该只做人可读的重试入口）？

## 已评估但不建议（累计）

- **全量并发改造（per-issue worktree for Agent A）**：方向正确但一个 PR 装不下，`processIssue` 的分支与状态语义会大改 → 先做小步。
- **只翻译文档（#8 方向）**：已被筛选器 REJECT，不再提。
- **Web 仪表盘**：收益不如零成本文本聚合，且引入前端依赖。
- **metrics/stats（§4 #3）**：连续第三轮被推迟为"下一轮首选"——今天 #1 的优先级更高（**承诺与实际不符**属于正确性缺陷；度量是增益）。若 #1 落地，下轮默认提它。
- **把 §4 #1 拆成"只修 workflow"或"只修 pipeline"**：单一根因（取消信号没有真正参与"取活"判定），拆开任一半都不成立（只修 YAML 无法防住本地 watcher；只修 pipeline 会留下错误的标签状态）。
