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
 *
 * @param {string} slotName
 * @param {string} instruction
 * @param {string} [marker] 请求期唯一标记，会被写进槽位内容
 *   （见 setPendingPayload —— 事件里认领请求体靠的就是它）
 */
export async function injectSlot(slotName, instruction, marker = '') {
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

    // 标记单独占一行放在末尾：它一定要出现在发出去的 messages 里，
    // 否则 CHAT_COMPLETION_SETTINGS_READY 那边认不出哪份请求是自己的。
    const suffix = marker ? `\n${marker}` : '';
    slot.content = `${instruction}${suffix}\n\n${SLOT_MARKER}`;
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
//
// ⚠️ 认领的依据是**标记字符串出现在 messages 里**，而事件里拿不到
// generation_id。所以标记必须真的被写进槽位内容（injectSlot 的 marker 参数）
// —— 早期版本用的是 `__AW_<generationId>__`，但没有任何地方把它写进请求，
// 于是每个阶段设置的 bodyFields（思考开关！）都被静默丢弃了。
// ---------------------------------------------------------------------------

const pendingPayloads = new Map();
let hooked = false;

/**
 * 按标记留档「事件里那份 generate_data」的顶层字段。
 *
 * 这是唯一能自证「附加参数到底发出去没有」的地方 —— 平板开不了 devtools，
 * 看不到真实请求。记的是认领成功那一刻的快照。
 */
const lastBodies = new Map();

/** 取走并清掉某次请求的留档（供 pipeline 写进最近请求记录） */
export function takeLastBody(tag) {
    const body = lastBodies.get(tag) ?? null;
    lastBodies.delete(tag);
    return body;
}

/** 只保留可 JSON 序列化、且不含密钥的顶层字段摘要 */
function summarizeBody(generateData) {
    const out = {};
    for (const [key, value] of Object.entries(generateData)) {
        if (key === 'messages') {
            const list = Array.isArray(value) ? value : [];
            out.messages = `（${list.length} 条，已省略）`;
            continue;
        }
        // 别把密钥写进面板里
        if (/secret|key|password|token|authorization/i.test(key)) {
            out[key] = '(已省略)';
            continue;
        }
        try {
            JSON.stringify(value);
            out[key] = value;
        } catch {
            out[key] = '(无法序列化)';
        }
    }
    return out;
}

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

            // 留档的是注入**之后**的样子 —— 这样面板上看到的就是真正要发的
            lastBodies.set(id, { claimed: true, applied: { ...entry.payload }, body: summarizeBody(generateData) });

            pendingPayloads.delete(id);
            break;
        }
    });

    console.log('[AgentWriter] 已挂上 CHAT_COMPLETION_SETTINGS_READY');
}

/**
 * 生成一个请求期唯一的标记，写进槽位内容供事件里认领请求体。
 * 用标记而不是 generation_id，是因为事件回调里拿不到 generation_id。
 */
