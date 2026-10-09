# K23-userscripts

自用的油猴（Tampermonkey）脚本。装一次，之后脚本有更新会自动同步到每台电脑。

## 脚本列表

| 脚本 | 作用 | 安装 |
| --- | --- | --- |
| [NodeSeek 图片上传助手（Lsky 自建图床）](nodeseek-lsky-uploader.user.js) | 在 NodeSeek 编辑器里粘贴、拖拽或点图片按钮，自动上传到自己的兰空图床，并插入 Markdown 图片链接 | [点此安装](https://raw.githubusercontent.com/K23Flux/K23-userscripts/main/nodeseek-lsky-uploader.user.js) |

## 安装

1. 浏览器先装好 [Tampermonkey](https://www.tampermonkey.net/)。
2. 点上面表格里的「点此安装」，在弹出的页面里确认安装。
3. 每台电脑、每个浏览器都要装一次。之后的更新由 Tampermonkey 自动拉取，也可以在它的管理面板里手动「检查更新」。

## NodeSeek 图片上传助手

**[➜ 点此安装脚本](https://raw.githubusercontent.com/K23Flux/K23-userscripts/main/nodeseek-lsky-uploader.user.js)**

点开后 Tampermonkey 会弹出安装页面。如果链接没有跳转，把下面的地址复制到浏览器地址栏打开：

```
https://raw.githubusercontent.com/K23Flux/K23-userscripts/main/nodeseek-lsky-uploader.user.js
```

### 第一次使用

不用设置 Token，也不用在脚本里输密码：**只要这个浏览器里登录过图床网页就能用**。

1. 在浏览器里打开图床（`https://lsky.ozoo.top`）并登录，登录时勾上「记住我」。
2. 打开 NodeSeek 的发帖或回复页面，编辑器工具栏右侧显示「Lsky 图床已就绪」就可以用了。
3. 如果显示的是「登录图床」按钮，说明这个浏览器里还没登录：点它会打开图床登录页，登录完回到 NodeSeek 即可。

脚本直接借用浏览器里图床的登录状态，自己不保存账号、密码和 Token。每台电脑、每个浏览器各自登录一次图床就行。

### 上传方式

- 在编辑器里直接粘贴截图或图片
- 把图片文件拖进编辑器
- 点工具栏上的图片按钮选择文件（可多选）

上传成功后会在光标处插入 `![](图片直链)`。

### 菜单

点浏览器工具栏的 Tampermonkey 图标，在脚本名下面可以看到：

| 菜单项 | 作用 |
| --- | --- |
| 检查登录状态 | 看看现在能不能上传 |
| 打开图床登录页 | 在新标签页打开图床登录 |
| 备用：用邮箱密码获取 Token | 网页登录用不了时，用图床账号换一个接口 Token 存在本机（密码不保存） |
| 备用：手动粘贴 Token | 已经有接口 Token（形如 `1|xxxxxxxx`）时直接粘贴 |
| 清除 Token（改回网页登录） | 删除本机保存的 Token |
| 设置存储策略 ID | 指定上传到哪个存储策略，留空用图床默认的 |
| 设置图床地址 | 改成别的兰空图床地址（见下一节） |

保存了 Token 时脚本优先用 Token；没有 Token 时用网页登录。

### 换成别的图床

脚本默认上传到 `lsky.ozoo.top`，这是私人图床，不开放给其他人使用。想用在自己的兰空图床（Lsky Pro V2 开源版）上，需要改两处：

1. 脚本头部的 `// @connect lsky.ozoo.top` 改成自己的域名，否则 Tampermonkey 会拦截请求。
2. 脚本里的 `DEFAULT_BASE` 改成自己的图床地址，或者在菜单「设置图床地址」里填。

自己改过的脚本建议删掉头部的 `@downloadURL` 和 `@updateURL` 两行，否则下次自动更新会被本仓库的版本覆盖。

### 常见问题

| 现象 | 原因和处理 |
| --- | --- |
| 出现「登录图床」按钮，或提示「还没登录图床」 | 这个浏览器里图床的登录过期了。点按钮登录，回到 NodeSeek 再传 |
| 明明登录了图床，脚本还是说没登录 | 浏览器或 Tampermonkey 没把图床的 Cookie 带上（比如图床是在隐身窗口、别的浏览器配置里登录的）。换用菜单里的「备用：用邮箱密码获取 Token」 |
| 提示「请求太频繁」 | 图床对接口做了限流，等一分钟再试 |
| 提示「图片太大」或图床返回的其他拒绝原因 | 超出了图床用户组的大小、类型或容量限制，到图床后台调整 |
| 提示「连不上图床」 | 图床没开，或者 `@connect` 里的域名和图床地址不一致 |
| 粘贴图片没反应 | 确认原版「NodeImage图片上传助手」已停用，两个脚本同时开会互相抢粘贴事件 |
| 工具栏没有出现状态文字 | 刷新页面；NodeSeek 改版后选择器可能失效，欢迎提 issue |

## 更新记录

### NodeSeek 图片上传助手

- **1.0.1**（2026-10-09）：默认改为借用浏览器里图床网页的登录状态，不用再设置 Token；Token 方式保留为菜单里的备用选项。
- **1.0.0**（2026-10-09）：首个版本。基于「NodeImage图片上传助手」1.0.2 改写，上传目标换成 Lsky Pro V2，认证改为接口 Token。

## 致谢与许可

- 「NodeSeek 图片上传助手」改写自 [NodeImage图片上传助手](https://greasyfork.org/scripts/542011)（作者 shuai，MIT 许可）。
- 本仓库的脚本以 [MIT 许可](LICENSE) 发布。
