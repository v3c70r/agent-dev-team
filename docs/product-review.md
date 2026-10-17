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
| Agent B 审查 | 独立模型（默认 glm-5.3）；双语判定 + 英文哨兵；模型不可用自动回退；可选独立 reviewer 账号（默认未启用） |
| Agent C 测试 | 分离式 worktree + 真实构建/测试；`AGENT_BUILD_CMD`/`AGENT_TEST_CMD` 可配置；失败自动回修 |
| 合并 = 真实状态 | ✅ `finishMerge()` 合并后读回 `pr state/mergedAt/headRefName`，用 `lib.classifyMergeAttempt()` 判 `merged/blocked/unknown`；命令报错但已合并仍记 `merged`；合并前 detached 兜底；漏删的远程分支尽力清理（#16/PR #17） |
| 认证安全 | ✅ doctor 校验**有效写权限**（`repos/*.permissions.push`，不只看 scope）；选项 origin 必须 SSH；prompt 禁止 `gh auth switch/login`；正文一律 `--body-file`（lesson #25） |
| 状态机 | `.agent/state.json`；`round`/`fixes` 正确记录；终态 `merged/failed/needs_human/rejected`；`lib.selectPendingIssues()` 把以上四种**一律当终态跳过** |
| PM / 筛选 | PM 每日折扣时段产提案；筛选 agent 独立评估 → 自动批准/SPLIT/REJECT；审计 append-only 注入 PM 上下文 |
| 自愈 | tmux supervisor 崩溃重启；单 issue 异常不拖垮循环；轮询失败指数退避 |
| 自我提升 | opt-in：模板缺陷自动上报 upstream `[skill-feedback]`（#18 即此类） |
| 自检 | `npm run doctor`（表格 + `--json`，真实模型探针）；`validate.mjs` 15 组检查（含临时真 git 仓库集成断言） |

## 3. 优势（有证据）

1. **真实生产验证，非 demo**：本仓库用同一套 loop 完成 #1/#3/#5/#7/#10/#12/#14/#16
   （PR #2/#4/#6/#9/#11/#13/#15/#17）。PM 提案连续 5 次通过筛选 → 自动实现 → 合并。
2. **多轮审查真的挡得住阻塞问题**：#14 的 PR #15 首轮被 Agent B 判 `REQUEST_CHANGES`
   （"运行中 `/reject` 仍会被自动合并"），修复轮补齐 `finishMerge` 守卫后通过。
3. **不可逆动作只认读回状态**（lesson #24）—— 这是很多同类项目仍在踩的坑（下见 §5）。
4. **坑固化**：25 条事故，每条都有代码守卫或文档规则；`validate.mjs` 把关键顺序断言成测试。
5. **人类介入点极少**：确定性环节零 LLM；配额代码级硬限。

## 4. 劣势 / 缺口（按证据强度排序）

| # | 缺口 | 证据（文件/事实） |
|---|---|---|
| 1 | **`needs_human` / `failed` 无恢复入口 = 死胡同** | `lib.selectPendingIssues()` 把 `needs_human` 列入 `TERMINAL`（`templates/lib.mjs`），watch 循环永不重取；全仓文档/grep 无任何"恢复/重试"说明；唯一逃生口是**未文档化**的 `pipeline.mjs run --issue N --force`，而 `--force` 同时**绕过 `isRejectedIssue()` 否决**（`templates/pipeline.mjs:398`）——人类为了救一个卡住的 issue，可能顺带复活一个已被 `/reject` 的 issue。真实后果实例：本仓 #14 合并成功却留在 `needs_human`（至今），上游 issue **#18 仍 OPEN**（下游 qc-gas 崩溃 → `needs_human` → 只能手改 gitignored 的 `state.json`）。 |
| 2 | 更新不会热加载：watcher 跑的是**启动时的代码** | `templates/supervisor.sh` 只在进程崩溃时重启。证据：issue #14 运行时用的是 #13 之前的旧逻辑，Agent A 还手动补救过被重置的分支。已合并的改进要等人工重启才生效。 |
| 3 | 收尾不幂等：合并成功但**清理漏做**后没有重放 | `git ls-remote --heads origin` 仍显示 `agent/14` 残留：`finishMerge()` 的远程分支清理只在**当次**运行；没有任何"读回 PR 已合并 → 补做清理/补正状态"的路径（#17 只保证新运行不再误判）。 |
| 4 | 并发：Agent A 占主工作区 | `docs/architecture.md`「隔离与并发」；`README.md` 已知限制。 |
| 5 | 无可观测聚合 | 无 `stats`（审查轮数、回退次数、`needs_human` 率、耗时、重试次数）。`docs/lessons.md` 编号已修（#24/#25 连续），但无自动校验覆盖全部编号唯一性以外的顺序。 |
| 6 | 发现性/分发 | 安装=手动复制/`pi install`；无 marketplace/registry。 |

