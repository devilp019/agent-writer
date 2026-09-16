/**
 * Agent Writer - 存档（参数 / 提示词分别存）
 *
 * 为什么是这个模型，而不是「快照时间线」
 * --------------------------------------
 * 一开始做的是「每次改动前自动存一份」的时间线。用起来别扭：
 *
 *   · 你没法预先建好几个版本来回切 —— 只能等它被改动之后再回去捞。
 *   · 列表里全是自动生成的条目，分不清哪个是哪个。
 *   · 想「一直保留一套调好的参数」也做不到：它只是历史里的一条，
 *     随时可能被上限挤掉。
 *
 * 现在改成**具名存档**：
 *
 *   · **参数**和**提示词**分开存。这样可以 3 套参数 × 2 套提示词混着用，
 *     而不是被绑成一个整体。
 *   · 当前这一份照旧自动保存（改一下就存），不用管。
 *   · 想留住哪一份，手动存成**有名字的存档**。存档一旦存下就**不受**
 *     当前乱改的影响 —— 这正是它存在的意义。
 *   · 存档可以随时「应用」回来；也可以改名、用当前覆盖、删掉。
 *
 * 应用时会先比一下：当前和这份存档**不一样**才弹框确认，并列出差在哪。
 * 一样就直接告诉你「已经就是这个」，不打扰。
 *
 * 存哪儿
 * ------
 * `extensionSettings.agent_writer_archives`（跟设置一样在服务端
 * `settings.json` 里，跟着酒馆账号走）。
 * 单独一个键，免得被 getSettings() 的深合并搅进来。
 */

import { MODULE_NAME, getSettings, saveSettings, DEFAULT_SETTINGS } from './config.js?v=0.9.1';

export const ARCHIVES_KEY = `${MODULE_NAME}_archives`;

const SCHEMA_VERSION = 1;

/** 每种存档最多留几份 */
export const MAX_ARCHIVES = 30;

/**
 * 「参数」存档包含哪些字段。
 *
 * 显式列出而不是整段拷走 —— 提示词有自己的存档（systemPrompt 不在这里），
 * 全局开关（auto / enabled）是运行时状态，也不该跟着参数走。
 */
const PARAM_FIELDS = [
    'slotName',
    'apiUrl',
    'apiKey',
    'proxyPreset',
    'model',
    'bodyFields',
    'bodyFieldsRaw',
    'temperature',
    'maxTokens',
    'useStream',
];

const STAGES = ['critic', 'final'];

export const KIND_LABELS = { params: '参数', prompts: '提示词' };

function ctx() {
    return globalThis.SillyTavern?.getContext?.() ?? null;
}

// ---------------------------------------------------------------------------
// 读 / 写
// ---------------------------------------------------------------------------

function emptyStore() {
    return {
        version: SCHEMA_VERSION,
        params: [],
        prompts: [],
        // 最近一次「应用」的是哪一份，用来在界面上标「当前已偏离」
        applied: { params: null, prompts: null },
    };
}

function readStore() {
    const stored = ctx()?.extensionSettings?.[ARCHIVES_KEY];
    if (!stored || typeof stored !== 'object') return emptyStore();
    const store = emptyStore();
    for (const kind of ['params', 'prompts']) {
        if (Array.isArray(stored[kind])) {
            store[kind] = stored[kind].filter((x) => x && typeof x === 'object' && x.data);
        }
    }
    if (stored.applied && typeof stored.applied === 'object') {
        store.applied = { ...store.applied, ...stored.applied };
    }
    return store;
}

function writeStore(store) {
    const context = ctx();
    if (!context?.extensionSettings) return false;
    context.extensionSettings[ARCHIVES_KEY] = store;
    // reason='archives' —— 写存档不算「用户改了设置」，
    // 免得触发了别处监听设置变化的东西
    saveSettings({ immediate: true, reason: 'archives' });
    return true;
}

