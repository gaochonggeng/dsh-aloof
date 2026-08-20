/**
 * Aloof（办公审批 + 团队资料库）→ DeepSeek Harness 原生工具。
 *
 * 两组工具。**办公审批**：查我的待办、看我能发起哪些审批、读某个模板要填什么、发起一单、
 * 同意或驳回。**团队资料库**：列空间、搜、列目录、读一份、写一份、删一个——这组是
 * 「团队共享知识」落到本机 dsh 上的通路，你在网页上看得到的那些空间，这里同一套权限
 * （空间 ACL 照旧生效，你在网页上进不去的空间，拿这张票一样进不去）。
 *
 * 读操作直连 Aloof 后端；**写操作先过 dsh 的审批闸门**（`ctx.approval`）——模型不能
 * 悄悄替人按下「同意」，也不能悄悄覆写或删掉团队的资料。
 *
 * 为什么整份文件没有一句 import：
 * dsh 的 `defineTool` / `credentialRef` / `installSettingsSection` 都在
 * `@deepseek-ai/dsh-*` 包里，用了就把这个插件钉死在某个 dsh 内部版本上，而且插件被
 * 软链进 profile 时 Node 会从**真实路径**往上找 node_modules，找不到那些包。这里改成
 * 直接手写 JSON Schema、只用 ctx 上的服务，插件因此可以原样丢进任何一套 dsh
 * （包括 Aloof 后端用的那个单文件 runtime，只要它哪天换成 npm 版）。
 * 代价是少了编译期类型推导，对一个只做 HTTP 转发的薄壳来说不亏。
 */

/** loader 用它做日志和错误定位；和 cordis.patch.yml 里的 `id` 无关。 */
export const name = 'aloof'

/**
 * 依赖声明。只写 `tools`：没有工具注册表就不该挂载。
 * `approval` 故意**不**写在这儿——见 apply 里的说明。
 */
export const inject = ['tools']

/**
 * 配置缺省值。cordis 行里没给的键落到这儿，别让插件因为少一行 YAML 就崩。
 *
 * **`baseUrl` 不在这儿，而且正常情况下根本不用配**：地址跟着票一起来（见 `split`）。
 * 这里要是兜一个我们的域名，别家用户的令牌就会静悄悄发到我们的服务器上——那边只会回
 * 401，但票已经出网了。真需要写死时（反向代理、内网另有入口）配置里还能填，填了以它为准。
 */
const DEFAULTS = {
  tokenEnv: 'ALOOF_TOKEN',
  timeoutMs: 20000,
  requireApproval: true,
}

/**
 * 把 Aloof 复制给你的那一整串票拆成「密钥」和「发给哪台」。
 *
 * 复制出来的形状是 `alf_xxxx@https://你那台`——**密钥和它该去的地址绑在一起**。
 * 这么设计是为了消掉一整类错误：地址和票各自是一个可填的字段时，「填串了、票发到别人
 * 服务器上」就永远可能发生；合成一个字符串之后，这件事在物理上就不成立了。
 * 顺带 dsh 那头也简单了——粘一串，不用再配第二个东西。
 *
 * 切法没有歧义：后端的密钥是 `secrets.token_urlsafe` 生成的，字母表 `[A-Za-z0-9_-]`，
 * **永远不含 `@`**，所以从第一个 `@` 切开就对。
 *
 * 票带不带地址取决于**发票的那台 Aloof**（是它的网页拼上去的），跟插件版本无关。
 * 老票不带 `@`，这时 `carried` 是 null，退回配置里的 `baseUrl`。
 * @param {string} raw 凭据里存的那一整串
 * @returns {{secret:string, carried:string|null}} 密钥 + 票自带的地址（没带就是 null）
 */
function split(raw) {
  const at = raw.indexOf('@')
  if (at < 0) return { secret: raw, carried: null }
  return { secret: raw.slice(0, at), carried: raw.slice(at + 1).trim().replace(/\/+$/, '') }
}

