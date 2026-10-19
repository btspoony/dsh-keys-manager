# 发布

[English](release.md) | **简体中文** — 返回 [README](../README.md)

## CI

CI（`.github/workflows/ci.yml`）运行 typecheck、build、测试，以及对 `lib/index.js`、`lib/client.js`、`bundle/cordis.patch.yml` 的 packed tarball 断言。

## 发布流程

发布由 PR 驱动：

1. Actions → **Release prep** → Run workflow。版本留空表示自动 patch 升级，或传入 `X.Y.Z` / `X.Y.Z-prerelease`。
2. 工作流升级 `package.json` 版本、从 git log 更新 `CHANGELOG.md`、校验构建，并打开 `release v<version>` PR。
3. 合并发布 PR。**Release** 工作流把 `dsh-keys-manager@<version>` 以 provenance 发布到 npm、推送 `v<version>` 标签，并创建 GitHub Release。

## npm 发布

npm 发布使用 OIDC trusted publishing（无需 `NPM_TOKEN`）。首次发布前，在 npmjs.com 上为本仓库与 `Release` 工作流配置 Trusted Publisher。预发布版本发布到 prerelease dist-tag，不会移动 `latest`。

## Actions 创建 PR 的权限

Release prep 工作流用 `GITHUB_TOKEN` 打开 PR。如果仓库禁用了 Actions 创建的 PR，请启用 **Settings → Actions → General → Allow GitHub Actions to create and approve pull requests**，或把工作流指向细粒度 PAT secret。
