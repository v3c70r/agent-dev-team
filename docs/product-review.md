# Product Review — agent-dev-team

> PM Agent 的长期记忆文件（由 `.agent/pm/run.mjs` 每日/每周维护）。
> 新仓库首次运行时会据此建立基线；如你刚安装本技能，此文件会在 PM 第一次运行时被填充。

## 1. 产品是什么

`agent-dev-team` 是一个**可复用的多 agent 开发团队技能**：把 GitHub 仓库变成
"提 issue → /approve → 实现 → 独立模型审查 → 功能测试 → 自动合并" 的自治流水线。

## 2. 当前能力清单（初始基线）

| 能力 | 说明 |
|------|------|
| Triage | Actions 轮询 + `/approve`→标签 + `/reject`；`issue_comment` 即时触发 |
| Agent A 实现 | pi 非交互会话，建分支、实现、开 PR；支持多轮修复 |
| Agent B 审查 | 独立模型（默认 glm-5.3），PR 评论讨论，双语判定解析 + 英文哨兵强制 |
| Agent C 测试 | 分离 worktree + 真实构建/测试；失败自动回修（有限轮次） |
| 自动合并 | 测试通过后 squash 合并 + 删分支；受分支保护时降级为人工 |
| PM Agent | 竞品调研 → 提案 issue（每日≤1、周≤5，仅模型折扣时段运行） |
| 自愈 | tmux supervisor 崩溃重启；单 issue 异常不拖垮循环；轮询失败指数退避 |
| 自我提升 | opt-in：模板缺陷自动上报 `[skill-feedback]` issue（脱敏、限流） |
| 方法论 | 内置 TDD / 系统性调试 / 完成前验证 / 审查意见消化 等技能接线 |

## 3. 优势

1. 经过真实生产验证（20+ issue 全自动完成），不是 demo
2. 13 类真实事故已固化为模板规则与单测
3. 审查使用不同厂商模型 → 独立视角，能抓跨切面问题
4. 人类介入点最少（提需求 + /approve）
5. 成本可控：确定性环节零 LLM，PM 只在折扣时段跑

## 4. 劣势 / 待改进（初始假设，待 PM 用证据替换）

| 类别 | 问题 |
|------|------|
| 并发 | Agent A 占用主工作区，同一时刻只能处理一个 issue（需 per-issue worktree） |
| 平台 | 依赖常在线机器；笔记本休眠期间不处理 |
| 发现性 | 需手动安装；尚无 marketplace 分发 |
| 可观测 | 只有 tmux/日志，无 web 仪表盘 |
| 测试 | Agent C 依赖仓库自带测试；无测试的仓库只能 build 校验 |
| 单账号 | 无法提交正式 approve review（已降级为评论） |

## 5. 竞争格局（待 PM 首次调研补充证据）

同类/相邻方案（需引用具体来源）：Claude Code 插件与 skills 生态、OpenHands、
SWE-agent、Devin 类托管 agent、GitHub Copilot coding agent、CodeRabbit 类审查机器人。
差异化假设：**本地常驻 + 多厂商模型分工 + PM 调研闭环 + 人类仅两处介入**。

## 6. 待调研问题

- 同类方案如何处理"多 issue 并行"与工作区隔离？
- 是否有现成的 worktree-per-issue 编排可借鉴？
- 如何让"审查发现率"可量化（用于证明独立模型审查的价值）？
- 无测试仓库如何自动生成最小测试（Agent C 的兜底）？
