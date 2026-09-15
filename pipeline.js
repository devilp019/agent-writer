/**
 * Agent Writer - 流水线
 *
 * ① 草稿：酒馆原生生成（不在这里）
 * ② 校验：独立连接配置，输出结构化问题清单
 * ③ 改写：独立连接配置，按清单改稿
 *
 * 两条实测得来的关键约束：
 *
 * 1. 部分上游（Cline）的**非流式响应包裹格式酒馆解析不了** ——
 *    HTTP 200、请求成功，但 content 是空字符串。
 *    所以成功判据必须是「正文非空」，拿到空正文时自动换另一种模式重试。
 *
 * 2. `json_schema` 必须作为请求体的**顶层字段**传。
 *    酒馆只有看到顶层 json_schema 才会把它转成 response_format；
 *    塞进 custom_include_body 的话会被原样 merge 进请求体，
 *    上游收到一个它不认识的 json_schema 对象。
 */

import {
    buildCriticMessages,
    buildRewriteMessages,
    renderCritique,
    parseCritique,
    isClean,
    looksRunaway,
    CRITIQUE_SCHEMA,
} from './stages.js?v=0.4.1';

function ctx() {
    return globalThis.SillyTavern?.getContext?.() ?? null;
}

function getService() {
    const context = ctx();
    const service = context?.ConnectionManagerRequestService ?? globalThis.ConnectionManagerRequestService;
    if (!service) {
        throw new Error('ConnectionManagerRequestService 不可用（检查酒馆的 connection-manager 扩展是否被禁用）');
    }
    return service;
}

/** 没有配置 profileId 时，退回当前选中的连接配置 */
function currentProfileId() {
    try {
        return ctx()?.extensionSettings?.connectionManager?.selectedProfile ?? '';
    } catch {
        return '';
    }
}

/**
 * 把阶段设置整理成发请求需要的东西。
 *
 * 拆成三块：
 *   - options          传给 sendRequest 的第 4 个参数
 *   - overridePayload  会被 merge 进请求体根字段
 *   - topLevelPayload  必须是 request.body 顶层才生效的字段（例如 json_schema）
 */
function buildRequestArgs(settings, messages, signal) {
    const profileId = settings.profileId || currentProfileId();
    if (!profileId) {
        throw new Error('没有可用的连接配置。请先在酒馆里建一个，或在面板里选一个。');
    }

    const overridePayload = { ...(settings.overridePayload ?? {}) };
    if (settings.model) overridePayload.model = settings.model;
    if (Number.isFinite(Number(settings.temperature))) overridePayload.temperature = Number(settings.temperature);

    return {
        profileId,
        options: {
            stream: !!settings.useStream,
            signal: signal ?? null,
            extractData: true,
            includePreset: true,
            includeInstruct: true,
        },
        overridePayload,
        maxTokens: Number(settings.maxTokens) || 2048,
        messages,
    };
}

/** 消费流式迭代器，边收边回调 */
async function consumeStream(streamFn, onProgress) {
    let text = '';
    let reasoning = '';
    let chunks = 0;

    for await (const chunk of streamFn()) {
        text = chunk?.text ?? text;
        reasoning = chunk?.state?.reasoning ?? reasoning;
        chunks++;
        onProgress?.({ text, reasoning, chunks });
    }

    return { text, reasoning, chunks };
}

/**
 * 跑一个阶段。
 *
 * @param {'critic'|'final'} stage
 * @param {object} settings 该阶段设置
 * @param {Array<{role:string, content:string}>} messages
 * @param {object} options
 * @param {AbortSignal} [options.signal]
 * @param {(info: object) => void} [options.onProgress]
 * @param {object} [options.topLevelPayload] 必须是 request.body 顶层的字段
 * @returns {Promise<{content:string, reasoning:string, mode:'stream'|'plain', retried:boolean}>}
 */
