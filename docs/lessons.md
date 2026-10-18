# Lessons learned（真实事故 → 模板中的对应修复）

全部来自本模板在真实生产仓库上连续运行两周、自动完成 20+ 个 issue 的过程。
每一条都是**先出事故、再定位、再修复**，已内置到模板里。安装时无需重复踩坑。

---

## 1. `pi` 二进制被 npm 的 `node_modules/.bin` 顶掉

**现象**：`npm run agent:watch` 报 `Error: Unknown options: --session-id, --no-approve`。
手动 `pi -p ...` 却正常。

**根因**：`npm run` 会把 `node_modules/.bin` 插到 PATH 最前；仓库的某个依赖恰好也
提供了名为 `pi` 的可执行文件（旧版本），把真正的 pi 顶掉了。

**修复**（`pipeline.mjs` 的 `resolvePi()`）：显式解析 pi 路径，**跳过所有包含
`node_modules` 的目录**；支持 `PI_BIN` 覆盖。PM runner 同样处理。

**教训**：任何"在 npm script 里调用工具"的场景都要警惕 PATH 污染。

---

## 2. `pi -p` 只给 system prompt 会静默退出

**现象**：Agent A 启动后立刻"完成"，没有任何输出、没有 commit、没有报错。

**根因**：`pi -p --system-prompt ...` 缺少**位置参数（用户消息）**，pi 没有可执行的
任务就退出，退出码 0。

**修复**：调用时追加位置参数 `现在执行上面给出的完整任务…`。

**教训**：headless 调用 LLM CLI 必须同时给 system prompt + user message，并**校验
它真的产出了内容**（我们是靠日志里没有 commit 才发现的）。

---

## 3. PR 创建后立刻查询会拿到 null（搜索索引延迟）

**现象**：Agent A 开完 PR，流水线崩溃 `Cannot read properties of null (reading 'number')`。

**根因**：`gh pr list --search "#N"` 依赖搜索索引，刚创建的 PR 检索不到。

**修复**：改为**按 head 分支查询**（`gh pr list --head <branch>`），并加重试等待；
PR 仍不可见时保存 `pr: null` 并留待下一轮，不崩溃。

---

## 4. 单账号无法 approve 自己的 PR

**现象**：`gh pr review --approve` 报 `Can not approve your own pull request`，流程中断。

**根因**：GitHub 禁止自审通过。A/B 是同一账号时必然触发。

**修复**：`finishMerge` 捕获该错误，改为**发一条"批准记录"评论**，然后继续合并；
分支保护导致合并失败时标记 `needs_human` 并告知用户手动合并。

---

## 5. Agent C 的 worktree 与主工作区分支冲突

**现象**：测试阶段 `fatal: 'agent/5' is already used by worktree`。

**根因**：Agent A 在主工作区 checkout 了 agent 分支，测试再用
`git worktree add <path> agent/5` 就冲突了。

**修复**：测试用 **分离式 worktree**：`git worktree add --detach <path> origin/<branch>`，
并在 finally 里 `worktree remove --force` + `prune`。

---

## 6. 审查判定解析被语言坑死（最贵的一次）

**现象**：GLM-5.3 明明在 PR 里批准了，流水线却继续让 A 改，3 轮后放弃
`needs_human`，用户只能手动合并。

**根因**：解析器只认英文 `RESULT: APPROVE`；GLM 最后一轮写的是中文
「结论：代码可接受…**结果：批准**」→ 不匹配 → 默认判为 `REQUEST_CHANGES`。

**修复**：双重保险
1. 解析器支持**中英双语**（`批准/予以批准/通过/LGTM` vs `要求修改/需要更改/不予批准/不通过`），
   **取最后一次信号**，无信号才保守默认；
2. reviewer 提示词**强制**最后一行输出英文 ASCII 哨兵（并说明是机器解析用）。

**验证**：修复后同一模型继续用中文提要求（`heuristic` 命中）、复审用英文哨兵
（`sentinel` 命中），**两条路径都自动跑通并自动合并**。
另有 8 个单测样本回放（含这次的真实失败样本）。

**教训**：跨厂商模型做自动化判定时，**不要依赖单一语言/格式约定**；
提示词约束 + 解析器容错，两层都要有。

---

## 7. 状态对象的"首次运行缺 key"崩溃

**现象**：首次处理某 issue 时 `TypeError: Cannot set properties of undefined (setting 'status')`。

**根因**：函数开头 `state.load()` 拿到的是旧快照（该 issue 还没有 key），中间步骤
`state.save()` 写入了新 key，但外层仍用旧对象写 `s[issue].status`。

**修复**：**写入前重新 `state.load()`**，并对 key 做存在性初始化。

---

## 8. `--dry-run` 消耗了真实配额

**现象**：演练（dry-run）之后，当天的真实运行被跳过。

**根因**：dry-run 也写了 `state.lastRun`，被调度器视为"今天已运行"。

**修复**：dry-run 只写 `lastDryRun`，**不占用真实配额**；dry-run 也不受配额短路限制。

---

## 9. 运行时文件被 `git add -A` 扫进 PR

**现象**：Agent A 的提交里出现 `.agent/watch.log`、`__pycache__/*.pyc` 等垃圾文件。

**根因**：Agent A 用 `git add -A`；忽略规则不完整（`.agent/*.log` 不覆盖子目录）。

**修复**：安装时**必须先写全忽略规则**（`.agent/state.json`、`.agent/**/*.log`、
`.agent/logs/`、`.agent/tmp/`、`.agent/pm/*` 运行时文件）。模板提供
`templates/gitignore.snippet`。

---

## 10. 在共享工作区手动改文件 → 改动被覆盖

**现象**：我在 watcher 运行期间编辑 `pipeline.mjs`，随后发现改动消失。

**根因**：Agent A 的流程里有 `git checkout -B <branch> origin/master` 与
`git reset --hard origin/<branch>`；未提交的改动会被 sweep 或丢弃（有时还会被
`git add -A` 一并提交到 agent 分支）。

**修复**：把"**watcher 运行时不要改工作区**"写成硬性规则，并在
`processIssue` 的 finally 里**自动切回用户原分支**，减少遗留状态。

**教训**：自治 agent 与人类共用同一工作区时，必须约定排他时段。

