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
} from './stages.js?v=0.8.26';
import {
    injectSlot,
    restoreSlot,
    tavernGenerate,
    setPendingPayload,
    clearPendingPayload,
    makePayloadTag,
    takeLastBody,
    recoverSlots,
} from './tavern.js?v=0.8.26';
import { subscribeStream } from './stream-hook.js?v=0.8.26';

function ctx() {
    return globalThis.SillyTavern?.getContext?.() ?? null;
}

// ---------------------------------------------------------------------------
// 最近一次请求体留档
//
// 平板开不了 devtools，「附加参数到底有没有发出去」只能靠面板回显。
// 记的是**事件里真正要发的那份 generate_data**（注入后），不是我以为发了什么。
// ---------------------------------------------------------------------------

const lastRequests = { critic: null, final: null };

/** 供 diagnostics.showLastRequests() 读取 */
export function getLastRequests() {
    return lastRequests;
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

// ---------------------------------------------------------------------------
// 单阶段
//
// 实时正文和思维链都从 stream-hook 来（它拦的是酒馆打给
// /api/backends/chat-completions/generate 的那次 fetch）。
//
// 曾经这里有一套 hookReasoning / takeReasoning / peekReasoning，
// 听的是酒馆的 STREAM_REASONING_DONE。那条路是死的：
// 唯一会发它的是 reasoning.js 的 ReasoningHandler，而没有任何地方用它。
// 细节见 stream-hook.js 顶部的说明。
// ---------------------------------------------------------------------------

/**
 * 把密集的流式回调节流成 ~8fps，并保证最后一次一定送达。
 *
 * 为什么要节流：酒馆助手的 fully 事件每个分片都来一次，直接写 DOM 在平板上
 * 会卡。结尾那次必须补发，否则最后几个字可能不显示。
 *
 * @param {(info: {text: string, reasoning: string}) => void} emit
 * @returns {(info: {text: string, reasoning: string}) => void}
 */
function makeProgressThrottle(emit, intervalMs = 120) {
    let last = 0;
    let pending = null;
    let timer = null;
    let latest = null;

    return (info) => {
        latest = info;
        const now = Date.now();
        if (now - last >= intervalMs) {
            last = now;
            pending = null;
            emit(info);
            return;
        }
        pending = info;
        if (timer) return;
        timer = setTimeout(() => {
            timer = null;
            if (pending) {
                last = Date.now();
                const p = pending;
                pending = null;
                emit(p);
            }
        }, intervalMs - (now - last));
    };
}

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
    // 同一个标记也用来认领拦截到的流式分片 —— 见 stream-hook.js。
    const tag = makePayloadTag(generationId);
    let injected = false;

    // 这一轮的实时正文与思维链。拦截是按标记归属的，所以这里攒到的
    // 一定是**本次**请求的分片，不会混进上一轮的。
    let liveText = '';
    let liveReasoning = '';
    let unsubscribe = null;

    try {
        if (signal?.aborted) throw Object.assign(new Error('user abort'), { name: 'AbortError' });

        await injectSlot(slotName, instruction, tag);
        injected = true;

        // 请求体附加字段走事件注入（provider 私有参数，例如思考开关）
        setPendingPayload(tag, { ...(settings.bodyFields ?? {}) });

        const throttled = makeProgressThrottle(() => onProgress?.({
            text: liveText,
            reasoning: liveReasoning,
        }));

        unsubscribe = subscribeStream(tag, (evt) => {
            // 拦截给的是累计值，直接覆盖，不用自己拼
            if (typeof evt?.text === 'string') liveText = evt.text;
            if (typeof evt?.reasoning === 'string') liveReasoning = evt.reasoning;
            throttled();
        });

        const content = await tavernGenerate({
            stage: settings,
            generationId,
            signal,
            // ⚠️ 这个回调的参数是**字符串**（累计全文），不是对象。
            //
            // 这里曾经写的是 `info?.text ?? ''` —— 字符串身上没有 .text，
            // 于是每一次节流后的进度都带着空字符串发出去。
            // 症状极具迷惑性：js_stream_token_received_fully 明明发了上千次，
            // 面板却从头到尾一个字都不显示（「正文最后一次性蹦出来」）。
            //
            // 酒馆助手这个事件只带正文，不带思维链，所以它现在只当**兜底**：
            // 正文以我们自己拦截到的为准（那份更全，而且和思维链同源）。
            onProgress: makeProgressThrottle((chunk) => {
                const text = typeof chunk === 'string' ? chunk : String(chunk?.text ?? '');
                if (text.length > liveText.length) liveText = text;
                throttled();
            }),
        });

        // 最后补发一次，保证结尾几个字一定送到面板
        onProgress?.({ text: liveText || String(content ?? ''), reasoning: liveReasoning });

        // 留档：事件里认领到的那份请求体（没认领到就是 null，本身就是结论）
        lastRequests[stage] = takeLastBody(tag) ?? {
            claimed: false,
            note: '事件里没有认领到这次请求 —— 槽位标记没出现在 messages 里，'
                + '或者酒馆没发 CHAT_COMPLETION_SETTINGS_READY。附加参数多半没生效。',
        };

        return { content: String(content ?? '').trim(), reasoning: liveReasoning };
    } finally {
        try { unsubscribe?.(); } catch { /* 忽略 */ }
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

    // 思维链不再需要在这里清 —— 它现在是每个阶段自己从拦截到的流里攒的
    // 局部变量，随阶段开始/结束天然隔离，跨不了轮。
    // （之前那套是模块级 Map + 全局单槽，「第二轮闪出第一轮思维链」就是那么来的。）

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

        // ⚠️ 只改**当前这一条 swipe**，绝不能重建整个数组。
        //
        // 曾经这里是 `message.swipes = [finalText]; message.swipe_id = 0;`
        // —— 那会把用户重 roll 出来的所有分支一次性抹掉。用户实测症状：
        // 重 roll 出 4 条，跑完流水线后计数变成「1/1」。
        // 那不是删楼层，是 swipes 被清空。
        //
        // 正确做法：写回当前正在看的那条，其它分支原样保留。
        if (Array.isArray(message.swipes) && message.swipes.length) {
            const id = Number.isInteger(message.swipe_id) ? message.swipe_id : 0;
            if (id >= 0 && id < message.swipes.length) {
                message.swipes[id] = finalText;
                // swipe_info 与 swipes 一一对应，只清掉这一条，别整个丢掉
                if (Array.isArray(message.swipe_info) && id < message.swipe_info.length) {
                    message.swipe_info[id] = null;
                }
            }
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
        // 每个阶段的订阅都在 runOneStage 的 finally 里退掉了，这里没有全局状态要收
    }
}

export { recoverSlots };
