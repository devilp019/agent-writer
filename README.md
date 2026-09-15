# Agent Writer

SillyTavern 扩展：**原生草稿 → 校验 → 重写** 三稿流水线。

当前版本 **0.8.0**。

---

## 它要解决什么

DeepSeek V4.1 Flash 在 RP 上有个矛盾：

- **关思考** → 文笔很好，但缺剧情推理，容易出逻辑 bug
- **开思考** → 思维链一直在推理剧情，不做文字整理，写出来的不是人话

所以流程改成三稿：

| 阶段 | 做什么 | 用什么 |
|---|---|---|
| ① 草稿 | 正常生成，靠它出文笔 | 酒馆原生生成（你当前连接），**关思考** |
| ② 校验 | 只找逻辑问题，输出问题清单 | 独立配置，**开思考** |
| ③ 正文 | 按清单改稿，保住原稿文风 | 独立配置，**关思考** |

②③ 各有一份独立的渠道配置（地址 + 密钥 + 模型 + 请求体附加字段），
所以「①②③ 全用官方 API 只改思考开关」和「② 换一个便宜渠道」都支持。

### 为什么三阶段都在酒馆里跑（而不是自己拼提示词）

你的 ②③ 是**同一个模型的不同调用**，上下文就是整段聊天记录。

自己拼提示词的话，②③ 的前缀和 ① 完全不同，**前缀缓存必然失效**，每次重发整份提示词。
走酒馆的完整组装（预设 + 世界书 + 角色卡 + 历史）则三阶段共用同一份前缀 ——
这对长上下文很关键：缓存命中的输入价是未命中的 **1/50**（DeepSeek 官方定价）。

同理，②③ 连续跑时命中的是**上一次 ② / ③ 自己的前缀**，所以即使 ② 换到别的渠道，仍然吃得到它自己的缓存。

---

## 安装

### 前置依赖：酒馆助手（JS-Slash-Runner）

**必需。** ②③ 走的是它的 `generate()`，没装整个流水线跑不了。启动时会检测并弹提示。

### 从 GitHub 安装

1. 酒馆 → **扩展** → **安装扩展** → 粘贴本仓库地址 → 安装
2. 刷新页面

### 手动放置

整个文件夹放到 `SillyTavern/data/<你的用户名>/extensions/agent-writer/`，
或 `SillyTavern/public/scripts/extensions/third-party/agent-writer/`。

> `manifest.json` 必须在**仓库根目录**，ST 的安装按钮靠它在根目录识别扩展。

---

## 首次配置

### 一、建两个预设槽位（必做，否则 ②③ 直接失败）

在酒馆的**预设编辑器**里新建两个条目，名字和面板里填的一致（默认 `AW-校验` / `AW-改写`）。

**为什么必须手工建条目，而不是把指令塞到历史末尾：**

注入到历史末尾的指令，盖不住预设里**更靠后**的强提示词（比如「推进剧情」「扮演角色」）。
模型会因为更靠后的指令而出现分歧，有概率不好好做校验、直接输出后续剧情。
只有预设条目能控制指令的**位置**和**身份** —— 所以由你决定这两个条目放在哪。

**放置建议：**

- 放在**靠后、但仍在聊天记录之下**的位置：既能压住前面的剧情类指令，又不会抢在历史之前
- 身份用 `system`
- 内容留空即可。扩展每次调用前写入、跑完还原（连启用状态一起还原）

### 二、配思考开关

思考开关在面板每个阶段的**「附加请求体字段 JSON」**里（没有下拉框）。

DeepSeek 官方 API 的写法：

```jsonc
// 关思考（①②③ 里的 ① 和 ③）
{ "thinking": { "type": "disabled" } }

// 开思考（② 校验）
{ "thinking": { "type": "enabled" }, "reasoning_effort": "low" }
```

> **`reasoning_effort` 只调「想多久」，不负责开关。** 想关掉必须用 `thinking`。
> 这是接 Cline 时踩过的坑 —— Cline 完全忽略 `reasoning_effort`。
>
> ② 建议配 `reasoning_effort: "low"`：开思考时正文会变啰嗦，但 ② 的产出只是给 ③ 的修改意见，
> 不需要长篇大论，压一压还能省钱。

### 三、换渠道（可选）

每个阶段可以单独指定渠道，优先级从高到低：

