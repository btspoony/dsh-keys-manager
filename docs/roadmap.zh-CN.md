# 路线图

[English](roadmap.md) | **简体中文** — 返回 [README](../README.md)

本页把两类未完成事项汇总成有顺序的计划：描述产品范围的 GitHub issues，以及承载工程残留的本地 issue store。它是规划文档而非承诺 —— 条目会随约束变化在里程碑之间移动，每条在自己的来源记录里保留验收标准。

快照：2026-10-21，`main` = `25d7fc8`（PR #28 已合并）。Issue store 汇总：47 条 open —— 0 critical、5 high、2 medium、33 low、7 nit。

## 方向

本插件负责两件事：**覆盖广度**（哪些路由能被池化）与**池的质量**（一条路由的多份凭证如何被调度）。覆盖是纯增量、风险低；质量才是当前最大的缺口 —— 每个 provider 只投影一个 grant 的 OAuth「池」，名不副实。

由此得到的排序原则：**先修路由正确性，再扩覆盖。** 加 provider 会放大路由层现有的行为；若账号归属或按步骤重试是错的，provider 越多，错得越多。

## 已交付基线

- **API-key 池**：21 条插件内建路由 + 33 条 DSH 内建路由；sticky session、round-robin、按步骤重试切换、冷却升级、恢复宽限。
- **OAuth 账号**：`llm-pi-ai` 实现了 flow 的七个 provider（Anthropic、GitHub Copilot、Kimi Coding、OpenAI Codex、OpenRouter、Radius、xAI）。每 provider 仅一个投影 grant，回落密钥池。
- **Cursor transport**：独立发布的 `dsh-llm-omp-transports`（打包 omp 传输代码、123 行模型表、文本/推理流、MCP 工具移交、PKCE 登录与刷新）。
- **`coreweave`**：header 载体落地后已支持（issue #11）。

## M1 —— 池质量：多账号与额度感知调度

放第一位的原因：这才是「能登录」与「能调度」的分界；其余里程碑都是覆盖。

| 条目 | 来源 | 验收信号 |
| --- | --- | --- |
| 额度感知排序：有余量者中额度最先重置者优先；仅 5 小时额度的账号降级，等其他账号都不可用才启用；冷却中的排最后 | #22 | 选择顺序是账号额度状态的纯函数，用表驱动测试钉住 |
| 选择环中的按账号轮换（sticky / round-robin / failover / cooldown 以账号为粒度而非 provider） | `I-000110` | 新 session 由第二个账号承接；失败只冷却出错的账号 |
| 登录 harvest 优先真实身份而非仅 email 的行；激活期间不占全局队列等待凭证写入 | `I-000110` | 两次并发激活不串行；harvest 行保留 org/project 字段 |
| 按 provider 并发水合投影归属，单点卡住不影响其余 provider | `I-000121`、`I-000114`、`I-000115`、`I-000116`、`I-000119` | A 的水合卡住时 B 在等待预算内仍可服务；不向永不 settle 的 promise 泄漏 reaction |
| 超时后无归属的请求要"响"出来，而不是只有一条 warn | `I-000120` | 超时路径可观测 |
| 连续相同 select prompt 需重新播种 | `I-000123` | 连续两次相同 prompt 都能被回答 |

出口判据：一个配有两个账号的 provider 能按账号路由、切换、冷却与恢复，且状态面能展示。

## M2 —— 覆盖：剩余 API-key 路由

来源：issue #2 Phase 1。每条都是普通 `llm-pi-ai` 路由，无需改 broker。

| 批次 | 路由 |
| --- | --- |
| 高置信 | `siliconflow`、`siliconflow-cn`、`litellm`、`charm-hyper` |
| 其次 | `typesafe`、`zhipu-coding-plan`、`alibaba-token-plan`、`meta` |
| 再次 | `abliteration`、`commandcode`、`firepass`、`yolo-auto`、`cline-pass` |

`meta` 与 `typesafe` 需先核对当前安装的 pi-ai chat catalog 是否真的提供，再决定是否重复添加。

## M3 —— 覆盖：OAuth transport

来源：issue #15 及其 store 记录 `I-000049`。这些 provider 说的是 `llm-pi-ai` 无法服务的线协议，需要像 Cursor 那样的独立 transport 切片。

