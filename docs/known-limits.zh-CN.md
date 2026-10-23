# 已知限制

[English](known-limits.md) | **简体中文** — 返回 [README](../README.md)

Keys Manager 插件当前的设计边界：

- CoreWeave Serverless Inference 在添加时从 DSH 进程环境读取 `COREWEAVE_PROJECT`（即 `<team>/<project>`），并作为静态 `OpenAI-Project` 头写进路由档案，因此请求始终发送添加时设定的项目。要更改项目，请先在 Keys Manager 中释放（停止接管）该提供商，再以新值重启 DSH 并再次添加该提供商。释放时会移除本插件写入、且仍与当前环境变量值相等的 `OpenAI-Project` 值；无法归属的值会保留，并在界面警告中报告；手写的 header 若恰好等于环境变量值，也会按同一规则被移除。插件创建的档案会在下次添加时被移除并重建，接管的档案则保留并重新接管；两种情况都只补齐档案尚未声明的 header，从不覆盖已存储的值。
- OAuth2 账号池已作为增量 1 落地，覆盖七家 pi-ai 支持的提供商；详见下方"OAuth 账户"限制。Anthropic key 池仍管理普通的 `ANTHROPIC_API_KEY`——其 OAuth/联邦令牌路径是独立的账户行，不属于 key 池成员。
- Cloudflare AI Gateway 与 Workers AI 除 API key 外还需要 Cloudflare 账号 ID（AI Gateway 还需网关 ID）。它们被上报为不支持的 key 池，应在 Models 中原生配置。
- 提供商原生云凭据链（例如 Bedrock 路由使用的 AWS profile）不会拆分成单 key 行；这些提供商除非还提供 API key 变量，否则会显示说明性原因。
- 停止接管会还原档案的 `apiKeyEnv`，但用户在 Models 中做的其他提供商修改会保留。停止接管由插件创建的额外提供商的路由档案时，会移除整条路由（包括后续修改）；确认文案中已说明这一点。
- 冷却计数只属于当前 Harness home；不在多个 host 之间共享。
- 重试身份是环境性的：重试 pin 与请求步骤按会话和提供商记录，而不是按 HTTP 请求。同一会话和提供商的多个步骤并发运行时，重试流可能消费不到自己的 pin，或一个结束的步骤可能清掉另一步骤的 pin。没有 `purpose` 的直连流在其窗口开启时也可能消费一个待处理的重试 pin。pin 窗口为 60 秒，它限制了但不消除这种暴露；并发多步骤重试行为仍是尽力而为。

## OAuth 账户（增量 1）

- 经 `llm-pi-ai` seam 的账户登录覆盖该 host 实现了 OAuth 流的七家提供商：Anthropic、GitHub Copilot、Kimi Coding、OpenAI Codex、OpenRouter、Radius、xAI。另有两条路由通过本插件自带的登录客户端登录——Kilo 与 Z.AI Coding Plan，见下方[内置登录](#内置登录kilo-zai-coding-plan)。在这些路由之外扩展覆盖在 [issue #15](https://github.com/btspoony/dsh-keys-manager/issues/15) 跟踪。
- 授权刷新失败按 fail-loud 处理：账户进入冷却。支持 key 池的路由会回落到该提供商的 key 池；仅有 OAuth 的路由没有 API-key 池，将停止服务，直到重新登录账户。重新认证是手动的——从账户菜单重新登录。
- 每个提供商同时只保留一个活跃授权。
- 条件删除是凭证 seam 不具备的能力：凭证库只提供 `deleteRecord(key)`，没有比较/版本守卫，因此降级或补偿 `llm-pi-ai/<provider>` 投影只能是"先比较、后删除"。原生授权若落在最后一次比较与删除排队入口之间的亚微任务窗口内，即使它已不属于被移除的账户，仍可能被删除。管理器用 seam 每 key 锁内的比较加删除前复读收窄了该窗口，并有回归测试精确固定这一残留行为。上游能力请求见 store issue I-000090（credential seam: compare-and-delete / versioned delete primitive）。
- 增量 1 的选择模型以 key 为中心：该提供商的 API key 构成粘滞/轮询/切换/冷却的选择环，同时只由一条被投影的 OAuth 授权服务该提供商。按账户排名（在账户间轮换）属于后续工作，不在本增量内。

## 内置登录（Kilo、Z.AI Coding Plan）

- 两个流程都是构建时从 `@oh-my-pi/pi-ai@18.12.3` 抽取的非官方客户端。提供商随时可能改动登录端点、scope 或响应；失效会以提供商自己的错误文本出现在登录对话框中，而不会导致崩溃。
- Kilo 的凭据是有效期一年的 bearer token，没有刷新令牌（`refresh: ''`）。它无法在后台续期：过期后从该行重新登录。
- Z.AI Coding Plan 流程最终签发一把 API key（`<id>.<secret>`），不是登录授权。该 key 会以 `oh-my-pi` 为名出现在 Z.AI 控制台中；在控制台删除或轮换它会使对应行失效，之后像普通 key 一样进入冷却。同一流程不覆盖 `zai-coding-cn`（中国区端点），那是独立路由。
- 这些登录只能从 Keys Manager 页面发起。DSH CLI 与 Models 页面都不会触发它们，也不会写入 `llm-pi-ai/<provider>` 授权记录。
- 签发得到的凭据就是该提供商池中的又一行：没有按账户的轮换或排名，与上述七家 pi-ai OAuth 账户一致。

## 传输路由（Cursor、Devin）

- 每条传输路由（`cursor`、`devin`）在 `llm-omp-transports/<route>` 只保留一条授权：其后没有 key 池，也没有可按账户配置的轮换。
- 只要授权带有可用的 `access` 令牌，且没有 `expires` 或 `expires` 仍在未来，状态就是 `active`。缺少 `expires` 是 Devin 凭据解析器接受的静态 bearer 形态；目前没有任何已发布流程会写入这种记录（Devin 会从令牌推导有效期），因此它保持 `active` 且不显示有效期。若 `expires` 存在但无法读取，那是损坏的记录而非静态 bearer，路由会上报 `needs-reauth`。
- 授权过期在两条路由上的后果不同：Devin 没有刷新令牌，过期后停止服务，直到重新登录；Cursor 在凭据 seam 上自动刷新并继续服务，只有刷新被拒或没有存刷新令牌时才停止。
- 两个客户端都是非官方实现，真实端点均未验证。Cursor 与 Devin 的具体风险（厂商身份、ToS 风险、不转发图片、Devin 无刷新）见[传输包的已知限制](../packages/llm-omp/docs/known-limits.md)。