---

## 11. watcher 会被单个 issue 的异常整死

**现象**：某个 issue 处理抛异常，整个常驻进程退出，之后再也不动。

**修复**（三层）：
- **单 issue try/catch**：标记 `needs_human` + 在 issue 里留言 + 继续循环；
- **轮询 try/catch**：gh/网络失败指数退避（30s→最多 5min），不退出；
- **supervisor 守护**：进程真退出时 10s 后自动重启；
- 心跳日志（带时间戳）用于判断"活着 vs 卡死"。

---

## 12. PM 提案质量的关键：让"宁缺毋滥"成为硬约束

**现象**：早期 PM 倾向凑数提案。

**修复**：
- 提示词明确"提 0 条也是好结果"、"每日深度优先只做一个主题"；
- **代码级硬限**（近 7 天/当日 `pm-proposal` 计数），不靠模型自觉；
- 让 PM 维护 `docs/product-review.md` 长期记忆，并记录"已评估但不建议"
  与"待调研问题"，避免跨天重复提案。

---

## 13. 调度必须落在模型折扣时段内

**实现**：PM 默认每日 17:00 UTC 运行，但**只在折扣窗口（如 16:30–00:30 UTC）
内真正执行**；窗口跨午夜的判断专门写了单元测试（9 个时间点全通过）。

**教训**：跨午夜的区间判断极易写错（`16.5–24.5` 这类表示法），务必单测。

---

## 14. 新仓库没有 `origin/HEAD`，默认分支探测在模块加载时崩溃

**现象**：刚用 `gh repo create --source=. --push` 建好的仓库，一启动 supervisor 就
`fatal: ref refs/remotes/origin/HEAD is not a symbolic ref`，进程 exit 1，
supervisor 每 10s 重启一次（死循环）。

**根因**：默认分支探测直接 `sh(['git','symbolic-ref','--short','refs/remotes/origin/HEAD'])`，
而 `sh()` 在命令失败时抛异常；且新克隆/新建仓库常常**没有** `origin/HEAD` 符号引用。
异常发生在**模块顶层**，所以连 `status` 子命令都跑不起来。

**修复**（`detectBase()`，多级降级且绝不抛异常）：
1. `AGENT_BASE` 环境变量
2. `git symbolic-ref refs/remotes/origin/HEAD`
3. 探测 `origin/main` / `origin/master` 是否存在
4. `git ls-remote --symref origin HEAD`（需要网络，放最后）
5. 兜底 `master`

**教训**：**模块顶层不要执行可能失败的外部命令**（尤其是 `sh()` 这种会抛异常的封装）；
自动探测必须提供多级降级与兜底值。这条是 dogfood 第一天就撞出来的。

---

## 15. 审查模型欠费/限流会让整个 issue 卡死

**现象**：Agent A 正常实现并开了 PR，审查阶段直接 `needs_human`，state.error 里是
`429 {"code":"1113","message":"余额不足或无可用资源包,请充值。"}`。
人工介入前，该 issue 完全无法推进。且 `pi auth check --provider <x>` 仍显示 `ready`
（它只验证凭证存在，**不检测余额/额度**）。

**根因**：`runPi()` 抛出的异常直接冒泡到"每-issue catch"，被当成不可恢复错误。

**修复**（模板内置）：
1. `isModelUnavailable()`：识别 `429 / insufficient / balance / quota / 余额不足 / rate limit / overload`；
2. 命中时**自动回退**到 `REVIEW_FALLBACK_PROVIDER/MODEL`（默认空 = pi 默认模型）完成本轮审查；
3. 在 PR 上留明确评论（哪个模型不可用、错误摘要、已回退到谁、长期方案）；
4. 调用 `reportGap()` 上报上游（opt-in），并在建议里点名 doctor 的预检缺口。

**教训**：外部依赖（模型额度）必须在**编排层**做降级，而不是让异常直通终态；
另外"凭证有效"≠"服务可用"，"检查通过"≠"服务可用"——健康检查要对齐真实失败模式
（doctor 的模型探针现在会对主模型 + 回退模型各做一次真实调用，失败重试一次再判定）。

---

## 16. 反馈机制自己坏了：调用了不存在的 helper（悬空引用）

**现象**：首次真正需要上报 skill 缺口时，日志只有一行
`[feedback] failed: ghJson is not defined` —— 反馈 issue 从未创建。

**根因**：`reportGap()` 里用了 `ghJson(...)`，但 `pipeline.mjs` 只定义了 `gh()`
（`ghJson` 当时只存在于 `pm/run.mjs`）。异常被 `reportGap` 的 try/catch 吞掉，
**静默失效**——最坏的一种失败。

**修复**：补上 `ghJson = (args) => JSON.parse(gh(args))`；并新增
`node .agent/pipeline.mjs feedback "<title>" [body]` 手动上报入口，
便于随时验证通道可用（而非等事故发生才发现它坏了）。

**教训**：
- 兜底/遥测代码必须**被测试过**，否则它只是"看起来有"；
- 静默 catch 会掩盖关键路径故障，至少要 `console.warn` 出可观测信号；
- 同一类问题在本项目出现过两次（本条与 Agent B 抓到的 `lib.mjs` 漏配）——
  **重构后要全局搜索悬空引用**（`grep -n "ghJson\|lib.mjs" 等`），这也正是
  独立模型审查的价值所在。

---

## 17. 测试器评论硬编码 "Playwright"，对外宣称与实际执行不一致

**现象**：Agent C 的通过评论固定写「build + Playwright」，但目标仓库的
`npm test` 实际是 `scripts/validate.mjs`（与 Playwright 无关）。任何非 Playwright
仓库都会收到一条误导性的"测试通过"评论。

**根因**：模板把作者当时的测试栈（Playwright）写死进了通用文案，忘了
Agent C 实际执行的只是 `npm run build` + `npm test`。

**修复**：`runTester()` 的通过评论改为通用表述「构建 + 测试套件通过」，
不再硬编码具体测试框架；若将来需要更精确，可从 `package.json` scripts 推导。

**教训**：**对外宣称必须与实际执行一致**。任何"模板默认值"都不能把作者当时的
环境细节当成所有仓库的真相，尤其是会被写入 PR 评论、供人类审计的文本。

---

