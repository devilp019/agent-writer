/**
 * Agent Writer - 流水线
 *
 * ① 草稿：酒馆原生生成（不在这里）
 * ② 校验：独立连接配置，输出结构化问题清单
 * ③ 改写：独立连接配置，按清单改稿
 *
 * 关键实现约束（实测得来，不是推测）：
 *
 *   部分上游（Cline）的**非流式响应包裹格式酒馆解析不了** ——
 *   HTTP 200、请求成功，但 content 是空字符串。
 *   所以成功判据必须是「正文非空」，不能是「HTTP 正常」；
 *   拿到空正文时自动重试一次流式。
 */

import {
    buildCriticMessages,
    buildRewriteMessages,
    renderCritique,
    parseCritique,
    isClean,
    CRITIQUE_SCHEMA,
} from './stages.js?v=0.4.0';

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
 * 把阶段设置变成 CustomApiConfig 需要的几块。
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
 * @param {object} [options.extraPayload] 额外请求体（例如 json_schema）
 * @returns {Promise<{content:string, reasoning:string, mode:'stream'|'plain', retried:boolean}>}
 */
export async function runStage(stage, settings, messages, options = {}) {
    const service = getService();
    const { signal, onProgress, extraPayload } = options;

    const args = buildRequestArgs(settings, messages, signal);
    const overridePayload = { ...args.overridePayload, ...(extraPayload ?? {}) };

    const attempt = async (useStream) => {
        const result = await service.sendRequest(
            args.profileId,
            args.messages,
            args.maxTokens,
            { ...args.options, stream: useStream },
            overridePayload,
        );

        if (useStream) {
            // 流式返回的是「产生迭代器的函数」
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
 * 所以不需要把草稿从 chat 里摘出去再放回来 —— 这是扩展形态相对脚本形态
 * 最大的简化。
 *
 * @param {object} options
 * @param {object} options.settings 完整设置
 * @param {number} options.messageIndex 草稿所在楼层
 * @param {string} options.draft 草稿正文
 * @param {(stage: string, info: object) => void} [options.onStage]
 * @param {AbortSignal} [options.signal]
 */
export async function runPipeline({ settings, messageIndex, draft, onStage, signal }) {
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

    // ---------- ② 校验 ----------
    report('critic', { phase: 'start' });

    const criticMessages = buildCriticMessages({
        settings: settings.critic,
        draft,
        ctx: context,
    });

    const criticResult = await runStage('critic', settings.critic, criticMessages, {
        signal,
        extraPayload: settings.critic.useJsonSchema ? { json_schema: CRITIQUE_SCHEMA } : {},
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

    // ---------- 无需修改就跳过 ③ ----------
    if (parsed && isClean(parsed)) {
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
    const critiqueForRewrite = parsed ? renderCritique(parsed) : critiqueText;
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

    message.mes = finalText;
    // 换了正文，旧的 swipes / extra 不再对应
    message.extra = {};
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
