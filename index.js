/**
 * Aloof 办公审批（OA）→ DeepSeek Harness 原生工具。
 *
 * 五个工具：查我的待办、看我能发起哪些审批、读某个模板要填什么、发起一单、同意或驳回。
 * 读操作直连 Aloof 后端；**写操作先过 dsh 的审批闸门**（`ctx.approval`）——模型不能
 * 悄悄替人按下「同意」。
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
 * **`baseUrl` 故意不给默认值**：patch 是整块替换 config 而不是深合并，用户为了改
 * `tokenEnv` 重写这一行时很容易漏掉 `baseUrl`；要是这里兜一个我们的域名，他的
 * 令牌就会静悄悄发到别人的服务器上（那边只会回 401，但票已经出网了）。
 * 宁可当场报错让他补上——见 apply 里的检查。
 */
const DEFAULTS = {
  tokenEnv: 'ALOOF_TOKEN',
  timeoutMs: 20000,
  requireApproval: true,
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

export function apply(ctx, config) {
  const conf = { ...DEFAULTS, ...(config ?? {}) }
  if (typeof conf.baseUrl !== 'string' || conf.baseUrl.trim() === '') {
    throw new Error('aloof: 没配 baseUrl —— 填你那台 Aloof 的地址（如 https://aloof.你的公司.com）。patch 是整块替换 config，覆盖时这个键要一起写')
  }
  const base = conf.baseUrl.trim().replace(/\/+$/, '')
  const ref = String(conf.tokenEnv)
  if (!REF_PATTERN.test(ref)) {
    throw new Error(`aloof: tokenEnv "${ref}" 不是合法的凭据引用名（需匹配 ${REF_PATTERN}）`)
  }

  /**
   * 取票据。**该放的是「dsh 接入令牌」**（`alf_` 开头，在 Aloof 里点左下角自己的名字 →
   * 「dsh 接入」生成），不是网页的登录票：登录票带着这个人的全部权限、没法单独作废，
   * 放在笔记本上被捞走的人能替他批审批。接入令牌只能查数据和提单，能按设备吊销。
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
    throw new Error(`没配 ${ref}：在 Aloof 里生成一张 dsh 接入令牌（左下角自己的名字 → dsh 接入），放进环境变量 ${ref}，或写进 $DSH_HOME/.credentials.yaml`)
  }

  /**
   * 一次 Aloof API 调用。
   * @param {'GET'|'POST'} method HTTP 方法
   * @param {string} path 形如 `/api/oa/tasks/todo`
   * @param {{query?:Record<string,any>,body?:any,signal?:AbortSignal}} [options] 附加项
   */
  async function api(method, path, options = {}) {
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
          authorization: `Bearer ${await token()}`,
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
  ]

  // 注册即随 fiber 生命周期：插件被禁用 / 热重载时这些工具自动摘掉，不留幽灵工具。
  for (const definition of registrations) ctx.tools.register(definition)
}
