# dsh-aloof

把 [Aloof](https://inside.aloof-ai.cn) 的办公审批接成 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）的**原生工具**：在自己电脑的 dsh 里直接说「我这个月的差旅报销提一下」「看看有什么等我批的」，不用切到浏览器。

这同时是一份**可运行的 dsh 插件样板**——它把插件机制的每一层都用到了（工具注册、凭据服务、写操作审批闸门、结果渲染），三百行、没有一句 `import`（为什么见 `index.js` 顶部）。

## 装

```sh
dsh plugin --profile web add dsh-aloof
```

然后给它一张票（下一节说怎么拿）：

```sh
export ALOOF_TOKEN='alf_……'
dsh web
```

卸载 `dsh plugin --profile web remove dsh-aloof`，profile 的 `bundles` 列表会自动摘掉这一层。

**私有部署必须先改 `baseUrl`**，见「配」——这一行填的是哪台，你的令牌就发给哪台。

## 五个工具

| 工具 | 干什么 | 读/写 |
|---|---|---|
| `oa_todo` | 查等我处理的单子，返回 `taskId` | 读 |
| `oa_templates` | 我能发起哪些审批，返回 `templateId` | 读 |
| `oa_form` | 某模板要填哪些字段（key / 类型 / 必填 / 选项） | 读 |
| `oa_submit` | 发起一单 | **写，过闸门** |
| `oa_decide` | 同意 / 驳回一条待办 | **写；接入令牌下后端直接拒**，见下 |

刻意分成四步（列模板 → 读字段 → 填 → 提交）：模型不该猜表单字段名，`oa_form` 就是把「猜」换成「查」。

## 票据：用「dsh 接入令牌」，不要用登录票

在 Aloof 里点左下角自己的名字 → **dsh 接入** → 生成一张。明文只显示一次，当场抄走。

为什么不直接把网页的登录票复制过来：那张票带着这个人的**全部**权限、三十天有效、没法单独作废——放在笔记本上被捞走的人能替他批审批。接入令牌反过来长：

| | 登录票 | 接入令牌（`alf_` 开头） |
|---|---|---|
| 查数据 | ✅ | ✅ 范围完全一样（该看见什么就看见什么） |
| 提审批单 / 撤回 | ✅ | ✅ 提单是「请人来批」，不是终局动作 |
| 同意 / 驳回 | ✅ | ❌ **403**，只能本人在网页上点 |
| 改业务数据 | ✅ | ❌ 403 |
| 单独吊销 | ❌ | ✅ 按设备，页面上还看得见最后一次什么时候用的 |

所以 `oa_decide` 在接入令牌下必然 403，报错原文是「批审批请在 Aloof 网页里操作」。**这是设计如此，不是配置错了**——工具描述里写了这句话，模型不会改参数重试。

## 配

默认值在包自带的 `cordis.patch.yml` 里。**不要改那个文件**（升级会覆盖），要改就在 profile 自己的 `cordis.patch.yml` 里按 id 覆盖。patch 是**整块替换** `config` 而不是深合并，所以覆盖时四个键要写全：

```yaml
- id: aloof
  name: 'dsh-aloof'
  config:
    baseUrl: https://aloof.你的公司.com
    tokenEnv: ALOOF_TOKEN
    timeoutMs: 20000
    requireApproval: true
```

| 键 | 说明 |
|---|---|
| `baseUrl` | 你那台 Aloof 的地址。**没有隐式默认值**：漏写会当场报错，而不是悄悄连到别人的服务器上 |
| `tokenEnv` | 令牌的**引用名**（POSIX 标识符），不是令牌本身 |
| `timeoutMs` | 单次 HTTP 超时 |
| `requireApproval` | 写操作是否必须先问人。`true` = fail closed |

令牌的值走 dsh 的 credentials（进程环境变量或 `$DSH_HOME/.credentials.yaml`），配置里只留引用名——这样配置可以随便同步、随便渲染到界面上，换令牌也不用碰文件，而且**每次调用现取不缓存**，换完下一次请求就生效。

## 写操作的两道闸

别搞混，这是两道独立的闸，分别在两个地方：

**本机这道**：`oa_submit` / `oa_decide` 在发请求之前先走 dsh 的 `ctx.approval.request()`，把「要改什么」写进 `reason` 交给人，只有拿到 `allowed-once` 才继续。三条拒绝路径都是不落库的——人点拒绝（`rejected`）、人关掉提示或会话被取消（`cancelled`）、这台 dsh 根本没有审批服务（直接拒，**不是**默认放行）。

`approval` 故意没写进模块级 `inject`：写进去会让整个插件在没有审批服务的装配里根本不挂载，连查待办都用不了。改成运行时探测 + fail closed，是能力降级而不是整体消失。

**服务端那道**：Aloof 后端按令牌类型和路由白名单拦，非 GET 请求只有「提审批单」和「撤回自己的单」放行。所以 `oa_decide` 就算在本机被人点了同意，到了后端照样 403——「批准」这个动作不接受来自一张笔记本上的票。

## 有问题

提 [issue](https://github.com/gaochonggeng/dsh-aloof/issues)。这个插件只是个转发壳，业务逻辑（权限、数据范围、审批链、审计）全在 Aloof 后端——所以「它不让我批审批」这类不是插件的问题，见上面「票据」那节。

## 还没做

- **没有设置页**：`baseUrl` / 令牌目前只能写 YAML 或环境变量。做成设置里的表单需要 `installSettingsSection` + schemastery，那就得引入运行时依赖。
- **没有专用 UI 卡片**：`output.render` 只给了文本。要把同意/驳回按钮画在对话里，得写浏览器那半边。
- **没做转办 / 催办 / 抄送**：后端接口都有，照现有工具复制即可。

## License

MIT