function newId(kind) {
    return `${kind}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

// ---------------------------------------------------------------------------
// 从当前设置里抠出存档内容
// ---------------------------------------------------------------------------

/** 参数：只取 PARAM_FIELDS */
export function pickParams(settings) {
    const out = {};
    for (const stage of STAGES) {
        const src = settings?.[stage] ?? {};
        const dst = {};
        for (const field of PARAM_FIELDS) {
            if (src[field] !== undefined) dst[field] = JSON.parse(JSON.stringify(src[field]));
        }
        out[stage] = dst;
    }
    return out;
}

/** 提示词：只取两个 systemPrompt */
export function pickPrompts(settings) {
    const out = {};
    for (const stage of STAGES) {
        out[stage] = String(settings?.[stage]?.systemPrompt ?? '');
    }
    return out;
}

export function pickFor(kind, settings) {
    return kind === 'prompts' ? pickPrompts(settings) : pickParams(settings);
}

// ---------------------------------------------------------------------------
// 增删改查
// ---------------------------------------------------------------------------

/** 某个种类的全部存档，新的在前 */
export function listArchives(kind) {
    const store = readStore();
    const items = Array.isArray(store[kind]) ? store[kind] : [];
    return items.slice().sort((a, b) => (b.updatedAt ?? b.at ?? 0) - (a.updatedAt ?? a.at ?? 0));
}

export function getArchive(kind, id) {
    const store = readStore();
    return (store[kind] ?? []).find((x) => x.id === id) ?? null;
}

/**
 * 把当前的参数/提示词存成一个具名存档。
 *
 * @param {'params'|'prompts'} kind
 * @param {string} name
 * @param {object} [options]
 * @param {boolean} [options.overwrite] 重名时是否覆盖
 * @param {object} [options.data] 不传就用当前设置
 * @returns {{ok: boolean, item?: object, reason?: string}}
 */
export function saveArchive(kind, name, { overwrite = false, data = null } = {}) {
    const clean = String(name ?? '').trim();
    if (!clean) return { ok: false, reason: '名字不能是空的' };
    if (clean.length > 60) return { ok: false, reason: '名字太长了（最多 60 字）' };

    const store = readStore();
    const list = store[kind] ?? [];
    const existing = list.find((x) => x.name === clean);

    const payload = data ?? pickFor(kind, getSettings());
    const now = Date.now();

    if (existing) {
        if (!overwrite) {
            return { ok: false, reason: 'exists', item: existing };
        }
        existing.data = payload;
        existing.updatedAt = now;
        writeStore(store);
        return { ok: true, item: existing };
    }

    const item = { id: newId(kind), name: clean, at: now, updatedAt: now, data: payload };
    list.push(item);

    // 超上限就丢最旧的
    if (list.length > MAX_ARCHIVES) {
        list.sort((a, b) => (a.updatedAt ?? 0) - (b.updatedAt ?? 0));
        list.splice(0, list.length - MAX_ARCHIVES);
    }

    store[kind] = list;
    writeStore(store);
    return { ok: true, item };
}

/** 用**当前**的参数/提示词覆盖已有存档（「二次修改」） */
export function overwriteArchive(kind, id) {
    const store = readStore();
    const item = (store[kind] ?? []).find((x) => x.id === id);
    if (!item) return { ok: false, reason: '找不到这份存档' };

    item.data = pickFor(kind, getSettings());
    item.updatedAt = Date.now();
    writeStore(store);
    return { ok: true, item };
}

export function renameArchive(kind, id, name) {
    const clean = String(name ?? '').trim();
    if (!clean) return { ok: false, reason: '名字不能是空的' };

    const store = readStore();
    const list = store[kind] ?? [];
    const item = list.find((x) => x.id === id);
    if (!item) return { ok: false, reason: '找不到这份存档' };

    const clash = list.find((x) => x.name === clean && x.id !== id);
    if (clash) return { ok: false, reason: '已经有同名的存档了' };

    item.name = clean;
    item.updatedAt = Date.now();

    // 界面上「已应用」显示的是名字，改名要跟着走
    if (store.applied?.[kind]?.id === id) {
        store.applied[kind] = { id, name: clean };
    }

    writeStore(store);
    return { ok: true, item };
}

export function deleteArchive(kind, id) {
    const store = readStore();
    const list = store[kind] ?? [];
    const before = list.length;
    store[kind] = list.filter((x) => x.id !== id);
    if (store[kind].length === before) return { ok: false, reason: '找不到这份存档' };

    if (store.applied?.[kind]?.id === id) store.applied[kind] = null;
    writeStore(store);
    return { ok: true };
}

/** 最近应用的是哪一份 */
export function getApplied(kind) {
    return readStore().applied?.[kind] ?? null;
}

// ---------------------------------------------------------------------------
// 应用
// ---------------------------------------------------------------------------

/**
 * 把一份存档写回当前设置。
 *
 * 只动这份存档管的那部分：
 *   · 应用参数 → 不碰提示词
 *   · 应用提示词 → 不碰参数
 * 这就是「分开存」的意义 —— 换参数不该顺手把你正在写的提示词也换掉。
 *
 * @returns {{ok: boolean, item?: object, reason?: string}}
 */
export function applyArchive(kind, id) {
    const store = readStore();
    const item = (store[kind] ?? []).find((x) => x.id === id);
    if (!item) return { ok: false, reason: '找不到这份存档（可能已经被删了）' };

    const context = ctx();
    if (!context?.extensionSettings) return { ok: false, reason: 'extensionSettings 不可用' };

    const settings = getSettings();

    if (kind === 'prompts') {
        for (const stage of STAGES) {
            if (!settings[stage]) settings[stage] = {};
            settings[stage].systemPrompt = String(item.data?.[stage] ?? '');
        }
    } else {
        for (const stage of STAGES) {
            if (!settings[stage]) settings[stage] = {};
            const data = item.data?.[stage] ?? {};
            for (const field of PARAM_FIELDS) {
                if (data[field] !== undefined) {
                    settings[stage][field] = JSON.parse(JSON.stringify(data[field]));
                }
            }
        }
    }

    store.applied[kind] = { id: item.id, name: item.name };
    context.extensionSettings[MODULE_NAME] = settings;
    // 先记 applied，再落盘
    context.extensionSettings[ARCHIVES_KEY] = store;
    saveSettings({ immediate: true, reason: 'archives' });

    return { ok: true, item };
}

// ---------------------------------------------------------------------------
// 差异对比
// ---------------------------------------------------------------------------

/** 字段路径 -> 中文名 */
const FIELD_LABELS = {
    'critic.slotName': '② 槽位名',
    'critic.apiUrl': '② API 地址',
    'critic.apiKey': '② 密钥',
    'critic.proxyPreset': '② 代理预设',
    'critic.model': '② 模型',
    'critic.bodyFieldsRaw': '② 附加请求体',
    'critic.temperature': '② 温度',
    'critic.maxTokens': '② 最大长度',
    'critic.useStream': '② 流式',
    'final.slotName': '③ 槽位名',
    'final.apiUrl': '③ API 地址',
    'final.apiKey': '③ 密钥',
    'final.proxyPreset': '③ 代理预设',
    'final.model': '③ 模型',
    'final.bodyFieldsRaw': '③ 附加请求体',
    'final.temperature': '③ 温度',
    'final.maxTokens': '③ 最大长度',
    'final.useStream': '③ 流式',
    'critic': '② 提示词',
    'final': '③ 提示词',
};

function brief(value) {
    if (value === undefined) return '(无)';
    if (value === '') return '(空)';
    if (typeof value === 'boolean') return value ? '开' : '关';
    const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
    if (text.length <= 24) return text;
    return `${text.slice(0, 18)}…（共 ${text.length} 字）`;
}

/** 密钥只说有没有，别把内容打出来 */
function briefSecret(value) {
    const text = String(value ?? '');
    if (!text) return '(空)';
    return `已设置（${text.slice(0, 4)}…，${text.length} 位）`;
}

/**
 * 这份存档和**当前**设置差在哪。
 *
 * @param {'params'|'prompts'} kind
 * @param {string} id
 * @returns {string[]} 一行行人话；空数组表示完全一致
 */
export function diffArchive(kind, id) {
    const item = getArchive(kind, id);
    if (!item) return ['(这份存档已经不在了)'];

    const current = pickFor(kind, getSettings());
    const lines = [];

    if (kind === 'prompts') {
        // 提示词整段比，只说「改了」和字数变化 —— 逐字 diff 对用户没意义
        for (const stage of STAGES) {
            const before = String(item.data?.[stage] ?? '');
            const after = String(current[stage] ?? '');
            if (before === after) continue;
            const name = FIELD_LABELS[stage] ?? stage;
            lines.push(`${name}：${before.length} 字 → ${after.length} 字`);
        }
        return lines;
    }

    for (const stage of STAGES) {
        const a = item.data?.[stage] ?? {};
        const b = current[stage] ?? {};
        const fields = [...new Set([...Object.keys(a), ...Object.keys(b)])];
        for (const field of fields) {
            const key = `${stage}.${field}`;
            if (!PARAM_FIELDS.includes(field)) continue;
            const before = a[field];
            const after = b[field];
            if (JSON.stringify(before) === JSON.stringify(after)) continue;

            const name = FIELD_LABELS[key] ?? key;
            if (field === 'apiKey') {
                lines.push(`${name}：${briefSecret(after)} → ${briefSecret(before)}`);
            } else {
                lines.push(`${name}：${brief(after)} → ${brief(before)}`);
            }
        }
    }
    return lines;
}

/** 这份存档和当前是不是一致 */
export function isArchiveCurrent(kind, id) {
    const item = getArchive(kind, id);
    if (!item) return false;
    return JSON.stringify(item.data) === JSON.stringify(pickFor(kind, getSettings()));
}

/**
 * 当前是不是偏离了「最近应用的那一份」。
 * 用来在界面上提醒「你已经改过东西了」。
 */
export function driftFromApplied(kind) {
    const applied = getApplied(kind);
    if (!applied?.id) return null;
    const item = getArchive(kind, applied.id);
    if (!item) return null;
    const differs = JSON.stringify(item.data) !== JSON.stringify(pickFor(kind, getSettings()));
    return { name: applied.name, differs };
}

// ---------------------------------------------------------------------------
// 显示辅助
// ---------------------------------------------------------------------------

export function formatTime(at) {
    const d = new Date(at ?? 0);
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 存档内容的可读摘要（「这份里存了什么」折叠框用） */
export function summarizeArchive(kind, item) {
    if (!item?.data) return '(空)';

    if (kind === 'prompts') {
        return STAGES.map((stage) => {
            const title = stage === 'critic' ? '② 校验提示词' : '③ 改写提示词';
            const text = String(item.data[stage] ?? '');
            const head = text.slice(0, 80).replace(/\n/g, ' ');
            return `${title}（${text.length} 字）\n  ${head}${text.length > 80 ? '…' : ''}`;
        }).join('\n\n');
    }

    const lines = [];
    for (const stage of STAGES) {
        const s = item.data[stage] ?? {};
        lines.push(`── ${stage === 'critic' ? '② 校验' : '③ 改写'} ──`);
        lines.push(`槽位名：${s.slotName || '(未填)'}`);
        lines.push(`渠道：${s.apiUrl ? s.apiUrl : (s.proxyPreset ? `代理预设 ${s.proxyPreset}` : '用当前连接')}`);
        lines.push(`密钥：${s.apiKey ? `已设置（${String(s.apiKey).slice(0, 4)}…，${String(s.apiKey).length} 位）` : '(空)'}`);
        lines.push(`模型：${s.model || '(不覆盖)'}`);
        lines.push(`温度 / 最大长度：${s.temperature} / ${s.maxTokens}`);
        lines.push(`流式：${s.useStream === false ? '关' : '开'}`);
        lines.push(`附加请求体：${(s.bodyFieldsRaw ?? '').trim() || '(空)'}`);
        lines.push('');
    }
    return lines.join('\n');
}

/** 测试用 */
export function _clearAll() {
    return writeStore(emptyStore());
}