## 18. 「审计记忆」写在别人的文件里 + 只靠自觉读取 = 形同没有

**现象**：筛选器把拒绝理由追加到 `docs/product-review.md`（PM 的长期记忆），
但该文件的 owner 是 PM，且 PM 被明确要求"保持 ≤180 行、删除过时内容"。
两个写入者 + 一个会被裁剪的文件 → 审计记录随时可能被删掉。
另外 SPLIT（需拆分）的**拆分方案只写在 issue 关闭评论里**，记忆里只有一句 WHY，
PM 下次既不知道"该怎么小范围重提"，也分不清"不许再提"与"应该小范围提"。

**根因**：
1. 记忆文件**所有权不清**（提案者与审计者共用一个文件）；
2. 关键信息（拆分方案）没有进入记忆；
3. 审计只靠提示词"请去读文件"传递，**没有注入上下文包** —— 属"自觉遵守"。

**修复**：
- 审计改为**筛选器独占的 append-only 文件** `docs/proposal-audit.md`，
  分 REJECT / SPLIT 两节（语义相反，必须分开），SPLIT **必须记录拆分方案**，
  每节自动裁剪到最近 40 条（有界增长）；
- PM 上下文包**强制注入**该文件内容 + 两条硬规则（REJECT 不得重提，除非引用新证据；
  SPLIT 必须按更小范围提）；
- 筛选器自身也把审计列为首要输入（同方向直接复用既往判定，避免重复劳动）。

**教训**：跨 agent 共享的"记忆"必须满足三条 —— **单一所有者、结构化（可机读）、被动注入**
（而不是期待对方主动去读）。把审计写进对方会重写的文件里，等于没写。

---

## 19. 修复轮把分支重置回 base，且状态计数器被覆盖

**现象**：Agent A 的**修复轮**（Agent B `REQUEST_CHANGES` 之后、Agent C 测试失败之后）
会把 agent 分支重置回 base，而不是基于 PR 现有分支继续提交。临时仓库实测：
`git checkout -B <branch> origin/<base>` 之后工作区回到 base，随后 `git push` 因
**非快进被拒**；`.agent/state.json` 中 #7 记 `round:0`，而 `.agent/logs/issue-7.md`
明确记录发生过一轮修复 —— 状态机根本无法记录修复轮次。

**根因**：
1. `runImplementer()` 每轮都无条件执行 `git fetch` + `git checkout -B <branch> origin/<base>`。
   `checkout -B` 对**已存在**的分支会静默强制重置到 base（不抛异常），因此唯一正确处理
   "修复轮"的 `catch`（`checkout <branch>` + `reset --hard origin/<branch>`）是**死代码**。
   结果：编排层把分支处理**外包给了实现模型**（只能靠 LLM 在会话里自己跟远端对账），
   多一次非确定步骤 + 额外 token，失败则落入 `needs_human`。
2. 同一函数的同一根因：审查循环刚写入 `round = r+1`，紧接着 `runImplementer()` 用
   `{ round:0, fixes:0 }` **整条覆盖**该条目；`fixes` 全仓没有任何递增点。

**修复**：
- 新增可测试的 `lib.prepareImplementerBranch({ branch, base, cwd })` —— `origin/<branch>`
  存在则 `checkout <branch>` + `reset --hard origin/<branch>`（**基于 PR 现有分支**），
  否则才从 `origin/<base>` 新开分支；`runImplementer()` 改调该 helper 并把
  `首轮/修复轮` 写进日志。
- 状态写入改为 `lib.mergeIssueState(prev, patch)`（**合并**，不覆盖），`round` 由审查轮维护、
  `fixes` 由测试修复轮递增（在调用 `runImplementer` **之前** `state.save`，否则被读到旧值）。
- `scripts/validate.mjs` 新增 check 13：在临时 bare origin + clone 中做真集成断言 ——
  首轮 `reused===false` 且 HEAD===`origin/<base>`；提交并推送后再调用 → `reused===true`、
  HEAD===`origin/<branch>`、且上一轮 commit 仍是 HEAD 的祖先（反向断言"未回到 base"）；
  另断言 `mergeIssueState` 保留 `round:1`。

**教训**：
- 自动化的"修复轮"**必须**基于 PR 现有分支；harness **绝不能**把 agent 放在 base 上提交
  （非快进 push = 静默搁置工作，最终以 `needs_human` 收场）。
- 任何"检查存在性再分支"的逻辑都要有**真仓库集成测试**：`try/catch` 兜底路径不会被
  "命令不抛异常"这一事实触发，成为永远不被执行的死代码。
- 状态机必须能**记录**它声称在度量的事（修复轮次）；整条覆盖写入等于把度量归零。

---

## 20. 「取消」必须移除触发标签：只加否定标签 ≠ 取消

**现象**：产品承诺 `/reject` 可以**取消**一次批准（README、SKILL、Actions 批准评论都这么写），
但实测否决**不生效**——尤其是**筛选器自动批准**之后（`screenAutoApprove` 默认开启，
这是目前最常见的"想反悔"场景）：

- Actions 的 reject 分支只 `ensureLabel('agent-rejected')`，**从不移除 `agent-approved`**；
- 本地 watcher 完全按标签取活：`gh issue list --label=agent-approved`，
  pending 过滤只看 `state.json` 的 `status`，**看不到 `agent-rejected` 这个否定信号**；
- `'rejected'` 这个终态在全仓**只被读、从未被写**（只在过滤数组里出现）。

⇒ 一个 issue 同时带 `agent-approved` + `agent-rejected` 时，仍会被实现、审查、测试并
**自动合并**。owner 目前唯一的止损手段是事后关 PR——而**合并是不可逆动作**。

**根因**：
1. 把"打一个否定标签"当成了"取消"，但**标签驱动的 worker 只认触发标签**——
   取消的语义就是**移除触发标签**；
2. 取活判定是内联的匿名 filter（`pipeline.mjs` 里写死的终态数组），无法被单测断言，
   因而"否定优先"这条规则从未被验证；
3. 状态机的 `rejected` 是**不可达终态**——没有任何代码路径写入它，
   状态机无法表达"已被否决"。

