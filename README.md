# 国科大硕士学位英语（慕课学习）自动刷课脚本 · 2026 秋季版

自动完成课程中的**视频任务点**（2 倍速播放、防暂停、防自动跳节），只需一个课程章节 URL 即可刷完整门课。Quiz/测验需要自己完成。

> 基于原项目 [kejaly/ucas_english_mooc](https://github.com/kejaly/ucas_english_mooc) 及其 2026 春季适配版思路，针对 2026 年秋季页面结构重新适配。

## 使用

```bash
npm install
node main.mjs
```

- 首次运行会弹出 Edge 窗口并自动登录（如遇验证码，请在窗口中手动完成，脚本会等待）。
- 登录态保存在 `.profile/` 目录，之后重跑**无需再登录**。
- 中途可直接关掉浏览器窗口或 Ctrl+C 中断，进度保存在服务端，重跑自动续。
- 视频不能跳进度（服务器会拒绝 seek 并回跳），脚本按顺序以 2 倍速真实播放；约播放到 72% 时服务器即判定完成。

### 边用电脑边刷

- 可以切换窗口、最小化、锁屏，视频继续播；脚本每 0.7s 自动恢复被暂停的播放（对抗鼠标移走/失焦检测）
- ⚠ **别让电脑睡眠**：建议插电 + 关闭自动睡眠（macOS 可用 `caffeinate -i node main.mjs` 防休眠）
- ⚠ 脚本运行期间**不要在其他浏览器打开同一课程页面**（会触发平台冲突重载，导致章节加载失败）
- 后台窗口时浏览器会节流定时器，倍速偶尔被重置、恢复略慢（秒级），对整体进度影响很小

### 配置

账号等私密信息不写入代码仓库。首次使用：

```bash
cp config.example.mjs config.mjs   # Windows: copy config.example.mjs config.mjs
```

编辑 `config.mjs`，填入以下三个参数：

| 变量 | 说明 |
|---|---|
| `url_login` | 课程章节页 URL（获取方法见下） |
| `edge_path` | 浏览器可执行文件路径（获取方法见下） |
| `username` / `password` | 学习通手机号与密码（获取方法见下） |

`config.mjs` 已被 `.gitignore` 排除，不会被提交。

以下获取方法参考 [kejaly 原项目说明](https://github.com/kejaly/ucas_english_mooc)，已按 2026 年秋季实测更新。

#### 1、获取 url_login

1. 访问国科大在线：https://mooc.ucas.edu.cn/portal
2. 校内登录 → 信息门户登录
3. 登录后回到 https://mooc.ucas.edu.cn/portal → 进入个人空间 → 选择“硕士学位英语（慕课学习）”→ 点击章节 → 随便进入一个章节，复制浏览器地址栏的 URL（就是 `url_login` 参数）

#### 2、获取 username 和 password

就是**学习通账号的手机号和密码**（与信息门户登录共用一套）。

验证方法：在浏览器**无痕模式**下访问上面复制的 `url_login`，会重定向到登录页——2026 年秋季实测为 `https://passport2.chaoxing.com/login`（老版本为 `passport.mooc.ucas.edu.cn`，现已不用）。能在这个页面正常登录的手机号和密码，即可填入 `config.mjs`。

#### 3、获取 edge_path

浏览器可执行文件路径。仅支持 Chromium 内核浏览器（Chrome、Edge、Brave 等），Firefox 和 Safari 不行。

- **Windows**（默认）：`C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`，正常来说不需要修改
- **macOS**（默认 Chrome）：`/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`
- 也可使用 Playwright 自带的 Chromium：删掉 `main.mjs` 中 `executablePath: edge_path` 那一行，然后执行 `npx playwright install chromium`

### 运行参数

倍速等运行参数在 `main.mjs` 顶部调整；环境变量 `MAX_SECTIONS=1` 可只跑 1 节（测试用）。

## 与旧版（2026 春季适配）的差异

| 项目 | 旧版 | 本版（2026 秋实测） |
|---|---|---|
| 课程树 | `#coursetree .ncells` | 回退为 `#coursetree div.posCatalog_select`（叶子节点带 `span.posCatalog_name[onclick=getTeacherAjax]`、`input.jobUnfinishCount`，完成标记 `span.icon_Completed`） |
| 登录页 | `passport.mooc.ucas.edu.cn` | `passport2.chaoxing.com/login`（表单占位符不变） |
| 文档端点 | `/ananas/job/document` | `/mooc-ans/job/document`（`documentJob.js` 内逻辑） |
| 文档任务 | 按计分任务点处理 | 当前课程中文档**非计分任务点**（iframe `data` 仅有 `_jobid` 无 `jobid`），脚本仅在 `job:true` 时才上报，兼容未来变化 |
| 上报接口 | `multimedia/log` | 不变：`/mooc-ans/multimedia/log/a/{cpi}/{enc}`，约每 60 秒一次，响应含 `isPassed` |
| 会话管理 | 每次全新浏览器 | **持久化 profile**（`.profile/`），只登录一次 |
| 进度机制 | seek 不可用未知 | 实测确认 **seek 会被服务器拒绝并回跳**，必须顺序播放 |

## 技术实现

- **视频**：点击 Video.js 原生大播放按钮让页面自身逻辑正常上报；每 0.7s 强制 `playbackRate=2`（覆盖播放器重置）+ 轮询恢复播放（对抗鼠标移走/失焦暂停）；拦截 `ended` 事件并覆盖 `player.trigger`，防止播完自动跳节。
- **完成判定**：`page.on('response')` 监听 `multimedia/log` 响应，`isPassed:true` 即完成（实测约 72% 进度时翻转）。
- **文档**：从 iframe `data` 属性读 `jobid`，仅当对应 `mArg` attachment `job:true` 时 GET `/mooc-ans/job/document`。
- **循环**：每轮重新扫描课程树取第一个未完成小节；真实失败最多重试 3 次，90 秒冷却防止重复复查；树自动刷新（实测服务端确认后约 1-2 分钟内 `icon_Completed` 出现）。
