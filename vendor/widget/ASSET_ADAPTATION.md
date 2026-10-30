# 挂件素材适配

本目录集成 dsh-whale-widget 0.4.2 的 MIT 代码。上游 `LICENSE` 与 `PROVENANCE.md` 保留其原文；后者记录上游发行版本的素材许可范围。本文件说明此项目当前随包提供的替换资源。

## 公开素材

- `assets/DSniang1.png`、`DSniang02.png`：由项目通用角色插画 `assets/portrait.png` 等比缩放。
- `assets/DSH2.png`：使用项目生成的通用海洋背景。
- `icon.png`：使用项目生成的入口图标。
- `assets/rua.gif`、`bubble-petpet.gif`、`bubble-money1.gif`：由项目代码绘制的通用表情转换为 GIF。
- 四个 MP3 与五个 WAV：由正弦波和淡入淡出包络合成的短提示音，无人声或外部采样。WAV 为 24kHz、单声道、PCM16；MP3 由 FFmpeg 编码并去除标签。

这些替换资源由本项目生成，按仓库的 MIT 许可提供。旧文件名与预设 ID 保持兼容；`minecraft-exp-orb.wav` 对应预设的显示名称为“清脆提示音”。声音是项目合成的提示音。

## 本机自定义

媒体解析先读取 `$DSH_HOME/dsh-dafeiyu-dot/assets/widget/<文件名>`，缺失时再读取包内同名资源。运行用脚本始终来自包内代码，自定义媒体目录不能覆盖脚本。插件列表图标由包内 `icon.png` 提供。

个人图片、声音和账户数据应留在本机数据目录。公开代码、默认素材与本机自定义媒体分别管理。

## 重新生成

开发环境安装 Python、Pillow 和 FFmpeg 后，在项目根目录运行：

```sh
python3 scripts/generate-widget-assets.py
```

生成脚本只读取本项目通用图片和代码贴纸，不读取本机自定义目录，不通过扬声器播放声音。使用 `--destination` 可将结果输出到独立的验证目录。正常使用插件无需 Python、Pillow 或 FFmpeg 来加载这些已生成文件。