**修复**：
- Actions 让两个标签**互斥**：reject 分支 `removeLabels(['agent-approved'])`，
  approve 分支对称 `removeLabels(['agent-rejected'])`（用户改主意后可重新批准）；
  两处失败都 `core.warning`，不静默（404=标签本来不在，属正常）。
- 新增纯函数 `lib.selectPendingIssues(issues, state)`：先判 `agent-rejected` → **硬排除**，
  再看终态；watch 循环改调它，不再内联写死数组。`lib.isRejectedIssue()` 供
  `processIssue()` 开头复用：带否决标签 → 置 `status='rejected'` 终态、写日志、
  `return { skipped: 'rejected' }`（不留言、不重入）；`run --issue` 手动路径同样尊重否决
  （除非显式 `--force`）。
- `scripts/validate.mjs` check 14：纯函数断言（双标签 issue 必被排除、终态排除、
  全新 issue 回归）+ 两个 yml 的 reject/approve 分支文本断言。
- **合并前守卫**：只在取活/开头检查会被 in-flight 路径绕过（review+test 跑完照常
  `gh pr merge`）。`finishMerge()` 在真正 `gh pr merge` **之前**重新取 issue 标签，
  带 `agent-rejected` → 置 `rejected` 终态、留言、**不合并**；取不到标签（无法确认）
  → 失败关闭（`needs_human`），因为合并不可逆。check 14 另断言该检查位于
  `gh pr merge` 之前且返回 `{ skipped: 'rejected' }`。
- `/approve` 对**存量双标签**（旧行为遗留 `agent-approved`+`agent-rejected`）不再 no-op：
  条件加上 `labels.includes(REJECTED)`，重新走一遍批准流程。

**边界**：若实现**已经在跑**，`/reject` **不会中断**运行中的 pi 会话；
但下一轮轮询不会再接管，**且合并前守卫会阻止自动合并**（`finishMerge` 在 `gh pr merge`
前重新确认标签，取不到标签则失败关闭）。这一边界已写进 README/SKILL，否则只是把
"承诺-实现不一致"换个位置。

**教训**：
- 标签驱动的取活逻辑，**取消 = 移除触发标签**；否定标签只是补充信号，
  必须被取活判定当作**硬性排除**，否则会留下"已取消但仍在跑"的假象。
- 状态机的终态必须**可达**（有写入点），否则"有终态"只是文档幻觉；
  本次 `rejected` 就是只被读、从未被写的死状态。
- 内联条件（匿名 filter）不可测 → 把"该不该取活"抽成纯函数，才能对
  "否决优先"这类安全语义做自动断言。
- **合并不可逆**，所以任何"会不会被合并"的判定都必须由纯函数 + 测试守住。

---

## 21. 改了 workflow 内联脚本调用的 helper，却忘了它已被重命名 → **所有 triage 全部失败**

**现象**：给 triage 增加 `auto-approve` 标签支持后，新 issue **完全没有被打标签**——
既没有 `agent-seen`，也没有自动批准。查 Actions 日志：
```
ReferenceError: ensureLabel is not defined
    at eval (... <anonymous>:114:5)
```
**根因**：`ensureLabel()` 在早先的 PR（#15，`/reject` 取消批准）中被重命名为 `addLabel()`，
但我新写的分支仍调用 `ensureLabel`。异常发生在脚本顶层 → **每次 triage 运行都整体失败**，
于是所有 issue 都停在"无标签"状态（表现完全静默：没有评论、没有标签、没有错误提示给用户）。

**修复**：
1. 调用点改为 `addLabel`；
2. `scripts/validate.mjs` 新增两道自动检查，专治这一类：
   - **抽取 + 包装 + 语法检查**：把 `issue-agent.yml` 的 `script: |` 块按缩进抽出，
     用 `(async () => { … })();` 包装（与 `actions/github-script` 的执行环境一致，
     否则顶层 `return`/`await` 会被判为语法错误），再 `node --check`；
   - **未定义 helper 检测**：收集 `await <name>(` 调用与 `function`/`const` 定义做差集
     （先剥离注释与字符串字面量，否则字符串里的 "approval (" 会误报）。

**教训**：
- workflow 内联脚本是**没有类型检查与引用检查的盲区**，必须给它加语法/引用检查；
- 检查本身要**验证能抓出目标 bug**（我们注入 `ensureLabel` 回放验证过），否则它只是装饰。

---

## 22. 升级时只复制了一半（pipeline.mjs 而没复制 lib.mjs）→ watcher 崩溃重启循环

**现象**：把模板同步到消费者仓库后，watcher 每 10 秒崩溃重启：
```
SyntaxError: The requested module './lib.mjs' does not provide an export named 'isRejectedIssue'
```
**根因**：`pipeline.mjs` 与 `lib.mjs` 是**一对**文件，但升级时只复制了前者；
消费仓库里的 `lib.mjs` 还是旧版本（缺少 `isRejectedIssue`/`mergeIssueState`/
`prepareImplementerBranch`/`resolveTesterCommands`/`selectPendingIssues`）。
崩在**模块导入期**，所以连 `status` 子命令都跑不起来。

**修复**：
1. 同步 `lib.mjs`（一并推送）；
2. `scripts/doctor.mjs` 新增 **pipeline/lib 导出一致性**检查：解析 pipeline 的
   `import { … } from './lib.mjs'` 与本仓库 `lib.mjs` 的 `export`，比对缺失项并给出
   明确修复建议（"从 templates/ 同时复制两个文件"）。doctor 在**目标仓库目录**下运行，
   所以任何消费者仓库也能自查；
3. SKILL.md 的升级说明强调：**整组复制**，不要只挑单个文件。

**教训**：模块化拆分（把逻辑从 pipeline 挪进 lib）会**把"单文件升级"变成"多文件升级"**，
必须同时提供（a）版本一致性自检、（b）面向使用者的"整组升级"指引。

---

## 23. `gh auth switch` 是全局状态，与并发流水线天然竞争

**背景**：本机同时存在多个常驻会话（qc-gas/维护仓库两个 watcher、两个 PM+筛选、本机探针），
它们随时可能调用 `gh`（轮询 issue、发评论、关闭 issue、推送）。而 `gh auth switch` 会改写
**全局** `~/.config/gh/hosts.yml` —— 切换瞬间，另一个进程可能正好用错身份：
以只读身份去 push/关闭 issue（失败），或以开发者身份去"独立"审查（破坏职责分离）。

