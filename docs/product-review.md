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
| Agent A 实现 | 非交互 pi 会话；**首轮**从 `origin/<base>` 开分支，**修复轮**基于 `origin/agent/<N>`；**在主工作区**运行（见 §4 #1） |
| Agent B 审查 | 独立模型（当前 glm-5.3-flash）；双语判定 + 英文哨兵；回退到 `reviewFallback`；可选独立 reviewer 账号 |
| Agent C 测试 | 分离式 worktree + 真实构建/测试；`AGENT_BUILD_CMD`/`AGENT_TEST_CMD` 可配置；失败自动回修 |
| 合并 = 真实状态 | ✅ 合并后读回 `pr state/mergedAt/headRefName` → `classifyMergeAttempt()`；命令报错但已合并仍记 `merged`；detached 兜底；远程分支清理（#16/PR #17） |
| 恢复入口 | ✅ `retryReset()` + `retry --issue/--list` + `agent:retry`；`merged`/`rejected`/`blocked`/`pr_open` 拒绝；标签读不到 fail-closed（#19/PR #20） |
| 凭据防线 | ✅ `redactSecrets()` + `assertNoSecrets()` 覆盖 pipeline/筛选器/上游反馈/日志；7e lint 扫每个 `'--body'` 调用点；提示词禁 `--body "`（#21/PR #22） |
| 模型健康 | ✅ `parseModelResetAt()`（解析"限额将在…重置"/`retry-after`，钳制 `[now+5m, now+7d]`）+ `.agent/model-health.json` 冷却跳过（无回退模型时永不跳过）+ 每 PR 每日一次警告 + 同标题上报去重 + `reviewedBy` 记账（#25/PR #26） |
| 认证安全 | ✅ doctor 校验**有效写权限**、prompt 禁 `gh auth switch/login`、origin 走 SSH（lesson #25） |
| 状态机 | `.agent/state.json`；`round/fixes/retries/reviewedBy`；终态 `merged/failed/needs_human/rejected`；人工 `retry` 是唯一逆转移 |
| PM / 筛选 | PM 每日折扣时段产提案；筛选 agent 独立评估 → 自动批准/SPLIT/REJECT；审计 append-only 注入 PM 上下文；`screenAutoCapWeekly` 限流 |
| 自愈 | tmux supervisor 崩溃重启；单 issue 异常不拖垮循环；轮询失败指数退避 |
| 自我提升 | opt-in：模板缺陷自动上报 upstream `[skill-feedback]`（#18/#23/#24 即此类，**仍 OPEN**，见 §4 #6） |
| 自检 | `npm run doctor`（表格/`--json`/`--skip`）；`validate.mjs` 18 组检查（含假 gh/假 pi 的离线端到端断言） |

## 3. 优势（有证据）

1. **真实生产验证**：本仓库用同一套 loop 完成 #1/#3/#5/#7/#10/#12/#14/#16/#19/#21/#25
   （PR #2/#4/#6/#9/#11/#13/#15/#17/#20/#22/#26）。PM 提案连续 **8** 次通过筛选 → 自动实现 → 合并。
2. **审查真的挡得住**：#21 的 PR #22 连续两轮要求结构性修法；#25 的 PR #26 第一轮就抓到
   `state.json` 覆盖导致**重复警告**的 bug（"核心场景仍有重复警告（状态覆盖 bug）"）。不同模型确实抓到了不同缺陷。
3. **三条已固化的原则**：不可逆动作只认清回的**真实状态**（#24）· 终态**必须可撤销**（#26）· 防线要**结构性**而非逐点记忆（#28）。
4. **坑固化**：29 条事故，每条都有代码守卫/文档规则；`validate.mjs` 把顺序、字面、lint 自身都断言成测试。
5. **人类介入点极少**：确定性环节零 LLM；配额代码级硬限；失败有显式恢复入口。
6. **dogfood 闭环**：下游仓库的真实崩溃经 opt-in 反馈回流（#18），成为模板规则的输入。

## 4. 劣势 / 缺口（按证据强度排序）

