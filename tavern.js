/**
 * Agent Writer - 酒馆助手桥接
 *
 * 两条设计决定，都是实测/实践得来，不是理论：
 *
 * 1. **走酒馆助手的完整组装**（而不是自己拼提示词）。
 *    你的场景是「①③ 用官 API 关思考、② 用 Cline 开思考」，三者同一个模型。
 *    自己拼的话 ②③ 的提示词结构与 ① 不同，前缀缓存必然失效、每次重发整份。
 *    走酒馆组装则三阶段共用预设与历史，能吃到前缀缓存。
 *
 * 2. **指令注入预设槽位**（而不是 injects 注入到历史末尾）。
 *    末尾注入的指令盖不住预设里更靠后的强提示词（例如推进剧情的），
 *    模型会跑偏去写剧情而不是做校验。
 *    只有预设条目能控制指令的「位置」和「身份」—— 所以用两个固定槽位。
 *
 * 依赖：酒馆助手（JS-Slash-Runner）。它把 TavernHelper 挂在宿主页面上，
 * 本扩展同样跑在宿主页面，所以可以直接调用，不需要 iframe。
 * 这是跨扩展依赖，不是酒馆官方接口 —— 调用前一律先探测。
 */

const SLOT_MARKER = '__AGENT_WRITER_SLOT__';

/** 取宿主页面上的 TavernHelper */
function th() {
    return globalThis.TavernHelper ?? null;
}

/**
 * 探测酒馆助手是否可用。
 * @returns {{ok: boolean, missing: string[], version?: string}}
 */
export function probeTavernHelper() {
    const api = th();
    if (!api) {
        return { ok: false, missing: ['TavernHelper —— 酒馆助手（JS-Slash-Runner）未安装或未启用'] };
    }

    const missing = [];
    for (const name of ['generate', 'getPreset', 'createOrReplacePreset', 'getProxyPresetNames']) {
        if (typeof api[name] !== 'function') missing.push(`TavernHelper.${name}`);
    }

    let version;
    try {
        version = api.getVersion?.();
    } catch { /* 拿不到就算了 */ }

    return { ok: missing.length === 0, missing, version };
}

function requireTh() {
    const probe = probeTavernHelper();
    if (!probe.ok) {
        throw new Error(
            `需要酒馆助手（JS-Slash-Runner）：${probe.missing.join('；')}。`
            + '请在扩展管理里确认它已安装并启用，然后刷新页面。',
        );
    }
    return th();
}

/** 代理预设名列表（下拉框用） */
export function getProxyPresets() {
    try {
        const names = th()?.getProxyPresetNames?.();
        return Array.isArray(names) ? names.filter((n) => n && n !== 'None') : [];
    } catch (e) {
        console.warn('[AgentWriter] 读取代理预设列表失败', e);
        return [];
    }
}

// ---------------------------------------------------------------------------
// 槽位注入
//
// 备份 → 注入 → 跑生成 → 还原。还原必须放在 finally 里，
// 并且扩展启动时要做一次崩溃恢复：万一上次没还原成功（刷新/崩溃/断电），
// 残留在槽位里的内容会被当成正常提示词发出去。
// ---------------------------------------------------------------------------

/** 当前正在使用的槽位备份：slotName → { content, enabled } */
const slotBackups = new Map();

/** 备份键，存在扩展设置里，用于跨刷新恢复 */
const BACKUP_KEY = 'slotBackups';

function settingsApi() {
    return globalThis.SillyTavern?.getContext?.() ?? null;
}

function persistBackups() {
    try {
        const ctx = settingsApi();
        if (!ctx?.extensionSettings) return;
        ctx.extensionSettings.agent_writer_slots = Object.fromEntries(slotBackups);
        ctx.saveSettingsDebounced?.();
    } catch (e) {
        console.warn('[AgentWriter] 保存槽位备份失败', e);
    }
}

function loadPersistedBackups() {
    try {
        return settingsApi()?.extensionSettings?.agent_writer_slots ?? {};
    } catch {
        return {};
    }
}

function isOurContent(content) {
    return typeof content === 'string' && content.includes(SLOT_MARKER);
}

