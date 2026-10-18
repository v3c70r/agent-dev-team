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
| Agent B 审查 | 独立模型（默认 glm-5.3-flash）；双语判定 + 英文哨兵；模型不可用自动回退；可选独立 reviewer 账号（默认未启用） |
| Agent C 测试 | 分离式 worktree + 真实构建/测试；`AGENT_BUILD_CMD`/`AGENT_TEST_CMD` 可配置；失败自动回修 |
| 合并 = 真实状态 | ✅ `finishMerge()` 合并后读回 `pr state/mergedAt/headRefName` → `lib.classifyMergeAttempt()`（merged/blocked/unknown）；命令报错但已合并仍记 `merged`；detached 兜底；漏删的远程分支尽力清理（#16/PR #17） |
| 恢复入口 | ✅ `lib.retryReset()` + `pipeline.mjs retry --issue N / --list` + `npm run agent:retry`：`needs_human`/`failed` 可复位续跑；`merged`/`rejected`/`blocked`/`pr_open` 拒绝；读不到标签 fail-closed；重试留痕（retries/previousStatus/lastError/评论/日志）（#19/PR #20） |
| 凭据下发拦截 | ⚠️ **部分**：`assertNoSecrets()` 只挂在 `commentOnIssue`/`commentOnPr`/PR 正文三处（c36aca5）；见 §4 #1 |
| 认证安全 | ✅ doctor 校验**有效写权限**（`repos/*.permissions.push`，不只看 scope）；prompt 禁 `gh auth switch/login`；要求 origin 走 SSH（lesson #25） |
| 状态机 | `.agent/state.json`；`round`/`fixes`/`retries` 记录；终态 `merged/failed/needs_human/rejected`；`selectPendingIssues()` 把四种**一律跳过**（自动重试不做，人工 `retry` 是唯一逆转移） |
| PM / 筛选 | PM 每日折扣时段产提案；筛选 agent 独立评估 → 自动批准/SPLIT/REJECT；审计 append-only 注入 PM 上下文；`screenAutoCapWeekly` 限流 |
| 自愈 | tmux supervisor 崩溃重启；单 issue 异常不拖垮循环；轮询失败指数退避 |
| 自我提升 | opt-in：模板缺陷自动上报 upstream `[skill-feedback]`（#18 即此类） |
| 自检 | `npm run doctor`（表格 + `--json` + `--skip <name>` 区分**宿主类**与**仓库类**检查，lesson #27）；`validate.mjs` **16 组**检查（含临时真 git 仓库 + 假 gh 的离线端到端断言） |

## 3. 优势（有证据）

1. **真实生产验证，非 demo**：本仓库用同一套 loop 完成 #1/#3/#5/#7/#10/#12/#14/#16/#19
   （PR #2/#4/#6/#9/#11/#13/#15/#17/#20）。PM 提案连续 **6** 次通过筛选 → 自动实现 → 合并。
2. **审查真的挡得住**：#14 的 PR #15 首轮被 Agent B 判 `REQUEST_CHANGES`（"运行中 `/reject` 仍会被自动合并"）；
   #19 的 PR #20 又反过来暴露了"测试依赖宿主环境"（lesson #27）。两轮都是**不同模型/不同角色**发现问题。
3. **不可逆动作只认读回状态**（#24）、**终态必须可撤销**（#26）——两条都已代码化 + 测试化。
4. **坑固化**：27 条事故，每条都有代码守卫/文档规则；`validate.mjs` 把顺序、字面约束都断言成测试。
5. **人类介入点极少**：确定性环节零 LLM；配额代码级硬限；失败有显式恢复入口。
6. **dogfood 闭环**：下游仓库的真实崩溃会经 opt-in 反馈回流（#18），成为模板规则的输入。

## 4. 劣势 / 缺口（按证据强度排序）

