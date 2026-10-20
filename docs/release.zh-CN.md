# 发布

[English](release.md) | **简体中文** — 返回 [README](../README.md)

## CI

CI（`.github/workflows/ci.yml`）先运行根包 typecheck、build、测试，以及对 `lib/index.js`、`lib/client.js`、`bundle/cordis.patch.yml` 的 packed tarball 断言；随后运行 `dsh-llm-omp-transports` workspace 包的 typecheck、build、测试与 drift manifest 校验。

## 发布流程

发布由 PR 驱动：

1. Actions → **Release prep** → Run workflow。版本留空表示自动 patch 升级，或传入 `X.Y.Z` / `X.Y.Z-prerelease`。传输包版本可选：留空表示按其独立版本线自动 patch 升级，传入正式 `X.Y.Z` 可固定版本，传入 `skip` 则不升级该包。
2. 工作流升级两个 `package.json` 版本（传输包独立升级）、从 git log 更新根包 `CHANGELOG.md`、校验构建，并打开 `release v<version>` PR。
3. 合并发布 PR。**Release** 工作流把 `dsh-keys-manager@<version>` 与 `dsh-llm-omp-transports@<传输包版本>` 以 provenance 发布到 npm（传输包版本若已发布则跳过）、推送 `v<version>` 与包名标签 `dsh-llm-omp-transports@<传输包版本>`，并创建 GitHub Release。

## 传输包

`packages/llm-omp` 随同一个发布 PR 发布 `dsh-llm-omp-transports`，但走独立版本线。根包依赖它，因此 `pnpm pack` 会把 `workspace:^` 改写成 semver 范围，已发布的根包 tarball 要求对应的传输包版本。

- `scripts/prepare-release.mjs` 每次运行都会 patch 升级传输包版本。`--transport X.Y.Z` 固定版本，`--skip-transport` 保持不动，`--dry-run` 只校验并打印两个包的版本与标签、不写文件。工作流把同样的选择暴露为可选的 `transport_version` 输入（`skip` 或 `X.Y.Z`）。
- 传输包没有生成的 changelog。`CHANGELOG.md` 及其 `## [<version>]` 小节只属于根包；传输包由自己的 README 与 git 历史描述。
- `release.yml` 只在传输包的确切 `package.json` 版本尚未发布到 npm 时发布它，因此重跑或只发布根包都是幂等的。打标签步骤总会确保 `dsh-llm-omp-transports@<version>` 存在。
- release prep 拒绝传输包预发布版本：传输包发布步骤尚无 dist-tag 规则，预发布版本会移动 npm 的 `latest`。请用正式 `X.Y.Z` 发布传输包。

## npm 发布

npm 发布使用 OIDC trusted publishing（无需 `NPM_TOKEN`）。首次发布前，在 npmjs.com 上为本仓库与 `Release` 工作流配置 Trusted Publisher。预发布版本发布到 prerelease dist-tag，不会移动 `latest`。

## Actions 创建 PR 的权限

Release prep 工作流用 `GITHUB_TOKEN` 打开 PR。如果仓库禁用了 Actions 创建的 PR，请启用 **Settings → Actions → General → Allow GitHub Actions to create and approve pull requests**，或把工作流指向细粒度 PAT secret。
