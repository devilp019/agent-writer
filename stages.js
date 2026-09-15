/**
 * Agent Writer - 阶段上下文拼装
 *
 * 关键设计：校验者与改写者看到的上下文是**受控的**，不是整份预设。
 *
 * 原因：把整份 RP 预设喂给校验者，它会被「推进剧情」「扮演角色」这类指令带跑，
 * 提示词里写再多「最高优先级」都在跟上下文打架 —— 这正是思维链跑偏的根源。
 * 校验者只需要：指令 + 角色卡摘要 + 最近几楼 + 草稿。
 */

import { CRITIQUE_SCHEMA } from './config.js?v=0.4.1';

/** 把校验 schema 渲染成提示词里的文字说明，让模型知道要输出什么 */
export function describeSchema() {
    return JSON.stringify(CRITIQUE_SCHEMA.value, null, 2);
}

/** 从角色卡取一份精简摘要，只保留校验需要的部分 */
function charCardDigest(ctx) {
    try {
        const fields = ctx.getCharacterCardFields?.({}) ?? {};
        const parts = [];
        const push = (label, value, limit = 1200) => {
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
 * 取最近 N 楼，转成 role/content 形式。
 *
 * 必须排除草稿本身所在的楼层 —— 否则草稿会先作为「最近历史」发一遍，
 * 后面又作为【草稿】发一遍，同一段文本重复出现。
 *
 * @param {object} ctx
 * @param {number} depth
 * @param {number} excludeIndex 要排除的楼层号（草稿所在层）
 */
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
 * @param {object} options
 * @param {object} options.settings 已解析的阶段设置
 * @param {string} options.draft 草稿正文
 * @param {number} options.draftIndex 草稿所在楼层（会被排除出历史）
 * @param {object} options.ctx SillyTavern context
 */
export function buildCriticMessages({ settings, draft, draftIndex, ctx }) {
    const messages = [{ role: 'system', content: settings.systemPrompt }];

    if (settings.includeCharCard) {
        const digest = charCardDigest(ctx);
        if (digest) {
            messages.push({ role: 'system', content: `以下是本场景的设定，校验时以此为准：\n\n${digest}` });
        }
    }

    const history = recentMessages(ctx, settings.contextDepth, draftIndex);
    if (history.length) {
        messages.push({ role: 'system', content: '以下是草稿之前的对话，用于判断前后一致性：' });
        messages.push(...history);
    }

    // 输出格式写进提示词本身，而不是依赖上游支持 response_format。
    // 草稿只出现一次 —— 历史里已经排除了草稿所在楼层。
    messages.push({
        role: 'user',
        content: [
            '【草稿】',
            draft,
            '',
            '【输出要求】',
            '只输出一个 JSON 对象，不要有任何解释文字、不要用 markdown 代码块包裹。',
            '结构如下：',
            describeSchema(),
            '',
            '限定：issues 最多 8 条，每条 evidence 不超过 60 字、fix 不超过 80 字。',
            '没有问题就输出 {"verdict":"无需修改","issues":[]}。',
        ].join('\n'),
    });

    return messages;
}

/**
 * ③ 改写阶段的完整消息数组。
 * @param {object} options
 * @param {object} options.settings
 * @param {string} options.draft
 * @param {string} options.critiqueText 已渲染成清单的修改意见
 */
export function buildRewriteMessages({ settings, draft, critiqueText }) {
    return [
        { role: 'system', content: settings.systemPrompt },
        {
            role: 'user',
            content: `【草稿】\n${draft}\n\n【修改意见】\n${critiqueText}\n\n请输出修改后的正文。`,
        },
    ];
}

/**
 * 把校验结果渲染成带编号的清单。
 *
 * 比塞一大段散文意见更精准：每条都带 severity、原文引用和具体改法，
 * 改写者可以逐条对照，不容易漏也不容易改过头。
 */
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
 * 尽最大努力把模型输出解析成结构化校验结果。
 *
 * 模型有时会把 JSON 包在 ```json 里，或在前后多写几句解释。
 * 解析失败不抛错 —— 返回 null，让调用方决定是中止还是降级。
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

/** 校验结果是否表示「不用改」 */
export function isClean(parsed) {
    if (!parsed) return false;
    const issues = Array.isArray(parsed.issues) ? parsed.issues : [];
    return issues.length === 0 || parsed.verdict === '无需修改';
}

/**
 * 校验输出是否明显跑飞了。
 *
 * 为什么需要这道闸：如果校验阶段自由发挥出一大段文字（schema 没生效），
 * 后面会把这段垃圾当「修改意见」喂给改写者，终稿就等于草稿甚至更糟 ——
 * 而且整个过程看起来是「成功」的。宁可中止并保留原稿，也不拿垃圾去改写。
 */
export function looksRunaway(text, parsed, { maxChars = 6000, maxIssues = 40 } = {}) {
    const raw = String(text ?? '').trim();

    if (!parsed) {
        return raw.length > maxChars
            ? `校验输出不是可解析的 JSON，且有 ${raw.length} 字（上限 ${maxChars}）`
            : '校验输出不是可解析的 JSON';
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
