# 已知限制

[English](known-limits.md) | **简体中文** — 返回 [README](../README.md)

Keys Manager 插件当前的设计边界：

- CoreWeave 提供商支持延后到后续版本；进度在 [issue #11](https://github.com/btspoony/dsh-keys-manager/issues/11) 跟踪。
- OAuth2 账号池已设计但未实现。Anthropic key 池管理普通的 `ANTHROPIC_API_KEY`；其 OAuth/联邦令牌路径不是账号池。
- Cloudflare AI Gateway 与 Workers AI 除 API key 外还需要 Cloudflare 账号 ID（AI Gateway 还需网关 ID）。它们被上报为不支持的 key 池，应在 Models 中原生配置。
- 提供商原生云凭据链（例如 Bedrock 路由使用的 AWS profile）不会拆分成单 key 行；这些提供商除非还提供 API key 变量，否则会显示说明性原因。
- 发布会还原档案的 `apiKeyEnv`，但用户在 Models 中做的其他提供商修改会保留。发布一个路由档案由插件创建的额外提供商时，会移除整条路由（包括后续修改）；确认文案中已说明这一点。
- 冷却计数只属于当前 Harness home；不在多个 host 之间共享。
- 重试身份是环境性的：重试 pin 与请求步骤按会话和提供商记录，而不是按 HTTP 请求。同一会话和提供商的多个步骤并发运行时，重试流可能消费不到自己的 pin，或一个结束的步骤可能清掉另一步骤的 pin。没有 `purpose` 的直连流在其窗口开启时也可能消费一个待处理的重试 pin。pin 窗口为 60 秒，它限制了但不消除这种暴露；并发多步骤重试行为仍是尽力而为。