| # | 缺口 | 证据（文件/事实） |
|---|---|---|
| 1 | **Agent A 在用户主工作区 fail-open：脏工作区会被丢弃或被扫进 PR** | 文档规则挡不住代码：`prepareImplementerBranch()` 修复轮直接 `git reset --hard origin/<branch>`（`templates/lib.mjs:158`）——**未提交的改动被静默销毁**；`runImplementer()` 随后 `git add -A`（`templates/pipeline.mjs:267`）——**未提交的改动被扫进 agent 分支并推送**。`grep -n "porcelain\|dirty"` 全仓**零命中**：没有任何开工前检查。这条事故已经真实发生过（`docs/lessons.md` #10「我在 watcher 运行期间编辑 `pipeline.mjs`，随后发现改动消失」），当时的"修复"只是把"watcher 运行时不要改工作区"写成**规则**（`README.md:124` 同款说法）——正是 #22 学到的教训：提示词/文档挡不住破坏性命令。**现场演示**：本次 PM 运行期间，主仓库 `git status` 就有未提交的 `M docs/product-review.md`，此刻若 watcher 接活，可能被 `reset --hard` 抹掉或被 `add -A` 提交进别人的 PR。 |
| 2 | 更新不会热加载：watcher 跑的是**启动时的代码** | `templates/supervisor.sh` 只在崩溃时重启。证据：#14 运行时用的是 #13 之前的旧逻辑；#22/#26 这类修复也要等人工重启才生效。 |
| 3 | 收尾不幂等：合并成功但清理/状态补正没有自动重放 | 远程分支 `agent/14` 仍残留（2026-10-20 复核，5 天）。`agent:retry` 可手工对账。 |
| 4 | 并发只有"单 issue、主工作区"一种形态 | `docs/architecture.md`「隔离与并发」；README 已知限制。§4 #1 的 fail-closed 只是止血，真解是 per-issue worktree。 |
| 5 | 无可观测聚合 | 无 `stats`（审查轮数、回退/冷却次数、`needs_human` 率、耗时）。原始字段已齐（`round/fixes/retries/reviewedBy` + 健康文件）。 |
| 6 | 上游反馈从未被收口 | `[skill-feedback]` #18（`gh pr create` 权限崩溃）、#23/#24（模型额度，已被 PR #26 修好）**全部仍 OPEN**，无"是否已有对应修复/lesson"的分流，维护者无法用它当信号。 |
| 7 | 发现性/分发 | 安装=手动复制/`pi install`；无 marketplace/registry。 |

（已修复：非 npm 仓库无法安装 → #10/PR #11；修复轮基线 → #12/PR #13；`/reject` 取消 → #14/PR #15；
合并误判 → #16/PR #17；`needs_human` 死胡同 → #19/PR #20；凭据防线 → #21/PR #22；模型不可用无记忆 → #25/PR #26。）

## 5. 竞争格局（累计调研，带 URL）

- **直接/相邻**：OpenHands、SWE-agent、Devin、GitHub Copilot coding agent、CodeRabbit、aider。
  https://airesponsibly.substack.com/p/open-source-ai-coding-agents-a-survey ·
  https://kanopylabs.com/blog/devin-vs-openhands-vs-swe-agent-autonomous-coding
- **"退出码 ≠ 成功"**（#17 已吸收）：https://dev.to/jeremy_longshore/exit-0-is-not-success-automation-assurance-that-verifies-outcomes-2a4n
- **终态必须可撤销**（#19 已吸收）：ForgeDock #3571 https://github.com/RapierCraftStudios/ForgeDock/issues/3571 ·
  know_thy_build #156 https://github.com/LeeHyeonKyu/know_thy_build/issues/156
- **凭据防线要覆盖全出口**（#21 已吸收）：GitHub push protection https://docs.github.com/en/code-security/secret-scanning/introduction/about-push-protection ·
  gitleaks https://github.com/gitleaks/gitleaks
- **模型额度：失败→冷却而非每次重试**（#25 已吸收）：LiteLLM Router cooldowns https://docs.litellm.ai/docs/routing ·
  MDN 429/Retry-After https://developer.mozilla.org/en-US/docs/Web/HTTP/Status/429