**修复/规范**：
- **禁止在多会话环境下使用 `gh auth switch`**；改用每次调用注入 `GH_TOKEN`：
  `GH_TOKEN=$(gh auth token --user <account>) gh …`（进程级、并发安全）
- 模板内置 `reviewerEnv()`：从 `.agent/config.json` 的 `reviewerGhUser`（或 env）取 token，
  仅注入给 Agent B 的 pi 会话与 approve review 调用；其余角色保持当前账号
- 批准后还会用该 token 查一次 `repos/{nwo}.permissions.push`，在合并评论里**如实说明**
  该批准是否计入 branch protection 的 required reviews（避免"以为有硬门禁其实没有"）

**教训**：CLI 工具的"**全局配置切换**"与"**多进程并发**"在架构上互斥。
凡是需要多身份的地方，一律走**每进程凭据**，不要走全局开关。

---

## 24. 合并结果必须以 PR 真实状态为准（命令报错 ≠ 合并失败）

**现象**（本仓库真实发生，issue #14 / PR #15）：自动合并**已经成功**，流水线却宣告
"❌ 自动合并失败（可能受分支保护限制）…请手动合并 PR #15"，把 issue 置为 `needs_human`
并留言让人去合并一个**已经合并**的 PR：

- `gh pr merge 15 --squash --delete-branch` 报
  `could not determine current branch: failed to run git: not on any branch`（17:23:34Z）；
- 但 `gh pr view 15 --json state,mergedAt` 显示 `mergedAt = 2026-10-11T17:23:32Z`
  —— **比那条报错日志早 2 秒**，合并早已成功；
- 远程分支 `agent/14` 至今仍在（`--delete-branch` 的远程删除也没做完）；
- `.agent/state.json` 里 #14 卡在 `needs_human`，而 issue #14 已是 CLOSED
  —— 状态机与现实永久背离：既不重试、也不收尾。

**根因**：
1. `finishMerge()` 把 `gh pr merge` 的**退出码**当成合并结果的事实来源。但
   `gh pr merge --delete-branch` 的语义是「**先合并，再删本地与远程分支**」
   （`--delete-branch` = "Delete the local and remote branch after merge"）；删本地分支需要
   「当前分支」，工作区 **detached HEAD** 时 gh 抛 `ErrNotOnAnyBranch` —— 于是
   **合并在前、报错在后**，"成功"被读成"失败"。这是已知坑（topij/agentic-dev-kit#196、
   aleskalfas/project-kit#878、cli/cli#2833）。
2. 工作区之所以 detached：`processIssue()` 的 finally 只在 `startBranch !== 'HEAD'` 时恢复分支，
   一旦 detached 就再也回不去 —— detached 变成**永久状态**。
3. 违反通用原则：不可逆动作必须以「读回的**真实状态**」判定结果，而不是退出码
   （"Exit 0 Is Not Success: verify outcomes"）。

**修复**：
- `templates/lib.mjs` 新增纯函数 `classifyMergeAttempt({ error, pr })` →
  `merged`（`pr.state==='MERGED'` 或 `pr.mergedAt`，**退出码非零也算**）/
  `blocked`（读回确认 `OPEN`/`CLOSED`，确实未合并）/
  `unknown`（读不到状态 → fail-closed）。
- `templates/pipeline.mjs` `finishMerge()`：合并**前**若本地是 detached
  （`git rev-parse --abbrev-ref HEAD` === `HEAD`）先 best-effort `git checkout <BASE>`
  （失败仅 warn），让 `--delete-branch` 的本地收尾有分支可用；保留原合并命令，但
  **无论成败都读回** `gh pr view <n> --json state,mergedAt,headRefName`（读回失败 → `pr=null`），
  再用 `classifyMergeAttempt` 分流：`merged` → 记 `merged`、评论"🎉 已合并"（若命令报错则
  附加说明"以真实状态为准"）+ 尽力 `gh api DELETE …/git/refs/heads/<branch>` 清理残留远程分支
  （失败只 warn）；`blocked` → `needs_human` + 评论含错误原文并**明确"读回确认未合并"**；
  `unknown` → `needs_human` + 评论"无法确认合并结果，已按未合并处理，请人工确认"。
  不再出现「命令报错 ⇒ 直接判合并失败」。
- `scripts/validate.mjs` check 15：纯函数断言（**含核心回归：真实错误串 + `state=MERGED` → `merged`**、
  `pr=null`→`unknown`、`OPEN`→`blocked`、`{}`→`unknown`）+ `finishMerge()` 顺序断言
  （`gh pr view` 读回与 `classifyMergeAttempt(` 必须在写 `needs_human` 的代码**之前**）
  + detached 兜底与远程分支清理文本断言 + lessons 编号唯一性。

**教训**：
- **不可逆动作只认读回的真实状态**，退出码只是"命令有没有正常返回"，不是"世界变成了什么样"。
  先做不可逆动作、再读回、再据此决定状态机走向；读不到状态一律 **fail-closed**。
- 一个命令可能**部分成功**（合并成功、清理失败）：不要用它的退出码去否定它已经做成的部分，
  也不要把"收尾失败"升级成"主操作失败"。
- 会让工作区变 detached 的路径必须**可恢复**：`finally` 只在非 detached 时恢复分支，
  等于把一次性异常固化成永久状态。
- 状态机的终态必须与现实一致：`needs_human` 只在**确实没合并/无法确认**时出现，
  否则 issue 会永久卡在非终态、既不重试也不收尾。

---

## 25. Agent 绝不能修改「全局」认证状态（一个真实事故）

**事故（2026-10-16，本机实测）**：qc-gas 流水线的 Agent B 在发 PR 评论时遇到 `401`
（该账号的 gh OAuth 令牌**静默失效**），它为了"把评论发出去"，**自行运行了 `gh auth switch`
切到另一个账号**。后果：

- `~/.config/gh/hosts.yml` 是**全机器共享**的 → 所有其它会话（我、PM、筛选、另一个仓库的
  流水线）的 `gh` 调用立刻变成"只读身份"，写操作全部 `403`；
