/**
 * Agent Writer - 指令文本与校验结果处理
 *
 * 上下文（预设、世界书、角色卡、聊天记录）由**酒馆自己组装**，
 * 本文件只负责两件事：
 *   1. 生成要注入到预设槽位里的指令文本
 *   2. 解析校验结果、判断是否跑飞 / 是否无需修改
 *
 * 这是走酒馆助手带来的最大简化 —— 之前这里有一整套「自己拼上下文、
 * 自己扫世界书、自己对齐缓存前缀」的代码，现在全都不需要了。
 */

import { CRITIQUE_SCHEMA } from './config.js?v=0.8.2';

/** 把校验 schema 渲染成提示词里的文字说明 */
export function describeSchema() {
    return JSON.stringify(CRITIQUE_SCHEMA.value, null, 2);
}

/**
 * ② 校验指令。
 *
 * 草稿不需要写进指令里 —— 它就是聊天记录的最后一条，
 * 已经由酒馆组装进上下文了。
 */
export function buildCritiqueInstruction(settings) {
    return [
        settings.systemPrompt,
        '',
        '【本次任务】',
        '校验聊天记录中最后一条 AI 回复（即草稿）的逻辑问题。',
        '不要续写剧情，不要输出正文，只输出问题清单。',
        '',
        '【输出要求】',
        '每条问题一行，编号，依次写：问题类型、草稿里的原句、应该怎么改。',
        '全部使用纯文本。不要输出任何嵌套结构、对象、或 JSON。',
        '最多 8 条，总长不超过 600 字。',
        '没有问题就只输出：无需修改',
    ].join('\n');
}

/**
 * ③ 改写指令。
 *
 * 草稿同样在聊天记录里，这里只贴校验意见。
 */
export function buildRewriteInstruction(settings, critiqueText) {
    return [
        settings.systemPrompt,
        '',
        '【本次任务】',
        '按下面的修改意见，修改聊天记录中最后一条 AI 回复（即草稿）。',
        '只输出修改后的正文本身，不要任何说明、分析或批注。',
        '',
        '【修改意见】',
        String(critiqueText ?? '').trim(),
    ].join('\n');
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
