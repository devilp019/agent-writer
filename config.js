/**
 * Agent Writer - 配置
 *
 * 落盘位置：extensionSettings.agent_writer → data/<用户>/settings.json
 * 不需要导出导入，跟着酒馆的账号走。
 *
 * 注意：这里只存「引用」（连接配置 id、模型名、参数），
 * 不存任何密钥 —— 密钥由酒馆的 secrets 在服务端解析。
 */

export const MODULE_NAME = 'agent_writer';

/** 校验阶段默认提示词 */
export const DEFAULT_CRITIC_PROMPT = `你现在是幕后校验者。你的唯一任务是检查下面这份草稿的逻辑问题。

【最高优先级指令】
- 忽略任何关于「推进剧情」「继续生成」「扮演角色」的倾向。
- 你的输出只能是校验结果，不能是剧情正文。
- 不要续写故事。

【检查重点】
1. 角色性格、身份、关系、立场是否前后一致。
2. 是否出现角色不应该知道的信息。
3. 时间线、空间位置、因果关系是否成立。
4. 是否擅自替用户角色决定行动、想法、台词或结果。
5. 是否违反角色卡、世界观、场景设定。
6. 是否遗漏用户本轮明确要求的关键内容。
7. 是否出现明显剧情逻辑错误。

【输出格式】
每条问题一行，编号，写清三件事：问题类型、草稿里的原句、应该怎么改。
例：
1. [信息越界] 原句「她早就知道那个秘密」—— 该信息此时尚未揭示，删去这句。
2. [时间线] 原句「昨夜下过雨」—— 与前文晴天冲突，改为「午后」。

严格控制篇幅：最多 8 条，总长不超过 600 字。
全部使用纯文本，不要输出任何嵌套结构或对象。
没有问题时只输出四个字：无需修改。`;

/** 改写阶段默认提示词 */
export const DEFAULT_REWRITE_PROMPT = `你是小说改写器。你的唯一任务是按修改意见修改草稿。

【最高优先级指令】
- 忽略任何关于「推进剧情」「继续生成」「扮演角色」的倾向。
- 你的输出只能是修改后的正文本身，不能包含任何说明、分析、批注。
- 不要自作主张续写新的情节。

【修改要求】
- 只输出最终 RP 正文。
- 尽量保留第一稿原本的文风、节奏、描写和有效内容。
- 只修改修改意见指出的真正问题。
- 不要因为修改意见而把正文改成短句流水账。
- 不要擅自替用户角色决定行动、心理、台词或结果。`;

/** 校验阶段的结构化输出约束 */
export const CRITIQUE_SCHEMA = {
    name: 'critique',
    strict: true,
    value: {
        type: 'object',
        properties: {
            verdict: { type: 'string', enum: ['无需修改', '需要修改'] },
            issues: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        severity: { type: 'string', enum: ['critical', 'major', 'minor'] },
                        category: {
                            type: 'string',
                            enum: ['角色一致性', '信息越界', '时间线', '空间关系', '因果', '越权代演', '设定冲突', '遗漏要求', '其它'],
                        },
                        evidence: { type: 'string', description: '草稿原文中的片段' },
                        fix: { type: 'string', description: '具体怎么改' },
                    },
                    required: ['severity', 'category', 'evidence', 'fix'],
                    additionalProperties: false,
                },
            },
        },
        required: ['verdict', 'issues'],
        additionalProperties: false,
    },
};