- 流水线无法合并 PR（写权限没了），需要人工恢复；
- 上游已有的评论又被 shell 反引号**二次损坏**（lessons #6 复现），且因令牌失效无法删除。

**两条独立缺陷叠加**：

1. **权限检查只看 scope，不看有效权限**：那个账号 `Token scopes: repo, workflow` 完全正常，
   但对目标仓库只有 `pull`（只读）。`gh auth status` 的 scope 行**看不出来**。
   → 预检必须查**实际写权限**（`gh api repos/{nwo} --jq .permissions.push`）。
2. **令牌静默失效**：`gho_` OAuth 令牌可能过期/被吊销，症状与"无权限"都是 401/403。
   → 长周期自动化（crontab 唤醒者、外部调度器）**不要**依赖 `gh auth token`；改用
   **长效 fine-grained PAT**（最小 scope：`Contents: write`），放 `600` 权限的本地文件，
   并在预检里**显式校验**（失效要吵，不能静默）。

**规则（已写进提示词并由 validate 守卫）**：

- Agent **禁止**执行 `gh auth switch` / `gh auth login` / `gh auth logout` / `gh auth refresh`
  或任何改写全局 gh 配置的命令；需要多身份就用**每进程 `GH_TOKEN`**（lessons #20）。
- 遇到 `401/403`：**如实报告并停止该步**，绝不换身份继续、不把权限错误当成完成。
- 所有 GitHub 正文走 `--body-file`（或单引号），禁止在双引号里放反引号/`$(...)`。

**附带发现（同一事故）**：本仓库的 `origin` 当时是 **HTTPS**，于是 `git push` 走 gh 凭据助手
→ 认证状态一坏，**连推送都 403**（qc-gas 用的是 SSH，所以它的探针全程不受影响）。
→ 规则：**推送必须走 SSH**（`git@github.com:owner/repo.git`），不要依赖 gh 令牌；
否则 OAuth 令牌一过期/一切换，整个循环连代码都推不上去。装技能时 doctor 应检查 remote 协议。

**教训**：把"完成任务"的激励和一个**全局副作用**的命令放在一起，agent 几乎必然按错。
凡是"全局状态变更"（认证、git config、系统 crontab）都必须视为**越权**，从工具层禁用。

---

## 26. 终态必须可撤销：没有恢复入口的 `needs_human` = issue 永久卡住

**现象**（本仓库真实案例）：

1. issue #14：合并**已经成功**（`mergedAt=2026-10-11T17:23:32Z`），`state.json` 却永久停在
   `needs_human`。没有任何命令能"重放对账"，`agent/14` 远程分支至今残留。
2. 上游 issue #18 至今 **OPEN**：下游仓库 qc-gas 的 `gh pr create` 报 `must be a collaborator`
   → 异常 → `needs_human`。分支已推、PR 没建、issue 卡死；恢复只能手改 **gitignored** 的
   `.agent/state.json`（重启容器/换机器就没了）。
3. `needs_human` 有 5 处写入点（审查轮耗尽、合并前无法确认 `/reject`、合并 blocked/unknown、
   未预期异常），`failed` 有 1 处（测试修复轮耗尽）—— **每一类失败都通往这个死胡同**。
4. 全仓 grep 无任何"重试/恢复"说明（`README.md`、`SKILL.md`、`docs/architecture.md`
   只写"请人工处理"）。唯一逃生口是**未文档化**的 `run --issue N --force`，而 `--force`
   同时绕过 `/reject` 检查（`if (isRejectedIssue(issue) && !force)`）—— 人类为了救一个卡住的
   issue，可能顺手复活一个已被否决的 issue（合并虽仍被 `finishMerge` 的活标签复查挡住，
   但 A/B/C 的钱和时间已经烧掉）。

同类项目独立踩过四例：

- ForgeDock #3571（已修复）：`needs-human` 终态后 `--retry` 拒绝重开，运维只能手改
  `FORGE:STATE`；修法 =「人类清掉标签即 hand-back 信号，可重开，但**仍带标签的运行永不重开**」。
  https://github.com/RapierCraftStudios/ForgeDock/issues/3571
- know_thy_build #156：按**原因**分类 —— 引擎缺陷类允许"新版本后自动重试一次"，
  人类判断类（审查轮耗尽/需人工合并/超预算）永不自动重试。
  https://github.com/LeeHyeonKyu/know_thy_build/issues/156
- viberpit #1540：`gave_up` 行无 un-park 入口 → 要求"人类手工编辑即 hand-back 信号"
  或 "retry now" 动作。 https://github.com/steiner385/viberpit/issues/1540
- 反面样本：ojones/ai-factory 的 `Stuck run [needs_human]` issue 一直堆着（没人清理，
  因为清理本身没有入口）。 https://github.com/ojones/ai-factory/issues/121

**根因**：

1. **状态机把"失败"当成了"结束"**：`needs_human` / `failed` 被 `selectPendingIssues()`
   列入终态硬跳过（这是对的 —— 自动重试会烧钱），但**没有提供任何显式的人工逆向转移**。
   终态一旦不可撤销，就等于把"人类修好根因后继续"这条路封死。
2. **唯一逃生口恰好是最危险的那个**：`--force` 把"重试"和"绕过否决"绑在一起，
   激励结构逼着人类用越权手段办正事（同 lessons #25 的"全局状态变更"模式）。
3. **状态在 gitignored 的本地文件里**：手改 `state.json` 不可审计、不可复现、
   换机器就丢 —— 而"可审计"正是整套 loop 的核心价值。

**修复**：

- `templates/lib.mjs` 新增纯函数 `retryReset(prev)` → `{ ok:true, next }` | `{ ok:false, reason }`：
  只允许 `needs_human` / `failed`；`next` 保留 `pr`/`branch`/`round`/`fixes`，
  `status` = `prev.pr ? 'pr_open' : 'new'`（无 PR 则从头实现），`retries+1`、
  `retriedAt`（ISO）、`previousStatus` 留痕，旧 `error` 移入 `lastError` 后清空。
  `merged`（不可逆）/ `rejected`（否决优先）/ `blocked`（等依赖，不是失败）/ `pr_open`
  （无需重试）/ 无记录 → 拒绝且不返回 `next`。
  另有 `formatRetryList(state)`（纯函数）列出"哪些卡住了"。