/** 凭据引用名的合法形状，和 dsh 的 `credentialRef` 一致（POSIX 标识符）。 */
const REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * 把紧凑参数声明编译成模型看到的 JSON Schema。
 * 每个字段写 `{ type, description, required?, enum?, items? }`，`required` 收敛成
 * 根上的数组——dsh 只接受 type/oneOf/properties/required/additionalProperties/items/
 * enum/const 这个子集，属性里挂 `required: true` 会被 register 直接拒掉。
 * @param {Record<string, any>} spec 紧凑声明
 * @returns {{type:'object',properties:Record<string,any>,required?:string[],additionalProperties:boolean}}
 */
function toSchema(spec) {
  const properties = {}
  const required = []
  for (const [key, raw] of Object.entries(spec)) {
    const { required: isRequired, ...rest } = raw
    properties[key] = rest
    if (isRequired === true) required.push(key)
  }
  // 参数根是开放对象：模型多传一个键不该让整次调用失败。
  return { type: 'object', properties, additionalProperties: true, ...(required.length > 0 ? { required } : {}) }
}

/**
 * 调用前的入参校验。dsh 的 `defineTool` 免费给这一层，手写就得自己补：
 * 没有它，一个漏填的必填参数会变成一次莫名其妙的 400，模型只能瞎猜。
 * @param {any} schema 编译后的 JSON Schema
 * @param {any} args 模型给的参数
 * @returns {string[]} 违规说明，空数组表示通过
 */
function violations(schema, args) {
  const out = []
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return ['参数必须是一个对象']
  for (const key of schema.required ?? []) {
    if (args[key] === undefined || args[key] === null || args[key] === '') out.push(`缺少必填参数 ${key}`)
  }
  for (const [key, node] of Object.entries(schema.properties)) {
    const value = args[key]
    if (value === undefined || value === null) continue
    const kind = node.type
    const ok = kind === 'string' ? typeof value === 'string'
      : kind === 'integer' ? Number.isInteger(value)
        : kind === 'number' ? typeof value === 'number'
          : kind === 'boolean' ? typeof value === 'boolean'
            : kind === 'array' ? Array.isArray(value)
              : kind === 'object' ? typeof value === 'object' && !Array.isArray(value)
                : true
    if (!ok) out.push(`参数 ${key} 应为 ${kind}`)
    if (Array.isArray(node.enum) && !node.enum.includes(value)) {
      out.push(`参数 ${key} 只能是 ${node.enum.join(' / ')}`)
    }
  }
  return out
}

/**
 * 组装一个注册表能直接吃的工具定义。等价于 dsh 的 `defineTool`，只做它真正干的两件事：
 * 编译 schema、在 execute 前验参。
 * @param {{name:string,description:string,parameters:Record<string,any>,output:any,execute:Function,timeoutMs?:number}} options 定义
 */
function tool(options) {
  const parameters = toSchema(options.parameters)
  return {
    name: options.name,
    description: options.description,
    parameters,
    output: options.output,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    async execute(args, exec) {
      const bad = violations(parameters, args)
      if (bad.length > 0) throw new Error(bad.join('；'))
      return await options.execute(args, exec)
    },
  }
}

/** 列表结果统一带 total：只报本页条数会让模型把「20 条」当成全部。 */
function page(body, limit) {
  const items = Array.isArray(body?.items) ? body.items : []
  const total = typeof body?.total === 'number' ? body.total : items.length
  return { items, total, shown: items.length, truncated: total > items.length, limit }
}

/**
 * 一次最多把多少字正文塞回模型。
 *
 * 资料库里躺着几十万字的文档是常态，整篇灌回去会把上下文一次吃光（后面几轮全废）。
 * 截断**必须说出来**：返回里带 `truncated`，不然模型会拿半篇当全文去下结论。
 */
const TEXT_CAP = 40000

function clip(text) {
  const full = typeof text === 'string' ? text : ''
  return full.length <= TEXT_CAP
    ? { text: full, chars: full.length, truncated: false }
    : { text: full.slice(0, TEXT_CAP), chars: full.length, truncated: true }
}

