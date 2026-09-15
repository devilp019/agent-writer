/**
 * Agent Writer - 阶段上下文拼装
 *
 * 两个硬约束：
 *
 * 1. **世界书必须注入。**
 *    校验者要判断「是否违反世界观设定」，就必须看得到世界书条目。
 *    好在酒馆通过 getContext() 暴露了 getWorldInfoPrompt()，不用自己扫描。
 *
 * 2. **前缀必须跨阶段保持一致。**
 *    部分上游（以及酒馆自己的缓存机制）靠前缀匹配复用缓存。
 *    如果两个阶段的 system 前缀不同，即使打同一个后端也永远命中不了。
 *    所以这里把「设定」做成一个**逐字节相同**的共享前缀，
 *    各阶段只在后面的 user 消息里写自己的指令。
 */

import { CRITIQUE_SCHEMA } from './config.js?v=0.5.0';

/** 把校验 schema 渲染成提示词里的文字说明 */
export function describeSchema() {
    return JSON.stringify(CRITIQUE_SCHEMA.value, null, 2);
}

/** 从角色卡取一份精简摘要 */
function charCardDigest(ctx) {
    try {
        const fields = ctx.getCharacterCardFields?.({}) ?? {};
        const parts = [];
        const push = (label, value, limit = 1500) => {
            const text = String(value ?? '').trim();
            if (!text) return;
            parts.push(`【${label}】\n${text.length > limit ? `${text.slice(0, limit)}…` : text}`);
        };
        push('角色描述', fields.description);
        push('性格', fields.personality);
        push('场景', fields.scenario);
        push('用户人设', fields.persona);
        return parts.join('\n\n');
    } catch (e) {
        console.warn('[AgentWriter] 取角色卡失败', e);
        return '';
    }
}

/**
 * 触发世界书扫描，拿到已激活的条目。
 *
 * getWorldInfoPrompt 的 chat 参数按「深度递增」排列，即 index 0 是最近一楼。
 * 签名可能随版本变化，所以对参数个数做一次兼容尝试。
 */
async function scanWorldInfo(ctx, chatStrings) {
    const fn = ctx.getWorldInfoPrompt;
    if (typeof fn !== 'function') {
        console.warn('[AgentWriter] getWorldInfoPrompt 不可用，校验者将看不到世界书');
        return null;
    }

    const maxContext = Number(ctx.maxContext) || 8192;

    try {
        return await fn.call(ctx, chatStrings, maxContext, true);
    } catch (e) {
        console.warn('[AgentWriter] 世界书扫描失败（试旧签名）', e?.message ?? e);
        try {
            return await fn.call(ctx, chatStrings, true);
        } catch (e2) {
            console.warn('[AgentWriter] 世界书扫描失败', e2?.message ?? e2);
            return null;
        }
    }
}

/** 把深度条目渲染成可插入的文本 */
function renderDepthEntries(entries) {
    const out = [];
    for (const entry of entries ?? []) {
        const content = typeof entry === 'string'
            ? entry
            : String(entry?.content ?? entry?.mes ?? '').trim();
        if (content) out.push(content);
    }
    return out.join('\n\n');
}

/**
 * 组装「共享前缀」。
 *
 * 这个前缀在两个阶段里**逐字节一致**，是缓存能命中的前提。
 * 所以任何阶段特有的内容都不能放进来。
 *
 * 只扫描一次，两处复用 —— 顺带避免重复触发世界书递归扫描的副作用。
 */
let prefixCache = null;

export function invalidatePrefixCache() {
    prefixCache = null;
}