export async function runStage(stage, settings, messages, options = {}) {
    const service = getService();
    const { signal, onProgress, topLevelPayload } = options;

    const args = buildRequestArgs(settings, messages, signal);

    const attempt = async (useStream) => {
        // 顶层字段混进请求体，而不是塞进 overridePayload
        const requestData = { ...(topLevelPayload ?? {}) };

        const result = await service.sendRequest(
            args.profileId,
            args.messages,
            args.maxTokens,
            { ...args.options, stream: useStream },
            args.overridePayload,
            requestData,
        );

        if (useStream) {
            if (typeof result !== 'function') {
                return { content: '', reasoning: '', mode: 'stream' };
            }
            const { text, reasoning } = await consumeStream(result, onProgress);
            return { content: text, reasoning, mode: 'stream' };
        }

        return {
            content: String(result?.content ?? ''),
            reasoning: String(result?.reasoning ?? ''),
            mode: 'plain',
        };
    };

    const first = await attempt(!!settings.useStream);

    // 空正文 + 允许重试 ⇒ 换一条路再试一次。
    // 这条分支就是为 Cline 这类「非流式包裹格式解析不了」的上游准备的。
    const empty = !String(first.content ?? '').trim();
    if (empty && settings.autoRetryOnEmpty) {
        const other = !settings.useStream;
        console.warn(`[AgentWriter] ${stage} 阶段拿到空正文（${first.mode}），改用${other ? '流式' : '非流式'}重试`);
        const second = await attempt(other);
        return { ...second, retried: true };
    }

    return { ...first, retried: false };
}

/**
 * 跑完整流水线，并把结果写回聊天楼层。
 *
 * 注意 ②③ 走的是纯 HTTP 请求，**不会往 chat 里写任何东西**，
 * 所以不需要把草稿从 chat 里摘出去再放回来。
 *
 * @param {object} options
 * @param {object} options.settings 完整设置
 * @param {number} options.messageIndex 草稿所在楼层
 * @param {string} options.draft 草稿正文
 * @param {string} [options.draftReasoning] 草稿的思维链（来自酒馆原生生成）
 * @param {(stage: string, info: object) => void} [options.onStage]
 * @param {AbortSignal} [options.signal]
 */