- `templates/pipeline.mjs` 新增 `retry` 子命令：
  `retry --issue N`（也接受裸 `N`）与 `retry --list`。判定顺序是刻意的 ——
  **纯状态判定 → 读 issue 标签确认 `/reject` → 才写状态**：带 `agent-rejected` 直接
  exit 2；读不到标签也 fail-closed（同 lessons #24 的合并读回原则）。拒绝时不写状态、
  不改动 `state.json`（字节级）。成功则写 `state.json`、append `.agent/logs/issue-N.md`、
  best-effort 在 issue 上评论"已由人工请求重试，将从 <阶段> 继续"并打印下一步。
  另外把实现入口从 `cur.status === 'pr_open'` 扩到也接受 `'new'` —— 否则"无 PR 的重试"
  会永久卡在 `waiting_pr`（复位了却没人接）。
- `package.json`：`"agent:retry": "node .agent/pipeline.mjs retry"`。
- `scripts/validate.mjs` check 16：`retryReset` 全分支断言（含"纯函数不修改入参"、
  "拒绝时不返回 next"）、`formatRetryList` 断言、`pipeline` 文本断言
  （retry 分支走纯函数、`isRejectedIssue` 在 `state.save` 之前、拒绝即 exit 2、
  **代码里不得出现 `force`**）、以及在 `mkdtemp` 里跑**真实** `pipeline.mjs` 的
  CLI 端到端测试（配假 `gh`，离线、无副作用）：merged → exit 2 且 state 字节不变、
  带 `agent-rejected` → exit 2 不写状态、needs_human(有 PR) → `pr_open` 且保留
  `pr`/`branch`/`round`/`fixes` + `error→lastError` + 写日志、failed(无 PR) → `new`、
  `--list` 只列 `needs_human`/`failed`。
- 文档：`docs/architecture.md`（恢复转移图）、`SKILL.md` / `README.md` 命令表。

**教训**：

- **终态必须可撤销**：任何"卡住"状态都要配一个**显式、可审计、幂等**的逆向转移。
  自动重试可以不做（会烧钱），但**人工重试入口必须有**，否则人类只能手改状态文件。
- 恢复入口**绝不能顺带打开另一个口子**：重试 ≠ 撤销否决。把"重试"和"绕过 `/reject`"
  绑在同一个 `--force` 上，等于用激励结构逼人越权。判定顺序要写死：
  **先否决、后复位**。
- **不可见的失败等于没修**：只给"重试"不够，还要能回答"现在到底哪些卡住了"
  （`retry --list`），否则 stuck 状态会像反面样本那样静默堆积。
- 每次恢复都要留痕（计数 + 日志 + 评论），恢复动作本身就是度量数据。

---

## 27. 测试 dogfood 了「宿主检查」→ 容器里 `npm test` 永远红，每个 PR 都被卡死

**现象**（2026-10-17，issue #19 / PR #20 的真实卡点）：Agent C 在测试容器里跑 `npm test`，
报 `1 FAILURE(S)`，唯一失败是：

```
✗ doctor not green:
✗     tmux          tmux 不存在
```

而本 PR **完全没碰** `doctor.mjs`，功能测试的全部 55+ 条断言都是 ✓ —— 也就是说：
**健康的功能改动因为容器里没装 tmux 被判失败**，issue 被置回 `needs_human`，
并且（讽刺地）只能用本 PR 新加的 `agent:retry` 才能恢复。

**根因**：

1. `scripts/validate.mjs` 的 check 8「doctor dogfood」要求 `node scripts/doctor.mjs` **全绿**，
   而 `doctor` 混了两类检查：
   - **仓库类**（`.gitignore`、`build/test` scripts、`config.json`、`pipeline/lib` 一致…）——
     反映代码健康，`npm test` 应该管；
   - **宿主类**（`tmux`、`gh auth`/`gh repo`、`pi`、模型探针、`reviewer 账号`、`labels`…）——
     反映**这台机器**，在 CI/测试容器里天然缺（无 tmux、无网络、无 gh 登录）。
2. 两类混在一个"全绿才通过"的口径里 → **测试结果依赖于跑测试的机器**。
   机器一换（容器、CI、同事笔记本）结论就变，这类测试是不可复现的。
3. 更糟的激励：为了让 `npm test` 变绿，人们会给容器装 tmux / 造 gh 登录 ——
   把一个业务仓库的测试套件绑死在宿主配置上。

**修复**：

- `scripts/doctor.mjs` 支持 `--skip <name[,name]>`：跳过点名的检查项（只用于宿主类）。
  拼错/空值必须**喷出来**（产生 `name: '--skip', status: 'fail'` 的检查项并 exit 非 0），
  否则漏检会被静默当成"全绿"—— 那比不做更危险。
- `scripts/validate.mjs`：check 8/11/12 调 doctor 时统一带
  `--skip tmux,gh auth,gh repo,pi,模型可用性,reviewer 账号,labels`，
  并在 ✓ 行里**写明**跳过了哪些项（不假装检查过）；另加 check 11b 断言 `--skip` 机制本身
  （跳过生效、未知项报错、仓库类检查不被连带跳过）。
- 真实安装的 preflight **不得**用 `--skip`：`SKILL.md` 第一步依旧要求 doctor 全绿，
  因为那正是"这台机器能不能跑这套 loop"的判定。

**教训**：

- **测试必须可复现**：断言要能被任意干净容器重放。凡是"结果取决于跑测试那台机器"的检查，
  要么移出测试套件，要么显式声明并按类跳过 —— 否则它会变成随机失败源，并训练人去
  "修环境"而不是"修代码"。
- **跳过必须可见、必须无副作用**：`--skip` 只减项、不改变其余判定，并且在输出与测试日志里
  列出名字；拼错即报错。**静默跳过 = 假绿**。
- 环境和代码要分层：`doctor` 面向"装/跑"（全绿口径），`validate` 面向"仓库是否健康"
  （只看仓库类）。同一个脚本同时服务两者时，**必须提供按类裁剪的入口**。

---

## 28. 凭据防线只覆盖了它被写在的地方（→ 改成结构性保证 + 日志脱敏）