async function buildSharedPrefix(ctx, { includeCharCard, includeWorldInfo }) {
    // 缓存键只看「内容构成」，与阶段无关 ——
    // 两个阶段必须拿到同一份前缀，否则缓存永远命中不了。
    const cacheKey = `wi=${includeWorldInfo ? 1 : 0};cc=${includeCharCard ? 1 : 0}`;

    if (prefixCache && prefixCache.key === cacheKey) {
        return prefixCache.value;
    }

    const blocks = [];
    let depthText = '';

    if (includeWorldInfo) {
        const chat = ctx.chat ?? [];
        // index 0 = 最近一楼，逐层往前
        const chatStrings = [];
        for (let i = chat.length - 1; i >= 0; i--) {
            const mes = chat[i]?.mes;
            if (typeof mes === 'string' && mes.trim()) chatStrings.push(mes);
        }

        const wi = await scanWorldInfo(ctx, chatStrings);
        const before = String(wi?.worldInfoBefore ?? '').trim();
        const after = String(wi?.worldInfoAfter ?? '').trim();
        depthText = renderDepthEntries(wi?.worldInfoDepth);

        if (before) blocks.push(`【世界观设定】\n${before}`);
        if (after) blocks.push(`【补充设定】\n${after}`);

        if (!before && !after && !depthText) {
            console.log('[AgentWriter] 本次没有世界书条目被激活');
        } else {
            console.log(`[AgentWriter] 世界书已注入：before ${before.length} 字 / after ${after.length} 字 / 深度 ${depthText.length} 字`);
        }
    }

    if (includeCharCard) {
        const digest = charCardDigest(ctx);
        if (digest) blocks.push(`【角色设定】\n${digest}`);
    }

    const value = { prefix: blocks.join('\n\n'), depthText };
    prefixCache = { key: cacheKey, value };
    return value;
}

/** 两个阶段必须一字不差的中间段，放在共享前缀之后 */
const SHARED_ROLE = [
    '你是一个 RP 文本流水线中的助手。流水线分两步：先校验草稿的逻辑问题，再按校验意见改写。',
    '你的输出只服务于这条流水线，不参与角色扮演，也不要续写剧情。',
].join('\n');

/** 取最近 N 楼，转成 role/content。排除 excludeIndex（草稿所在层） */
function recentMessages(ctx, depth, excludeIndex) {
    const n = Number(depth);
    if (!Number.isFinite(n) || n <= 0) return [];

    const chat = ctx.chat ?? [];
    const end = Number.isInteger(excludeIndex) && excludeIndex >= 0 ? excludeIndex : chat.length;
    const start = Math.max(0, end - n);
    const slice = chat.slice(start, end);

    const out = [];
    for (const m of slice) {
        if (!m || typeof m.mes !== 'string' || !m.mes.trim()) continue;
        if (m.is_system) continue;
        out.push({ role: m.is_user ? 'user' : 'assistant', content: m.mes });
    }
    return out;
}

/**
 * ② 校验阶段的完整消息数组。
 *
 * 结构（前两段与 ③ 完全一致，供缓存命中）：
 *   [0] 共享前缀（世界书 + 角色卡）   ← 与 ③ 相同
 *   [1] 共享角色说明                  ← 与 ③ 相同
 *   [2..] 历史 + 校验指令 + 草稿       ← 阶段特有
 */
export async function buildCriticMessages({ settings, draft, draftIndex, ctx }) {
    const shared = await buildSharedPrefix(ctx, {
        includeCharCard: settings.includeCharCard !== false,
        includeWorldInfo: settings.includeWorldInfo !== false,
    });

    const messages = [];

    if (shared.prefix) messages.push({ role: 'system', content: shared.prefix });
    messages.push({ role: 'system', content: SHARED_ROLE });

    const history = recentMessages(ctx, settings.contextDepth, draftIndex);
    if (history.length) {
        const head = [];
        head.push({ role: 'system', content: '以下是草稿之前的对话（按时间顺序）：' });
        if (shared.depthText) head.push({ role: 'system', content: shared.depthText });
        messages.push(...head, ...history);
    }

    messages.push({ role: 'system', content: settings.systemPrompt });

    // 草稿只出现一次 —— 历史里已经排除了草稿所在楼层
    messages.push({
        role: 'user',
        content: [
            '【草稿】',
            draft,
            '',
            '【输出要求】',
            '每条问题一行，编号，依次写：问题类型、草稿里的原句、应该怎么改。',
            '全部使用纯文本。不要输出任何嵌套结构、对象、或 JSON。',
            '最多 8 条，总长不超过 600 字。',
            '没有问题就只输出：无需修改',
        ].join('\n'),
    });

    return messages;
}

/**
 * ③ 改写阶段的完整消息数组。
 *
 * 前两段与 ② 完全一致；之后换成改写任务。
 * 两个阶段打同一后端时，长前缀可以被复用。
 */