1. **API 地址 + 密钥** —— 最通用，指向任意 OpenAI 兼容端点
2. **酒馆代理预设** —— 但酒馆的代理预设是**挂在具体厂商下面**的（DeepSeek / Gemini 等），
   没法指向自定义端点，多数情况下用不了
3. **都不填** —— 用当前连接

地址填 **base 地址**（例如 `https://api.deepseek.com`）就行，`/chat/completions` 由酒馆自己补。
已经写全端点的写法也认。

> ⚠️ 密钥必须是真正的 **API key**，不能拿「账号登录 token」顶替。
> Cline 这类服务两种凭据不通用 —— 拿插件里那个 token 去调它的 API 会得到 401，
> 而且报错文案会误导你去重装 Cline。真正的 API key 在 app.cline.bot 的 Settings → API Keys 里建。

---

## 使用

两个入口，**没有扩展设置抽屉**：

1. **悬浮球** —— 同时是状态灯，点一下开/关面板。可拖动，自动吸附到最近的屏幕边缘
2. **扩展菜单项** —— 在扩展菜单里，右侧带行内状态

### 两种模式

- **自动**：你按发送键 → ① 酒馆原生生成 → 自动接 ②③
- **手动**：点面板里的「运行」，把**最后一条 AI 回复**当作草稿跑 ②③

### 悬浮球状态

| 状态 | 外观 | 含义 |
|---|---|---|
| 待命 | 紫色，4 秒慢呼吸 | 就绪 |
| 草稿 | 青色，呼吸 + 环慢转 | ① 酒馆正在生成 |
| 校验 | 紫色，呼吸 + 环快转 | ② 校验中 |
| 改写 | 琥珀，呼吸 + 环快转 | ③ 改写中 |
| 完成 | 绿色，扩散环（4 秒后回落） | 完成 |
| 出错 | 红色，抖动两次 | 出错 |
| 停用 | 灰色，静止半透明 | 自动模式已关 |

面板「参数」页有**状态演示**按钮，可以逐个预览，确认平板和手机上的表现。

> 系统开启「减弱动态效果」时，所有动画自动降级为只换颜色、不做位移。

---

## 自检与排错

平板后端不方便开 devtools，所以内置了自检。**面板 → 参数**页：

| 按钮 | 作用 |
|---|---|
| 运行自检 | 环境、依赖 API、界面挂载点、视口 |
| 测试当前连接配置 | 真发一个 `max_tokens=8` 的请求验证链路（消耗极少额度） |
| 密钥来源对照 | 比对「酒馆里存的密钥」和「面板里填的密钥」指纹，定位 401 |
| **查看实际请求体** | **确认附加参数到底发出去没有** |
| 换渠道诊断 | 分别用两种密钥来源打同一个端点 |
| 请求体形状对照 | 从最干净的 body 逐层加字段，二分定位是哪个字段被上游拒 |

结果可以点「复制结果」，或直接截图。

### 「查看实际请求体」怎么读

数据来自酒馆发出请求前的 `CHAT_COMPLETION_SETTINGS_READY` 事件里那一份
`generate_data`（**注入之后**的快照），不是「我以为发了什么」。三种结果对应三种病因：

| 显示 | 含义 |
|---|---|
| ✘ 没认领到 | 附加参数根本没发出去 —— 槽位标记没进 messages，或酒馆没发这个事件 |
| ✔ 已认领，但「本次附加的字段」是 `{}` | 面板里那个阶段没填附加参数 |
| ✔ 已认领，字段也在，但模型行为不符 | 上游不认这个字段名（各家写法不一样） |

密钥类字段一律省略，不会出现在面板里。

### 出问题时

关键路径上的失败会**弹一个可见提示**（优先用酒馆的 toastr，拿不到就自绘角标）——
包括缺少酒馆助手、槽位没配、流水线中断、流水线抛错。不再只有控制台里一行。

如果连提示都没有，用调试入口：

```js
aw.show()          // 强制补挂并打开面板（最常用）
aw.diagnose()      // 环境自检
aw.getSettings()   // 看当前设置
awLastRequests()   // 最近一次各阶段实际发出的请求体
awProbeChannel()   // 换渠道诊断
```

---

## 文件结构