/**
 * 找到槽位条目。找不到就抛明确的错 —— 这个槽位是用户在预设里手工建的，
 * 名字写错的话必须让人一眼看出来，而不是静默失效。
 */
function findSlot(preset, slotName) {
    const target = String(slotName ?? '').trim();
    if (!target) throw new Error('未配置槽位条目名');
    const slot = preset.prompts.find((p) => (p.name ?? '').trim() === target);
    if (!slot) {
        throw new Error(
            `预设里找不到名为「${target}」的条目。`
            + '请在酒馆的预设编辑器里新建两个条目作为注入槽位（校验 / 改写各一个），'
            + '并把它们放在你希望指令生效的位置。',
        );
    }
    return slot;
}

/**
 * 把指令写入槽位，返回还原所需的信息。
 * @param {string} slotName
 * @param {string} instruction
 */
export async function injectSlot(slotName, instruction) {
    const api = requireTh();
    const preset = await api.getPreset('in_use');
    const slot = findSlot(preset, slotName);

    // 如果里面已经是我们上一轮留下的内容，说明上次没还原干净 —— 用持久化的备份兜底
    const persisted = loadPersistedBackups();
    const backup = isOurContent(slot.content) && persisted[slotName]
        ? { content: persisted[slotName].content, enabled: persisted[slotName].enabled }
        : { content: slot.content ?? '', enabled: slot.enabled !== false };

    slotBackups.set(slotName, backup);
    persistBackups();

    slot.content = `${instruction}\n\n${SLOT_MARKER}`;
    slot.enabled = true;

    // render: 'none' —— 每轮都刷新预设界面会抖动，而且会惊动监听预设的脚本
    await api.createOrReplacePreset('in_use', preset, { render: 'none' });

    return backup;
}

/**
 * 还原槽位。任何路径下都必须调用，所以调用方要放在 finally 里。
 */
export async function restoreSlot(slotName) {
    const backup = slotBackups.get(slotName);
    if (!backup) return;

    try {
        const api = requireTh();
        const preset = await api.getPreset('in_use');
        const slot = findSlot(preset, slotName);

        slot.content = backup.content;
        slot.enabled = backup.enabled;
        await api.createOrReplacePreset('in_use', preset, { render: 'none' });
    } catch (e) {
        console.error(`[AgentWriter] 还原槽位「${slotName}」失败，预设可能残留脏内容`, e);
    } finally {
        slotBackups.delete(slotName);
        persistBackups();
    }
}

/**
 * 崩溃恢复：扩展启动时调用。
 * 万一上次没还原成功（刷新、崩溃、断电），把残留清掉。
 */
export async function recoverSlots(slotNames) {
    const api = th();
    if (!api?.getPreset || !api?.createOrReplacePreset) return { recovered: [] };

    const recovered = [];
    const persisted = loadPersistedBackups();

    for (const slotName of slotNames) {
        const name = String(slotName ?? '').trim();
        if (!name) continue;
        try {
            const preset = await api.getPreset('in_use');
            const slot = preset.prompts.find((p) => (p.name ?? '').trim() === name);
            if (!slot || !isOurContent(slot.content)) continue;

            const backup = persisted[name];
            slot.content = backup?.content ?? '';
            slot.enabled = backup?.enabled ?? true;
            await api.createOrReplacePreset('in_use', preset, { render: 'none' });
            recovered.push(name);
            console.warn(`[AgentWriter] 发现槽位「${name}」残留脏内容，已还原`);
        } catch (e) {
            console.error(`[AgentWriter] 恢复槽位「${name}」失败`, e);
        }
    }

    if (recovered.length) {
        try {
            const ctx = settingsApi();
            if (ctx?.extensionSettings) {
                ctx.extensionSettings.agent_writer_slots = {};
                ctx.saveSettingsDebounced?.();
            }
        } catch { /* 忽略 */ }
    }

    return { recovered };
}

// ---------------------------------------------------------------------------
// 请求体字段注入
//
// 酒馆助手在发出请求前会 emit CHAT_COMPLETION_SETTINGS_READY，
// 带上即将发送的 generate_data。监听它、认领自己的那次请求、直接改字段。
// 比走 custom_include_body 可靠（那个要过一遍 YAML 序列化，嵌套对象容易出问题）。
// ---------------------------------------------------------------------------