export async function buildRewriteMessages({ settings, draft, critiqueText, ctx }) {
    const shared = await buildSharedPrefix(ctx, {
        includeCharCard: settings.includeCharCard !== false,
        includeWorldInfo: settings.includeWorldInfo !== false,
    });

    const messages = [];

    if (shared.prefix) messages.push({ role: 'system', content: shared.prefix });
    messages.push({ role: 'system', content: SHARED_ROLE });
    messages.push({ role: 'system', content: settings.systemPrompt });

    messages.push({
        role: 'user',
        content: `【草稿】\n${draft}\n\n【修改意见】\n${critiqueText}\n\n请输出修改后的正文。`,
    });

    return messages;
}

/** 把校验结果渲染成带编号的清单 */
export function renderCritique(parsed) {
    if (!parsed || typeof parsed !== 'object') return '';

    const issues = Array.isArray(parsed.issues) ? parsed.issues : [];
    if (issues.length === 0) return '';

    const label = { critical: '严重', major: '重要', minor: '次要' };
    return issues
        .map((issue, i) => {
            const severity = label[issue?.severity] ?? issue?.severity ?? '?';
            const category = issue?.category ?? '其它';
            const evidence = issue?.evidence ? `原文：「${issue.evidence}」` : '';
            const fix = issue?.fix ? `改法：${issue.fix}` : '';
            return `${i + 1}. [${severity}/${category}] ${[evidence, fix].filter(Boolean).join(' → ')}`;
        })
        .join('\n');
}

/**
 * 尽最大努力把校验输出解析成结构化结果。
 * 默认提示词走纯文本，所以解析失败是正常路径，不算错误。
 */
export function parseCritique(text) {
    const raw = String(text ?? '').trim();
    if (!raw) return null;

    const attempts = [
        raw,
        raw.match(/```(?:json)?\s*([\s\S]*?)```/)?.[1],
        raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1),
    ];

    for (const candidate of attempts) {
        const text2 = String(candidate ?? '').trim();
        if (!text2 || !text2.startsWith('{')) continue;
        try {
            const parsed = JSON.parse(text2);
            if (parsed && typeof parsed === 'object' && Array.isArray(parsed.issues)) {
                return parsed;
            }
        } catch { /* 试下一个 */ }
    }

    return null;
}

/** 从纯文本里粗判是否有问题 */
export function looksCleanText(text) {
    const raw = String(text ?? '').trim();
    if (!raw) return false;
    if (raw.length > 60) return false;
    return /无需修改|没有问题|无问题|不用修改|no\s*issues?/i.test(raw);
}

/** 校验结果是否表示「不用改」。支持结构化与纯文本两种形态 */
export function isClean(parsed, rawText = '') {
    if (parsed) {
        const issues = Array.isArray(parsed.issues) ? parsed.issues : [];
        if (parsed.verdict === '无需修改') return true;
        if (issues.length === 0) return true;
    }
    return looksCleanText(rawText);
}

/**
 * 校验输出是否明显跑飞了。
 *
 * 不要求 JSON —— 要求结构化输出的唯一理由是 `[Object]` 问题
 * （模型把嵌套对象拼进了正文），只要顶层保持扁平就不会有。
 * 这里只拦「跑飞」：长到失控。
 */
export function looksRunaway(text, parsed, { maxChars = 6000, maxIssues = 40 } = {}) {
    const raw = String(text ?? '').trim();
    if (!raw) return '校验输出为空';

    if (!parsed) {
        return raw.length > maxChars
            ? `校验输出无法解析为结构化结果，且有 ${raw.length} 字（上限 ${maxChars}）`
            : null;
    }

    const issues = Array.isArray(parsed.issues) ? parsed.issues : [];
    if (issues.length > maxIssues) {
        return `校验输出了 ${issues.length} 条问题（上限 ${maxIssues}）`;
    }

    const total = issues.reduce(
        (sum, i) => sum + String(i?.evidence ?? '').length + String(i?.fix ?? '').length,
        0,
    );
    if (total > maxChars) {
        return `校验意见合计 ${total} 字（上限 ${maxChars}），疑似跑飞`;
    }

    return null;
}

export { CRITIQUE_SCHEMA };
