# 发布与隐私

公开源码与运行数据分别保存。发布前检查整个项目树及实际归档；旧安装包、实机截图、个人音色录音、QQ身份与会话、配置文件和记忆文件都应留在本机私有目录。

本机自定义媒体位于插件运行数据目录的`assets/`下。源码中的默认角色图和主题贴纸为通用素材；新安装由使用者选择自己的音色与账号。

记账挂件还使用DSH数据目录下的`.dshw-*.json`、`whale-roles/`、`whale-audio/`及`whale-bubble-imgs/`，并兼容`profiles/web/`对应位置。它们属于本机运行数据。发布Git仓库时核对实际暂存清单与提交历史；npm文件白名单只约束安装包，不约束Git提交。

本地检查：

```sh
npm run privacy
```

维护者可以向检查器提供本机运行数据和额外私有清单，以精确检查身份、会话、音色、凭据和私有媒体哈希：

```sh
python3 scripts/check-release-privacy.py . \
  --runtime-dir "$DSH_HOME/dsh-dafeiyu-dot" \
  --private-manifest /path/to/private-manifest.json \
  --report /path/to/private-report.json --fail-on-risk
```

私有清单和报告放在项目外。输出仅报告相对路径和类别，不显示命中的私值。检查器同时检查tar/zip成员和媒体元数据；图片画面仍需结合来源与人工查看确认。

发布内容采用明确文件白名单，并对归档中的每个文件与源码比对。公开素材及第三方许可见[素材说明](assets.md)与[许可声明](../THIRD_PARTY_NOTICES.md)。本地检查通过后，公开发布仍由维护者决定。
