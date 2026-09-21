# agent-dev-team

> 把一个 GitHub 仓库变成**自治开发团队**：提 issue → `/approve` → 实现 → 独立模型审查 → 功能测试 → 自动合并。
> 你只做两件事：**提需求**、**点批准**。

```
┌─ GitHub Actions（定时 + 评论事件）──────────────────────────┐
│ 发现新 issue → @ 你询问；/approve → 打标签；/reject → 关闭   │
└───────────────────────────┬────────────────────────────────┘
                            ▼
┌─ 本机常驻（tmux supervisor，崩溃自愈）──────────────────────┐
│ Agent A 实现 ──▶ PR ──▶ Agent B 审查（独立模型）⇄ 修改 ≤N 轮 │
│                              └──▶ Agent C 构建+功能测试      │
│                                        └──▶ 自动合并/部署    │
│ PM Agent（可选，每日折扣时段）：竞品调研 → 提案 issue        │
└────────────────────────────────────────────────────────────┘
```

## 为什么值得用

- **不是玩具**：模板来自两周真实生产运行，自动完成 20+ 个 issue（含新功能、bug 修复、数据管线改造）。
- **坑都修好了**：13 类真实事故（PATH 污染、PR 索引延迟、自批准限制、worktree 冲突、双语判定解析、配额误耗…）已内置为模板代码与规则，见 [`docs/lessons.md`](docs/lessons.md)。
- **审查用不同厂商模型**：独立视角，实践中确实抓到了 i18n 完整性、XSS 转义、数据结构一致性等跨切面问题。
- **人类只在关键点介入**：提需求 + `/approve`。省 token，也省心。
- **自托管**：本仓库用它自己维护自己 —— 你提的改进 issue 会被同一套 loop 实现。

## 安装（pi 用户）

```bash
pi install git:github.com/v3c70r/agent-dev-team
```

然后在你的项目仓库里对 pi 说：

> 用 agent-dev-team 技能给这个仓库装上多 agent 开发团队

pi 会按 [`SKILL.md`](SKILL.md) 的步骤：做 preflight 检查 → 询问你的配置
（审查模型、是否装 PM、是否开启自我提升反馈）→ 复制模板并参数化 → 写入忽略规则
→ 启动 tmux 常驻 → 验证。

**其他 harness（Claude Code / Codex / Cursor 等）**：模板本体是 bash/node/gh/YAML，
与 harness 无关。把仓库克隆或复制到你的项目，让 agent 阅读 `SKILL.md` 并执行同样步骤即可。

## 使用

```bash
# 1) 在 GitHub 建 issue（写清：背景 / 验收标准 / 建议范围）
# 2) 在该 issue 回复：/approve
# 3) 剩下的自动发生（30 秒内接管）
```

| 操作 | 命令 |
|---|---|
| 看实现流水线 | `tmux attach -t agent`（Ctrl-b 然后 d 脱离） |
| 看 PM Agent | `tmux attach -t pm` |
| 状态机 | `npm run agent:status` |
| 单独复审某个 PR | `node .agent/pipeline.mjs review --pr 12 --issue 7` |
| PM 调度/名额 | `node .agent/pm/run.mjs --check` |
| PM 演练（不建 issue） | `node .agent/pm/run.mjs --dry-run --force` |
| 停止 | `tmux kill-session -t agent` / `-t pm` |

## 配置

| 变量 | 默认 | 说明 |
|---|---|---|
| `REVIEW_PROVIDER` / `REVIEW_MODEL` | `zai-coding-cn` / `glm-5.3` | Agent B 使用的模型（建议与实现模型不同厂商） |
| `IMPL_PROVIDER` / `IMPL_MODEL` | 空（用 pi 默认） | Agent A 使用的模型 |
| `MAX_REVIEW_ROUNDS` | 3 | 审查修改轮数上限 |
| `MAX_TEST_FIXES` | 2 | 测试失败后的修复轮数上限 |
| `TEST_SKIP` | — | `=1` 跳过功能测试（演示用） |
| `TEST_ENV_FILE` | 仓库 `.env` | 测试所需密钥的 env 文件路径（supervisor 自动注入） |
| `PM_DAILY_CAP` / `PM_WEEKLY_CAP` | 1 / 5 | PM 提案上限 |
| `PM_HOUR_UTC` + `PM_WINDOW_*` | 17:00 + 16:30–00:30 | PM 运行时刻与**折扣时段窗口** |
| `PI_BIN` | 自动解析 | 显式指定 pi 可执行文件 |

`.agent/config.json` 保存自我提升反馈的 opt-in 与 upstream 地址。

## 自我提升反馈（opt-in）

使用中如果流水线撞到**模板自身**的缺陷，可以自动向本仓库提 `[skill-feedback]` issue
——只含错误描述与堆栈，**不含你的代码**，每日≤3 条，随时可关。
详见 [`docs/feedback.md`](docs/feedback.md)。

## 贡献

两种方式：

1. **提 issue**（推荐）：描述你遇到的 gap / 期望能力。本仓库装了同一套 loop，
   `/approve` 后会被自动实现、审查、测试、合并。
2. **提 PR**：改 `templates/` 时**必须同步 `.agent/` 下的 live 副本**，
   否则 `npm test`（= `scripts/validate.mjs`）会因 DRIFT 检查失败。这是刻意的 dogfood 纪律。

新发现的坑请补进 [`docs/lessons.md`](docs/lessons.md)：**现象 → 根因 → 修复 → 教训**。

## 文档

- [`SKILL.md`](SKILL.md) — 技能本体（安装/运行/规则，pi 技能格式）
- [`docs/architecture.md`](docs/architecture.md) — 组件、状态机、成本模型、并发隔离
- [`docs/lessons.md`](docs/lessons.md) — 13 类真实事故与修复
- [`docs/feedback.md`](docs/feedback.md) — 自我提升回路与防骚扰设计
- [`docs/product-review.md`](docs/product-review.md) — PM Agent 的长期产品认知（由 PM 自动维护）

## 已知限制

- Agent A 在主工作区工作，因此**watcher 运行时不要手动改该仓库文件**（用 `tmux kill-session -t agent` 暂停）。
  多 issue 并行需要改成 per-issue worktree（属扩展点，未默认开启）。
- 需要一台常在线的机器（笔记本休眠期间不处理）。
- 单账号下 B 无法提交正式 approve review，模板会降级为评论记录（不影响合并）。
- PM 的竞品调研质量取决于可用的检索能力（Brave API key 可选）。

## License

MIT
