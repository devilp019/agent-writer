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
        /** 引用哪个酒馆连接配置；空 = 用当前连接 */
        profileId: '',
        /** 覆盖配置里的模型；空 = 不覆盖 */
        model: '',
        /** 追加到请求体，用来开关思考等 provider 私有参数 */
        overridePayload: {},
        temperature: 1.0,
        maxTokens: 2048,
        /** 默认走流式：部分上游（实测 Cline）的非流式包裹格式酒馆解析不了 */
        useStream: true,
        /** 拿到空正文时是否自动重试一次流式 */
        autoRetryOnEmpty: true,
        /**
         * 上游专有的「停止生成」字段名（留空 = 不发）。
         * 酒馆中止上游主要靠关闭连接，但有些上游还认显式的请求体字段。
         */
        abortFlag: '',
        abortFlagOnStop: true,
        /** 校验阶段可见的聊天楼层数 */
        contextDepth: 6,
        includeCharCard: true,
        ...overrides,
    };
}

export const DEFAULT_SETTINGS = Object.freeze({
    version: 2,
    auto: false,
    /** 总开关，关掉后悬浮球显示停用态 */
    enabled: true,

    critic: stageDefaults({
        temperature: 0.3,
        useStream: true,
        /**
         * 默认关闭。
         *
         * 打开后会把 CRITIQUE_SCHEMA 作为请求体顶层 json_schema 发出去，
         * 酒馆会转成 OpenAI 的 response_format —— 但自定义来源未必支持，
         * 不支持时上游会报错或忽略，反而更糟。
         * 默认靠提示词里写明的 JSON 结构约束输出，配合解析容错，通用性更好。
         */
        useJsonSchema: false,
        systemPrompt: DEFAULT_CRITIC_PROMPT,
        overridePayload: { thinking: { type: 'enabled' } },
    }),

    final: stageDefaults({
        temperature: 1.0,
        useStream: true,
        autoRetryOnEmpty: true,
        systemPrompt: DEFAULT_REWRITE_PROMPT,
        overridePayload: { thinking: { type: 'disabled' } },
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
