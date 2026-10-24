# DSH Keys Manager

[![npm downloads](https://img.shields.io/npm/dm/dsh-keys-manager)](https://www.npmjs.com/package/dsh-keys-manager)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%5E22.19%20%7C%7C%20%3E%3D24-339933)](https://www.npmjs.com/package/dsh-keys-manager)
[![DSH](https://img.shields.io/badge/DSH-%5E0.2.1--rc.3-0969DA)](https://www.npmjs.com/package/@deepseek-ai/dsh-llm)

[English](README.md) | **简体中文**

DSH Keys Manager 是一个 DeepSeek Harness 插件，把一个提供商 API key 变成托管密钥池。它扩展而非替换 Models 页面：提供商、模型和模型选择器都在原处，只有 API key 来源移到管理器之后。

## 功能

**密钥池与路由**

- 每个提供商可配多把 key，每把有别名和健康状态。
- 一把 key 粘滞绑定到会话，新会话按轮询选择；请求失败先在同一把 key 上重试，再换到另一把。
- 指数升级的冷却恢复，上限七天。

**账户与登录**

- 七家 pi-ai OAuth 提供商可以以账户身份入池，而不必粘贴 key。
- 另有两条通过本插件自带的登录客户端入池：Kilo 与 Z.AI Coding Plan。
- 随附七条传输路由，服务随附 pi-ai 无法支持的提供商：Cursor、Devin、两条 Google 路由、Factory Droid 与两条 GitLab Duo 路由。

**界面**

- 插件详情页上提供可搜索的 Keys Manager 页面。
- 既有 Models 提供商卡片内出现"由 Keys Manager 托管"徽标。
- 额外内置提供商以普通 `llm-pi-ai` 路由安装——共 35 个，清单见[提供商覆盖](#提供商覆盖)。

## 快速开始

### 安装 —— DeepSeek Harness 桌面版 / Web 版

桌面版或 Web 版打开 **插件** 页面，点击 **添加插件**，在包名输入框中填入 `dsh-keys-manager` 并点击 **安装**；安装完成后选择 **立即启用** 启用插件。

通过向导安装时，应用会下载与下面 CLI 路径相同的已发布 npm 包，包内已包含构建好的产物。安装完成后刷新页面，让插件的浏览器侧代码被加载。

### 安装 —— 已发布包

```sh
dsh plugin --profile web add dsh-keys-manager
```

安装 `dsh-keys-manager` 会安装两个 bundle 组件。已发布包依赖 `dsh-llm-omp-transports`，因此一次安装会解析两个 npm 包，插件页面会同时列出 `dsh-keys-manager` 与 `llm-omp-transports`。两者都要启用：管理器负责凭据与路由，传输组件负责其七条路由（Cursor、Devin、两条 Google 路由、Factory Droid 与两条 GitLab Duo 路由）的线协议。

安装完成后刷新 Web 页面，让浏览器侧代码被取到。

<details>
<summary>从本地检出安装</summary>

```sh
git clone https://github.com/btspoony/dsh-keys-manager
cd dsh-keys-manager
pnpm i
dsh plugin --profile web link .
```

两条 CLI 安装路径的区别在于构建产物的来源：`dsh plugin --profile web add dsh-keys-manager` 安装的已发布 npm tarball 中已包含构建好的 `lib/` 与客户端 bundle。本地 `dsh plugin --profile web link .` 路径会在 `pnpm i` 期间运行 `prepare`，构建 `lib/` 与客户端 bundle，因此上面的克隆流程包含这一步构建；`prepack` 则在打包或发布时生成同样的产物。

</details>

## 使用

打开 **Plugins → 密钥管理 → 查看**（英文 locale 下显示为 `Plugins → Keys Manager → View`）。管理器渲染在插件详情页上，位于描述与包含行之间，与随附的插件配置卡片一致。

### 接管提供商并添加 key

1. 搜索提供商。既有 DSH 提供商排在前面；插件同时附带精选的额外提供商目录，见[提供商覆盖](#提供商覆盖)。
2. 接管提供商。对既有提供商，管理器导入当前解析出的凭据、把 broker 引用写进提供商档案，并把原 key 留在凭据存储里，以便停止接管时还原。
3. 用别名添加更多 key。每把 key 都以自己的引用存进 Harness 凭据存储；管理器状态文档从不包含 key 字面量。
4. 在三点菜单中管理 key：重命名、暂停/恢复、删除。key 行显示状态、最近使用，以及冷却中的恢复时间。
5. 在设置卡片中调整重试次数（1–3）、基础冷却与恢复宽限。

### 账户与登录

支持原生 OAuth 登录的提供商有两种入池方式：**添加密钥**保存静态 API key，**添加账户**则执行提供商的 OAuth 登录流程，把得到的授权作为账户行存进同一个池。

| 路由组 | 如何入池 | 刷新 / 续期 |
|---|---|---|
| 七家 pi-ai OAuth 提供商：Anthropic、GitHub Copilot、Kimi Coding、OpenAI Codex、OpenRouter、Radius、xAI | **添加账户** —— 提供商自己的 OAuth 流程 | 由提供商负责刷新 |
| `kilo`、`zai`（Kilo、Z.AI Coding Plan） | **添加账户** —— 走插件自带的登录客户端：Kilo 用设备码，Z.AI 粘贴跳转地址 | 静态凭据，**重新登录**是唯一的续期方式 |
| 七条传输路由：Cursor、Devin、两条 Google 路由、Factory Droid、两条 GitLab Duo 路由 | **传输账户** —— 每条路由一条授权 | 见[传输路由](#传输路由) |

增量 1 的真实模型是：**API key 构成选择环**——会话粘滞、轮询选择、重试切换与冷却都作用在该提供商的 API key 之间；**每个提供商由一条被投影的 OAuth 授权服务**——被投影的账户直接响应请求，同时只保留一个活跃授权。按账户排名（在多个账户间轮换或分流）是后续工作；账户行上的计数只反映该账户自身的成功与失败，不代表按账户的流量拆分。

被投影的授权失败（过期或刷新被拒）时，该账户进入冷却：支持 key 池的路由会回落到该提供商的 key 池；仅有 OAuth 的路由没有 API-key 池，将停止服务，直到重新登录账户。恢复方式是从账户菜单手动重新登录。

<details>
<summary>登录流程（Kilo、Z.AI、muse-code）</summary>

- **Kilo**（`kilo`，以插件内置扩展路由的形式安装）：设备码页面加轮询。首次登录成功会创建该路由及其第一把 key 行；之后再登录则追加行。
- **Z.AI (GLM Coding Plan)**（`zai`，DSH 随附的 pi-ai 路由）：需要先接管。流程会打开浏览器页面，并要求你把最终跳转 URL（`zcode://` 链接）或授权码粘贴回对话框。

两者签发的都是**静态凭据**——一个 token 或一个 `id.secret` key——以普通的 key 行存入同一个池，标记为 `signin:kilo` / `signin:zai-coding-plan`。它们不是可刷新的授权，因此行菜单里的**重新登录**是唯一的续期方式：它会就地替换该行的字面量，保留行 ID 与位置。这两条路由不会向 `llm-pi-ai/<provider>` 写入任何内容。

**登录流程不等于传输。** 这两条路由走常规 pi-ai key 池，参与会话粘滞、轮询、重试切换与冷却。传输路由是另一套机制：每条路由一条授权，没有池。

**`muse-code` 不需要传输。** 它已由随附 pi-ai 的 `meta` 路由提供（`openai-responses` 走 `https://api.meta.ai/v1`，目录键为 `meta`），因此按普通 pi-ai 提供商的路径管理即可。证明目录条目与提供商在该路由形态和凭据形态上一致的检查是静态的，没有发起真实请求；首次真实调用属于手动冒烟检查，详见[已知限制](docs/known-limits.zh-CN.md)。

</details>

<details>
<summary>账户密钥存放在哪里</summary>

添加账户只把提供商签发的授权存进 Harness 凭据存储（挂在账户的 `grantRef` 之下）；管理器状态里只存引用与非敏感元数据（邮箱、账户 ID、过期时间）——与 API key 相同的无明文布局。

</details>

### 传输路由

随附 pi-ai 无法支持的提供商由配套的 `dsh-llm-omp-transports` 组件提供。所有路由遵循同一模型：

- 每条路由只有一条授权，位于 `llm-omp-transports/<route>`；没有 key 池，也没有按账户轮换。
- 登录在 Keys Manager 页面的 **传输账户**（`Transport accounts`）区块完成。
- 模型是构建时从固定的 `@oh-my-pi/pi-catalog@18.12.3` 表生成的目录，客户端均为非官方实现。依赖前请阅读[传输包文档](packages/llm-omp/README.md)与其[已知限制](packages/llm-omp/docs/known-limits.md)。

| 路由 | 登录 | 刷新 | 模型行数 |
|---|---|---|---|
| `cursor` | 浏览器页面 + 轮询 | 在凭据 seam 上 | 123 |
| `devin` | 粘贴浏览器最终落到的地址 | 无 —— 需重新登录 | 2 |
| `google-gemini-cli` | 回环 `8085` + 粘贴兜底 | 在凭据 seam 上 | 7 |
| `google-antigravity` | 回环 `51121` + 粘贴兜底 | 在凭据 seam 上 | 22 |
| `factory-droid` | WorkOS 设备码（网址 + 用户码） | 60 秒窗口内刷新一次，保留 `orgId`/`region` | 62 |
| `gitlab-duo` | PKCE 回环 `localhost:8080/callback`，无端口回落，可粘贴兜底 | 60 秒窗口内刷新一次 | 16 |
| `gitlab-duo-agent` | 粘贴 `vscode://` 链接 | 刷新一次，回显 `vscode` 重定向 | 1 |

<details>
<summary>各路由说明</summary>

- **Cursor** —— 支持文本与推理流，并把工具调用交给 DSH 的工具循环；遇到图片块以类型化错误拒绝，而不是静默丢弃。该客户端是非官方实现，会呈现 Cursor 厂商内部的 OAuth 身份。
- **Devin** —— 没有刷新：记录是静态 bearer，其有效期由令牌推导（JWT `exp` 减五分钟，否则一年）。没有可读有效期的授权按 `active` 服务，倒计时列留空；可读的有效期一旦过期，需要手动重新登录。该客户端呈现已发布的 Devin CLI 身份，真实端点与协议行为均未验证。
- **两条 Google 路由** —— 共用一份生成的 `lib/omp/google.mjs` 产物，由产物内的提供商按模型分派，但各自保留独立的授权、账户行与模型目录；插件自带的监听器在默认端口被占用时会改用空闲端口。授权内容为 `{access, refresh, expires, projectId, email?}`，登录过程还会解析该路由计费与请求所用的 Google Cloud 项目；`legacy-tier` 或付费账户若无法发现项目，登录会以 `AUTH_FAILED` 失败，直到在 DSH 进程环境中设置 `GOOGLE_CLOUD_PROJECT`（或 `GOOGLE_CLOUD_PROJECT_ID`）；两条路由的首次真实请求都是手动冒烟检查。
- **Factory Droid** —— 一个代理背后是四套协议，由产物内的模型 id 选择：插件从不选择后端，行上也不带 base URL。账户的区域属性（`orgId`/`region`）在每次刷新后保留。
- **GitLab Duo 一对** —— `gitlab-duo` 先 POST 换取 direct-access token，产物内的 token 缓存以 GitLab token 为键，因此轮换后的 token 按构造会未命中；`gitlab-duo-agent` 每个请求重新播种一条工作流并重放会话记录，而不是复用上一轮的 socket。

</details>

### 选择与故障策略

| 机制 | 行为 |
|---|---|
| 会话粘滞 | 会话的首次请求选出一把 key，并为该会话/提供商对绑定；后续请求复用该 key。 |
| 轮询 | 新会话推进提供商游标，取下一把健康 key。 |
| 重试 | 失败请求在同一把 key 上重试 `retryCount` 次。`CONTEXT_WINDOW_EXCEEDED` 这类请求形态的失败与取消从不冷却 key。 |
| 切换 | 重试预算耗尽后，失败 key 标记为冷却，会话重新绑定到另一把健康 key；没有备用 key 时，管理器委托给组合层常规的重试/回退策略。 |
| 冷却 | 首次失败使 key 冷却 `baseCooldownMs`。冷却中再次失败，或恢复后 `recoveryGraceMs` 内失败，下一次冷却翻倍；长时间健康运行会重置升级。硬上限七天。 |
| 恢复 | 冷却到期后 key 自动恢复可选，无需手动重置。 |

## 配置与数据

管理器元数据位于：

```text
$DSH_HOME/keys-manager/state.json
```

权限为仅属主可读写。内容包含别名、凭据引用、健康计数、会话绑定和提供商接管事实。API key 字面量只存在于 Harness 凭据存储。文件通过临时文件加重命名原子写入。

每个受管提供商档案的 `apiKeyEnv` 指向 broker 引用，例如 `KEYSMGR_ZAI_CODING_CN_3FA2C1`。Host 凭据层按请求用该会话选中的 key 应答这个引用。Models 页面视该档案为已配置；直接写 broker 引用会被拒绝并指向管理器。

<details>
<summary>OAuth2 扩展点</summary>

状态结构已区分 `kind: "api-key"` 与 `kind: "oauth"`，并在凭据引用旁保留可空的 `oauth` 对象。未来的账号流程可以在 `keys-manager/<provider>/<key>` 下追加记录而不改写既有行。本版本中，只有 OAuth 认证的提供商会按不支持上报，而不会被当作 API key 提供商处理。

</details>

## 提供商覆盖

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
| `openai-codex` | 仅支持 ChatGPT OAuth 登录，无 API key 凭据——可作为 [OAuth 账户](#账户与登录)使用而非 key |

其余 DSH 目录路由都提供 API key 凭据。同时支持 OAuth 的提供商（Anthropic、GitHub Copilot、Kimi Coding、OpenAI Codex、OpenRouter、Radius、xAI）仍可经其 API key 路径管理，其 OAuth 登录则以 [OAuth 账户](#账户与登录)形式提供。

这 35 个额外提供商收录自
[oh-my-pi](https://github.com/can1357/oh-my-pi) 的提供商目录（MIT）。

<details>
<summary>全部 35 个额外提供商</summary>

| 提供商 | Route id | API key 环境变量 |
|---|---|---|
| DeepInfra | `deepinfra` | `DEEPINFRA_API_KEY` |
| Novita | `novita` | `NOVITA_API_KEY` |
| StepFun | `stepfun` | `STEPFUN_API_KEY` |
| SambaNova | `sambanova` | `SAMBANOVA_API_KEY` |
| Qianfan | `qianfan` | `QIANFAN_API_KEY` |
| GMI Cloud | `gmi-cloud` | `GMI_API_KEY` |
| Synthetic | `synthetic` | `SYNTHETIC_API_KEY` |
| ZenMux | `zenmux` | `ZENMUX_API_KEY` |
| Kilo Gateway | `kilo` | `KILO_API_KEY` |
| NanoGPT | `nanogpt` | `NANO_GPT_API_KEY` |
| Venice AI | `venice` | `VENICE_API_KEY` |
| AIML API | `aimlapi` | `AIMLAPI_API_KEY` |
| AI& | `aiand` | `AIAND_API_KEY` |
| Helmcode | `helmcode` | `HELMCODE_API_KEY` |
| Alibaba Coding Plan | `alibaba-coding-plan` | `ALIBABA_CODING_PLAN_API_KEY` |
| MiniMax Coding (Global) | `minimax-code` | `MINIMAX_CODE_API_KEY` |
| MiniMax Coding (CN) | `minimax-code-cn` | `MINIMAX_CODE_CN_API_KEY` |
| Umans AI Coding Plan | `umans` | `UMANS_AI_CODING_PLAN_API_KEY` |
| Sakana AI | `sakana` | `SAKANA_API_KEY` |
| CoralBricks | `coralbricks` | `CORAL_API_KEY` |
| Wafer Serverless | `wafer-serverless` | `WAFER_SERVERLESS_API_KEY` |
| Alibaba Token Plan | `alibaba-token-plan` | `ALIBABA_TOKEN_PLAN_API_KEY` |
| Alibaba Token Plan (CN) | `alibaba-token-plan-cn` | `BAILIAN_TOKEN_PLAN_API_KEY` |
| Charm Hyper | `charm-hyper` | `CHARM_HYPER_API_KEY`, `HYPER_API_KEY` |
| LiteLLM Proxy | `litellm` | `LITELLM_API_KEY` |
| SiliconFlow | `siliconflow` | `SILICONFLOW_API_KEY` |
| SiliconFlow (CN) | `siliconflow-cn` | `SILICONFLOW_CN_API_KEY` |
| Zhipu Coding Plan | `zhipu-coding-plan` | `ZHIPU_API_KEY` |
| Abliteration | `abliteration` | `ABLITERATION_API_KEY`, `ABLIT_KEY` |
| ClinePass | `cline-pass` | `CLINE_API_KEY` |
| Command Code | `commandcode` | `COMMAND_CODE_API_KEY`, `COMMANDCODE_API_KEY` |
| CoreWeave Serverless Inference | `coreweave` | `COREWEAVE_API_KEY` |
| Fire Pass | `firepass` | `FIREPASS_API_KEY` |
| Ollama Cloud | `ollama-cloud` | `OLLAMA_CLOUD_API_KEY` |
| Yolo Auto | `yolo-auto` | `YOLO_AUTO_API_KEY` |

列出两个变量时二者皆可接受，第一个为主变量。

CoreWeave Serverless Inference 还需在添加前把 `COREWEAVE_PROJECT=<team>/<project>` 设置到 DSH 进程环境中。

</details>

## 文档

| 文档 | 内容 |
|---|---|
| [开发](docs/development.zh-CN.md) | 构建与开发工作流、仓库布局 |
| [发布](docs/release.zh-CN.md) | CI 检查与 npm 发布流程 |
| [已知限制](docs/known-limits.zh-CN.md) | 当前设计边界，含七条传输路由 |
| [传输包（英文）](packages/llm-omp/README.md) | 传输路由：支持状态、风险、构建/测试与发布 |

英文版本：[README.md](README.md) 及 `docs/` 下的 `*.md` —— [Development](docs/development.md) · [Release](docs/release.md) · [Known limits](docs/known-limits.md)。当前设计边界速览：[已知限制](docs/known-limits.zh-CN.md)。

## 许可证

基于 [MIT 许可证](LICENSE) 发布。
