# 发版流程（维护者）

> 普通用户不需要看这里；安装/使用见 [README.zh.md](README.zh.md)。

## 一次性配置（已完成）

- npm 包已由本地首次发布创建：`dsh-gemini-tool-schema`。
- npmjs.com → 该包 → **Settings → Trusted Publisher** 已绑定 GitHub Actions：
  `ChenXu233` / `dsh-gemini-tool-schema` / `publish.yml`，并**允许 `npm publish` 动作**。
  - 只允许 `stage publish` 时，CI 会以 `403 OIDC permission denied for this action` 失败 —— 那是权限勾选问题，不是配置写错。
- 之后不需要任何 token：CI 用 OIDC 身份换取一次性发布权限，并自动附 **SLSA provenance** 签名。

## 每次发版

```sh
# 1. 改版本号（同时同步 lockfile）
npm version patch --no-git-tag-version     # 或 minor / major
npm install --package-lock-only

# 2. 提交并打 tag，推送即触发发布
git add -A && git commit -m "chore(release): v$(node -p "require('./package.json').version")"
git tag v$(node -p "require('./package.json').version")
git push origin main && git push origin --tags
```

CI（`.github/workflows/publish.yml`）会跑测试 → 构建 → `npm publish --provenance --access public`。

## 两个已知现象（都不是 bug）

1. **发布成功后 registry 可能短暂查不到**：npm 会提示 "Your package is being processed and may take a few minutes to become available"。
   本地缓存也会滞后，检查时加 `--prefer-online`：
   ```sh
   npm view dsh-gemini-tool-schema@<version> version --prefer-online
   curl -s https://registry.npmjs.org/dsh-gemini-tool-schema | grep -o '"<version>"'
   ```
2. **首次创建全新包会留下一个 `0.0.0-stage` 占位版本**：这是 npm 新版 staged publishing 的行为，不影响安装（`latest` 指向真实版本）。

## 校验一次发布

```sh
npm view dsh-gemini-tool-schema@<version> dist.attestations   # 应含 provenance / SLSA
npm i -D dsh-gemini-tool-schema@<version> --prefer-online
```

## 本地手动发布（仅在 CI 不可用时）

`npm publish --access public` 会提示输入 2FA 一次性验证码。
**注意**：不要把 `provenance: true` 写进 `publishConfig` —— 本地没有 CI provider，会直接 `EUSAGE: Automatic provenance generation not supported for provider: null`；provenance 只在 workflow 里用 `--provenance` 传。
