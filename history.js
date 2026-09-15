/**
 * Agent Writer - 版本历史（快照）
 *
 * 为什么要这个
 * ------------
 * 设置是自动保存的（改一下就写进 settings.json）。这很方便，但意味着
 * **误触没有后悔药** —— 手滑改了温度、清空了一段调了很久的提示词、
 * 按到「恢复默认提示词」，原值当时就没了。
 *
 * 所以这里做两层保护：
 *   1. 自动快照：每次设置**变化之前**先留一份旧值。误触之后能回退一步。
 *   2. 手动快照：你自己点「存快照」打一个标记，以后随时回到那个点。
 *
 * 恢复之前也会自动存一份当前值，所以「恢复」这个动作本身也能撤销 ——
 * 否则防误触的功能自己变成最大的误触来源。
 *
 * 存哪儿
 * ------
 * `extensionSettings.agent_writer_history`，跟设置一样在服务端
 * （data/<用户>/settings.json），跟着酒馆账号走。
 *
 * 为什么不塞进 agent_writer 里面：getSettings() 会拿 DEFAULT_SETTINGS 做一次
 * 深合并再写回，历史里那个数组会被 merge 当普通值反复搬运；分开存就完全
 * 绕开那条路径，设置对象保持干净。
 */

import { MODULE_NAME, getSettings, saveSettings, DEFAULT_SETTINGS } from './config.js?v=0.8.27';

/** 历史单独一个键，避免被 getSettings() 的深合并搅进来 */
export const HISTORY_KEY = `${MODULE_NAME}_history`;

/** 留多少份。每份几 KB，settings.json 撑得住；再多就只是占地方。 */
export const MAX_SNAPSHOTS = 24;

const SCHEMA_VERSION = 1;

/**
 * 会进快照的字段。
 *
 * 显式列出来而不是「整个 settings」—— 这样以后加了新字段忘记同步时，
 * 是快照里少一个字段（看得见），而不是把不该存的悄悄存进去。
 *
 * ⚠️ 故意**不含 `ui`**：`ui.tab` 是「当前开着哪个页签」，点一下页签就会
 * 触发一次保存。把它算进来的话，光是来回翻页就能把快照格子占满，
 * 真正要紧的改动反而被挤掉了。
 */
const SNAPSHOT_FIELDS = ['auto', 'enabled', 'critic', 'final'];

function ctx() {
    return globalThis.SillyTavern?.getContext?.() ?? null;
}

/** 把设置里该存的那部分抠出来（深拷贝） */
export function pickSnapshotData(settings) {
    const out = {};
    for (const key of SNAPSHOT_FIELDS) {
        if (settings?.[key] !== undefined) {
            out[key] = JSON.parse(JSON.stringify(settings[key]));
        }
    }
    return out;
}

function readRaw() {
    const context = ctx();
    const stored = context?.extensionSettings?.[HISTORY_KEY];
    if (!stored || typeof stored !== 'object') return { version: SCHEMA_VERSION, items: [] };
    if (!Array.isArray(stored.items)) return { version: SCHEMA_VERSION, items: [] };
    return { version: SCHEMA_VERSION, items: stored.items.filter((x) => x && typeof x === 'object' && x.data) };
}

function writeRaw(store) {
    const context = ctx();
    if (!context?.extensionSettings) return false;
    context.extensionSettings[HISTORY_KEY] = store;
    // reason='history' —— 写历史本身不算「用户改了设置」。
    // 不标出来的话，每次存快照都会再触发一次自动快照的定时器（虽然
    // 最终会被去重挡住，但白白多跑一圈）。
    saveSettings({ immediate: true, reason: 'history' });
    return true;
}

/** 读出全部快照，新的在前 */
export function listSnapshots() {
    return readRaw().items.slice().sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
}

export function countSnapshots() {
    return readRaw().items.length;
}

export function clearSnapshots() {
    return writeRaw({ version: SCHEMA_VERSION, items: [] });
}

/**
 * 存一份快照。
 *
 * @param {object} options
 * @param {string} [options.label]  你给这次快照起的名字（手动存时用）
 * @param {'manual'|'auto'|'before-restore'|'before-reset'} [options.reason]
 * @param {object} [options.data]   要存的内容；不给就存当前设置
 * @returns {object|null} 存进去的那一条
 */