```
manifest.json      ST 扩展清单（必须在根目录）
index.js           入口：装配、生命周期钩子、触发钩子
config.js          设置读写（落盘 extensionSettings.agent_writer）
tavern.js          酒馆助手桥接：槽位注入、请求体字段注入、生成
pipeline.js        流水线：②③ 编排、写回楼层、请求体留档
stages.js          指令文本与校验结果处理
notice.js          可见的错误反馈（toastr / 自绘角标）
diagnostics.js     自检与各类连通性探测
state.js           状态机 + 订阅（球和菜单项的唯一状态源）
style.css          样式与动画
ui/
  fab.js           悬浮球：7 态动画、拖拽、触摸/鼠标双输入
  menu.js          扩展菜单项：多路容器探测 + 行内状态
  panel.js         面板：内联模板 + 渲染、拖拽、页签、日志
```

> 面板模板内联在 `ui/panel.js` 的 `PANEL_HTML` 里，**没有 settings.html**。
> 走 `renderExtensionTemplateAsync` 需要酒馆按扩展文件夹名解析模板路径，
> 路径一旦对不上会静默失败，表现为「悬浮球能点但面板打不开」。内联之后这条失败路径不存在。

### 为什么图标都用 inline SVG

不用 emoji。同一个 emoji 在 Android / iOS / Windows 上字形、基线、颜色都不一样，
而这个扩展要在平板、手机、电脑上通用。

### 为什么球的位置存在 localStorage

位置属于**纯客户端 UI 状态**。手机和电脑屏幕尺寸不同，把位置同步过去只会得到一个跑到屏幕外的球。

### 三处为了「坏不掉」做的设计

1. **三个挂载点各自独立 try**。球、菜单项、面板任一环炸掉都不能连累其它两环，失败会弹提示
2. **点球时就地补挂**。面板不在就地补挂并给出可见反馈，而不是毫无反应
3. **启动三重保险**。`APP_READY` 事件 + `onActivate` / `onEnable` 钩子 + 后台重试，谁先到都能拉起来

### 槽位注入的安全措施

槽位注入是**改用户预设**的操作，所以：

- 注入前备份（内容 + 启用状态），跑完在 `finally` 里还原
- 备份同时落盘，扩展启动时做一次**崩溃恢复**：万一上次没还原成功（刷新/崩溃/断电），
  残留在槽位里的内容会被当成正常提示词发出去，必须在启动时清掉

---

## 开发说明

只用 `SillyTavern.getContext()` 暴露的 API，**不深层 `import` ST 内部模块**。

### 开发工具在仓库外面

```
<工作区>/
├── agent-writer/          ← 上传到 GitHub 的只有这个目录
└── agent-writer-tools/    ← 本地开发用，永远不进扩展目录
```

**扩展目录里绝不能出现 `.mjs` / `_dev/` / `node_modules/`。**
烟测脚本会往 `globalThis` 上装一个假的 `document`，万一被酒馆当模块加载，整页会直接崩。

### 改完代码的流程

```bash
cd ../agent-writer-tools
node strip-bom.mjs          # 文件体检：BOM / 空文件 / NUL / 编码损坏
node check-version.mjs      # 版本号一致性 + 无开发工具残留 + 测试没写死版本
node check-imports.mjs      # 导入导出一致性
node test-pipeline.mjs      # 70 项：槽位注入/还原、崩溃恢复、事件注入、请求体留档
node smoke.mjs              # 99 项：面板、状态机、菜单项、可见报错、触摸事件
```

全绿再推。

### 推送需要代理

**直连 github.com 会被重置**（本机走 Clash Verge，系统代理 `127.0.0.1:7897`，
但 git 默认不读系统代理）。仓库级已经配好了：

```bash
git config http.proxy  http://127.0.0.1:7897
git config https.proxy http://127.0.0.1:7897
```

另外本机 git 的 schannel 后端在部分环境里会报
`AcquireCredentialsHandle failed: SEC_E_NO_CREDENTIALS`，
已改用 OpenSSL：`git config http.sslBackend openssl`。

推送凭证存在 Windows 凭据管理器里，由 Git Credential Manager 提供。

### 改版本号要同时改多处

`manifest.json` 的 `version`、`index.js` 的 `VERSION`、`ui/panel.js` 的 `VERSION`、
以及所有 import 的 `?v=`。`check-version.mjs` 会递归核对导入图，漏一处就报出来。