const pendingPayloads = new Map();
let hooked = false;

function hookRequestBody() {
    if (hooked) return;
    const ctx = settingsApi();
    const eventSource = ctx?.eventSource;
    if (!eventSource?.on || !ctx?.eventTypes?.CHAT_COMPLETION_SETTINGS_READY) return;

    hooked = true;
    eventSource.on(ctx.eventTypes.CHAT_COMPLETION_SETTINGS_READY, (generateData) => {
        if (!generateData || pendingPayloads.size === 0) return;

        // 事件里拿不到 generation_id，所以按内容认领：
        // 哪次请求的槽位内容带着我们的标记，就注入哪一份。
        const haystack = JSON.stringify(generateData.messages ?? '');
        for (const [id, entry] of pendingPayloads) {
            if (!haystack.includes(entry.tag)) continue;

            Object.assign(generateData, entry.payload);
            console.log(`[AgentWriter] 已注入请求体字段：`, entry.payload);
            pendingPayloads.delete(id);
            break;
        }
    });

    console.log('[AgentWriter] 已挂上 CHAT_COMPLETION_SETTINGS_READY');
}

export function setPendingPayload(tag, payload) {
    hookRequestBody();
    if (!payload || Object.keys(payload).length === 0) return;
    pendingPayloads.set(tag, { tag, payload });
}

export function clearPendingPayload(tag) {
    pendingPayloads.delete(tag);
}

// ---------------------------------------------------------------------------
// 生成
// ---------------------------------------------------------------------------

/**
 * 跑一次生成。指令由调用方写入槽位，这里只负责调 generate。
 *
 * @param {object} options
 * @param {object} options.stage 该阶段设置
 * @param {string} options.generationId
 * @param {AbortSignal} [options.signal]
 * @param {(text: string) => void} [options.onProgress]
 * @returns {Promise<string>}
 */
export async function tavernGenerate({ stage, generationId, signal, onProgress }) {
    const api = requireTh();
    const ctx = settingsApi();

    const customApi = {};
    if (stage.proxyPreset) {
        customApi.proxy_preset = String(stage.proxyPreset).trim();
        // proxy_preset 只覆盖 url/key，source 要自己给，否则 provider 私有字段不生效
        customApi.source = 'custom';
    }
    if (stage.model) customApi.model = stage.model;
    if (Number.isFinite(Number(stage.temperature))) customApi.temperature = Number(stage.temperature);
    if (Number.isFinite(Number(stage.maxTokens)) && Number(stage.maxTokens) > 0) {
        customApi.max_tokens = Number(stage.maxTokens);
    }

    const useStream = stage.useStream !== false;

    const config = {
        preset_name: 'in_use',
        generation_id: generationId,
        // user_input 留空：指令已经在预设槽位里了，不需要再往历史末尾塞东西
        user_input: '',
        should_stream: useStream,
        should_silence: true,
    };
    if (Object.keys(customApi).length > 0) config.custom_api = customApi;

    // 流式进度：直接听酒馆自己的事件，按 generation_id 过滤
    let unsubscribe = null;
    if (useStream && typeof ctx?.eventSource?.on === 'function' && ctx.eventTypes?.STREAM_TOKEN_RECEIVED) {
        try {
            unsubscribe = ctx.eventSource.on(ctx.eventTypes.STREAM_TOKEN_RECEIVED, (text) => {
                onProgress?.(String(text ?? ''));
            });
        } catch (e) {
            console.warn('[AgentWriter] 监听流式事件失败', e);
        }
    }

    let aborted = false;
    const onAbort = () => {
        aborted = true;
        try {
            api.stopGenerationById?.(generationId);
        } catch (e) {
            console.warn('[AgentWriter] stopGenerationById 失败', e);
        }
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    try {
        const result = await api.generate(config);
        return typeof result === 'string' ? result : String(result?.content ?? '');
    } finally {
        signal?.removeEventListener('abort', onAbort);
        try {
            unsubscribe?.stop?.();
        } catch { /* 忽略 */ }
        if (aborted) {
            const err = new Error('user abort');
            err.name = 'AbortError';
            throw err;
        }
    }
}
