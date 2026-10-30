# dsh-dafeiyu-dot 内置挂件

基础：MeteorNOX / DeepSeek-Balance-Whale-Widget，npm 包 `dsh-whale-widget` 0.4.2。

来源：<https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget>。代码基于0.4.2，采用上游MIT许可证，完整保留LICENSE与PROVENANCE.md。当前随包提供的图片、动图与短提示音由本项目生成，来源和使用范围见[ASSET_ADAPTATION.md](ASSET_ADAPTATION.md)。

本集成在 `lib/index.js` 增加经白名单处理的挂件配置引导；在 `assets/whale-widget.js` 内接入头部、脸颊、鱼鳍点击、独立短句气泡、单路点击语音、全局停止协调和页面快捷入口。原有记账模块 `lib/accounting.mjs` 保持上游内容，其 SHA-256 为 `67f7e915455f8506e9aa1e4032801d7cc332d8a842291cd31271d659cfc5ad8a`。

账务路径、账户与凭据接入、余额请求、时段判断、用量计算、原挂件配置及 `/dsh-whale/*` 路由沿用上游实现。当前插件拥有该内置实例的生命周期；外部独立挂件应由安装迁移流程停用，以保证一个记账采样来源。