| # | 缺口 | 证据（文件/事实） |
|---|---|---|
| 1 | **凭据防线只覆盖"被写在的三处"**：其余出站正文/日志/反馈通道全部裸奔 | 实测事故（c36aca5 提交信息）：评论正文里的 `$(gh auth token ...)` 被 shell 展开 → 真令牌贴进 PR 评论 → GitHub 自动吊销 → 全链路 401。新增的 `assertNoSecrets()` 只挂在 `commentOnIssue`/`commentOnPr`/`pr create --body`（`templates/pipeline.mjs:182/183/232`），以下**仍未加拦截**：`reportGap()` 发往**上游第三方仓库**的 issue 正文（`:87/:90`，且正文含 `err.stack`）、`pr review --approve --body`（`:596/:610`）、筛选器 `templates/pm/screen.mjs:198/203/214`（正文含**模型生成**的 WHY/SCOPE/REFINED_TASK，`issue edit` 还会把原正文拼回去）、以及 `.agent/logs/issue-N.md` 原样落地 pi 输出（`:217`/`:297`，screen.mjs 还整段落盘模型输出）。**提示词自相矛盾**：`templates/prompts/reviewer.md:14` 禁止双引号 `$(...)`，`:39` 的示例却是 `gh pr comment <PR#> --body "…"`（正是出事的写法），而 validate 只 grep 文件里**存在** `--body-file` 字样。 |
| 2 | 更新不会热加载：watcher 跑的是**启动时的代码** | `templates/supervisor.sh` 只在进程崩溃时重启。证据：issue #14 运行时用的是 #13 之前的旧逻辑。已合并的改进要等人工重启才生效。 |
| 3 | 收尾不幂等：合并成功但**清理/状态补正**没有自动重放 | `git ls-remote --heads origin` 仍显示 `agent/14` 残留（2026-10-18 复核）。现在可用 `agent:retry` 手工对账，但没有任何自动路径。 |
| 4 | 并发：Agent A 占主工作区 | `docs/architecture.md`「隔离与并发」；`README.md` 已知限制。 |
| 5 | 无可观测聚合 | 无 `stats`（审查轮数、回退次数、`needs_human` 率、重试次数、耗时）。已有 `retries`/`previousStatus` 等原始字段可聚合。 |
| 6 | 发现性/分发 | 安装=手动复制/`pi install`；无 marketplace/registry。 |

（已修复：非 npm 仓库无法安装 → #10/PR #11；修复轮基线 → #12/PR #13；`/reject` 取消 → #14/PR #15；
合并误判 → #16/PR #17；`needs_human` 死胡同 → #19/PR #20；宿主类检查污染测试 → lesson #27。）

## 5. 竞争格局（累计调研，带 URL）

- **直接/相邻**：OpenHands、SWE-agent、Devin、GitHub Copilot coding agent、CodeRabbit、aider。
  https://airesponsibly.substack.com/p/open-source-ai-coding-agents-a-survey ·
  https://kanopylabs.com/blog/devin-vs-openhands-vs-swe-agent-autonomous-coding
- **"退出码 ≠ 成功"**（#17 已吸收）：https://dev.to/jeremy_longshore/exit-0-is-not-success-automation-assurance-that-verifies-outcomes-2a4n ·
  https://github.com/apache/airflow/pull/73142
- **终态必须可撤销 / 恢复入口**（#19 已吸收）：ForgeDock #3571（`--retry` 拒绝重开 needs-human，运维手改 `FORGE:STATE`）https://github.com/RapierCraftStudios/ForgeDock/issues/3571 ·
  know_thy_build #156（按原因分类，只自动重试引擎缺陷类）https://github.com/LeeHyeonKyu/know_thy_build/issues/156 ·
  viberpit #1540（`gave_up` 无 un-park）https://github.com/steiner385/viberpit/issues/1540 ·
  反面样本堆积 https://github.com/ojones/ai-factory/issues/121
