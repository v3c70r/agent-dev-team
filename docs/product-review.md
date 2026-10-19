# Product Review — agent-dev-team

> PM Agent 的长期记忆文件（由 `.agent/pm/run.mjs` 每日/每周维护）。
> 本仓库的产品 = **这个 skill 本身**（把任意 GitHub 仓库变成自治多 agent 开发团队）。
> 证据来自本仓库代码/文档/日志；外部结论均带 URL。行数上限 180。

## 1. 产品是什么

可复用的**多 agent 开发团队技能**：`提 issue → /approve → 实现(A) → 独立模型审查(B)
→ 功能测试(C) → 自动合并`，外加 **PM 调研 agent**（产提案）与 **筛选 agent**
（独立评估提案值不值得做，通过则自动批准）。人类只做两件事：提需求、`/approve`
（另可选"可信 agent 免人工门禁"的自动批准标签）。

## 2. 当前能力清单（已对代码核实；✅ = 最近新增/已修复）

| 能力 | 说明 |
|---|---|
| Triage | Actions 定时(10min) + `issue_comment` 即时；`/approve`/`/reject` 标签**互斥**；新 issue 自动 @owner；内联脚本有语法/未定义 helper 守卫 |
| 依赖门禁 | issue 可写 `Depends on: #N`；未完成则置 `blocked` 不实现 |
| 可信自动批准 | 特定标签的 trusted-agent issue 可跳过人工 `/approve`（周上限） |
| Agent A 实现 | 非交互 pi 会话；**首轮**从 `origin/<base>` 开分支，**修复轮**基于 `origin/agent/<N>` |
| Agent B 审查 | 独立模型（当前 glm-5.3-flash）；双语判定 + 英文哨兵；**单次**回退到 `reviewFallback`；可选独立 reviewer 账号（默认未启用） |
| Agent C 测试 | 分离式 worktree + 真实构建/测试；`AGENT_BUILD_CMD`/`AGENT_TEST_CMD` 可配置；失败自动回修 |
| 合并 = 真实状态 | ✅ 合并后读回 `pr state/mergedAt/headRefName` → `classifyMergeAttempt()`（merged/blocked/unknown）；命令报错但已合并仍记 `merged`；detached 兜底；远程分支清理重试（#16/PR #17） |
| 恢复入口 | ✅ `retryReset()` + `retry --issue N / --list` + `npm run agent:retry`：`needs_human`/`failed` 可复位续跑；`merged`/`rejected`/`blocked`/`pr_open` 拒绝；标签读不到 fail-closed；重试留痕（#19/PR #20） |
| 凭据防线 | ✅ **结构性**：`lib.redactSecrets()`（幂等脱敏）+ `assertNoSecrets()`（硬拦截）；pipeline/筛选器/上游反馈/日志全出口覆盖；`validate` 7e lint 扫描每个 `'--body'` 调用点 + 禁止提示词里 `--body "` 示范；终端诊断另有 `scrub()` 收口（#21/PR #22） |
| 认证安全 | ✅ doctor 校验**有效写权限**（`.permissions.push`）、prompt 禁 `gh auth switch/login`、要求 origin 走 SSH（lesson #25） |
| 状态机 | `.agent/state.json`；`round`/`fixes`/`retries`；终态 `merged/failed/needs_human/rejected`；`selectPendingIssues()` 全跳过（人工 `retry` 是唯一逆转移） |
| PM / 筛选 | PM 每日折扣时段产提案；筛选 agent 独立评估 → 自动批准/SPLIT/REJECT；审计 append-only 注入 PM 上下文；`screenAutoCapWeekly` 限流 |
| 自愈 | tmux supervisor 崩溃重启；单 issue 异常不拖垮循环；轮询失败指数退避 |
| 模型不可用 | ⚠️ **部分**：捕获额度/限流错误 → 单次回退 + 每轮评论 + opt-in 上报；**无冷却记忆、无上报去重、日志把回退轮的模型记成主模型**（见 §4 #1） |
| 自我提升 | opt-in：模板缺陷自动上报 upstream `[skill-feedback]` |
| 自检 | `npm run doctor`（表格/`--json`/`--skip <name>` 分离宿主类与仓库类检查，lesson #27）；`validate.mjs` 17 组检查（含假 gh 的离线端到端断言） |

## 3. 优势（有证据）