**为什么必须带 `?v=`**：浏览器按 URL 缓存 ES 模块。只改一处版本号会出现
「旧模块 + 新代码」混着加载，典型症状是**上一版还有悬浮球，这一版什么都没有**。

### 测试不许写死版本号

测试加载扩展模块时必须走 `load-ext.mjs` 的 `ext()`，由它现场从 `index.js` 读版本号。
写死会让测试和扩展各自加载出**两个互不相干的模块实例**（例如两个 `state.js`），
`setState` 设在一个上、组件读的是另一个，断言会以「看起来像功能坏了」的方式失败。
`check-version.mjs` 会拦住这种写法。

### 用 PowerShell 改文件要小心

本项目已经因为 PowerShell 的默认编码踩过三次静默损坏，每次症状都不同：

| 操作 | 后果 | 症状 |
|---|---|---|
| `Set-Content -Encoding UTF8` | 写进 BOM | `manifest.json` 直接 `JSON.parse` 失败，酒馆读不到扩展 |
| `Get-Content -Raw`（不带 `-Encoding`） | 按 ANSI/GBK 读中文 | 读坏了再写回去，文件变乱码 |
| `cmd /c "... > file"` | 按 UTF-16 重定向 | 文件变成一堆 NUL 字节，模块加载直接失败 |

**改完一律跑 `node strip-bom.mjs ..\agent-writer`** —— 它会拦下 BOM、空文件、
NUL 字节和 `U+FFFD` 编码损坏四种情况。另外 `Get-Content` / `Set-Content`
一定要显式带 `-Encoding UTF8`。

---

## 已知限制

- 需要 SillyTavern **≥ 1.18.0**
- 需要 **酒馆助手（JS-Slash-Runner）**，未安装则 ②③ 不可用
- ② 的密钥以明文存在扩展设置里（跟随酒馆账号）。不分享设置文件则只影响你自己
- 中止生成依赖 `stopGenerationById`，部分上游不吃这套

---

## 上游实测笔记：Cline（api.cline.bot）

这几条都是直连探针实测出来的，不是推测。留着免得重复踩。

### 1. 401 的真正原因：`custom_api.key` 这条路送出去的凭据不对

**已修（0.8.3）。** 记在这里是因为排查过程绕了很多弯，值得留下。

同一个 key、同一个端点，用面板的「换渠道诊断」并排跑两种形状：

| 形状 | 怎么送凭据 | 结果 |
|---|---|---|
| A | `custom_api.key` | `HTTP 400 Unauthorized: … re-authenticate your Cline account` |
| B | 顶层 `custom_include_headers` | `HTTP 200` |

读 TavernHelper 源码确认了机制（`src/function/generate/responseGenerator.ts:190`）：

```js
if (customApi.apiurl) {
  generateData.reverse_proxy  = normalizedApiUrl;
  generateData.proxy_password = customApi.key || '';   // ← 对 custom 源不起作用
  if (chat_completion_source === 'custom') {
    generateData.custom_url = normalizedApiUrl;
    if (customApi.key) {
      generateData.custom_include_headers =
        overrideCustomAuthorizationHeader(..., customApi.key);   // ← 问题在这
    }
  }
}
```

酒馆后端对 `custom` 源**只看 `custom_url` + `custom_include_headers`** 决定送什么凭据，
`proxy_password` 那条路对 custom 不起作用。而它替我们拼出来的那份 Authorization 头，Cline 不认。

**现在的做法：显式传 `custom_include_headers`，让酒馆原样合并。** 两个要点：

1. **不能再同时传 `key`** —— 否则 `proxy_password` 也会被设上，行为不可预期。测试里钉了一条断言。
2. **值只放裸 key** —— TavernHelper 会自己拼成 `` `Bearer ${key}` ``。我在值里带了 `Bearer`，
   会变成 `Bearer Bearer sk_...`。这条是测试抓出来的。

> 排查过程中另外三个被证伪的假设，一并留着免得重走：
> - **不是额度**。曾经因为「同一个 key 前一刻全 200、后一刻全 401」就断定是额度限制。
>   后来同一个 key 在直连探针里始终 200、在扩展里始终 401 —— 与额度无关。
>   **不要用时间相邻推因果。**
> - **不是 key 类型**，也不是账号问题。直连探针一开始就证明了这个 key 可用。
> - **不是模型名**。`cline-pass/deepseek-v4-flash` 与 `cline-pass/deepseek-v4.1-flash` 都能通。

