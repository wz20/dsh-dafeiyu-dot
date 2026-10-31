# 安装与配置

在DSH的插件安装入口输入`https://github.com/wz20/dsh-dafeiyu-dot`，确认安装并按提示启用，从侧栏「大肥鱼」进入配置中心。也可使用`dsh plugin --profile desktop add "https://github.com/wz20/dsh-dafeiyu-dot" --ignore-scripts`。本地开发继续支持`link:$PWD`安装。

1. **角色**：编辑名字、称呼和角色提示词；选择陪伴会话，开启鲸鱼娘模式。
2. **语音**：选择本地或API，填写兼容服务的地址、模型并选择自己的音色。API密钥通过密码输入保存至DSH凭据服务。首次配置可以先读取音色列表，再选择音色；检查连接后手动试听。
3. **记忆**：开启陪伴记忆，进入关系图查看、编辑与更正事实。复制完整宫殿目录可备份，须包含隐藏的`.state`目录。
4. **QQ**：启动支持OneBot正向WebSocket的本机网关，在配置页保存地址与令牌，选择陪伴会话，再使用主号完成配对。需要群回复时，单独启用该群，成员需真实@机器人。
5. **挂件**：按需开启显示与声音。触点文字可编辑，声音文件可放在本机插件数据目录的`assets/audio/`中。

本地兼容TTS默认地址是`http://127.0.0.1:3900/v1`，模型名`audiocpp`；应按自己的服务修改。其他API的情绪指令支持以服务文档和试听结果为准。语音识别使用DSH当前识别器，需要时在DSH准备识别模型。

本地情绪语音参考部署为[VoiceStudio](https://github.com/debpalash/VoiceStudio)的`audiocpp`引擎，通过[audio.cpp](https://github.com/0xShug0/audio.cpp)运行[Breeze TTS 2](https://github.com/breezeblue-ai/breeze-tts)。插件请求`POST /v1/audio/speech`，将朗读台词、音色及情绪指令分别放入`input`、`voice`、`instructions`。语气判断仅在开启情绪且使用本地`audiocpp`支持链路时执行。对话模型、音色和服务地址由使用者配置。

QQ参考部署使用[NapCatQQ](https://github.com/NapNeko/NapCatQQ)。在网关启用OneBot v11正向WebSocket服务后，由插件主动建立连接；接收数组格式的消息段，发送文字、语音和图片。网关独立运行，登录状态由其管理。

QQ网关默认WebSocket为`ws://127.0.0.1:13001`，NapCat管理地址默认为`http://127.0.0.1:16099`，实际端口应与部署一致。在插件QQ页点击「重新连接」或「扫码登录」，即可在弹窗中查看二维码、刷新及确认登录状态。首次在弹窗的「NapCat连接设置」保存管理地址与WebUI Token，密钥由DSH凭据服务保管；Token可从自己的NapCat启动记录或管理配置中获取。手机QQ确认登录后，插件自动检查并恢复原有消息通道，保留原来的账号绑定。其他OneBot网关可继续使用原有连接方式。网关、DSH和语音服务需要保持运行。

本机插件数据目录为`$DSH_HOME/dsh-dafeiyu-dot/`，未设置`DSH_HOME`时使用`~/.dsh/dsh-dafeiyu-dot/`。自定义角色预览可放在`assets/role-preview.png`，自定义表情使用`assets/stickers/catalog.json`及同目录图片。自定义媒体只由当前本机插件读取，静态角色图与触点声音使用已鉴权的资源路由。

用户确认的现成清唱可登记在本机插件数据目录的`recorded-songs.json`中，格式为`{"version":1,"defaultRecordingId":"song-one","recordings":[{"id":"song-one","song":"曲名","audioFile":"/absolute/path/song.wav","sha256":"已确认音频的SHA-256","approved":true}]}`。未点名歌曲时播放默认曲目，点名时按曲名或`aliases`精确匹配；每次返回的歌曲音频与已确认文件保持一致，并绑定当前会话供桌面重播或QQ发送。目录和个人音频保存在本机运行数据中。

通话入口位于会话顶栏电话图标及配置中心「语音通话」。点击开始后才打开麦克风；识别、思考与播放阶段暂停收音。可以静音、打断、挂断，展开文字区后可打字和切换会话模型。

记忆默认保存于插件本机数据目录的`memory-palace/`。已有部署的`memoryPalaceRoot`设置继续沿用；希望保存在工作区时可指定该选项，并将宫殿目录排除版本控制。

内置挂件的账务与偏好沿用`$DSH_HOME/.dshw-*.json`及`$DSH_HOME/profiles/web/`对应文件；上传媒体沿用`whale-roles/`、`whale-audio/`、`whale-bubble-imgs/`目录。这些位置位于DSH本机数据范围内，与主插件的`dataRoot`选项独立。主号QQ私聊继承所选DSH会话已启用的工具权限；群成员使用独立受限会话。