1. **真实生产验证，非 demo**：本仓库用同一套 loop 完成 #1/#3/#5/#7/#10/#12/#14/#16/#19/#21
   （PR #2/#4/#6/#9/#11/#13/#15/#17/#20/#22）。PM 提案连续 **7** 次通过筛选 → 自动实现 → 合并。
2. **审查真的挡得住**：#14 的 PR #15 被 Agent B 判 `REQUEST_CHANGES`；#21 的 PR #22 被 Agent B 连续
   两轮要求结构性修法（并自行做"删掉修复是否变红"的负向验证），第三轮 APPROVE。
3. **不可逆动作只认读回状态**（#24）、**终态必须可撤销**（#26）、**防线要结构性而非逐点**（#28）——都已代码化 + 测试化。
4. **坑固化**：28 条事故，每条都有代码守卫/文档规则；`validate.mjs` 把顺序、字面、lint 自身都断言成测试。
5. **人类介入点极少**：确定性环节零 LLM；配额代码级硬限；失败有显式恢复入口。
6. **dogfood 闭环**：下游仓库的真实崩溃经 opt-in 反馈回流（#18），成为模板规则的输入。

## 4. 劣势 / 缺口（按证据强度排序）

| # | 缺口 | 证据（文件/事实） |
|---|---|---|
| 1 | **模型不可用是一次"有截止时间的事实"，但流水线不记忆、不复用、不记账** | 实测（2026-10-18）：主审查模型 `zai-coding-cn/glm-5.3-flash` 返回 `429 {"code":"1310","message":"您已达到每周/每月使用上限，您的限额将在 2026-10-19 07:47:19 重置。"}`。后果三连：(a) **每个审查轮都重试一次已死的模型** —— PR #22 的 3 个轮次留下 **3 条** `⚠️ 审查模型不可用` 评论；(b) **重复上报** —— 同一天发出 #23（17:12）与 #24（17:21）两条标题完全相同的上游 skill-feedback（现有每日上限 3 条只管总量，不按主题去重）；(c) **记账不实** —— `runReviewRound()` 回退后仍写 `model=${describeModel(REVIEW)}`（`templates/pipeline.mjs:307`），日志与 `state.json` 都看不出这轮其实是 fallback 审的。代码事实：无任何 health/cooldown 状态（grep 无 `health`），错误文本里的"重置时间"被丢弃，回退链只支持 1 个候选。额度是**周期性**的（周/月），所以这不是一次性故障。 |
| 2 | 更新不会热加载：watcher 跑的是**启动时的代码** | `templates/supervisor.sh` 只在进程崩溃时重启。证据：issue #14 运行时用的是 #13 之前的旧逻辑；已合并的改进要等人工重启。 |
| 3 | 收尾不幂等：合并成功但清理/状态补正没有自动重放 | `git ls-remote --heads origin` 仍显示 `agent/14` 残留（2026-10-19 复核，4 天）。`agent:retry` 可手工对账，但无自动路径。 |
| 4 | 并发：Agent A 占主工作区 | `docs/architecture.md`「隔离与并发」；`README.md` 已知限制。 |
| 5 | 无可观测聚合 | 无 `stats`（审查轮数、回退次数、`needs_human` 率、重试/冷却次数、耗时）。已有 `round/fixes/retries/reviewedBy` 等原始字段可聚合。 |
| 6 | 发现性/分发 | 安装=手动复制/`pi install`；无 marketplace/registry。 |

（已修复：非 npm 仓库无法安装 → #10/PR #11；修复轮基线 → #12/PR #13；`/reject` 取消 → #14/PR #15；
合并误判 → #16/PR #17；`needs_human` 死胡同 → #19/PR #20；凭据防线只覆盖 3 处 → #21/PR #22。）

## 5. 竞争格局（累计调研，带 URL）

- **直接/相邻**：OpenHands、SWE-agent、Devin、GitHub Copilot coding agent、CodeRabbit、aider。
  https://airesponsibly.substack.com/p/open-source-ai-coding-agents-a-survey ·
  https://kanopylabs.com/blog/devin-vs-openhands-vs-swe-agent-autonomous-coding
- **"退出码 ≠ 成功"**（#17 已吸收）：https://dev.to/jeremy_longshore/exit-0-is-not-success-automation-assurance-that-verifies-outcomes-2a4n
- **终态必须可撤销**（#19 已吸收）：ForgeDock #3571 https://github.com/RapierCraftStudios/ForgeDock/issues/3571 ·
  know_thy_build #156 https://github.com/LeeHyeonKyu/know_thy_build/issues/156 ·
  viberpit #1540 https://github.com/steiner385/viberpit/issues/1540