### 怎么把「上游的问题」和「酒馆转发的问题」分开

先跑直连探针。如果它通过，问题就一定在酒馆这一侧，别再去查上游账号：

```bash
cd ../agent-writer-tools
$env:AW_KEY='你的key'
node probe-endpoint.mjs --model cline-pass/deepseek-v4-flash
```

然后点面板里的 **「换渠道诊断」**，它会用面板里 ② 的实际配置，并排打两种形状（见上表）。

### 2. 非流式响应多包了一层 `data`，酒馆解析不到正文

```jsonc
// Cline 非流式实际返回：
{ "data": { "choices": [ { "message": { "content": "OK" } } ] } }
//                 ↑ 标准结构被包在这里面

// 酒馆读的是：
choices[0].message.content      // ← 顶层没有 choices，拿到空字符串
```

表现就是 **HTTP 200、请求成功、但正文是空的**，只看状态码会得到一个假的成功信号。

**修法：把该阶段的「流式」打开。** 实测流式分片是标准 OpenAI 格式，没有那层包裹：

```
分片总数          83
被包 data 的分片  0        ← 干净的
带 content 的分片  20
带 reasoning 的分片 61
```

### 3. Cline 无法关思考

`thinking: { type: 'disabled' }` 和 `reasoning_effort: 'none'` **都被静默忽略** —— 不报错，也不关。同一道题跑三遍的 reasoning 分片数：

| 请求 | reasoning 分片 |
|---|---|
| 不传任何参数 | 96 |
| `thinking.type = disabled` | 111 |
| `reasoning_effort = none` | 112 |

**所以 Cline 只能放在②这类本来就要开思考的阶段。** ③ 必须靠「关思考」才有好文笔，放 Cline 会得到边写边盘算剧情的正文 —— 正是要避免的那种。

### 4. 附加字段必须写**能解析的** JSON —— 「加尾逗号绕过过滤」是错的

流传过一个做法：把附加字段写成不严格的 JSON（故意留尾逗号），
据说能让酒馆跳过解析、把字段原样转发给上游。

**实测是反的，而且这个做法会让所有附加字段静默失效。**

酒馆后端对 custom 源的处理（`src/endpoints/backends/chat-completions.js:2409`）：

```js
bodyParams = { logprobs, top_logprobs };
mergeObjectWithYaml(bodyParams, request.body.custom_include_body);   // ← 合并
...
requestBody = { model, messages, ..., ...bodyParams };               // ← bodyParams 原样展开
```

而 `mergeObjectWithYaml` 内部是 try/catch：

| 情况 | 行为 |
|---|---|
| 解析成功 | `Object.assign` → 字段**全部**进请求体 |
| 解析失败 | catch 里什么都不做 → **一个字段都不加** |

**它是合并，不是过滤。** 不认识的字段（例如 `providerOptions`）根本不会被丢掉，
所以不需要任何「绕过」技巧。而尾逗号让解析失败，结果：

- 带尾逗号 → 上游回 `{"error":"Error parsing request"}`，或者附加字段全部消失
- 去掉尾逗号 → 立刻正常

写严格 JSON 就行。

### 5. 那个模型名

`cline-pass/deepseek-v4-flash` 可用（Cline 侧实际路由到 `vmc/deepseek-v4-flash-contributor-fallbacks`）。
`cline-pass/deepseek-v4.1-flash` 这个写法**没验证过**，别想当然。

### 怎么自己复现这些结论

仓库外的 `agent-writer-tools/probe-endpoint.mjs` 是直连探针，绕开酒馆和扩展：

```bash
cd ../agent-writer-tools
$env:AW_KEY='你的key'
node probe-endpoint.mjs --model cline-pass/deepseek-v4-flash          # 逐层加字段二分
node probe-endpoint.mjs --model cline-pass/deepseek-v4-flash --stream-shape   # 看流式分片结构
node probe-endpoint.mjs --model cline-pass/deepseek-v4-flash --thinking       # 验关思考有没有效
```

**「上游的问题」和「酒馆转发的问题」必须先分开**，否则会一直在错误的地方找原因。