export function pushSnapshot({ label = '', reason = 'manual', data = null } = {}) {
    const store = readRaw();

    const payload = data ?? pickSnapshotData(getSettings());
    const now = Date.now();

    // 连着存了同样的内容就没意义 —— 手指抖两下不该占两个格子
    const newest = store.items.reduce((acc, x) => (x.at > (acc?.at ?? 0) ? x : acc), null);
    if (newest && JSON.stringify(newest.data) === JSON.stringify(payload)) {
        return null;
    }

    const item = {
        id: `snap-${now}-${Math.random().toString(36).slice(2, 7)}`,
        at: now,
        label: String(label ?? '').slice(0, 60),
        reason,
        data: payload,
    };

    store.items.push(item);

    // 超了就丢最旧的，但**手动存的优先保留** —— 那是用户特意打的点
    if (store.items.length > MAX_SNAPSHOTS) {
        const sorted = store.items.slice().sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
        while (sorted.length > MAX_SNAPSHOTS) {
            const idx = sorted.findIndex((x) => x.reason !== 'manual');
            sorted.splice(idx >= 0 ? idx : 0, 1);
        }
        store.items = sorted;
    }

    writeRaw(store);
    return item;
}

export function deleteSnapshot(id) {
    const store = readRaw();
    const before = store.items.length;
    store.items = store.items.filter((x) => x.id !== id);
    if (store.items.length === before) return false;
    writeRaw(store);
    return true;
}

/**
 * 恢复到某一份快照。
 *
 * ⚠️ 恢复之前会先把**当前**状态存一份（reason='before-restore'），
 * 所以恢复错了还能再恢复回来。少了这一步，这个功能本身就是最大的误触来源。
 *
 * @returns {{ok: boolean, backup?: object, error?: string}}
 */
export function restoreSnapshot(id) {
    const store = readRaw();
    const item = store.items.find((x) => x.id === id);
    if (!item) return { ok: false, error: '找不到这份快照（可能已经被删了）' };

    const backup = pushSnapshot({ reason: 'before-restore', label: '恢复前自动留存' });

    const context = ctx();
    if (!context?.extensionSettings) return { ok: false, error: 'extensionSettings 不可用' };

    // 记下当前页签：快照里不含 ui（见 SNAPSHOT_FIELDS 的说明），
    // 不特意保留的话恢复完面板会跳回「参数」页 —— 你明明在「版本」页上操作。
    const currentTab = context.extensionSettings[MODULE_NAME]?.ui?.tab;

    // 以默认值为骨架合并，这样旧快照缺的新字段还能拿到默认值
    const merged = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
    deepMerge(merged, item.data);
    if (currentTab) merged.ui = { ...merged.ui, tab: currentTab };

    context.extensionSettings[MODULE_NAME] = merged;
    saveSettings({ immediate: true });

    // 刚恢复完的样子就是新基准，免得 1.5 秒后的自动快照又把
    // 「恢复前」当成一次新改动记一遍（去重能挡住，但基准更新更干净）
    markBaseline();

    return { ok: true, backup, applied: item };
}

function deepMerge(base, extra) {
    if (!extra || typeof extra !== 'object') return base;
    for (const key of Object.keys(extra)) {
        const value = extra[key];
        if (value && typeof value === 'object' && !Array.isArray(value)
            && base[key] && typeof base[key] === 'object' && !Array.isArray(base[key])) {
            deepMerge(base[key], value);
        } else if (value !== undefined) {
            base[key] = value;
        }
    }
    return base;
}

// ---------------------------------------------------------------------------
// 差异对比 —— 「这份快照和现在差在哪」是这个页面最有用的信息
// ---------------------------------------------------------------------------

/** 字段路径 -> 中文名字。没列到的会退化成路径本身。 */
const FIELD_LABELS = {
    auto: '自动模式',
    enabled: '总开关',
    'critic.slotName': '② 槽位名',
    'critic.apiUrl': '② API 地址',
    'critic.apiKey': '② 密钥',
    'critic.proxyPreset': '② 代理预设',
    'critic.model': '② 模型',
    'critic.bodyFieldsRaw': '② 附加请求体',
    'critic.temperature': '② 温度',
    'critic.maxTokens': '② 最大长度',
    'critic.useStream': '② 流式',
    'critic.systemPrompt': '② 提示词',
    'final.slotName': '③ 槽位名',
    'final.apiUrl': '③ API 地址',
    'final.apiKey': '③ 密钥',
    'final.proxyPreset': '③ 代理预设',
    'final.model': '③ 模型',
    'final.bodyFieldsRaw': '③ 附加请求体',
    'final.temperature': '③ 温度',
    'final.maxTokens': '③ 最大长度',
    'final.useStream': '③ 流式',
    'final.systemPrompt': '③ 提示词',
    'ui.tab': '当前页签',
};

function flatten(value, prefix = '', out = {}) {
    if (value === null || typeof value !== 'object') {
        out[prefix] = value;
        return out;
    }
    if (Array.isArray(value)) {
        out[prefix] = JSON.stringify(value);
        return out;
    }
    for (const key of Object.keys(value)) {
        flatten(value[key], prefix ? `${prefix}.${key}` : key, out);
    }
    return out;
}

/** 值太长就别整段打出来，给个长度和头几个字 */
function brief(value) {
    if (value === undefined) return '(无)';
    if (value === '') return '(空)';
    if (typeof value === 'boolean') return value ? '开' : '关';
    const text = String(value);
    if (text.length <= 24) return text;
    return `${text.slice(0, 18)}…（共 ${text.length} 字）`;
}