- **"开工前检查工作区干净"是 agent runner 的标准前置门（fail-closed）**（2026-10-20 新增调研，正对 §4 #1）：
  - larch 的 `/implement`·`/fix-issue` 在**创建锁/分支之前**调用 `check-clean-tree.sh --fail-closed`
    （`git status --porcelain`），并进一步把"本地 main 与 origin 同步"也纳入同一前置门
    —— 说明"用脏工作区起跑"是这类系统的共性缺陷，且正确做法是**起跑前拒绝**而不是事后恢复。
    https://github.com/zhupanov/larch/issues/2534
  - Git 权威语义：`git reset --hard` 会**丢弃**工作区与索引中的改动（`--hard` 段落）
    https://git-scm.com/docs/git-reset ；
    `git status --porcelain` 是给脚本判断"工作区是否干净"的稳定接口
    https://git-scm.com/docs/git-status
  - `git worktree` 是官方的"多工作树并行"机制（Agent C 已在用），也是 §4 #4 的长期解法
    https://git-scm.com/docs/git-worktree
- **可观测性是标配**：Copilot usage metrics https://docs.github.com/en/copilot/how-tos/administer-copilot/view-usage-and-adoption ·
  CodeRabbit dashboard https://docs.coderabbit.ai/guides/dashboard → 仍缺（§4 #5）。
- **差异化（仍成立）**：本地常驻（无云依赖/lock-in）+ **多厂商模型分工** + **PM 调研 + 独立筛选闭环** + 人类仅两处介入 + "事故→模板规则"的教训库。

## 6. 待调研问题

- §4 #1 的最小步 = **开工前 fail-closed 检查 + "等待轮"语义**（脏就本 tick 跳过、干净后自动接活、不烧 `needs_human`），对不对？还是应直接上 per-issue worktree？
- "脏"的判定要不要扩展到"本地 base 与 `origin/base` 不同步（领先/落后/分叉）"（larch 的做法）？
- 缺口 #2（热加载）：空闲时 `mtime` 变更 → `exit(0)` 交 supervisor 重启，还是每轮重新 `import()`？
- 缺口 #3（对账）：watch 每 tick 对"state≠merged 但 PR 已 MERGED"重放对账，与 `retry` 是否重叠？
- 缺口 #6（反馈收口）：能否在 triage 里对 `[skill-feedback]` 做"是否已有对应 lesson/PR"的自动关联并附一行状态？
- 缺口 #5 最小形态：`round/fixes/retries/reviewedBy` + 冷却次数，聚合哪几个最能证明"独立模型审查"的价值？

## 已评估但不建议（累计）

- **全量并发改造（per-issue worktree for Agent A）**：方向正确但一个 PR 装不下（先做 §4 #1 的止血）。
- **只翻译文档（#8 方向）**：已被筛选器 REJECT，不再提。
- **Web 仪表盘**：不如零成本文本聚合。
- **metrics/stats（§4 #5）**：连续第八轮推迟——数据丢失/安全类缺陷每次都影响运行，度量是增益。
- **只修 lessons.md 重复编号** / **拆开修合并误判**：已被 #16、#17 一并解决。
- **模型冷却扩展到 PM/筛选模型**：#25 的同一模式，先观察现有实现是否够用，无新证据不重复提。
- **修 pi 的 `Model "deepseek-v4-flash" not found for provider "deepseek"` 警告**（PM 日志 stderr 实测）：属配置/校验层（doctor 已有真实 1-token 探针），单独提案价值低，先记录观察。
- **本轮考虑但未提**：
  - *watch 热加载（§4 #2）*：仍无用户报告，且改成"空闲时重启"会与 §4 #1 的"等待轮"语义交互，先做更硬的数据丢失问题。
  - *反馈收口（§4 #6）*：维护者体验，非普通用户价值，暂缓。
- **本轮决定提**：**开工前 fail-closed 工作区检查**（防止人类未提交改动被 `git reset --hard` 销毁或 `git add -A` 扫进 PR），带"等待轮"语义与一次限流提示。