- **凭据防线要覆盖全出口且可测**（#21 已吸收）：GitHub push protection https://docs.github.com/en/code-security/secret-scanning/introduction/about-push-protection ·
  gitleaks https://github.com/gitleaks/gitleaks · IRLight #468/#481 https://github.com/azumag/IRLight/issues/468
- **"失败计数 → 冷却"是成熟模式，不是每次请求重试**（2026-10-19 新增调研，正对 §4 #1）：
  - LiteLLM Router 的可靠性三件套 = cooldowns + fallbacks + retries；`allowed_fails`（每分钟允许失败几次）
    → `cooldown_time`（该 deployment 冷却多久），冷却中的 deployment 会被跳过、请求落到其余健康候选。
    https://docs.litellm.ai/docs/routing
  - HTTP 语义层面：429 的 `Retry-After` 就是"服务器告诉你什么时候再来"；
    忽略它、按自己的节奏重试是反模式。https://developer.mozilla.org/en-US/docs/Web/HTTP/Status/429
  - 回退链本身也是标准件（LangChain `with_fallbacks`），说明"单候选回退"已属最低配。
    https://python.langchain.com/docs/how_to/fallbacks/
  - 结论：我们已具备"回退 + 上报"，缺的是**记住不可用状态（含截止时间）并据此跳过**，以及**一次中断只上报一次**。
- **可观测性是标配**：Copilot usage metrics https://docs.github.com/en/copilot/how-tos/administer-copilot/view-usage-and-adoption ·
  CodeRabbit dashboard https://docs.coderabbit.ai/guides/dashboard → 仍缺（§4 #5）。
- **差异化（仍成立）**：本地常驻（无云依赖/lock-in）+ **多厂商模型分工** + **PM 调研 + 独立筛选闭环** + 人类仅两处介入 + "事故→模板规则"的教训库。

## 6. 待调研问题

- §4 #1 的最小闭环 = 健康文件（`模型 → 冷却至`）+ 跳过主模型 + 上报去重 + 记账 `reviewedBy`，是否够？（不做多候选列表）
- 额度重置时间的**时区**：中文报错里的 `2026-10-19 07:47:19` 未标时区（提供商多在 +08:00）。按 UTC 宽松解释 + 上限钳制（≤ now+7d）是否可接受，还是要读 `Retry-After`/epoch 字段？
- 缺口 #2（热加载）：`mtime` 变更 → 空闲时 `exit(0)` 交 supervisor 重启，还是每轮重新 `import()`？
- 缺口 #3（对账）：watch 每 tick 对"state≠merged 但 PR 已 MERGED"做重放对账，与 `retry` 入口是否重叠？
- `needs_human` 该不该按**原因分类**（引擎缺陷类可自动重试一次）？
- 缺口 #5 最小形态：`round/fixes/retries/reviewedBy` + 模型冷却次数，聚合哪几个最能证明"独立模型审查"的价值？

## 已评估但不建议（累计）

- **全量并发改造（per-issue worktree for Agent A）**：方向正确但一个 PR 装不下。
- **只翻译文档（#8 方向）**：已被筛选器 REJECT，不再提。
- **Web 仪表盘**：不如零成本文本聚合。
- **metrics/stats（§4 #5）**：连续第七轮推迟——正确性/成本缺陷每次都影响运行，度量是增益。
- **只修 lessons.md 重复编号**：已被 #16 顺带修好；**拆开修合并误判**：已被 #17 一并修好。
- **本轮考虑但未提**：
  - *只做"上报去重"*（修 #23/#24 那种重复）：太小，且不解决"每轮重试死模型"的真实成本。
  - *多模型候选列表 / 跨进程共享健康状态（Redis）*：本产品刻意单机常驻，一个本地 JSON 足够。
  - *watch 热加载（§4 #2）*：证据仍是推断、无用户报告，重启语义风险高——但**它会让今天这类修复也要等人工重启才生效**，下一轮若再无明显安全/成本缺陷，优先提它。
  - *PM/筛选模型同样可能额度耗尽*：今天证据只覆盖审查模型，先修同一段代码里的审查路径；扩展到 PM/筛选作为后续。
- **本轮决定提**：审查模型的**健康记忆（含重置时间）+ 一次中断只上报/评论一次 + 如实记录当轮所用模型**（实测事故、3 条重复评论、2 条重复上游 issue、1 处日志记账错误）。
