---
name: agent-dev-team
description: Bootstrap and operate a multi-agent development team (implementer / reviewer / tester / product-manager) orchestrated through GitHub issues and PRs with a human /approve gate. Agents run unattended via tmux supervisors: approved issues are implemented, reviewed by an independent model, functionally tested, and auto-merged. Use when the user wants autonomous, self-reviewing, self-testing feature development on a GitHub repository, or mentions agent-dev-team / multi-agent loop / 自动开发团队.
---

# agent-dev-team — GitHub 多 agent 开发团队

本技能把一个 GitHub 仓库变成**自治开发团队**：

```
GitHub issue ──/approve──▶ Agent A 实现 ──▶ PR ──▶ Agent B 审查(独立模型)
                          ▲                        │  ▲
                          └────── 修改轮(≤N) ◀──────┘  ▼
                                            Agent C 构建+功能测试 ──▶ 自动合并+部署
PM Agent（可选，定时折扣时段）──▶ 竞品调研 ──▶ 提案 issue（每日≤1，等 /approve）
```

人类只做两件事：**提需求** 和 **/approve**。

模板来自两周真实生产运行（20+ 个 issue 全自动实现/审查/测试/合并），
全部坑都已修好（见 `docs/lessons.md`，安装时会自动规避）。

---

## 第一步：Preflight（开始前必须逐项确认）

先运行 `npm run doctor`，按输出逐项修复，**全绿（0 退出）再继续**。
若目标仓库尚未安装该脚本，可在目标仓库目录下运行
`node <agent-dev-team 技能目录>/scripts/doctor.mjs`（它会自检当前目录所在仓库）。

同时确认（决定 Agent C 如何工作）：
- 仓库的构建/测试命令（doctor 会检查 `package.json` scripts 的 `build` / `test`）
- 若测试需要密钥（如地图 token）：存在哪个 env 文件？测试用 `TEST_ENV_FILE` 注入
- 若仓库没有任何测试：警告用户"Agent C 将只跑 build"，建议先补测试

**任何一个 preflight 失败都不要继续安装**，向用户报告缺什么。

## 第二步：询问用户配置（用 ask_user_question 或逐条确认）

1. **Agent B 审查模型**：建议与实现模型**不同厂商**（独立视角、降低自我确认偏差）。
   例如实现=deepseek-v4-pro，审查=glm-5.3（更便宜的档位：`glm-5.3-flash`）。
   注意 `pi auth check` **不检测余额**；`npm run doctor` 已内置模型可用性探针（对审查模型做 1-token 真实调用），或启用 `reviewFallback` 兜底。
2. **PM Agent**：是否安装？若安装：每日运行时刻（UTC，建议落在所用模型的折扣时段，如
   DeepSeek 为 16:30–00:30 UTC）；每日/每周提案上限（默认 1/天、5/周）。
   PM 需要联网调研：是否安装 brave-search 技能（需 `BRAVE_API_KEY`）？
3. **自我提升反馈（opt-in）**：明确询问——
   > 是否开启 skill 自我提升反馈？使用中若流水线遇到模板本身的缺陷，
   > 会自动向 github.com/v3c70r/agent-dev-team 发 `[skill-feedback]` issue
   > （仅含错误描述与堆栈，**不含你的代码**；每日最多 3 条；随时可关）。
   记录用户选择，写入 `.agent/config.json`。
4. **触发通知的账号**：`/approve` 提醒要 @ 谁（默认仓库 owner）。

## 第三步：安装模板

模板在本技能目录的 `templates/` 下。复制并参数化：

| 目标 | 来源 | 参数化 |
|---|---|---|
| `.github/workflows/issue-agent.yml` | `templates/issue-agent.yml` | `{{GITHUB_OWNER}}` → 通知账号 |
| `.agent/pipeline.mjs` | `templates/pipeline.mjs` | 无需改（env 可覆盖） |
| `.agent/lib.mjs` | `templates/lib.mjs` | 无需改 |
| `.agent/prompts/implementer.md` | `templates/prompts/implementer.md` | 无需改 |
| `.agent/prompts/reviewer.md` | `templates/prompts/reviewer.md` | 无需改 |
| `.agent/supervisor.sh` | `templates/supervisor.sh` | 无需改 |
| `.agent/config.json` | `templates/config.json` | 填 upstream + feedbackOptIn + 模型 |
| `.agent/pm/`（可选） | `templates/pm/` | 无需改（env 可覆盖） |
| `.agents/skills/brave-search/`（可选） | `templates/brave-search/` | 无需改（运行时读 BRAVE_API_KEY） |