（已修复：非 npm 仓库无法安装 → #10/PR #11；修复轮基线 + 状态计数覆盖 → #12/PR #13；
`/reject` 取消不生效 → #14/PR #15；合并误判失败 → #16/PR #17；有效写权限预检 → 73dd846。）

## 5. 竞争格局（累计调研，带 URL）

- **直接/相邻**：OpenHands、SWE-agent、Devin、GitHub Copilot coding agent、CodeRabbit、aider。
  https://airesponsibly.substack.com/p/open-source-ai-coding-agents-a-survey ·
  https://kanopylabs.com/blog/devin-vs-openhands-vs-swe-agent-autonomous-coding
- **"退出码 ≠ 成功"**（已由 #17 吸收）：https://dev.to/jeremy_longshore/exit-0-is-not-success-automation-assurance-that-verifies-outcomes-2a4n ·
  Airflow 教训"trust a confirmed terminal state over an unobserved exit code"（https://github.com/apache/airflow/pull/73142）
- **升级/升级后的恢复入口是同行的真实痛点**（2026-10-17 新增调研）：
  - ForgeDock #3571（已修复）：`needs-human` 是终态，人类清掉标签后 `run-issue --retry` **拒绝重开**
    （"`--retry` only reopens an engine-error run"），运维只能手改 `FORGE:STATE` 才能继续；修复口径 =
    "人类清掉标签即 hand-back 信号，`--retry` 可重开，但**仍带标签的运行永不被重开**"。
    https://github.com/RapierCraftStudios/ForgeDock/issues/3571
  - know_thy_build #156：把 `needs-human` **按原因分类**——引擎缺陷类允许"新版本上线后自动重试一次"，
    人类判断类（审查轮耗尽/需人工合并/超预算）**永不自动重试**。
    https://github.com/LeeHyeonKyu/know_thy_build/issues/156
  - viberpit #1540：`gave_up` 行没有 un-park 入口，人类把卡片拖回 Ready 仍被冷却规则永久挡住 → 要求
    "把人类的手工编辑当作 hand-back 信号"或提供 "retry now" 动作。
    https://github.com/steiner385/viberpit/issues/1540
  - 反面样本（卡住即堆积）：ojones/ai-factory 的 "Stuck run [needs_human]" issue 一直开着。
    https://github.com/ojones/ai-factory/issues/121
- **标签驱动的取消要移除触发标签**（已由 #14 吸收）：https://github.com/jeffwlawson/agent-workflows/issues/259
- **可观测性是标配**：Copilot usage metrics（https://docs.github.com/en/copilot/how-tos/administer-copilot/view-usage-and-adoption）、CodeRabbit dashboard（https://docs.coderabbit.ai/guides/dashboard）→ 仍缺（§4 #5）。
- **差异化（仍成立）**：本地常驻（无云依赖/lock-in）+ **多厂商模型分工** + **PM 调研 + 独立筛选闭环** + 人类仅两处介入 + "事故→模板规则"的教训库。

## 6. 待调研问题

- 缺口 #2（更新不热加载）：`mtime` 变更 → `exit(0)` 交 supervisor 重启，还是每轮重新 `import()`？
- 缺口 #3（收尾幂等）：要不要在 watch 每次 tick 对"state≠merged 但 PR 已 MERGED"的条目做一次**重放对账**（读回 → 补清理 → 补正状态）？这与 #1 的 retry 入口是否重叠？
- 缺口 #5 最小可用形态：从 `state.json` + logs 聚合哪几个指标最能证明"独立模型审查"的价值？
- Agent A 迁到 per-issue worktree（§4 #4）的最小可独立验证步骤？

## 已评估但不建议（累计）

- **全量并发改造（per-issue worktree for Agent A）**：方向正确但一个 PR 装不下。
- **只翻译文档（#8 方向）**：已被筛选器 REJECT，不再提。
- **Web 仪表盘**：不如零成本文本聚合。
- **metrics/stats（§4 #5）**：连续第五轮推迟——正确性/可恢复性缺陷每次运行都影响人类，度量是增益。
- **只修 lessons.md 重复编号**：单独立项太琐碎（已被 #16 顺带修好）。
- **把"合并误判"拆成 detached / 读回两半**：已由 #17 一并修好。
- **本轮考虑但未提**：
  - *runImplementer 前预检写权限*（防 #18 那类"整轮 pi 白跑 + 留下孤儿分支"）：doctor 已覆盖同一检查（73dd846），增量只是"pipeline 启动时调同一次检查"，价值低于恢复入口。
  - *`gh pr create` 幂等化（分支已推/PR 已存在时复用）*：`prForBranch()` 已在创建前查询，真实失败原因是身份权限而非缺查询，收益小。
  - *watch 热加载（§4 #2）*：证据仍是推断（无用户报告），且"重启语义"改动风险高，先做可验证的恢复入口。
- **本轮决定提**：`needs_human/failed` 的可发现、可审计恢复入口（不绕过 `/reject`）——四个独立项目同一痛点、我们已有两个真实卡死实例。
