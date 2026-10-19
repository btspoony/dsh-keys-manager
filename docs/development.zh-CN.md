# 开发

[English](development.md) | **简体中文** — 返回 [README](../README.md)

## 前置要求

- Node `^22.19 || >=24`
- pnpm

## 命令

```sh
pnpm install
pnpm typecheck
pnpm build
pnpm test
```

- `pnpm typecheck` 对 Host、Client 与 spec 三份 tsconfig 运行 `tsc --noEmit`。
- `pnpm build` 执行 Node 侧 `tsc` 构建（`lib/`）、生成 Client 声明、用 esbuild 打包 Client，并校验包清单解析到的每个产物。
- `pnpm test` 运行 Vitest 测试套件。

## Host 与 Client 两侧

Host 侧是普通的 ESM Cordis function 插件。Client 侧是普通的 slot 插件；`scripts/build-client.mjs` 只在打包时把它包进 `window.__ModuleLoader__.load` 闭包，因此源码可以被测试直接导入。

## 仓库布局

| 文件 | 职责 |
|---|---|
| `src/index.ts` | Host 插件：凭据 broker、选择、故障切换、设置写入、Remote 命名空间 |
| `src/core.ts` | 纯轮询、冷却、状态与校验策略 |
| `src/store.ts` | 无密钥持久化状态与原子写入器 |
| `src/providers.ts` | 额外内置提供商目录 |
| `src/domain.ts` | Host/Client 共享领域结构 |
| `src/client/index.ts` | Client 在 plugin-detail 与 Models 插槽上的注册 |
| `src/client/ui.ts` | 管理器页面、key 行、表单与 Models 徽标 |
| `src/client/store.ts` | Client 快照存储与 RPC 调用 |
| `tests/core.test.ts` | 策略与存储测试 |
| `tests/host.test.ts` | Host 服务、接管、故障切换与无密钥持久化测试 |
| `tests/client.test.ts` | 注册、locale 对等与 Client 存储测试 |
