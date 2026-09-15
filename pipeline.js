/**
 * Agent Writer - 流水线
 *
 * 三个阶段都用酒馆的完整组装：
 *
 *   ① 草稿   酒馆原生生成（你按发送键那一次）
 *   ② 校验   指令写进「校验槽位」→ TavernHelper.generate()
 *   ③ 改写   指令写进「改写槽位」→ TavernHelper.generate()
 *
 * 为什么不用自己的请求组装：这三个阶段是同一个模型（只是 ② 换渠道开思考），
 * 自己组装会让 ②③ 的提示词前缀和 ① 完全不同，前缀缓存必然失效。
 *
 * 为什么注入的是预设槽位而不是历史末尾：末尾注入的指令盖不住预设里
 * 更靠后的强提示词（例如推进剧情的），模型会跑偏去写剧情而不是做校验。
 * 只有预设条目能控制指令的位置和身份。
 *
 * 槽位注入是**改用户预设**的操作，所以每一步都必须有还原，且在 finally 里；
 * 扩展启动时还会做一次崩溃恢复（见 tavern.recoverSlots）。
 */

import {
    buildCritiqueInstruction,
    buildRewriteInstruction,
    parseCritique,
    isClean,
    looksRunaway,
} from './stages.js?v=0.7.0';
import {
    injectSlot,
    restoreSlot,
    tavernGenerate,
    setPendingPayload,
    clearPendingPayload,
    makePayloadTag,
    recoverSlots,
} from './tavern.js?v=0.7.0';

function ctx() {
    return globalThis.SillyTavern?.getContext?.() ?? null;
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
 * 酒馆原生生成的思维链挂在消息对象上，不同版本字段不一样，多试几个位置。
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

// ---------------------------------------------------------------------------
// 思维链收集
//
// 酒馆助手不返回思维链，但酒馆自己会发 STREAM_REASONING_DONE。
// 这里在整个流水线期间挂一次监听，跑完清掉。
// ---------------------------------------------------------------------------

const reasonings = new Map();
let reasoningHook = null;

function hookReasoning() {
    if (hookReasoning.unavailable) return;
    const context = ctx();
    const eventSource = context?.eventSource;
    const eventTypes = context?.eventTypes;
    if (!eventSource?.on || !eventTypes?.STREAM_REASONING_DONE) return;

    try {
        reasoningHook = eventSource.on(eventTypes.STREAM_REASONING_DONE, (reasoning, _duration, messageId) => {
            if (typeof reasoning === 'string' && reasoning.trim()) {
                reasonings.set(String(messageId ?? 'last'), reasoning);
            }
        });
    } catch (e) {
        console.warn('[AgentWriter] 挂思维链监听失败', e);
        hookReasoning.unavailable = true;
    }
}

function unhookReasoning() {
    try {
        reasoningHook?.stop?.();
    } catch { /* 忽略 */ }
    reasoningHook = null;
    reasonings.clear();
}

function takeReasoning() {
    if (reasonings.size === 0) return '';
    // 取最长的一条 —— 通常就是本次生成的
    let best = '';
    for (const value of reasonings.values()) {
        if (value.length > best.length) best = value;
    }
    reasonings.clear();
    return best;
}

// ---------------------------------------------------------------------------
// 单阶段
// ---------------------------------------------------------------------------

/**
 * 跑一个阶段：注入槽位 → 生成 → 还原槽位。
 *
 * @param {object} options
 * @param {'critic'|'final'} options.stage
 * @param {object} options.settings 该阶段设置
 * @param {string} options.instruction 要注入的指令
 * @param {string} options.generationId
 * @param {AbortSignal} [options.signal]
 * @param {(info: object) => void} [options.onProgress]
 * @returns {Promise<{content: string, reasoning: string}>}
 */
async function runOneStage({ stage, settings, instruction, generationId, signal, onProgress }) {
    const slotName = settings.slotName;
    // 标记要真的写进槽位内容，否则 CHAT_COMPLETION_SETTINGS_READY
    // 那边认不出这份请求，bodyFields（思考开关）会被丢掉。
    const tag = makePayloadTag(generationId);
    let injected = false;

    try {
        if (signal?.aborted) throw Object.assign(new Error('user abort'), { name: 'AbortError' });

        await injectSlot(slotName, instruction, tag);
        injected = true;

        // 请求体附加字段走事件注入（provider 私有参数，例如思考开关）
        setPendingPayload(tag, { ...(settings.bodyFields ?? {}) });

        const content = await tavernGenerate({
            stage: settings,
            generationId,
            signal,
            onProgress: (text) => onProgress?.({ text, reasoning: '' }),
        });

        return { content: String(content ?? '').trim(), reasoning: takeReasoning() };
    } finally {
        clearPendingPayload(tag);
        if (injected) {
            await restoreSlot(slotName);
        }
    }
}

/**
 * 跑完整流水线，并把结果写回聊天楼层。
 *
 * 注意 ②③ 走的是酒馆助手的 generate()，**不会往 chat 里写任何东西**，
 * 所以草稿不需要从 chat 里摘出去再放回来 —— 它一直待在原地，
 * 校验者看的就是「历史最后一条」。
 *
 * @param {object} options
 * @param {object} options.settings 完整设置
 * @param {number} options.messageIndex 草稿所在楼层
 * @param {string} options.draft 草稿正文
 * @param {string} [options.draftReasoning]
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

    if (!String(draft ?? '').trim()) throw new Error('草稿是空的');

    hookReasoning();

    try {
        report('draft', { phase: 'done', text: draft, reasoning: draftReasoning });

        // ---------- ② 校验 ----------
        report('critic', { phase: 'start' });

        const criticResult = await runOneStage({
            stage: 'critic',
            settings: settings.critic,
            instruction: buildCritiqueInstruction(settings.critic),
            generationId: `aw-critic-${Date.now()}`,
            signal,
            onProgress: (info) => report('critic', { phase: 'progress', ...info }),
        });

        const critiqueText = criticResult.content;
        if (!critiqueText) {
            report('critic', { phase: 'error', message: '校验阶段没拿到内容' });
            return { ok: false, stage: 'critic', reason: '校验阶段没拿到内容', draft, critic: criticResult };
        }

        const parsed = parseCritique(critiqueText);
        report('critic', {
            phase: 'done',
            text: critiqueText,
            reasoning: criticResult.reasoning,
            parsed,
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
        if (isClean(parsed, critiqueText)) {
            report('final', { phase: 'skipped', reason: '校验判定无需修改' });
            return { ok: true, replaced: false, draft, critique: critiqueText, parsed, critic: criticResult };
        }

        // ---------- ③ 改写 ----------
        report('final', { phase: 'start' });

        const finalResult = await runOneStage({
            stage: 'final',
            settings: settings.final,
            instruction: buildRewriteInstruction(settings.final, critiqueText),
            generationId: `aw-final-${Date.now()}`,
            signal,
            onProgress: (info) => report('final', { phase: 'progress', ...info }),
        });

        const finalText = finalResult.content;
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

        report('final', { phase: 'done', text: finalText, reasoning: finalResult.reasoning });

        // ---------- 写回楼层 ----------
        const message = context.chat?.[messageIndex];
        if (!message) throw new Error(`找不到第 ${messageIndex} 楼`);

        // 记下原始草稿：调用方据此判断「这一层已经处理过」，避免自动模式循环
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
    } finally {
        unhookReasoning();
    }
}

export { recoverSlots };