**现象**（2026-10-16 事故，提交 `c36aca5`，issue #21 复盘）：一条 PR 评论的正文里
写着 `$(gh auth token --user <owner>)`，被 shell 展开成**真 OAuth 令牌**并贴进 PR 评论；
GitHub secret scanning **自动吊销**该令牌 → 之后每个 `gh` 调用 401，整条流水线卡死。
代价不是"改一下"而是**凭据作废**：已推送的令牌无法收回，只能吊销。

事后加了硬拦截 `assertNoSecrets()`，但只挂在 **3 个调用点**（`commentOnIssue`、
`commentOnPr`、`pr create --body`）。同一份代码里还有 **7 类出站/落盘路径裸奔**（grep 实测）：

| 位置 | 风险 |
|---|---|
| `reportGap()`（上游 feedback，2 处 `issue create`） | **跨仓库公开泄漏**：`err.stack` / 错误原文经 opt-in 发到第三方仓库 `cfg.upstream`；远端 URL 内嵌凭据的 push 报错就会整条发出去 |
| `gh pr review --approve --body`（2 处） | 同类出站点，正文当时是静态串，但新增字段即失守 |
| `pm/screen.mjs` 筛选判定评论 | 正文含**模型生成**的 WHY / SCOPE / TESTABILITY / REFINED_TASK |
| `pm/screen.mjs` `issue edit --body` | 把原正文 + 模型生成内容拼回去**整体覆盖**已发布 issue |
| `pm/screen.mjs` REJECT/SPLIT 评论 | 同上，含模型生成内容 |
| `log()` → `.agent/logs/issue-N.md` | 日志**原样落盘** pi/模型输出与异常栈；人类排障时会把日志贴进 issue（lessons #25 的评论损坏事故正是"内容贴来贴去"） |
| PM 的 `screen-*.md` | 同日志路径 |

**为什么"只加在 3 个地方"必然漏**：防线写在调用点，就要求每个新增出站点的人都
"记得加"。这类保证会随代码增长而衰减，且衰减是静默的（没有测试会变红）。

**修复（结构性 + 可测 + fail-closed）**：

1. **实现只留一份**：`SECRET_PATTERNS` / `assertNoSecrets` / 新增 `redactSecrets` /
   `countSecretMatches` 全部移入 `templates/lib.mjs`（无副作用；`pipeline.mjs` 与
   `pm/screen.mjs` 都已 import lib）。`pipeline.mjs` 保留 `export { assertNoSecrets,
   SECRET_PATTERNS }` 兼容既有引用。
2. **规则二分**（两个 helper，不是一个）：
   - **硬拦截**（`assertNoSecrets` throw）= agent **自己撰写**的正文：pipeline 评论、
     PR 正文、`pr review` 正文。宁可不发一条评论，也不泄漏。
   - **脱敏后发送**（`redactSecrets`）= **必须留下审计记录**的通道：上游 feedback、
     筛选判定评论、`issue edit --body`、本地日志。凭据必须去掉，但判定本身
     **绝不能因检测到凭据而丢失**，否则审计断链。脱敏命中时留痕
     （"已自动脱敏 N 处疑似凭据" / `[_已脱敏 N 处_]`），人类能看出这里被处理过。
3. **`log()` 单点收口**：一个函数覆盖 pi 输出、review 输出、retry 日志、循环异常栈 →
   一次改动覆盖所有日志路径，不需要在每个 `log()` 调用点重复。
4. **lint 变成断言**：`scripts/validate.mjs` 7e 要求 `templates/pipeline.mjs` 与
   `templates/pm/screen.mjs` 里**每个** `'--body'` 所在行同时出现 `assertNoSecrets(` 或
   `redactSecrets(`；`templates/prompts/*.md`、`templates/pm/*.md` 中不得出现 `--body "`。
   新增出站点不包裹 → `npm test` 红（已实测：去掉一处包裹即 2 FAILURE）。
5. **修掉自相矛盾的提示词**：`templates/prompts/reviewer.md` 一边禁止双引号正文，
   一边示范 `gh pr comment <PR#> --body "…"`；`pm/prompt.md` 同样用
   `--body "$(cat <<'EOF' …)"`。全部改成 `--body-file`（正文先写文件），并补一句
   "正文需引用命令输出时先写文件；出现 `$(`/反引号/令牌形状一律不直接发送"。
   旧的 7b 检查只 grep "文件里存在 `--body-file` 字样"，所以矛盾示范能长期存活 ——
   断言必须**同时禁止坏写法**，否则它只证明"好写法出现过"。

**外部共识（同类实践）**：

- GitHub push protection / secret scanning 会在**已推送**后吊销凭据 → 必须**发送前**拦截。
  https://docs.github.com/en/code-security/secret-scanning/introduction/about-push-protection
- gitleaks 的定位即 "detect secrets **before** they get committed/pushed" —— 前置扫描是成熟模式。
  https://github.com/gitleaks/gitleaks
- 脱敏必须**覆盖日志**并且**可测 / fail-closed**（IRLight #468 脱敏日志检查 false-negative、
  #481 secret diagnostics 必须 fail-closed）。
  https://github.com/azumag/IRLight/issues/468 · https://github.com/azumag/IRLight/issues/481
- https://owasp.org/www-project-top-10-for-large-language-model-applications/（敏感信息泄漏，输出侧同样要治理）

**教训**：

- **安全防线要写成"结构性保证"，不是"记得加"**：共享 helper + 静态 lint 断言，
  让遗漏变成红测试，而不是变成事故。
- **拦截与脱敏是两个不同承诺**，混用会两头坏：全拦 → 审计记录丢失；
  全脱敏 → agent 自己写的正文里带着凭据继续流动。按"这条通道能不能丢"二分。
- **日志是出站点**。最容易被人类触碰的路径（把日志贴进 issue）必须默认脱敏。
- **示例即文档**：提示词里的示范会被模型照抄。禁令与示范矛盾时，模型学的是示范。
- **可测性就是可信度**：`redactSecrets` 做纯函数（幂等、只留 4 位前缀、正常文本零误报），
  `reportGap` / `log()` 用假 `gh` + 临时仓库跑真实 pipeline 断言 —— 不靠"看起来对了"。

**已知边界（本 PR 不做）**：不拦截模型自己在 bash 里跑出的 `gh` 调用（代码不可控，
只能靠提示词）；不引入第三方扫描器。