**npm scripts**（若缺失则添加）：
```json
"agent:watch": "node .agent/pipeline.mjs watch",
"agent:status": "node .agent/pipeline.mjs status"
```

**gitignore（必须在首次运行前加，否则运行时文件会被 Agent A 的 `git add -A` 扫进 PR）**：
```
.agent/state.json
.agent/logs/
.agent/tmp/
.agent/**/*.log
.agent/pm/state.json
.agent/pm/logs/
.agent/pm/context.md
.agent/pm/wt/
```
（完整片段见 `templates/gitignore.snippet`）

**提交并推送**这些文件（这会让 GitHub Actions triage 生效）。

## 第四步：启动常驻服务（tmux）

```bash
tmux new -d -s agent -c <repo>   # 实现流水线
tmux send-keys -t agent './.agent/supervisor.sh' Enter

# PM（可选）
tmux new -d -s pm -c <repo>
tmux send-keys -t pm './.agent/pm/supervisor.sh' Enter
```

supervisor 会在进程崩溃后 10s 自动重启；watcher 每 30s 轮询
`agent-approved` 标签的 issue。`TEST_ENV_FILE` 由 supervisor 从仓库 `.env` 自动注入。

## 第五步：验证

```bash
node .agent/pipeline.mjs status          # 状态机为空 = 正常
node .agent/pm/run.mjs --check           # （若装了 PM）调度/窗口/名额
# 手动触发一次 triage（否则要等定时）：
gh workflow run issue-agent.yml
```
然后建一个**小而真实**的测试 issue → 在 issue 里回复 `/approve` →
确认 Actions 打上 `agent-approved` 标签且 watcher 在 30s 内开始处理。

## 运行手册（告诉用户）

| 操作 | 命令 |
|---|---|
| 提需求 | GitHub 建 issue（写清：背景/验收标准/建议范围） |
| 批准 | issue 下回复 `/approve`（否决 `/reject`） |
| 看流水线 | `tmux attach -t agent`（Ctrl-b d 脱离） |
| 状态机 | `npm run agent:status` |
| 单独复审 | `node .agent/pipeline.mjs review --pr <N> --issue <M>` |
| PM 状态/演练 | `node .agent/pm/run.mjs --check` / `--dry-run --force` |
| 停止 | `tmux kill-session -t agent`（PM: `-t pm`） |

## 必须遵守的坑位规则（全部来自真实事故，见 docs/lessons.md）

1. **watcher 运行时绝不在该仓库工作区手动改文件** —— Agent A 会 `git add -A` +
   `reset --hard`。要改代码：先 `tmux kill-session -t agent`，改完提交，再启动。
2. pi 二进制解析已内置防 PATH 污染逻辑（npm 会把 node_modules/.bin 插到最前）。
3. PR 查询按 head 分支（搜索索引有延迟）；单账号不能 self-approve，已有评论降级。
4. Agent C 用**分离式 worktree**（agent 分支正被主工作区占用）。
5. 审查判定解析已支持中英双语（`RESULT: APPROVE` / 批准 / LGTM / 要求修改…），
   reviewer 提示词强制英文哨兵。
6. `--dry-run` 不消耗配额；每个 issue 处理完自动切回原分支。

## 自我提升协议（skill 的维护回路）

- 安装时询问 opt-in（第二步.3），写入 `.agent/config.json`。
- 运行中流水线遇到**未预期异常** → 自动向 upstream 发 `[skill-feedback]` issue
  （脱敏：仅错误与堆栈；每日≤3 条；无标签权限时自动去掉 label 重试）。
- 你（执行本技能的 agent）在使用中发现模板能力缺口（如"该仓库用 pytest 而模板
  假设 npm"）且用户已 opt-in → 主动提出并代发 `[skill-feedback]` issue；
  未 opt-in 则只在本地说明，不强推。
- upstream 仓库 `v3c70r/agent-dev-team` 自身用同一套 loop 维护（dogfood）。

## 卸载 / 暂停

```bash
tmux kill-session -t agent; tmux kill-session -t pm   # 停服务
git rm -r .agent .github/workflows/issue-agent.yml    # 移除（可选）
# GitHub 端：Actions 页面手动 disable issue-agent workflow
```
