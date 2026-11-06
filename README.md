# dsh-welcome-bypass

桌面端（DeepSeek Harness Desktop）每次启动都会先弹出一个「添加一个 API Key 开始使用」的启动门槛窗口。
这个插件让该门槛始终处于「已满足」状态，从而**不必输入 API Key 就能直接进入工作区**。

> **它不涉及登录。** 本插件只影响本地启动门槛对「凭据是否已配置」的判断，**不读取、不修改、也不绕过任何登录态、会话、心跳或远程授权**。它没有网络代码，不与任何服务器通信。

## 它为什么有效

桌面端的主进程用下面这个判断决定开哪个窗口（`lib/main.js` 中的 `needsWelcome`）：

```js
needsWelcome(authentication) = !authentication.loggedIn && !authentication.hasApiKey
```

- `loggedIn`：账号状态是否为 `credential-stored`（需要真正登录）。**本插件从不触碰这一项。**
- `hasApiKey`：**任意一个**被当前 provider 目录声明过的凭据引用（官方 `llm-deepseek` 的 `apiKeyEnv`，以及每个可配置 provider 的 `settingsPath.apiKeyEnv`）在 `credentials` 服务里 `configured === true`。

关键点是：门槛**从不校验 Key 的内容**，只看该引用「是否已配置」。所以只要某个被声明的引用已存有任意非空值，门槛就不会出现。

本插件在启动时做且只做一件事：如果所有候选引用都未配置，就为其中一个写入一个占位值。它**永不覆盖已有值**（先 `describe`），并在该引用被 `unset` 之后自动补回（`refill`），因此重启后依然跳过。

## ⚠️ 前置条件：装完之后仍需要能用的模型

**这个插件只跳过启动门槛，不提供任何模型能力。**

它骗过的只是「凭据存在性」判断，占位值本身不能用来发请求。所以你仍然必须有一个真正可用的模型来源，例如：

- 在 profile 里配好一个第三方 provider（走它自己的 `apiKeyEnv`），或
- 换成免费模型网关类插件，或
- 填一个真实的官方 DeepSeek API Key（插件检测到已配置即不再介入）。

否则门槛是过了，但一发消息就会鉴权失败。

## 配置项

| 键 | 默认值 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 关掉后恢复桌面端原生行为。 |
| `ref` | `""` | 要维持「已配置」的凭据引用名。留空表示自动从 provider 已声明的引用里挑一个。 |
| `placeholder` | `"dsh-welcome-bypass-placeholder"` | 未配置时写入的占位值。 |
| `refill` | `true` | 该引用被 `unset` 后是否自动补回。 |

### 关于 `ref` 的一个坑

默认目标是官方的 `DEEPSEEK_API_KEY`，这是有意的：占用它只会让官方 DeepSeek provider 在「模型」页面显示为已配置。

**不建议**把 `ref` 改成你实际在用的 provider 的密钥引用（例如 `YUANJIN_API_KEY` 之类）——那会让真实的密钥引用被占位值占据，语义混乱，也更容易误操作。保持默认即可。

## 安全边界

- 只调用 `credentials` 服务的 `describe` / `set` 两个方法，只监听 `credentials/reference-updated` 一个事件。
- 不 import 任何模块，无网络、无文件、无子进程、无环境变量读取。
- 不改动 `app.asar`，升级桌面端不会失效，也不涉及签名校验。
- 永不覆盖已有凭据值：写入前一律先 `describe` 确认未配置。
- 卸载后已写入的占位值仍留在凭据库里；如需清除，用 `credentials` 服务 `unset` 该引用即可。

## 与相近插件的区别

社区里已有几个名字相近的插件，但它们做的事不同，不能互相替代：

| 插件 | 它实际做什么 | 与本插件的关系 |
| --- | --- | --- |
| `@iasiv5/dsh-skip-browser-auth` | 替换官方 Connection 提供方，跳过 Web 端的 BrowserAuth，省去把启动 URL 里的随机 token 抄进浏览器。**明确声明仅支持 web 宿主，desktop 宿主一律自动休眠。** | 绕的是 Web 端 token 门，且桌面端不可用，无法替代本插件。 |
| `dsh-auth-cookie-guard` | 提升本地监听器的 HTTP 头部预算并退休过期的 `dsh-auth-*` 启动 cookie，修复固定 profile 约 72 次启动后卡在 `desktop welcome: Web authentication failed`。 | 修的是启动链路的**故障**，不是跳过门槛，方向不同。 |
| `dsh-cookie-cleaner` | 同赛道，处理同一类 431 启动失败。 | 同上。 |
| `dsh-welcome-greeting` / `dsh-welcome-back` | 替换首屏问候语 / 闲置回到会话时重播上一条消息。 | 纯界面文案，与启动门槛无关。 |

其余名字里带 `auth` / `gate` 的插件（`dsh-auth-gate`、`dsh-ui-auth`、`dsh-auth-tunnel` 等）都是**给 Web 界面增加密码门禁**的，方向与本插件相反。

## 安装

通过 `plugin_manager` 的 `install_bundle` 安装本目录（绝对路径），或在 profile 的 `cordis.patch.yml` 里加入：

```yaml
- insert:
    - id: welcome-bypass
      name: dsh-welcome-bypass
      config:
        enabled: true
```

从 git 安装：

```bash
dsh plugin --profile desktop add github:lycaptain/dsh-welcome-bypass
```

## 兼容性

`engines.dsh: >=0.2.0-rc.1 <0.3.0-0`

插件只依赖 `credentials` 服务这一处稳定接缝（`describe` / `set` / `reference-updated` 事件），未使用任何随版本变动的内部接口，因此对 0.2.x 整条线开放。若未来该接缝发生变化，退化结果是「占位值写不进去、门槛照旧显示」，不会破坏已有凭据。

## 许可

MIT