| 顺序 | Provider | 备注 |
| --- | --- | --- |
| 1 | `devin` | 另有 API-key 路径，可先部分落地 |
| 2 | `google-gemini-cli` | 该组用户价值最高；flow 与 Cursor 不同 |
| 3 | `google-antigravity` | 与上者同族 |
| 4 | `factory-droid` | device flow，无 API-key 产品 |
| 5 | `gitlab-duo`、`gitlab-duo-agent` | OAuth 或 `GITLAB_TOKEN` |
| 6 | `muse-code`、`ollama-cloud`、`qwen-portal`、`xai-oauth`、`snowflake` | 需求较低；`snowflake` 还需 M4 的多字段凭证 |

依赖：先完成 M1。第二个 transport 会让账号路由面成倍增长，而 Cursor 路由目前仍是单 grant。

## M4 —— 多字段凭证

来源：issue #2 Phase 3。这些路由无法用单个 API-key 引用表达，需逐 provider 决定「托管原生凭证」还是「留在 Models 原生配置、不进池」。

- `bedrock-mantle` 与 `amazon-bedrock`（SigV4 / 凭证链）
- `snowflake`（账号 + OAuth/PAT）
- `cloudflare-ai-gateway`、`cloudflare-workers-ai`（account / gateway id）
- `coreweave` 收尾：按值相等判定归属可能删掉用户自写的同名 header（`I-000129`）、release 不还原记录的 env 名（`I-000132`）、repair 误报不可读设置为已删除（`I-000135`、`I-000137`）、漂移只在 add/repair 暴露（`I-000166`）、文档未给清除无归属 header 的操作（`I-000138`）。

## M5 —— 体验

| 条目 | 来源 | 说明 |
| --- | --- | --- |
| Provider 筛选栏（内建 / 支持 OAuth / transport） | #16 | 覆盖接近 60 条路由后成为必需 |
| Transport 账号诊断 | `I-000170`、`I-000154` | 单一登录入口、真实 settings 契约或删掉、文档化 seam 侧重试归属 |
| 文档修正 | `I-000139`、`I-000169` | README 仍称 known-limits 覆盖已延后的 provider |

## M6 —— 发布与供应链

要在下一次 `npm publish` 之前完成，而不是下一个 PR 之前。

- `I-000173` —— transport 发布守卫能拒空值/非祖先 `gitHead`，但证明不了发布者身份；需要 attestation + tarball digest。
- `I-000046` —— `@deepseek-ai/dsh-llm` 的 `latest` dist-tag 陈旧。
- `I-000124` —— workflow-close attestation 记录了两个不精确的值。
- `I-000090` —— 凭证 seam 缺少 compare-and-delete 原语。

## M7 —— Cursor transport 加固

不阻塞任何事项，但每条都是读者或运维会踩到的小刺。

- shim 面：`I-000143`（JSON stub 与 `Bun.deepEquals`/`gunzipSync` 可达性）、`I-000155`（logger 绑死原始 console）、`I-000156`（LRU cache 与 omp 行为不一致）。
- 漂移门禁：`I-000158`（thinking mode 子字段）、`I-000164`、`I-000165`。
- 行为：`I-000159`（8 个错误分支中 3 个未实现）、`I-000151`（`PI_REQ_DEBUG` 把请求体 dump 到宿主 cwd）、`I-000153`（把 row-test 状态机从 `src/index.ts` 抽出）、`I-000177`（移除与 attempt 缓存驱逐的窗口）、`I-000169`（外来历史拒绝路径未钉）。
- 已记录不排期的产品限制：图片输入是拒绝而非转发、Cursor 原生 exec 帧不移交 DSH、客户端非官方（ToS 风险，停止条件 S4）、无真实 Cursor 端点验证。

## 卫生积压

规模小、相互独立，可并入任一里程碑：`I-000091`、`I-000092`、`I-000093`、`I-000102`、`I-000109`、`I-000126`、`I-000127`、`I-000128`、`I-000117`、`I-000118`、`I-000133`、`I-000140`、`I-000180`、`I-000185`。

## 明确不做

- 本地/无密钥引擎：`ollama`、`lm-studio`、`llama.cpp`、`vllm`、`apple` —— 没有可池化的对象。
- 重写 `llm-pi-ai` 已能服务的线协议：那些留在 pi-ai 路由上，不走 transport。