export async function runPipeline({ settings, messageIndex, draft, draftReasoning = '', onStage, signal }) {
    const context = ctx();
    if (!context) throw new Error('SillyTavern.getContext() 不可用');

    const report = (stage, info) => {
        try {
            onStage?.(stage, info);
        } catch (e) {
            console.warn('[AgentWriter] onStage 回调出错', e);
        }
    };

    if (!String(draft ?? '').trim()) {
        throw new Error('草稿是空的');
    }

    // 草稿本身先展示（含酒馆原生生成时的思维链）
    report('draft', { phase: 'done', text: draft, reasoning: draftReasoning });

    // ---------- ② 校验 ----------
    report('critic', { phase: 'start' });

    const criticMessages = buildCriticMessages({
        settings: settings.critic,
        draft,
        draftIndex: messageIndex,
        ctx: context,
    });

    const criticResult = await runStage('critic', settings.critic, criticMessages, {
        signal,
        // json_schema 必须是顶层字段，酒馆才会转成 response_format
        topLevelPayload: settings.critic.useJsonSchema ? { json_schema: CRITIQUE_SCHEMA } : {},
        onProgress: ({ text, reasoning, chunks }) => {
            report('critic', { phase: 'progress', text, reasoning, chunks });
        },
    });

    const critiqueText = String(criticResult.content ?? '').trim();
    if (!critiqueText) {
        report('critic', { phase: 'error', message: '校验阶段没拿到内容' });
        return {
            ok: false,
            stage: 'critic',
            reason: '校验阶段没拿到内容',
            draft,
            critic: criticResult,
        };
    }

    const parsed = parseCritique(critiqueText);
    report('critic', {
        phase: 'done',
        text: critiqueText,
        reasoning: criticResult.reasoning,
        parsed,
        mode: criticResult.mode,
        retried: criticResult.retried,
    });

    // ---------- 校验跑飞就中止，别拿垃圾去改写 ----------
    const runaway = looksRunaway(critiqueText, parsed);
    if (runaway) {
        report('final', { phase: 'skipped', reason: `校验结果疑似异常，已中止：${runaway}` });
        return {
            ok: false,
            stage: 'critic',
            reason: `校验结果疑似异常：${runaway}`,
            draft,
            critique: critiqueText,
            parsed,
            critic: criticResult,
        };
    }

    // ---------- 无需修改就跳过 ③ ----------
    if (isClean(parsed)) {
        report('final', { phase: 'skipped', reason: '校验判定无需修改' });
        return {
            ok: true,
            replaced: false,
            draft,
            critique: critiqueText,
            parsed,
            critic: criticResult,
        };
    }

    // ---------- ③ 改写 ----------
    const critiqueForRewrite = renderCritique(parsed);
    report('final', { phase: 'start' });

    const rewriteMessages = buildRewriteMessages({
        settings: settings.final,
        draft,
        critiqueText: critiqueForRewrite,
    });

    const finalResult = await runStage('final', settings.final, rewriteMessages, {
        signal,
        onProgress: ({ text, reasoning, chunks }) => {
            report('final', { phase: 'progress', text, reasoning, chunks });
        },
    });

    const finalText = String(finalResult.content ?? '').trim();
    if (!finalText) {
        report('final', { phase: 'error', message: '改写阶段没拿到内容' });
        return {
            ok: false,
            stage: 'final',
            reason: '改写阶段没拿到内容',
            draft,
            critique: critiqueText,
            parsed,
            critic: criticResult,
            final: finalResult,
        };
    }

    report('final', {
        phase: 'done',
        text: finalText,
        reasoning: finalResult.reasoning,
        mode: finalResult.mode,
        retried: finalResult.retried,
    });

    // ---------- 写回楼层 ----------
    const message = context.chat?.[messageIndex];
    if (!message) {
        throw new Error(`找不到第 ${messageIndex} 楼`);
    }

    // 记下原始草稿：调用方据此判断"这一层已经被处理过"，避免自动模式反复触发
    message.extra = { ...(message.extra ?? {}), agent_writer: { draft } };
    message.mes = finalText;
    if (Array.isArray(message.swipes) && message.swipes.length) {
        message.swipes = [finalText];
        message.swipe_id = 0;
        message.swipe_info = [];
    }

    await context.saveChat?.();
    try {
        context.updateMessageBlock?.(messageIndex, message, { rerenderMessage: true });
    } catch (e) {
        console.warn('[AgentWriter] 刷新楼层显示失败，尝试整页重绘', e);
        try {
            await context.printMessages?.();
        } catch { /* 尽力而为 */ }
    }

    return {
        ok: true,
        replaced: true,
        messageIndex,
        draft,
        finalText,
        critique: critiqueText,
        parsed,
        critic: criticResult,
        final: finalResult,
    };
}

/** 找最后一条 assistant 楼层 */
export function findLastAssistantIndex(chat) {
    if (!Array.isArray(chat)) return -1;
    for (let i = chat.length - 1; i >= 0; i--) {
        const m = chat[i];
        if (m && !m.is_user && !m.is_system) return i;
    }
    return -1;
}

/**
 * 取一条消息的思维链。
 *
 * 酒馆原生生成的思维链挂在消息对象上，不同版本字段不一样，所以多试几个位置。
 * 拿不到就返回空串，不影响主流程。
 */
export function extractReasoning(message) {
    if (!message || typeof message !== 'object') return '';

    const candidates = [
        message.extra?.reasoning,
        message.extra?.reasoning_content,
        message.reasoning,
        message.reasoning_content,
    ];
    for (const c of candidates) {
        if (typeof c === 'string' && c.trim()) return c;
    }

    const details = message.extra?.reasoning_details ?? message.reasoning_details;
    if (Array.isArray(details)) {
        const joined = details
            .map((d) => (typeof d === 'string' ? d : (d?.text ?? d?.content ?? '')))
            .filter(Boolean)
            .join('\n');
        if (joined.trim()) return joined;
    }

    return '';
}