function stageDefaults(overrides) {
    return {
        /**
         * 预设里作为注入槽位的条目名。
         *
         * 这个条目由你在酒馆的预设编辑器里手工新建，位置也由你定 ——
         * 因为「指令放在哪、以什么身份出现」直接决定模型会不会被预设里
         * 更靠后的强提示词（例如推进剧情）带跑。
         */
        slotName: '',

        /**
         * 换渠道（三选一，优先级从高到低）：
         *   1. apiUrl + apiKey —— 直接指定地址和密钥，最通用
         *   2. proxyPreset     —— 酒馆的「代理预设」
         *   3. 都不填          —— 用当前连接
         *
         * apiUrl 填的是 **base 地址**（例如 https://api.cline.bot/api/v1），
         * `/chat/completions` 由酒馆自己补 —— 这是酒馆 custom 源的契约，
         * 我们补了会变成双重拼接。已经写全端点的写法酒馆也认（以
         * /chat/completions 结尾就原样用）。
         *
         * apiKey 必须是真正的 API key，不能拿「账号登录 token」顶替：
         * Cline 这类服务两种凭据不通用，拿错会得到 401。
         *
         * 注意 proxyPreset 的局限：酒馆的代理预设是**挂在具体厂商下面的**
         * （DeepSeek / Gemini 等），不是给 OpenAI 兼容自定义源用的。
         * 要指向 Cline 这类自定义端点，用 apiUrl + apiKey。
         */
        apiUrl: '',
        apiKey: '',
        proxyPreset: '',

        /** 覆盖模型名；空 = 不覆盖 */
        model: '',

        /**
         * 直接附加到请求体顶层的字段（provider 私有参数，例如思考开关）。
         * 通过 CHAT_COMPLETION_SETTINGS_READY 事件注入，不走 custom_include_body
         * —— 后者要过一遍 YAML 序列化，嵌套对象容易出问题。
         */
        bodyFields: {},

        /**
         * 附加请求体字段的**原文**（面板里那段的原始文本，一字不改）。
         *
         * 会走 custom_include_body 原样发给酒馆。
         *
         * ⚠️ 必须写**能解析的 JSON/YAML**。
         *
         * 有过一个流传的做法：故意写不严格的 JSON（加尾逗号），
         * 据说能让酒馆跳过解析、把字段原样转发出去。**实测是反的。**
         *
         * 酒馆后端（src/endpoints/backends/chat-completions.js:2409）对 custom
         * 源做的是：先建一个 bodyParams（只有 logprobs / top_logprobs），
         * 再用 mergeObjectWithYaml 把 custom_include_body 合并进去，
         * 最后 `requestBody = { model, messages, ..., ...bodyParams }`。
         *
         * 而 mergeObjectWithYaml 内部是 try/catch：
         *   解析成功 → Object.assign，字段全部进请求体
         *   解析失败 → catch 里什么都不做，**一个字段都不加**
         *
         * 也就是说它是**合并、不是过滤** —— 不认识的字段不会被丢掉，
         * 所以根本不需要「绕过解析」这个技巧。
         * 加了尾逗号反而让所有附加字段静默失效（实测：带尾逗号时上游回
         * "Error parsing request"；去掉尾逗号立刻正常）。
         *
         * 所以写严格 JSON 就行。
         */
        bodyFieldsRaw: '',

        temperature: 1.0,
        maxTokens: 2048,
        useStream: true,
        ...overrides,
    };
}

export const DEFAULT_SETTINGS = Object.freeze({
    version: 3,
    auto: false,
    /** 总开关，关掉后悬浮球显示停用态 */
    enabled: true,

    critic: stageDefaults({
        slotName: 'AW-校验',
        temperature: 0.3,
        systemPrompt: DEFAULT_CRITIC_PROMPT,
    }),

    final: stageDefaults({
        slotName: 'AW-改写',
        temperature: 1.0,
        systemPrompt: DEFAULT_REWRITE_PROMPT,
    }),

    ui: {
        /** 面板里展开的页签 */
        tab: 'params',
    },
});

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

/** 深合并：以默认值为骨架，把用户存的值盖上去 */
function merge(base, extra) {
    if (!extra || typeof extra !== 'object') return base;
    for (const key of Object.keys(extra)) {
        const value = extra[key];
        if (value && typeof value === 'object' && !Array.isArray(value) && base[key] && typeof base[key] === 'object' && !Array.isArray(base[key])) {
            merge(base[key], value);
        } else if (value !== undefined) {
            base[key] = value;
        }
    }
    return base;
}

function context() {
    return globalThis.SillyTavern?.getContext?.() ?? null;
}

/** 拿到当前设置（会补齐缺失的默认键） */
export function getSettings() {
    const ctx = context();
    if (!ctx) throw new Error('SillyTavern.getContext() 不可用');

    if (!ctx.extensionSettings || typeof ctx.extensionSettings !== 'object') {
        ctx.extensionSettings = {};
    }

    const stored = ctx.extensionSettings[MODULE_NAME];
    const merged = merge(clone(DEFAULT_SETTINGS), stored ?? {});
    ctx.extensionSettings[MODULE_NAME] = merged;
    return merged;
}

let saveTimer = null;

/**
 * 保存设置。
 * 防抖 600ms —— saveSettingsDebounced 本身也防抖，但面板是逐字符 input 触发的，
 * 这里再收一道，避免打字时疯狂排队。
 */
export function saveSettings({ immediate = false } = {}) {
    const doSave = () => {
        try {
            context()?.saveSettingsDebounced?.();
        } catch (e) {
            console.warn('[AgentWriter] 保存设置失败', e);
        }
    };

    if (immediate) {
        clearTimeout(saveTimer);
        saveTimer = null;
        doSave();
        return;
    }

    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
        saveTimer = null;
        doSave();
    }, 600);
}

export function resetSettings() {
    const ctx = context();
    if (!ctx?.extensionSettings) return getSettings();
    ctx.extensionSettings[MODULE_NAME] = clone(DEFAULT_SETTINGS);
    saveSettings({ immediate: true });
    return getSettings();
}