- **凭据防线要覆盖"所有出站与落盘"**（2026-10-18 新增调研，正对 §4 #1）：
  - 平台侧：GitHub push protection / secret scanning 会把**已推送**的令牌当作既成事实并吊销
    https://docs.github.com/en/code-security/secret-scanning/introduction/about-push-protection
    → 泄漏代价不是"改一下"，而是**凭据作废 + 全链路中断**，所以必须**发送前**拦截。
  - 工具侧：gitleaks 的定位就是"检测 secret **before** they get committed/pushed"，说明"前置扫描"是成熟模式
    https://github.com/gitleaks/gitleaks
  - 同类项目的实践信号：`secret-redaction` 必须**覆盖日志**且要**可测**——IRLight 的
    "egress … secret redaction log check 会 false-negative" https://github.com/azumag/IRLight/issues/468
    与 "secret diagnostics 必须 fail-closed" https://github.com/azumag/IRLight/issues/481 ；
    另有项目把 "secret-redaction logging coverage" 当作独立交付项 https://github.com/saniche/tip-backen-api/issues/48
  - OWASP LLM Top 10（敏感信息泄漏类风险，输出侧同样要治理）https://owasp.org/www-project-top-10-for-large-language-model-applications/
- **可观测性是标配**：Copilot usage metrics https://docs.github.com/en/copilot/how-tos/administer-copilot/view-usage-and-adoption ·
  CodeRabbit dashboard https://docs.coderabbit.ai/guides/dashboard → 仍缺（§4 #5）。
- **差异化（仍成立）**：本地常驻（无云依赖/lock-in）+ **多厂商模型分工** + **PM 调研 + 独立筛选闭环** + 人类仅两处介入 + "事故→模板规则"的教训库。

## 6. 待调研问题

- §4 #1 的落地形态：把 `assertNoSecrets` 移进 `lib.mjs` 供 pipeline/PM/筛选共用，并补 `redactSecrets`（日志/反馈脱敏而非丢弃）是否就是最小闭环？
- 缺口 #2（热加载）：`mtime` 变更 → `exit(0)` 交 supervisor 重启（仅空闲时），还是每轮重新 `import()`？
- 缺口 #3（对账）：watch 每 tick 对"state≠merged 但 PR 已 MERGED"做重放对账，是否与 `retry` 入口重叠？
- `needs_human` 是否该**按原因分类**（know_thy_build 模式），让"引擎缺陷类"可自动重试一次、人类判断类永不自动重试？
- 缺口 #5 最小形态：`retries`/`round`/`fixes`/`lastError` 已落盘，聚合哪几个指标最能证明"独立模型审查"的价值？

## 已评估但不建议（累计）

- **全量并发改造（per-issue worktree for Agent A）**：方向正确但一个 PR 装不下。
- **只翻译文档（#8 方向）**：已被筛选器 REJECT，不再提。
- **Web 仪表盘**：不如零成本文本聚合。
- **metrics/stats（§4 #5）**：连续第六轮推迟——安全/正确性缺陷每次都影响运行，度量是增益。
- **只修 lessons.md 重复编号**：已被 #16 顺带修好。
- **把"合并误判"拆成 detached / 读回两半**：已被 #17 一并修好。
- **runImplementer 前预检写权限 / `gh pr create` 幂等化**：doctor 已覆盖同一检查（73dd846）；真实失败原因是身份权限而非查询缺失。
- **watch 热加载（§4 #2）**：证据仍是推断、无用户报告，重启语义改动风险高。
- **本轮考虑但未提**：
  - *收尾幂等对账（§4 #3）*：`retry` 已提供手工路径，自动对账属增益，且与"状态机自动化"耦合较深。
  - *PM/筛选 agent 自身用 bash 发正文的路径*：代码无法拦截模型自己的 `gh` 调用；靠提示词 + 本文 §4 #1 的收口，先修**代码可控**的出口。
- **本轮决定提**：把凭据防线扩到**全部代码可控出口** + 日志脱敏 + 修正自相矛盾的提示词示例（一次实测事故、9 处出站点里 7 处裸奔）。
