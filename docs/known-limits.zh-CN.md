# 已知限制

[English](known-limits.md) | **简体中文** — 返回 [README](../README.md)

Keys Manager 插件当前的设计边界：

- CoreWeave 提供商支持延后到后续版本；进度在 [issue #11](https://github.com/btspoony/dsh-keys-manager/issues/11) 跟踪。
- OAuth2 账号池已作为增量 1 落地，覆盖七家 pi-ai 支持的提供商；详见下方"OAuth 账户"限制。Anthropic key 池仍管理普通的 `ANTHROPIC_API_KEY`——其 OAuth/联邦令牌路径是独立的账户行，不属于 key 池成员。
- Cloudflare AI Gateway 与 Workers AI 除 API key 外还需要 Cloudflare 账号 ID（AI Gateway 还需网关 ID）。它们被上报为不支持的 key 池，应在 Models 中原生配置。
- 提供商原生云凭据链（例如 Bedrock 路由使用的 AWS profile）不会拆分成单 key 行；这些提供商除非还提供 API key 变量，否则会显示说明性原因。
- 停止接管会还原档案的 `apiKeyEnv`，但用户在 Models 中做的其他提供商修改会保留。停止接管由插件创建的额外提供商的路由档案时，会移除整条路由（包括后续修改）；确认文案中已说明这一点。
- 冷却计数只属于当前 Harness home；不在多个 host 之间共享。
- 重试身份是环境性的：重试 pin 与请求步骤按会话和提供商记录，而不是按 HTTP 请求。同一会话和提供商的多个步骤并发运行时，重试流可能消费不到自己的 pin，或一个结束的步骤可能清掉另一步骤的 pin。没有 `purpose` 的直连流在其窗口开启时也可能消费一个待处理的重试 pin。pin 窗口为 60 秒，它限制了但不消除这种暴露；并发多步骤重试行为仍是尽力而为。

## OAuth 账户（增量 1）

- 账户登录仅限 `llm-pi-ai` host 实现了 OAuth 流的七家提供商：Anthropic、GitHub Copilot、Kimi Coding、OpenAI Codex、OpenRouter、Radius、xAI。通过 oh-my-pi 扩展覆盖更多提供商在 [issue #15](https://github.com/btspoony/dsh-keys-manager/issues/15) 跟踪。
- 授权刷新失败按 fail-loud 处理：账户进入冷却，池回退到该提供商的 key 池。重新认证是手动的——从账户菜单重新登录。
- 每个提供商同时只保留一个活跃授权。
- 增量 1 的选择模型以 key 为中心：该提供商的 API key 构成粘滞/轮询/切换/冷却的选择环，同时只由一条被投影的 OAuth 授权服务该提供商。按账户排名（在账户间轮换）属于后续工作，不在本增量内。
