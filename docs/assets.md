# 素材与许可

通用深海背景、声球、角色插画、入口图标及星图纹理由本项目通过image_gen生成，用于默认界面。角色使用蓝发、鲸鳍耳饰与深蓝白配色。

公开默认QQ贴纸由`scripts/generate-stickers.mjs`绘制，为10张通用卡通主题图片。脚本可在安装Sharp后重新生成图片与预览；输出目录可以通过环境变量`DAFEIYU_STICKER_OUTPUT`和`DAFEIYU_STICKER_PREVIEW`指定。

运行者可在本机插件数据目录设置自己的图片、表情和触点声音。这些素材使用者自行管理来源与许可。

- 角色提示词：保留上游MIT许可，见`assets/persona-LICENSE`。
- Tabler图标：MIT，见`assets/icons/LICENSE`。
- 记账挂件代码：dsh-whale-widget 0.4.2，MIT。原始许可与来源保留；当前默认美术与短提示音由本项目生成，见`vendor/widget/ASSET_ADAPTATION.md`。

## README 配图

`docs/images/`中的三张手绘白板图由内置`image_gen`生成，说明系统架构、记忆读写与情绪语音链路。图内关系按当前实现核对，标明VoiceStudio、audio.cpp、Breeze TTS 2、NapCatQQ及OneBot v11等参考技术；服务能力以实际配置与代码为准。最终细化提示词见[diagrams.json](images/diagrams.json)。

- `architecture.png`：DSH、插件、语音服务、QQ网关和本机数据的边界。
- `memory-flow.png`：回复前召回、来源持久入队、事实提取与压缩保护。
- `emotional-voice-flow.png`：台词清洗与情绪判断、本地/API合成分路、校验与调速。

四张`demo-*.png`截图使用项目实际`client.js`、样式和公开素材，在独立演示环境中渲染。人物、配置、记忆、消息和服务状态均为虚构示例，画面顶部标明产品演示；用于介绍界面布局。演示环境不接通实际模型、QQ、语音服务或麦克风。
