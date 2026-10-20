# 发布

[English](release.md) | **简体中文** — 返回 [README](../README.md)

## CI

CI（`.github/workflows/ci.yml`）先运行根包 typecheck、build、测试，以及对 `lib/index.js`、`lib/client.js`、`bundle/cordis.patch.yml` 的 packed tarball 断言；随后运行 `dsh-llm-omp-transports` workspace 包的 typecheck、build、测试与 drift manifest 校验。

工作流会在测试套件之前安装固定版本的 `@deepseek-ai/dsh`（`0.2.1-rc.2`），并在最后执行显式的安装/装载证明步骤（`vitest run tests/install.test.ts`）：本地打包两个 tarball、把根插件装进全新 profile，组合后的 loader 树必须同时包含两个组件。只有该步骤设置 `INSTALL_PROOF=required` 时，缺少 `dsh` 或 `pnpm` 才会直接失败而不是跳过；先前的 `Test` 步骤排除该文件，发布工作流以普通套件运行且不带该变量——它们不安装 CLI，因此跳过该证明而不是在发布前失败。

## 发布流程

发布由 PR 驱动：

1. Actions → **Release prep** → Run workflow。版本留空表示自动 patch 升级，或传入 `X.Y.Z` / `X.Y.Z-prerelease`。传输包版本可选：留空表示按其独立版本线自动 patch 升级，传入 `X.Y.Z` / `X.Y.Z-prerelease` 可固定版本，传入 `skip` 则不升级该包。
2. 工作流升级两个 `package.json` 版本（传输包独立升级）、从 git log 更新根包 `CHANGELOG.md`、校验构建，并打开 `release v<version>` PR。
3. 合并发布 PR。**Release** 工作流把 `dsh-keys-manager@<version>` 与 `dsh-llm-omp-transports@<传输包版本>` 以 provenance 发布到 npm（传输包版本若已从本仓库历史中的提交发布则跳过）、推送 `v<version>` 与包名标签 `dsh-llm-omp-transports@<传输包版本>`，并创建 GitHub Release。

## 传输包

`packages/llm-omp` 随同一个发布 PR 发布 `dsh-llm-omp-transports`，但走独立版本线。根包依赖它，因此 `pnpm pack` 会把 `workspace:^` 改写成 semver 范围，已发布的根包 tarball 要求对应的传输包版本。

- `scripts/prepare-release.mjs` 每次运行都会 patch 升级传输包版本。`--transport X.Y.Z` 固定版本，`--skip-transport` 保持不动，`--dry-run` 只校验并打印两个包的版本与标签、不写文件。工作流把同样的选择暴露为可选的 `transport_version` 输入（`skip` 或 `X.Y.Z`）。
- 传输包没有生成的 changelog。`CHANGELOG.md` 及其 `## [<version>]` 小节只属于根包；传输包由自己的 README 与 git 历史描述。
- `release.yml` 在传输包的确切 `package.json` 版本已发布、且其记录的提交是本仓库历史中的祖先（ancestor）时跳过发布，因此重跑或只发布根包都是幂等的；记录的提交不属于本仓库历史时该步骤失败。打标签步骤总会确保 `dsh-llm-omp-transports@<version>` 存在。
- 传输包预发布版本与根包使用同样的派生 dist-tag 规则（`X.Y.Z-alpha.1` → `alpha`），不会移动 `latest`；release prep 只拒绝派生出非法 tag 的预发布版本。

## npm 发布

npm 发布使用 OIDC trusted publishing（无需 `NPM_TOKEN`）。首次发布前，在 npmjs.com 上为本仓库与 `Release` 工作流配置 Trusted Publisher。**每个发布的包都需要各自的 Trusted Publisher**：`dsh-keys-manager` 与 `dsh-llm-omp-transports` 是两个 npm 包，一个 publisher 条目不会覆盖另一个。预发布版本发布到 prerelease dist-tag，不会移动 `latest`。

`Release` 工作流会**先**发布传输包、后发布根包，且传输包步骤不依赖根包任何东西：它失败时根包发布不会执行。这是有意的——传输包是已安装根包的真实依赖，只发布一半比完全不发布更糟——但也意味着传输包一侧的 npm 问题会阻塞根包。先修好传输包再重跑：其确切版本已在 npm 上、且来自本仓库历史中的提交时，该步骤会自行跳过。

## Actions 创建 PR 的权限

Release prep 工作流用 `GITHUB_TOKEN` 打开 PR。如果仓库禁用了 Actions 创建的 PR，请启用 **Settings → Actions → General → Allow GitHub Actions to create and approve pull requests**，或把工作流指向细粒度 PAT secret。