/** 密钥这类只说有没有，别把内容打出来 */
function briefSecret(value) {
    const text = String(value ?? '');
    if (!text) return '(空)';
    return `已设置（${text.slice(0, 4)}…，${text.length} 位）`;
}

/**
 * 比较两份设置，返回人能看懂的一行行差异。
 *
 * @param {object} a 旧
 * @param {object} b 新
 * @returns {string[]}
 */
export function diffSettings(a, b) {
    const flatA = flatten(a ?? {});
    const flatB = flatten(b ?? {});
    const keys = [...new Set([...Object.keys(flatA), ...Object.keys(flatB)])].sort();

    const lines = [];
    for (const key of keys) {
        const before = flatA[key];
        const after = flatB[key];
        if (before === after) continue;

        const name = FIELD_LABELS[key] ?? key;
        if (key.endsWith('.apiKey')) {
            lines.push(`${name}：${briefSecret(before)} → ${briefSecret(after)}`);
        } else {
            lines.push(`${name}：${brief(before)} → ${brief(after)}`);
        }
    }
    return lines;
}

/** 时间戳 → 「09-16 14:32」 */
export function formatTime(at) {
    const d = new Date(at ?? 0);
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export const REASON_LABELS = {
    manual: '手动',
    auto: '自动·改动前',
    'before-restore': '恢复前',
    'before-reset': '恢复默认前',
};

export function describeSnapshot(item) {
    const reason = REASON_LABELS[item?.reason] ?? item?.reason ?? '';
    const label = item?.label ? `${item.label}` : '';
    return [formatTime(item?.at), reason, label].filter(Boolean).join(' · ');
}

// ---------------------------------------------------------------------------
// 自动快照
// ---------------------------------------------------------------------------

let lastSeenJson = null;
let autoTimer = null;
let pendingReason = 'auto';
const AUTO_DELAY_MS = 1500;

/**
 * 结算一次待处理的快照。
 *
 * ⚠️ 定时器和 flushPendingSnapshot（测试用）**必须共用这一份实现**。
 * 之前两边各写了一遍，结果测试只跑到 flush 那一份，定时器那一份
 * 改坏了也测不出来 —— 回归测试等于摆设（确实发生过：把方向改反了，
 * 测试照样全绿）。
 *
 * @returns {boolean} 有没有真的存下一份
 */
function settlePendingSnapshot() {
    const currentJson = JSON.stringify(pickSnapshotData(getSettings()));
    if (lastSeenJson === null) {
        lastSeenJson = currentJson;
        return false;
    }
    if (currentJson === lastSeenJson) return false;

    // 存的是 lastSeenJson —— 也就是**改动之前**的样子。
    // 方向千万别搞反：存成「改完之后」的话，误触之后回退到的是刚改坏的
    // 状态，等于没救。
    pushSnapshot({ reason: pendingReason, data: JSON.parse(lastSeenJson) });
    lastSeenJson = currentJson;
    return true;
}

/**
 * 记下「现在的样子」作为基准。启动时调一次。
 *
 * 之后每次变化都会和这个基准比，不同就把**基准**（改动之前的样子）存下来。
 */
export function markBaseline() {
    try {
        lastSeenJson = JSON.stringify(pickSnapshotData(getSettings()));
    } catch {
        lastSeenJson = null;
    }
}

/**
 * 设置变了 —— 安排一次「改动前」快照。
 *
 * 防抖的意义：敲提示词是逐字符触发的，不防抖会存出几百份。
 * 防抖之后，一气呵成的编辑只对应一份「编辑之前」的快照 —— 这正是
 * 误触之后想回到的那个点。
 *
 * @param {string} [reason] 覆盖默认的 'auto'
 */
export function noteChange(reason = 'auto') {
    pendingReason = reason;
    if (autoTimer) clearTimeout(autoTimer);
    autoTimer = setTimeout(() => {
        autoTimer = null;
        try {
            settlePendingSnapshot();
        } catch (e) {
            console.warn('[AgentWriter] 自动快照失败', e);
        }
    }, AUTO_DELAY_MS);
}

/**
 * 测试用：不等防抖，立刻结算。
 * 走的是和定时器同一个 settlePendingSnapshot，所以测到的就是生产路径。
 */
export function flushPendingSnapshot() {
    if (!autoTimer) return false;
    clearTimeout(autoTimer);
    autoTimer = null;
    try {
        return settlePendingSnapshot();
    } catch {
        return false;
    }
}

/** 测试用：重置模块内的基准状态 */
export function _resetBaselineForTest() {
    if (autoTimer) clearTimeout(autoTimer);
    autoTimer = null;
    lastSeenJson = null;
    pendingReason = 'auto';
}
