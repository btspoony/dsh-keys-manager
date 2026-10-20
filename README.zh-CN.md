# DSH Keys Manager

[![npm downloads](https://img.shields.io/npm/dm/dsh-keys-manager)](https://www.npmjs.com/package/dsh-keys-manager)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%5E22.19%20%7C%7C%20%3E%3D24-339933)](https://www.npmjs.com/package/dsh-keys-manager)
[![DSH](https://img.shields.io/badge/DSH-%5E0.2.1--rc.2-0969DA)](https://www.npmjs.com/package/@deepseek-ai/dsh-llm)

[English](README.md) | **简体中文**

DSH Keys Manager 是一个 DeepSeek Harness 插件，把一个提供商 API key 变成托管密钥池。它扩展而非替换 Models 页面：提供商、模型和模型选择器都在原处，只有 API key 来源移到管理器之后。

## 特性

- 每个提供商可配多把 key，每把有别名和健康状态。
- 一把 key 粘滞绑定到会话，新会话按轮询选择。
- 同一把 key 上有界重试，预算耗尽后自动切换到另一把 key。
- 指数升级的冷却恢复，上限七天。
- 插件详情页上提供可搜索的 Keys Manager 页面。
- 既有 Models 提供商卡片内出现"由 Keys Manager 托管"徽标。
- 额外内置提供商以普通 `llm-pi-ai` 路由安装。
- 七家 pi-ai 覆盖的提供商支持 OAuth 账户登录，凭据与 API key 并存管理。

### 额外提供商

`src/providers.ts` 收录 34 个精选提供商（原有 21 个加本次发布新增 13 个，例如 SiliconFlow、智谱编码套餐、Cline Pass、Ollama Cloud、Alibaba Token Plan (CN)），目录源自 [oh-my-pi](https://github.com/can1357/oh-my-pi)（MIT）。只有当随附 DSH 目录尚未声明该 route id 时才会新增条目（例如 `meta`、`typesafe` 不会重复提供）；与既有端点共享 base URL、但凭据身份不同的提供商会按设计保留。

## 快速开始

### 安装 —— DeepSeek Harness 桌面版 / Web 版

桌面版或 Web 版打开 **插件** 页面，点击 **添加插件**，在包名输入框中填入 `dsh-keys-manager` 并点击 **安装**；安装完成后选择 **立即启用** 启用插件。

它与下面的 CLI 安装使用同一个已发布 npm tarball——不会在本地执行构建，也不需要命令行。安装完成后刷新页面，让插件的浏览器侧代码被加载。

### 安装 —— 已发布包

```sh
dsh plugin --profile web add dsh-keys-manager
```

### 安装 —— 本地检出

```sh
git clone https://github.com/btspoony/dsh-keys-manager
cd dsh-keys-manager
pnpm i
dsh plugin --profile web link .
```

上面两条 CLI 安装路径中，只有已发布包路径不会在本地执行构建：`dsh plugin --profile web add dsh-keys-manager` 按原样安装 npm tarball——注册表安装不会运行包生命周期脚本（`prepare` / `prepack`），tarball 内已带构建好的 `lib/` 与客户端 bundle。本地 `dsh plugin --profile web link .` 路径不同——安装本地目录会在 `pnpm i` 期间运行 `prepare`，构建 `lib/` 与客户端 bundle，因此上面的克隆流程不需要手动构建步骤。

安装完成后刷新 Web 页面，让浏览器侧代码被取到。

## 使用

打开 **Plugins → 密钥管理 → 查看**（英文 locale 下显示为 `Plugins → Keys Manager → View`）。管理器渲染在插件详情页上，位于描述与包含行之间，与随附的插件配置卡片一致。

1. 搜索提供商。既有 DSH 提供商排在前面；插件同时附带上述精选扩展目录。
2. 接管提供商。对既有提供商，管理器导入当前解析出的凭据、把 broker 引用写进提供商档案，并把原 key 留在凭据存储里，以便停止接管时还原。
3. 用别名添加更多 key。每把 key 都以自己的引用存进 Harness 凭据存储；管理器状态文档从不包含 key 字面量。
4. 在三点菜单中管理 key：重命名、暂停/恢复、删除。key 行显示状态、最近使用，以及冷却中的恢复时间。
5. 在设置卡片中调整重试次数（1–3）、基础冷却与恢复宽限。

### OAuth 账户

支持原生 OAuth 登录的提供商有两种入池方式：**添加密钥**保存静态 API key，**添加账户**则执行提供商的 OAuth 登录流程，把得到的授权作为账户行存进同一个池。

支持的提供商——`llm-pi-ai` 实现了 OAuth 流的七家：Anthropic、GitHub Copilot、Kimi Coding、OpenAI Codex、OpenRouter、Radius、xAI。

增量 1 的真实模型是：**API key 构成选择环**——会话粘滞、轮询选择、重试切换与冷却都作用在该提供商的 API key 之间；**每个提供商由一条被投影的 OAuth 授权服务**——被投影的账户直接响应请求，同时只保留一个活跃授权。按账户排名（在多个账户间轮换或分流）是后续工作。账户行上的计数只反映该账户自身的成功与失败，不代表按账户的流量拆分。被投影的授权失败（过期或刷新被拒）时，该账户进入冷却：支持 key 池的路由会回落到该提供商的 key 池；仅有 OAuth 的路由没有 API-key 池，将停止服务，直到重新登录账户。恢复方式是从账户菜单手动重新登录。

添加账户只把提供商签发的授权存进 Harness 凭据存储（挂在账户的 `grantRef` 之下）；管理器状态里只存引用与非敏感元数据（邮箱、账户 ID、过期时间）——与 API key 相同的无明文布局。

### 选择与故障策略

- **会话粘滞**：会话的首次请求选出一把 key 并为该会话/提供商对绑定，后续请求复用。
- **轮询**：新会话推进提供商游标，取下一把健康 key。
- **重试**：失败请求在同一把 key 上重试 `retryCount` 次。
- **切换**：重试预算耗尽后，失败 key 标记为冷却，会话重新绑定到另一把健康 key。
- **冷却**：首次失败使 key 冷却 `baseCooldownMs`。冷却中再次失败，或恢复后 `recoveryGraceMs` 内失败，下一次冷却翻倍；长时间健康运行会重置升级。硬上限七天。
- **恢复**：冷却到期后 key 自动恢复可选，无需手动重置。
- **委托**：请求形态的失败（如 `CONTEXT_WINDOW_EXCEEDED`）与取消从不冷却 key。没有备用 key 时，管理器委托给组合层常规的重试/回退策略。

## 配置与数据

管理器元数据位于：

```text
$DSH_HOME/keys-manager/state.json
```

权限为仅属主可读写。内容包含别名、凭据引用、健康计数、会话绑定和提供商接管事实。API key 字面量只存在于 Harness 凭据存储。文件通过临时文件加重命名原子写入。

每个受管提供商档案的 `apiKeyEnv` 指向 broker 引用，例如 `KEYSMGR_ZAI_CODING_CN_3FA2C1`。Host 凭据层按请求用该会话选中的 key 应答这个引用。Models 页面视该档案为已配置；直接写 broker 引用会被拒绝并指向管理器。

### OAuth2 扩展点

状态结构已区分 `kind: "api-key"` 与 `kind: "oauth"`，并在凭据引用旁保留可空的 `oauth` 对象。未来的账号流程可以在 `keys-manager/<provider>/<key>` 下追加记录而不改写既有行。本版本中，只有 OAuth 认证的提供商会按不支持上报，而不会被当作 API key 提供商处理。

## 提供商分类

每个提供商卡片标注来源：

- **DSH 内置**（英文界面显示 `DSH built-in`）——随附 DSH pi-ai 目录的路由。
- **插件内置**（`Plugin built-in`）——来自本插件 `src/providers.ts` 扩展目录的路由。
- **自定义**（`Custom`）——当前档案中手工声明的路由。

以下 DSH 内置提供商明确不在单 key 池管理范围内：

| 提供商 | 原因 |
|---|---|
| `amazon-bedrock` | AWS 凭据链（profile、IAM 密钥、ECS/IRSA/EC2），不是单一 API key |
| `cloudflare-ai-gateway` | API key 之外还需 Cloudflare 账号 ID 与网关 ID |
| `cloudflare-workers-ai` | API key 之外还需 Cloudflare 账号 ID |
| `openai-codex` | 仅支持 ChatGPT OAuth 登录，无 API key 凭据——可作为 [OAuth 账户](#oauth-账户)使用而非 key |

其余 DSH 目录路由都提供 API key 凭据。同时支持 OAuth 的提供商（Anthropic、GitHub Copilot、Kimi Coding、OpenAI Codex、OpenRouter、Radius、xAI）仍可经其 API key 路径管理，其 OAuth 登录则以 [OAuth 账户](#oauth-账户)形式提供。

## 文档

| 文档 | 内容 |
|---|---|
| [开发](docs/development.zh-CN.md) | 构建与开发工作流、仓库布局 |
| [发布](docs/release.zh-CN.md) | CI 检查与 npm 发布流程 |
| [已知限制](docs/known-limits.zh-CN.md) | 当前设计边界，含延后提供商 |

英文版本：[README.md](README.md) 及 `docs/` 下的 `*.md` —— [Development](docs/development.md) · [Release](docs/release.md) · [Known limits](docs/known-limits.md)。当前设计边界速览：[已知限制](docs/known-limits.zh-CN.md)。

## 许可证

基于 [MIT 许可证](LICENSE) 发布。
