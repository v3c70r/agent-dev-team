# 自我提升反馈（opt-in）

这个 skill 的独特之处：**它在使用中会学习**。

## 用户侧（安装时询问）

安装时（`SKILL.md` 第二步）会明确询问：

> 是否开启 skill 自我提升反馈？使用中若流水线遇到模板本身的缺陷，会自动向
> `github.com/v3c70r/agent-dev-team` 发 `[skill-feedback]` issue
> （仅含错误描述与堆栈，**不含你的代码**；每日最多 3 条；随时可关）。

回答写入 `.agent/config.json`：

```json
{ "upstream": "v3c70r/agent-dev-team", "feedbackOptIn": true }
```

关闭：把 `feedbackOptIn` 改成 `false`（或删掉该文件）。

## 触发点

| 触发 | 位置 | 内容 |
|---|---|---|
| 流水线未预期异常 | `pipeline.mjs` 的每-issue `catch` | 错误消息 + 堆栈（截断 1500 字符） |
| Agent 使用中发现能力缺口 | 安装/运行中的 agent 判断 | 由 agent 描述现象与期望行为 |

**不做**：把用户代码、issue 内容、PR 内容、仓库名发上去。只有"模板哪里不好用"。

## 防骚扰设计

- 每日最多 3 条（`reportGap` 内用 `gh issue list --search` 统计）；
- 标题统一 `[skill-feedback] <一句话>`，便于维护者过滤/批量处理；
- 尝试带 `skill-feedback` 标签；**普通用户对公共仓库无打标签权限时会自动去掉标签重试**
  （这也是为什么标题前缀是必需的——它是唯一可靠的识别方式）。

## 维护者侧（dogfood）

upstream 仓库自身也装了同一套 loop，因此：

1. 用户/agent 提的 `[skill-feedback]` issue 会像普通 issue 一样被 triage 通知；
2. 维护者（或 owner）`/approve`；
3. Agent A 改模板 → Agent B（独立模型）审查 → Agent C 跑 `scripts/validate.mjs`
   （含 **模板与 `.agent/` 一致性检查**，防止改了模板忘了同步 live 副本）→ 自动合并。

即：**这个 skill 用它自己维护自己**。

## 给贡献者的约定

- 改 `templates/` 里任何文件，**必须同步 `.agent/` 下的 live 副本**，否则
  `validate.mjs` 会因 DRIFT 失败（这是刻意的 dogfood 纪律）。
- 新发现的坑请补进 `docs/lessons.md`：现象 → 根因 → 修复 → 教训。