export function makePayloadTag(seed) {
    return `__AW_PAYLOAD_${String(seed ?? Date.now())}__`;
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
 * 归一化自定义端点地址。
 *
 * ⚠️ 酒馆的 `custom_url` 要的是**base url**，`/chat/completions` 由酒馆自己补。
 * TauriTavern（酒馆原生 API 格式的适配层）的文档把这条契约写得很明白：
 * 「端点预览只展示当前所选格式的最终 endpoint（base URL + suffix）」，
 * 而 suffix 映射就是 OpenAI-compatible→`/chat/completions`。
 *
 * 所以这里**只去掉末尾多余的斜杠，绝不补路径**。
 * 上一版我照抄了 st-end-component-generator 的 normalizeChatCompletionsUrl()，
 * 那是错的 —— 那个仓库是浏览器直连 fetch、自己拼 URL，当然要自己补；
 * 本扩展走的是酒馆的请求管线，补了就会变成
 * /api/v1/chat/completions/chat/completions。
 *
 * 两种写法都仍然接受（用户怎么填都不会炸）：已经是完整端点的写法，
 * 酒馆会以 `/chat/completions` 结尾作为判据、原样使用不再追加。
 */
export function normalizeChatCompletionsUrl(rawUrl) {
    const url = String(rawUrl ?? '').trim();
    if (!url) return '';
    // 只收拾末尾斜杠：多余斜杠会让酒馆拼出 //chat/completions
    return url.replace(/\/+$/, '');
}

/**
 * 把上游的报错翻译成人能直接照做的提示。
 *
 * 起因：接 Cline 时反复撞同一个 401「Please make sure you're using the latest
 * version of Cline and re-authenticate」。这句话把人引向「去重装 Cline」，
 * 但它对应好几种完全不同的原因：
 *
 *   1. **酒馆转发时送的凭据不对**（实测最终就是这个）——
 *      custom_api.key 会被 TavernHelper 写进 proxy_password（对 custom 源无效）
 *      和一份它自己拼的 Authorization 头，而那份头上游不认。
 *      改用顶层 custom_include_headers 后 200。见 buildCustomApi 的注释。
 *
 *   2. 拿错了凭据类型 —— Cline 有两种 token：
 *        · API key：app.cline.bot 的 Settings > API Keys 里生成，给脚本用
 *        · 账号 auth token：登录插件/CLI 时自动生成，只给官方客户端用
 *
 *   3. 额度用尽 —— 撞到额度上限时 Cline 返回的**不是 429**，而是这个 401。
 *
 *   4. key 被撤销/失效。
 *
 * ⚠️ 别看到 401 就归因于额度。曾经因为「同一个 key 前一刻全 200、后一刻全 401」
 * 就断定是额度，那是拿时间相邻当因果 —— 后来同一个 key 在直连探针里始终 200、
 * 在扩展里始终 401，与额度无关。
 *
 * 所以提示里先教人**怎么把上游的问题和转发的问题分开**（跑直连探针），
 * 而不是直接给一个原因。
 */
export function humanizeUpstreamError(error) {
    const raw = String(error?.message ?? error ?? '').trim();
    if (!raw) return error;

    const isCline = /cline\.bot|latest version of Cline|re-authenticate your Cline/i.test(raw);
    const is401 = /\b401\b|unauthori[sz]ed/i.test(raw);

    if (isCline && is401) {
        return new Error(
            'Cline 拒绝了这次请求（401）。这个报错对应好几种原因，别急着换 key：\n\n'
            + '① 用直连探针先分清「上游的问题」还是「酒馆转发的问题」：\n'
            + '   agent-writer-tools/probe-endpoint.mjs，同一个 key 直连如果通，\n'
            + '   那就不是账号问题，别再去查 Cline。\n'
            + '② 凭据类型：必须用 app.cline.bot → Settings → API Keys 里生成的\n'
            + '   API key，不能用登录插件/CLI 时的账号 auth token。\n'
            + '③ 额度：撞额度上限时 Cline 返回的也是这个 401，不是 429。去 app.cline.bot 看用量。\n'
            + '④ key 被撤销或失效。\n'
            + '\n面板里的「换渠道诊断」会把两种送密钥的形状并排测出来。'
            + `\n上游原文：${raw}`,
        );
    }

    // 地址补错方向：base url 少拼了路径时是 404/405，不是 401
    if (/\b(?:404|405)\b/.test(raw) && /not found|method not allowed/i.test(raw)) {
        return new Error(
            `上游返回 404/405，地址可能没写到端点。本扩展已自动补 /chat/completions，`
            + `如果你填的地址本身带路径（不是以 /v1 结尾），请检查是否需要手工写全。`
            + `\n\n上游原文：${raw}`,
        );
    }

    // 上游返回 200 但没有正文：多半是响应被包了一层，酒馆解析不到 choices
    if (/返回为空|empty response|no content/i.test(raw)) {
        return new Error(
            `上游返回了成功状态但正文是空的。\n\n`
            + '如果这个阶段指向 Cline，几乎可以确定是这个原因：**Cline 的非流式响应会把'
            + '标准结构再包一层 data**（{"data":{"choices":[…]}}），而酒馆读的是 '
            + 'choices[0].message.content，于是拿到空字符串。\n\n'
            + '解决办法：把该阶段的「流式」打开。Cline 的**流式**分片是标准 OpenAI 格式，'
            + '没有那层包裹，酒馆能正常解析。\n'
            + `\n上游原文：${raw}`,
        );
    }

    return error;
}

/**
 * 把一个阶段的设置编译成 TavernHelper 的 `custom_api`。
 *
 * 抽成独立函数是为了让它成为**单一真相源**：tavernGenerate 用它发请求，
 * 诊断也用它做「不打请求就能看出发的是什么」的展示 —— 两处不可能走偏。
 *
 * ---------------------------------------------------------------------------
 * 密钥走 custom_include_headers，不走 key —— 这是实测出来的，很重要。
 *
 * 看 TavernHelper 的 applyCustomApiOverrides（responseGenerator.ts:190）：
 *
 *   if (customApi.apiurl) {
 *     generateData.reverse_proxy  = ...
 *     generateData.proxy_password = customApi.key || '';     // 对 custom 源无效
 *     if (chat_completion_source === 'custom') {
 *       generateData.custom_url = ...
 *       if (customApi.key) {
 *         generateData.custom_include_headers =
 *           overrideCustomAuthorizationHeader(..., customApi.key);  // ← 问题在这
 *       }
 *     }
 *   }
 *
 * 传 key 时它会替我们拼一份 Authorization 头，但实测这份头送到 Cline 会被判 401；
 * 同一个 key 直连、以及「自己给 custom_include_headers」都是 200。
 * 见 README「上游实测笔记」里形状 A/B 的对照。
 *
 * 两个要点，都踩过：
 *   1. 不能再同时传 key —— 否则 proxy_password 也被设上，行为不可预期。
 *   2. 值只放**裸 key** —— TavernHelper 会自己拼成 `Bearer ${key}`，
 *      值里再带一次前缀会变成 "Bearer Bearer sk_..."。
 * ---------------------------------------------------------------------------
 *
 * @param {object} stage 单阶段设置
 * @returns {object} 可直接放进 generate() config 的 custom_api（空对象 = 用当前连接）
 */
export function buildCustomApi(stage = {}) {
    const customApi = {};

    // 换渠道有两条路，直接地址优先。
    //
    // 为什么不用 proxy_preset 打头：酒馆的代理预设是挂在具体厂商下面的
    // （DeepSeek / Gemini 等），只覆盖该厂商的 base url，没法用来指向
    // Cline 这类 OpenAI 兼容的自定义端点。apiUrl 才是通用的。
    const apiKey = String(stage.apiKey ?? '').trim();
    if (stage.apiUrl) {
        customApi.apiurl = normalizeChatCompletionsUrl(stage.apiUrl);
        // source 必须显式给 'custom'，否则会落到 'openai' 的协议分支上
        customApi.source = 'custom';
        if (apiKey) {
            customApi.custom_include_headers = { Authorization: apiKey };
        }
    } else if (stage.proxyPreset) {
        customApi.proxy_preset = String(stage.proxyPreset).trim();
        customApi.source = 'custom';
    }

    if (stage.model) customApi.model = stage.model;
    if (Number.isFinite(Number(stage.temperature))) customApi.temperature = Number(stage.temperature);
    if (Number.isFinite(Number(stage.maxTokens)) && Number(stage.maxTokens) > 0) {
        customApi.max_tokens = Number(stage.maxTokens);
    }

    return customApi;
}

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

    const customApi = buildCustomApi(stage);

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
    } catch (e) {
        // 把「重装 Cline」这类把人引偏的报错换成可照做的提示
        throw humanizeUpstreamError(e);
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
