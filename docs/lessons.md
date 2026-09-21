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