export function apply(ctx, config) {
  const conf = { ...DEFAULTS, ...(config ?? {}) }
  /**
   * 配置里写死的地址。**平常是空的**——地址跟着票来。
   * 填了就以它为准（而不是票里那个）：反向代理、内网另有入口时，网页的地址和 dsh 能到达的
   * 地址确实可能不是同一个，这是留给那种情形的手动覆盖口子。显式配置优先于内嵌缺省。
   */
  const pinned = typeof conf.baseUrl === 'string' && conf.baseUrl.trim() !== ''
    ? conf.baseUrl.trim().replace(/\/+$/, '')
    : null
  const ref = String(conf.tokenEnv)
  if (!REF_PATTERN.test(ref)) {
    throw new Error(`aloof: tokenEnv "${ref}" 不是合法的凭据引用名（需匹配 ${REF_PATTERN}）`)
  }

  /**
   * 取票据。**该放的是「dsh 接入令牌」**（形如 `alf_xxxx@https://你那台`，在 Aloof 里点
   * 左下角自己的名字 → 「dsh 接入」生成，整串复制），不是网页的登录票：登录票带着这个人的
   * 全部权限、没法单独作废，放在笔记本上被捞走的人能替他批审批。接入令牌只能读数据、提审批单、
   * 改资料库内容，批审批做不了，而且能按设备吊销。
   *
   * 优先走 dsh 的 credentials 服务（它把进程环境变量叠在 `$DSH_HOME/.credentials.yaml`
   * 之上，还能被设置页写入）；这套服务不在时退回读环境变量，让插件在裸装配里也能用。
   *
   * **每次调用现取，不缓存**——这是 dsh credentials 的明确主张：换了 token，下一次请求就生效，
   * 不用重启任何东西。
   */
  async function token() {
    const service = ctx.get?.('credentials')
    if (service !== undefined) {
      const hit = await service.resolve(ref)
      if (hit?.value) return hit.value
    }
    const ambient = process.env[ref]
    if (ambient) return ambient
    throw new Error(`没配 ${ref}：在 Aloof 里生成一张 dsh 接入令牌（左下角自己的名字 → dsh 接入），把复制出来的**整串**（alf_xxxx@https://你那台）放进环境变量 ${ref}，或写进 $DSH_HOME/.credentials.yaml`)
  }

  /**
   * 一次 Aloof API 调用。
   * @param {'GET'|'POST'|'PUT'|'DELETE'} method HTTP 方法
   * @param {string} path 形如 `/api/oa/tasks/todo`
   * @param {{query?:Record<string,any>,body?:any,signal?:AbortSignal}} [options] 附加项
   */
  async function api(method, path, options = {}) {
    // 地址每次现算：票换了（换了公司、换了实例）下一次请求就打到新的那台，不用重启 dsh。
    const { secret, carried } = split(await token())
    const base = pinned ?? carried
    if (base === null) {
      throw new Error(`${ref} 里那串票不带地址，配置里也没写 baseUrl。去 Aloof 里重新复制一次——复制出来的是「alf_xxxx@https://你那台」一整串，@ 后面那截就是地址，别只粘前半截`)
    }
    if (!/^https?:\/\//.test(base)) {
      throw new Error(`地址 "${base}" 不像个网址（要带 http:// 或 https://）。它来自${pinned === null ? ` ${ref} 里 @ 后面那截` : '配置里的 baseUrl'}`)
    }
    const url = new URL(base + path)
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value))
    }
    // 两个终止条件缝在一起：模型这次调用被取消（exec.signal），或者后端太慢（timeoutMs）。
    // 少了前者，用户点「停止」之后这条请求还会挂着。
    const timeout = AbortSignal.timeout(Number(conf.timeoutMs))
    const signal = options.signal === undefined ? timeout : AbortSignal.any([options.signal, timeout])
    let response
    try {
      response = await fetch(url, {
        method,
        signal,
        headers: {
          authorization: `Bearer ${secret}`,
          ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      })
    } catch (error) {
      // fetch 的原始错误（`TypeError: fetch failed`）对模型毫无信息量，它会开始瞎试。
      throw new Error(`连不上 Aloof（${base}）：${error instanceof Error ? error.message : String(error)}`)
    }
    const text = await response.text()
    if (!response.ok) {
      // 后端的 `{"detail": "..."}` 才是给人看的那句话，优先透出它。
      let detail = text.slice(0, 400)
      try {
        const parsed = JSON.parse(text)
        if (typeof parsed?.detail === 'string') detail = parsed.detail
      } catch { /* 不是 JSON，就用原文 */ }
      throw new Error(`Aloof ${response.status}：${detail}`)
    }
    return text === '' ? null : JSON.parse(text)
  }

  /**
   * 写操作的闸门。`approval` 不写进模块级 `inject` 是刻意的：那样会让整个插件在没有
   * 审批服务的装配里根本不挂载，连查待办都用不了。这里改成运行时探测 + **fail closed**：
   * 服务不在就拒绝写操作，而不是默认放行。
   * @param {string} toolName 工具名（审计和界面上显示）
   * @param {string} reason 为什么要问——写清楚要改什么，人才判断得了
   * @param {any} exec 工具执行上下文
   */
  async function allowed(toolName, reason, exec) {
    if (conf.requireApproval !== true) return
    const approval = ctx.get?.('approval')
    if (approval === undefined) {
      throw new Error('这台 dsh 没有审批服务，按 fail-closed 拒绝写操作；确实要放开就把 dsh-aloof 的 requireApproval 设为 false')
    }
    const outcome = await approval.request({
      agent: exec.agent,
      toolName,
      callId: exec.callId,
      reason,
      signal: exec.signal,
    })
    if (outcome !== 'allowed-once') throw new Error(`人没有批准这次操作（${outcome}）`)
  }

  const registrations = [
    tool({
      name: 'oa_todo',
      description:
        '查「我的审批待办」——等着我处理的单子。返回单子标题、模板名、发起人、待我处理的节点名和任务 id。'
        + '要同意或驳回，先用这个拿到 taskId。总数看 total，不要用返回条数当总数。',
      parameters: {
        keyword: { type: 'string', description: '按标题 / 发起人筛，留空是全部' },
        limit: { type: 'integer', description: '最多返回几条，1~100，默认 20' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: {
            items: { type: 'array', items: { type: 'object', additionalProperties: true } },
            total: { type: 'integer' },
            shown: { type: 'integer' },
            truncated: { type: 'boolean' },
          },
        },
        render: (_args, value) => [{
          type: 'text',
          text: value.total === 0
            ? '待办是空的。'
            : `待办 ${value.total} 条，列出 ${value.shown} 条：\n`
              + value.items.map(t => `- [taskId=${t.id}] ${t.title}（${t.templateName}，${t.initiatorName ?? '未知'}发起，待办节点：${t.nodeName ?? '—'}）`).join('\n'),
        }],
      },
      async execute(args, exec) {
        const limit = Math.min(Math.max(args.limit ?? 20, 1), 100)
        const body = await api('GET', '/api/oa/tasks/todo', {
          query: { keyword: args.keyword, limit, offset: 0 },
          signal: exec.signal,
        })
        return page(body, limit)
      },
    }),

    tool({
      name: 'oa_templates',
      description: '看我能发起哪些审批（模板清单）。要发起单子时先用它拿 templateId。',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: {
            items: { type: 'array', items: { type: 'object', additionalProperties: true } },
            total: { type: 'integer' },
          },
        },
        render: (_args, value) => [{
          type: 'text',
          text: value.total === 0
            ? '没有可发起的审批模板（可能是权限没开）。'
            : value.items.map(t => `- [templateId=${t.id}] ${t.name}${t.description ? ` —— ${t.description}` : ''}`).join('\n'),
        }],
      },
      async execute(_args, exec) {
        const body = await api('GET', '/api/oa/templates/startable', { signal: exec.signal })
        return page(body, null)
      },
    }),

    tool({
      name: 'oa_form',
      description:
        '读某个审批模板要填哪些字段（字段 key、名称、类型、是否必填、下拉选项）。'
        + '发起单子前必须先调它：formData 的键就是这里的 key，别自己编。',
      parameters: {
        templateId: { type: 'integer', required: true, description: '模板 id，来自 oa_templates' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: {
            templateId: { type: 'integer' },
            name: { type: 'string' },
            fields: { type: 'array', items: { type: 'object', additionalProperties: true } },
          },
        },
        render: (_args, value) => [{
          type: 'text',
          text: `「${value.name}」需要填：\n`
            + value.fields.map(f =>
              `- ${f.key}（${f.label}，${f.type}${f.required ? '，必填' : ''}${f.options?.length ? `，可选：${f.options.join('/')}` : ''}）`,
            ).join('\n'),
        }],
      },
      async execute(args, exec) {
        const body = await api('GET', `/api/oa/templates/${args.templateId}`, { signal: exec.signal })
        return {
          templateId: body.id,
          name: body.name,
          fields: (body.formSchema ?? []).map(f => ({
            key: f.key, label: f.label, type: f.type, required: f.required === true, options: f.options ?? [], help: f.help ?? null,
          })),
        }
      },
    }),

    tool({
      name: 'oa_submit',
      description:
        '发起一单审批。formData 的键必须来自 oa_form，必填字段一个都不能少。'
        + '这是写操作：会先向人确认，人不同意就不会提交。',
      parameters: {
        templateId: { type: 'integer', required: true, description: '模板 id' },
        formData: { type: 'object', required: true, description: '表单内容，键取自 oa_form 的 key' },
        title: { type: 'string', description: '单子标题，留空由后端按模板生成' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: {
            instanceId: { type: 'integer' },
            serialNo: { type: 'string' },
            title: { type: 'string' },
            status: { type: 'string' },
            currentStepName: { type: 'string' },
          },
        },
        render: (_args, value) => [{
          type: 'text',
          text: `已提交「${value.title}」（单号 ${value.serialNo ?? value.instanceId}），当前状态 ${value.status}`
            + `${value.currentStepName ? `，等 ${value.currentStepName}` : ''}。`,
        }],
      },
      async execute(args, exec) {
        const keys = Object.keys(args.formData ?? {})
        await allowed('oa_submit', `提交审批（模板 ${args.templateId}，字段：${keys.join('、') || '空'}）`, exec)
        const body = await api('POST', '/api/oa/instances', {
          body: { templateId: args.templateId, formData: args.formData, ...(args.title ? { title: args.title } : {}) },
          signal: exec.signal,
        })
        return {
          instanceId: body.id,
          serialNo: body.serialNo ?? null,
          title: body.title,
          status: body.status,
          currentStepName: body.currentStepName ?? null,
        }
      },
    }),

    tool({
      name: 'oa_decide',
      description:
        '处理一条待办：同意或驳回。taskId 来自 oa_todo。'
        + '这是写操作，而且是替人表态：一定会先向人确认，人不同意就不会落库。'
        + '注意：用 dsh 接入令牌时后端会直接拒（403）——批准和驳回只能本人在 Aloof 网页上点，'
        + '这不是配置问题，别改参数重试，把「去网页处理」告诉用户就行。',
      parameters: {
        taskId: { type: 'integer', required: true, description: '待办任务 id，来自 oa_todo' },
        decision: { type: 'string', required: true, enum: ['approve', 'reject'], description: 'approve 同意 / reject 驳回' },
        comment: { type: 'string', description: '审批意见；驳回时务必写清理由' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: {
            instanceId: { type: 'integer' },
            title: { type: 'string' },
            status: { type: 'string' },
            decision: { type: 'string' },
          },
        },
        render: (_args, value) => [{
          type: 'text',
          text: `已${value.decision === 'approve' ? '同意' : '驳回'}「${value.title}」，单子当前状态 ${value.status}。`,
        }],
      },
      async execute(args, exec) {
        const word = args.decision === 'approve' ? '同意' : '驳回'
        await allowed('oa_decide', `${word}待办 ${args.taskId}${args.comment ? `，意见：${args.comment}` : ''}`, exec)
        const body = await api('POST', `/api/oa/tasks/${args.taskId}/${args.decision}`, {
          body: { comment: args.comment ?? null },
          signal: exec.signal,
        })
        return { instanceId: body.id, title: body.title, status: body.status, decision: args.decision }
      },
    }),

    // ── 团队资料库 ─────────────────────────────────────────────────────────
    // 「共享」在这儿是**同一份**，不是各存一份：写进去的东西同事在网页上立刻看得见，
    // 同事写的这里也搜得到。所以每个写操作的确认文案都要说清「这是团队看得见的」。

    tool({
      name: 'kb_spaces',
      description:
        '列出我在 Aloof 资料库里能进的空间（个人空间 + 被拉进去的团队空间）。'
        + '要搜、要读、要写之前先用它拿 spaceId。myRole 是我在这个空间的角色：'
        + 'viewer 只能读，member 能写，admin 还能删目录。',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: {
            items: { type: 'array', items: { type: 'object', additionalProperties: true } },
            total: { type: 'integer' },
          },
        },
        render: (_args, value) => [{
          type: 'text',
          text: value.total === 0
            ? '一个空间都没有（可能是 work.kb:view 权限没开）。'
            : value.items.map(s =>
              `- [spaceId=${s.id}] ${s.name}（${s.kind === 'personal' ? '个人' : '团队'}，我是 ${s.myRole}，${s.docCount} 份资料）`
              + `${s.summary ? ` —— ${s.summary}` : ''}`,
            ).join('\n'),
        }],
      },
      async execute(_args, exec) {
        // 这个端点直接回数组（不是 {items,total}）：空间数量本来就是个位数，没分页
        const body = await api('GET', '/api/work/kb/spaces', { signal: exec.signal })
        const items = Array.isArray(body) ? body : []
        return { items, total: items.length }
      },
    }),

    tool({
      name: 'kb_search',
      description:
        '在团队资料库里搜（按名字、用途说明和正文全文）。**要用团队已有的结论时先搜这里，'
        + '别自己从头编**——同事写过的方案、报价、踩过的坑都在里面。'
        + '返回每条命中的 spaceId + nodeId（拿去 kb_read 读全文）、它在哪个目录下、以及命中的那一句。'
        + '总数看 total，不要把返回条数当全部。',
      parameters: {
        keyword: { type: 'string', required: true, description: '搜什么，支持中文；一次一个主题词效果最好' },
        spaceId: { type: 'integer', description: '只搜某个空间，来自 kb_spaces；留空是搜我能进的全部' },
        limit: { type: 'integer', description: '最多返回几条，1~100，默认 10' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: {
            items: { type: 'array', items: { type: 'object', additionalProperties: true } },
            total: { type: 'integer' },
            shown: { type: 'integer' },
            truncated: { type: 'boolean' },
          },
        },
        render: (args, value) => [{
          type: 'text',
          text: value.total === 0
            ? `资料库里搜不到「${args.keyword}」。`
            : `命中 ${value.total} 条，列出 ${value.shown} 条：\n`
              + value.items.map(h =>
                `- [spaceId=${h.spaceId} nodeId=${h.id}] ${h.name}（${h.spaceName} / ${h.pathText}）`
                + `${h.snippet ? `\n    …${h.snippet}…` : ''}`,
              ).join('\n'),
        }],
      },
      async execute(args, exec) {
        const limit = Math.min(Math.max(args.limit ?? 10, 1), 100)
        // 后端这几个 query 参数是 snake_case，名字对不上会**静默不过滤**（不报错，只是搜了全库）
        const body = await api('GET', '/api/work/kb/search', {
          query: { keyword: args.keyword, space_id: args.spaceId, limit, offset: 0 },
          signal: exec.signal,
        })
        return page(body, limit)
      },
    }),

    tool({
      name: 'kb_list',
      description:
        '列一个空间某个目录下的一层（目录排在文件前面）。用来摸清结构、或给 kb_write 挑一个 parentId。'
        + '不给 folderId 就是列空间根。想按内容找东西用 kb_search，别一层层翻。',
      parameters: {
        spaceId: { type: 'integer', required: true, description: '空间 id，来自 kb_spaces' },
        folderId: { type: 'integer', description: '列哪个目录下的一层；留空 = 空间根' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: {
            items: { type: 'array', items: { type: 'object', additionalProperties: true } },
            total: { type: 'integer' },
            path: { type: 'string' },
          },
        },
        render: (_args, value) => [{
          type: 'text',
          text: `${value.path || '根目录'}：`
            + (value.total === 0
              ? '空的。'
              : `\n${value.items.map(n =>
                n.kind === 'folder'
                  ? `- [folderId=${n.id}] ${n.name}/（${n.childCount} 项）`
                  : `- [nodeId=${n.id}] ${n.name}${n.note ? ` —— ${n.note}` : ''}`,
              ).join('\n')}`),
        }],
      },
      async execute(args, exec) {
        const body = await api('GET', `/api/work/kb/spaces/${args.spaceId}/nodes`, {
          query: { parent_id: args.folderId },
          signal: exec.signal,
        })
        return {
          items: Array.isArray(body?.items) ? body.items : [],
          total: body?.total ?? 0,
          path: (body?.crumbs ?? []).map(c => c.name).join(' / '),
        }
      },
    }),

    tool({
      name: 'kb_read',
      description:
        '读资料库里一份资料的全文。nodeId 来自 kb_search 或 kb_list。'
        + '正文很长时会截断并在 truncated 里说明——那种情况别把它当全文下结论。'
        + '写操作要改哪一份，也先用它读一遍再改。',
      parameters: {
        spaceId: { type: 'integer', required: true, description: '空间 id' },
        nodeId: { type: 'integer', required: true, description: '资料 id，来自 kb_search / kb_list' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: {
            name: { type: 'string' },
            text: { type: 'string' },
            chars: { type: 'integer' },
            truncated: { type: 'boolean' },
            readable: { type: 'boolean' },
          },
        },
        render: (_args, value) => [{
          type: 'text',
          text: value.readable === false
            ? `「${value.name}」是${value.why}，正文读不出来。在 Aloof 网页里打开看吧。`
            : `「${value.name}」（${value.chars} 字${value.truncated ? `，只给前 ${TEXT_CAP} 字` : ''}）：\n\n${value.text}`,
        }],
      },
      async execute(args, exec) {
        const doc = await api('GET', `/api/work/kb/spaces/${args.spaceId}/docs/${args.nodeId}`, {
          signal: exec.signal,
        })
        const name = doc?.node?.name ?? '这份资料'
        // Word / Excel / PPT 走的是另一套编辑接口，按文本读只会读出一堆压缩包乱码；
        // 图片 / PDF 同理。**宁可明说读不了，也别把乱码当正文回给模型**——它会照着乱码瞎猜。
        if (doc?.officeKind) {
          return { name, readable: false, why: `一份 ${doc.officeKind}（Office 文件）`, text: '', chars: 0, truncated: false }
        }
        if (doc?.editable === false) {
          return { name, readable: false, why: '二进制文件（图片 / PDF 之类）', text: '', chars: 0, truncated: false }
        }
        return { name, readable: true, rev: doc?.rev ?? null, ...clip(doc?.text) }
      },
    }),

    tool({
      name: 'kb_write',
      description:
        '往团队资料库写一份文档。不给 nodeId = 新建（name 要带后缀，只能 .md / .csv / .html / .txt / .json）；'
        + '给了 nodeId = 改那一份，mode=append 追加到末尾（默认），mode=replace 整篇覆盖。'
        + '**这是团队共享的地方，同事在网页上立刻看得见**，所以一定会先向人确认。'
        + '版本号（rev）由插件自己处理，别自己编；如果这中间有人改过同一份，后端会拒，那时重新读一遍再写。',
      parameters: {
        spaceId: { type: 'integer', required: true, description: '写到哪个空间，来自 kb_spaces（要 member 以上）' },
        text: { type: 'string', required: true, description: '正文（Markdown）' },
        nodeId: { type: 'integer', description: '改哪一份；留空 = 新建' },
        name: { type: 'string', description: '新建时的文件名，要带后缀，如「电价踩坑记.md」' },
        parentId: { type: 'integer', description: '新建时放在哪个目录下，来自 kb_list；留空 = 空间根' },
        note: { type: 'string', description: '新建时的一句用途说明，方便同事以后搜到' },
        mode: { type: 'string', enum: ['append', 'replace'], description: '改已有文档时：append 追加（默认）/ replace 覆盖' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: {
            spaceId: { type: 'integer' },
            nodeId: { type: 'integer' },
            name: { type: 'string' },
            created: { type: 'boolean' },
            mode: { type: 'string' },
          },
        },
        render: (_args, value) => [{
          type: 'text',
          text: value.created
            ? `已新建「${value.name}」（nodeId=${value.nodeId}），同事现在就能在资料库里看到。`
            : `已${value.mode === 'replace' ? '覆写' : '追加到'}「${value.name}」（nodeId=${value.nodeId}）。`,
        }],
      },
      async execute(args, exec) {
        const spaceId = args.spaceId
        if (args.nodeId === undefined || args.nodeId === null) {
          if (!args.name) throw new Error('新建文档要给 name（带后缀，如「电价踩坑记.md」）；要改已有的那份就给 nodeId')
          await allowed('kb_write', `在资料库空间 ${spaceId} 新建团队可见的「${args.name}」（${args.text.length} 字）`, exec)
          const node = await api('POST', `/api/work/kb/spaces/${spaceId}/docs`, {
            body: {
              name: args.name,
              content: args.text,
              ...(args.parentId === undefined ? {} : { parentId: args.parentId }),
              ...(args.note === undefined ? {} : { note: args.note }),
            },
            signal: exec.signal,
          })
          return { spaceId, nodeId: node.id, name: node.name, created: true, mode: 'create' }
        }

        // 先读一遍：一是拿 rev（乐观锁的版本号，让模型编这个数迟早覆盖掉别人的修改），
        // 二是 append 要拼在旧正文后面，三是确认文案里能报出「多少字 → 多少字」。
        const mode = args.mode === 'replace' ? 'replace' : 'append'
        const doc = await api('GET', `/api/work/kb/spaces/${spaceId}/docs/${args.nodeId}`, { signal: exec.signal })
        if (doc?.officeKind) throw new Error(`「${doc.node.name}」是 Office 文件，这个工具改不了；在 Aloof 网页里编辑`)
        const old = typeof doc?.text === 'string' ? doc.text : ''
        // 追加前补一个空行：直接接上去会和上一段黏成一段，Markdown 里那是同一个段落
        const next = mode === 'replace' ? args.text : `${old}${old.endsWith('\n') ? '' : '\n'}\n${args.text}`
        const word = mode === 'replace' ? `整篇覆盖（原 ${old.length} 字 → 新 ${args.text.length} 字，原文会没了）` : `追加 ${args.text.length} 字`
        await allowed('kb_write', `改团队资料「${doc.node.name}」：${word}`, exec)
        const saved = await api('PUT', `/api/work/kb/spaces/${spaceId}/docs/${args.nodeId}`, {
          body: { text: next, rev: doc.rev },
          signal: exec.signal,
        })
        return { spaceId, nodeId: saved.node.id, name: saved.node.name, created: false, mode }
      },
    }),

    tool({
      name: 'kb_delete',
      description:
        '删掉资料库里的一个文件或目录。**删了找不回来，没有回收站**；删目录连里面所有东西一起走。'
        + '一定会先向人确认。人不同意就不会删。删目录还要空间管理员权限。',
      parameters: {
        spaceId: { type: 'integer', required: true, description: '空间 id' },
        nodeId: { type: 'integer', required: true, description: '要删的文件或目录 id' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: { spaceId: { type: 'integer' }, nodeId: { type: 'integer' }, name: { type: 'string' } },
        },
        render: (_args, value) => [{ type: 'text', text: `已删掉「${value.name}」。这个动作找不回来了。` }],
      },
      async execute(args, exec) {
        // 确认文案里的「删的是什么」必须从服务端问出来，不能让模型自己报——它报错了，
        // 人就是在给一句假话点同意。先按目录探，404 再按文件探（列目录端点对文件回 404）。
        let what = null
        try {
          const dir = await api('GET', `/api/work/kb/spaces/${args.spaceId}/nodes`, {
            query: { parent_id: args.nodeId },
            signal: exec.signal,
          })
          const here = (dir?.crumbs ?? []).at(-1)
          what = { name: here?.name ?? `节点 ${args.nodeId}`, kind: 'folder', children: dir?.total ?? 0 }
        } catch {
          const doc = await api('GET', `/api/work/kb/spaces/${args.spaceId}/docs/${args.nodeId}`, { signal: exec.signal })
          what = { name: doc?.node?.name ?? `节点 ${args.nodeId}`, kind: 'file', children: 0 }
        }
        const reason = what.kind === 'folder'
          ? `删掉团队资料库里的目录「${what.name}」，底下直接挂着 ${what.children} 项（子目录里的一并删掉）。删了找不回来`
          : `删掉团队资料库里的「${what.name}」。删了找不回来`
        await allowed('kb_delete', reason, exec)
        await api('DELETE', `/api/work/kb/spaces/${args.spaceId}/nodes/${args.nodeId}`, { signal: exec.signal })
        return { spaceId: args.spaceId, nodeId: args.nodeId, name: what.name }
      },
    }),
  ]

  // 注册即随 fiber 生命周期：插件被禁用 / 热重载时这些工具自动摘掉，不留幽灵工具。
  for (const definition of registrations) ctx.tools.register(definition)
}
