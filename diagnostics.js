/**
 * Agent Writer - 自检与连通性探测
 *
 * 为什么需要这个：酒馆后端在平板上，改完代码没法开 devtools 慢慢查。
 * 出问题时点一下「运行自检」，把文本框里的结果截图发出来即可。
 *
 * 同时挂到 window.awDiagnose() / window.awProbe()，平板外接键盘时可直接调。
 */

import { log, setDiagOutput } from './ui/panel.js?v=0.6.0';
import { describeMenuContainer, isMenuItemMounted } from './ui/menu.js?v=0.6.0';

/** 用于自检的独立命名空间，不占用扩展自己的设置 */
const DIAG_NS = 'agent_writer_diag';

function ctx() {
    return globalThis.SillyTavern?.getContext?.() ?? null;
}

function line(label, value) {
    return `${label}: ${value}`;
}

function ok(value) {
    return value ? '✔' : '✘';
}

// ---------------------------------------------------------------------------
// 环境自检
// ---------------------------------------------------------------------------

async function collectEnvironment(context) {
    const out = [];

    out.push('=== 环境 ===');
    out.push(line('扩展版本', '0.1.0'));
    out.push(line('getContext()', ok(context) + (context ? '' : '  ← 致命：扩展环境异常')));
    out.push(line('ST 版本', context?.version ?? '(ctx.version 未暴露)'));
    out.push(line('主 API', context?.mainApi ?? '(空)'));
    out.push(line('聊天文件', context?.getCurrentChatId?.() ?? '(无)'));

    out.push('');
    out.push('=== 依赖的 API ===');
    const svc = context?.ConnectionManagerRequestService ?? globalThis.ConnectionManagerRequestService;
    out.push(line('ConnectionManagerRequestService', ok(svc) + (svc ? '' : '  ← 致命：无法按配置发请求')));
    out.push(line('  .sendRequest', ok(typeof svc?.sendRequest === 'function')));
    out.push(line('  .handleDropdown', ok(typeof svc?.handleDropdown === 'function')));
    out.push(line('ChatCompletionService', ok(context?.ChatCompletionService)));
    out.push(line('generateRaw', ok(typeof context?.generateRaw === 'function')));
    out.push(line('getPresetManager', ok(typeof context?.getPresetManager === 'function')));
    out.push(line('getCharacterCardFields', ok(typeof context?.getCharacterCardFields === 'function')));
    out.push(line('getWorldInfoPrompt', ok(typeof context?.getWorldInfoPrompt === 'function')));
    out.push(line('saveSettingsDebounced', ok(typeof context?.saveSettingsDebounced === 'function')));
    out.push(line('parseReasoningFromString', ok(typeof context?.parseReasoningFromString === 'function')));

    out.push('');
    out.push('=== 连接管理器 ===');
    const disabled = context?.extensionSettings?.disabledExtensions;
    const cmDisabled = Array.isArray(disabled) && disabled.includes('connection-manager');
    out.push(line('connection-manager 已启用', ok(!cmDisabled)));
    out.push(line('disabledExtensions', Array.isArray(disabled) ? disabled.join(', ') || '(空)' : '(不可读)'));

    const profiles = context?.extensionSettings?.connectionManager?.profiles;
    out.push(line('连接配置数量', Array.isArray(profiles) ? profiles.length : '(不可读)'));

    if (Array.isArray(profiles) && profiles.length > 0) {
        out.push('');
        for (const profile of profiles) {
            let supported = '?';
            try {
                supported = svc?.isProfileSupported?.(profile) ? '可用' : '不支持的类型';
            } catch (error) {
                supported = `判定失败(${error.message})`;
            }
            out.push(`  · ${profile.name ?? '(无名)'} [${supported}]`);
            out.push(`      id=${profile.id ?? '?'} api=${profile.api ?? '?'} model=${profile.model || '(空)'}`);
            out.push(`      secret-id=${profile['secret-id'] ? '已设置' : '(无)'} api-url=${profile['api-url'] || '(空)'} preset=${profile.preset || '(空)'}`);
        }
    }

    out.push('');
    out.push('=== 界面挂载点 ===');
    out.push(line('#extensionsMenu', ok(document.getElementById('extensionsMenu'))));
    out.push(line('菜单容器探测', describeMenuContainer()));
    out.push(line('#aw-menu-item 已挂载', ok(isMenuItemMounted())));
    out.push(line('#aw-fab（悬浮球）', ok(document.getElementById('aw-fab'))));
    out.push(line('  位置', document.getElementById('aw-fab')?.style?.left
        ? `${document.getElementById('aw-fab').style.left} / ${document.getElementById('aw-fab').style.top}`
        : '(未定位)'));
    out.push(line('#aw-panel（面板）', ok(document.getElementById('aw-panel')) + (document.getElementById('aw-panel') ? '' : '  ← 点悬浮球应能补挂')));
    out.push(line('  display', document.getElementById('aw-panel')?.style?.display || '(空)'));
    out.push(line('aw 调试入口', ok(globalThis.aw)));
    out.push(line('prefers-reduced-motion', window.matchMedia('(prefers-reduced-motion: reduce)').matches ? '是（动画已降级）' : '否'));
    out.push(line('视口', `${window.innerWidth}x${window.innerHeight} @${window.devicePixelRatio}x`));

    return out;
}

/**
 * 运行环境自检。结果写入面板文本框，同时打到日志。
 */
export async function diagnose() {
    const context = ctx();
    const out = [];

    try {
        out.push(...(await collectEnvironment(context)));
    } catch (error) {
        out.push(`自检本身出错: ${error?.message ?? error}`);
        console.error('[AgentWriter] 自检出错', error);
    }

    out.push('');
    out.push('=== 结论 ===');
    if (!context) {
        out.push('getContext() 拿不到 —— 扩展没有在酒馆环境里运行，请确认安装位置。');
    } else if (!(context.ConnectionManagerRequestService ?? globalThis.ConnectionManagerRequestService)) {
        out.push('ConnectionManagerRequestService 不可用 —— 请在扩展管理里确认 connection-manager 没有被禁用。');
    } else {
        out.push('环境看起来正常。可以再点「测试当前连接配置」验证请求链路。');
    }

    const text = out.join('\n');
    setDiagOutput(text);
    log('自检完成，结果见「参数」页的自检框');
    return text;
}

// ---------------------------------------------------------------------------
// 连通性探测
// ---------------------------------------------------------------------------

function getDiagProfileId(context) {
    const saved = context.extensionSettings?.[DIAG_NS]?.probeProfileId;
    if (saved) return saved;

    const svc = context.ConnectionManagerRequestService;
    const profiles = svc.getSupportedProfiles?.() ?? [];
    const selected = context.extensionSettings?.connectionManager?.selectedProfile;
    if (selected && profiles.some((p) => p.id === selected)) return selected;
    return profiles[0]?.id ?? '';
}

function setDiagProfileId(context, id) {
    if (!context.extensionSettings[DIAG_NS]) {
        context.extensionSettings[DIAG_NS] = {};
    }
    context.extensionSettings[DIAG_NS].probeProfileId = id;
    context.saveSettingsDebounced?.();
}

/** 发一次请求，流式或非流式。返回统一的 { ok, content, reasoning, note } */
async function runOnce(svc, profileId, useStream) {
    const messages = [{ role: 'user', content: 'Say OK' }];
    const options = { stream: useStream, extractData: true, includePreset: false, includeInstruct: false };

    if (!useStream) {
        const result = await svc.sendRequest(profileId, messages, 1024, options);
        const content = String(result?.content ?? '');
        return {
            ok: !!content,
            content,
            reasoning: String(result?.reasoning ?? ''),
            note: content ? '' : 'HTTP 成功但解析不出正文（包裹格式可能不被酒馆识别）',
        };
    }

    const streamFn = await svc.sendRequest(profileId, messages, 1024, options);
    if (typeof streamFn !== 'function') {
        return { ok: false, content: '', reasoning: '', note: '这个配置不支持流式' };
    }
    let full = '';
    let reasoning = '';
    for await (const { text, state } of streamFn()) {
        full = text ?? full;
        reasoning = state?.reasoning ?? reasoning;
    }
    return { ok: !!full, content: full, reasoning, note: full ? '' : '流式也没拿到正文' };
}

/**
 * 用指定（或当前）连接配置发一个真实请求，验证整条链路。
 * 这会消耗极少量额度 —— 是显式点击触发的，不是自动跑的。
 *
 * 关键：先试非流式，正文为空就自动改走流式。
 * 有些上游（例如 Cline）的非流式包裹格式酒馆解析不了，
 * 只看 HTTP 状态会得到一个假的成功信号。
 *
 * @param {string} [profileId]
 */
export async function probe(profileId) {
    const context = ctx();
    if (!context) {
        setDiagOutput('getContext() 不可用，无法探测。');
        return null;
    }

    const svc = context.ConnectionManagerRequestService ?? globalThis.ConnectionManagerRequestService;
    if (!svc) {
        setDiagOutput('ConnectionManagerRequestService 不可用，无法探测。');
        return null;
    }

    const id = profileId || getDiagProfileId(context);
    const out = [];

    if (!id) {
        out.push('没有可用的连接配置。');
        out.push('请先在酒馆的「连接配置 / Connection Manager」里建一个（选 API 源、填模型、关联密钥）。');
        const text = out.join('\n');
        setDiagOutput(text);
        return null;
    }

    let profile = null;
    try {
        profile = svc.getProfile(id);
    } catch { /* 后面 sendRequest 会报更准确的信息 */ }

    const apiMap = profile ? (context.CONNECT_API_MAP?.[profile.api] ?? {}) : {};

    out.push(`探测目标: ${profile?.name ?? id} (${id})`);
    if (profile) {
        out.push(`  api=${profile.api}  →  selected=${apiMap.selected ?? '?'}  source=${apiMap.source ?? '?'}`);
        out.push(`  model=${profile.model || '(空)'}  api-url=${profile['api-url'] || '(空)'}  secret=${profile['secret-id'] ? '已设' : '(无)'}  preset=${profile.preset || '(空)'}`);
    }

    setDiagOutput(out.join('\n'));
    log(`开始探测连接配置「${profile?.name ?? id}」`);

    try {
        // —— 第一轮：非流式 ——
        out.push('');
        out.push('【非流式】发送中…');
        setDiagOutput(out.join('\n'));

        const started = Date.now();
        const plain = await runOnce(svc, id, false);
        out.push(`  耗时 ${Date.now() - started}ms`);
        if (plain.ok) {
            out.push(`  ✔ 正文: ${JSON.stringify(plain.content.slice(0, 100))}`);
            out.push(`  思维链: ${plain.reasoning ? `${plain.reasoning.length} 字` : '(空)'}`);
        } else {
            out.push(`  △ HTTP 通了，但没拿到正文${plain.note ? ` —— ${plain.note}` : ''}`);
        }

        // —— 第二轮：需要时才试流式 ——
        let final = { ok: plain.ok, mode: '非流式', content: plain.content, reasoning: plain.reasoning };

        if (!plain.ok) {
            out.push('');
            out.push('【流式】自动重试中…');
            setDiagOutput(out.join('\n'));

            const started2 = Date.now();
            const streamed = await runOnce(svc, id, true);
            out.push(`  耗时 ${Date.now() - started2}ms`);
            if (streamed.ok) {
                out.push(`  ✔ 正文: ${JSON.stringify(streamed.content.slice(0, 100))}`);
                out.push(`  思维链: ${streamed.reasoning ? `${streamed.reasoning.length} 字` : '(空)'}`);
                final = { ok: true, mode: '流式', content: streamed.content, reasoning: streamed.reasoning };
            } else {
                out.push(`  ✘ ${streamed.note || '流式也没拿到正文'}`);
            }
        }

        out.push('');
        out.push('=== 结论 ===');
        if (final.ok) {
            out.push(`✔ 这条配置可用，走${final.mode}。`);
            if (final.mode === '流式') {
                out.push('');
                out.push('⚠ 非流式的包裹格式酒馆解析不了，这条配置必须开流式。');
                out.push('  扩展会自动对这类配置启用流式，你不用手动管。');
            }
            out.push('');
            out.push('=== 思维链能力 ===');
            out.push(
                final.reasoning
                    ? '✔ 返回了 reasoning —— 非流式/流式都能直接读，不需要拦截 fetch。'
                    : '△ 未拿到 reasoning —— 可能是模型不支持、或该源未透出。功能不受影响，只是思维链看不到。',
            );
            setDiagProfileId(context, id);
        } else {
            out.push('✘ 非流式和流式都没拿到正文。');
            out.push('  下一步需要看酒馆后台日志里上游返回的原始响应。');
        }
    } catch (error) {
        out.push('');
        out.push(`✘ 请求失败: ${error?.message ?? error}`);
        const cause = error?.cause;
        if (cause) out.push(`  cause: ${cause?.message ?? cause}`);
    }

    const text = out.join('\n');
    setDiagOutput(text);
    log('探测完成');
    return text;
}

function getKnownProfiles(context) {
    try {
        return context.ConnectionManagerRequestService.getSupportedProfiles?.() ?? [];
    } catch {
        return [];
    }
}

/**
 * 针对「酒馆里手动测能通、程序调返回 error」这种情况的定向诊断。
 *
 * 最可能的差别是密钥来源：酒馆界面上直接用当前激活的密钥，
 * 而 ConnectionManagerRequestService 用的是存在 profile 里的 secret id，
 * 这两个可以是不同的（profile 里那个可能过期或属于另一个账号）。
 *
 * 所以把所有候选 secret 排列组合都试一遍，外加换模型对照。
 */
export async function probeSecret() {
    const context = ctx();
    const svc = context?.ConnectionManagerRequestService;
    if (!svc) {
        setDiagOutput('ConnectionManagerRequestService 不可用。');
        return null;
    }

    const profileId = getDiagProfileId(context);
    let profile;
    try {
        profile = svc.getProfile(profileId);
    } catch (e) {
        setDiagOutput(`取连接配置失败: ${e?.message}`);
        return null;
    }

    const apiMap = context.CONNECT_API_MAP?.[profile.api] ?? {};
    const out = [];
    const say = (s) => {
        out.push(s);
        setDiagOutput(out.join('\n'));
    };

    say('=== 密钥来源对照测试 ===');
    say(`配置「${profile.name}」  model=${profile.model || '(空)'}`);
    say('');

    const variants = [
        { label: '① 用 profile 里存的 secret', secret_id: profile['secret-id'] },
        { label: '② 不带 secret（酒馆用当前激活的密钥）', secret_id: undefined },
    ];

    // 把该配置自己声明的密钥也加进来对照
    try {
        const raw = context.extensionSettings?.connectionManager?.profiles
            ?.find((p) => p.id === profileId)?.secret;
        if (raw) variants.push({ label: `③ 用 profile.secret=${raw}`, secret_id: raw });
    } catch { /* 没有就算了 */ }

    // 同时也看看当前激活的是哪个
    try {
        const active = context.ChatCompletionSettings?.secret_id
            ?? context.chatCompletionSettings?.secret_id;
        if (active) say(`当前酒馆界面激活的 secret: ${active}`);
        say('');
    } catch { /* 读不到就算了 */ }

    const messages = [{ role: 'user', content: 'Say OK' }];

    for (const v of variants) {
        const body = {
            stream: false,
            messages,
            model: profile.model,
            chat_completion_source: apiMap.source ?? 'custom',
            custom_url: profile['api-url'],
            max_tokens: 8,
            use_sysprompt: true,
        };
        if (v.secret_id) body.secret_id = v.secret_id;

        say(`${v.label}`);
        try {
            const resp = await fetch('/api/backends/chat-completions/generate', {
                method: 'POST',
                headers: context.getRequestHeaders?.() ?? { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            const text = await resp.text();
            let parsed = null;
            try { parsed = JSON.parse(text); } catch { /* 非 JSON */ }

            const err = parsed?.error;
            if (err) {
                say(`   ✘ HTTP ${resp.status}  上游报错: ${err.message ?? JSON.stringify(err)}`);
            } else {
                const content = parsed?.choices?.[0]?.message?.content
                    ?? parsed?.choices?.[0]?.text
                    ?? parsed?.content
                    ?? '';
                say(`   ✔ HTTP ${resp.status}  返回: ${JSON.stringify(String(content).slice(0, 80))}`);
                say('   ⇒ 这条密钥来源是通的');
            }
        } catch (e) {
            say(`   抛错: ${e?.message}`);
        }
        say('');
    }

    // 换模型对照：区分「密钥问题」和「这个模型在该账号下不可用」
    if (profile.model) {
        say('=== 换模型对照（同一个密钥，只改 model）===');
        const body = {
            stream: false,
            messages,
            model: 'gpt-4o-mini',
            chat_completion_source: apiMap.source ?? 'custom',
            custom_url: profile['api-url'],
            max_tokens: 8,
            use_sysprompt: true,
        };
        if (profile['secret-id']) body.secret_id = profile['secret-id'];
        try {
            const resp = await fetch('/api/backends/chat-completions/generate', {
                method: 'POST',
                headers: context.getRequestHeaders?.() ?? { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            const parsed = await resp.json().catch(() => null);
            if (parsed?.error) {
                say(`   model=gpt-4o-mini → ✘ ${parsed.error.message ?? JSON.stringify(parsed.error)}`);
                say('   ⇒ 换模型也不行，问题在密钥/端点而不在模型名');
            } else {
                say('   model=gpt-4o-mini → ✔ 通');
                say(`   ⇒ 端点与密钥没问题，是「${profile.model}」这个模型名在该账号下不可用`);
            }
        } catch (e) {
            say(`   抛错: ${e?.message}`);
        }
    }

    say('');
    say('判断方法：同密钥换模型能通 ⇒ 模型名的问题；两条密钥都报错 ⇒ 端点或密钥本身的问题。');
    log('密钥来源对照测试完成');
    return out.join('\n');
}

/**
 * 空请求体对照：极端 A/B 测试。
 *
 * 背景：cline2 在酒馆里手动用能通，但程序构造请求时上游回 500
 * （而换一个不存在的模型名回的是 Bad Request，说明请求确实到达并被解析了）。
 * 「能判断模型名不合法、却在对的模型名上崩掉」通常意味着请求体里有它不接受的字段。
 *
 * 所以这里发一个几乎空的 body，看它认不认。如果空 body 能通，
 * 就逐个把字段加回去，二分找出是哪个字段把上游搞崩的。
 *
 * @param {string} [model] 留空则用 profile 的模型
 */
export async function probeShape(model) {
    const context = ctx();
    const svc = context?.ConnectionManagerRequestService;
    if (!svc) {
        setDiagOutput('ConnectionManagerRequestService 不可用。');
        return null;
    }

    const profileId = getDiagProfileId(context);
    let profile;
    try {
        profile = svc.getProfile(profileId);
    } catch (e) {
        setDiagOutput(`取连接配置失败: ${e?.message}`);
        return null;
    }

    const apiMap = context.CONNECT_API_MAP?.[profile.api] ?? {};
    const useModel = String(model ?? '').trim() || profile.model;
    const url = profile['api-url'];

    const out = [];
    const say = (s) => {
        out.push(s);
        setDiagOutput(out.join('\n'));
    };

    say('=== 请求体形状对照 ===');
    say(`配置「${profile.name}」  api-url=${url || '(空)'}`);
    say(`使用模型 ${useModel || '(空)'}`);
    say('');

    async function attempt(label, body, { viaService = false } = {}) {
        // 干掉 undefined，避免服务端把它当成"有值"
        for (const k of Object.keys(body)) {
            if (body[k] === undefined) delete body[k];
        }

        const shown = JSON.stringify(body);
        say(`${label}`);
        say(`   发出: ${shown.length > 320 ? `${shown.slice(0, 320)}…` : shown}`);

        try {
            if (viaService) {
                // 走酒馆自己的服务代码，拿到的是上游错误对象（如果它选择抛错）
                const result = await svc.sendRequest(
                    profileId,
                    body.messages,
                    body.max_tokens ?? 8,
                    { stream: false, extractData: true, includePreset: false, includeInstruct: false },
                    useModel ? { model: useModel } : {},
                );
                const content = String(result?.content ?? '');
                say(`   ✔ 服务代码返回: ${JSON.stringify(content.slice(0, 80))}`);
                return true;
            }

            const resp = await fetch('/api/backends/chat-completions/generate', {
                method: 'POST',
                headers: context.getRequestHeaders?.() ?? { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            const text = await resp.text();
            let parsed = null;
            try { parsed = JSON.parse(text); } catch { /* 非 JSON */ }

            if (parsed?.error) {
                say(`   ✘ HTTP ${resp.status}  上游报错: ${parsed.error.message ?? JSON.stringify(parsed.error)}`);
                return false;
            }
            const content = parsed?.choices?.[0]?.message?.content
                ?? parsed?.choices?.[0]?.text ?? parsed?.content ?? '';
            say(`   ✔ HTTP ${resp.status}  返回: ${JSON.stringify(String(content).slice(0, 80))}`);
            return true;
        } catch (e) {
            const cause = e?.cause?.message ?? e?.cause;
            say(`   ✘ 抛错: ${e?.message}${cause ? ` / cause: ${cause}` : ''}`);
            return false;
        } finally {
            say('');
        }
    }

    const messages = [{ role: 'user', content: 'Say OK' }];

    // 1. 最干净：只有 messages + model，连 source 都不给
    await attempt('① 极简 body（只有 messages + model）', {
        stream: false,
        messages,
        model: useModel,
    });

    // 2. 加 source 和 custom_url（我目前用的形状）
    await attempt('② 加 chat_completion_source + custom_url', {
        stream: false,
        messages,
        model: useModel,
        chat_completion_source: apiMap.source ?? 'custom',
        custom_url: url,
    });

    // 3. 再加 max_tokens / use_sysprompt
    await attempt('③ 再加 max_tokens + use_sysprompt', {
        stream: false,
        messages,
        model: useModel,
        chat_completion_source: apiMap.source ?? 'custom',
        custom_url: url,
        max_tokens: 8,
        use_sysprompt: true,
    });

    // 4. 换成一个看起来很正常的 max_tokens（8 太小可能被上游嫌弃）
    await attempt('④ max_tokens 改成 1024', {
        stream: false,
        messages,
        model: useModel,
        chat_completion_source: apiMap.source ?? 'custom',
        custom_url: url,
        max_tokens: 1024,
        use_sysprompt: true,
    });

    // 5. 走酒馆自己的服务代码（它内部会按 source 分派）
    await attempt('⑤ 走 ConnectionManagerRequestService（非流式）', {
        messages,
        max_tokens: 1024,
    }, { viaService: true });

    // 6. 流式：有些上游的非流式包裹格式酒馆解析不了，只能走流式
    say('=== 流式对照 ===');
    say('（非流式返回空内容时，这一节通常才是真相）');
    say('');
    try {
        const streamFn = await svc.sendRequest(
            profileId,
            messages,
            1024,
            { stream: true, extractData: true, includePreset: false, includeInstruct: false },
        );

        if (typeof streamFn !== 'function') {
            say('✘ 没有拿到流式迭代器（这个配置可能不支持流式）');
        } else {
            let full = '';
            let reasoning = '';
            let chunks = 0;
            const started = Date.now();
            for await (const { text, state } of streamFn()) {
                full = text ?? full;
                reasoning = state?.reasoning ?? reasoning;
                chunks++;
            }
            const elapsed = Date.now() - started;
            say(`   分片数 ${chunks}   耗时 ${elapsed}ms`);
            say(`   正文   ${full ? JSON.stringify(full.slice(0, 120)) : '(空)'}`);
            say(`   思维链 ${reasoning ? `${reasoning.length} 字` : '(空)'}`);
            say('');
            if (full) {
                say('   ✔ 流式能拿到正文 ⇒ 这个配置必须走流式，非流式的包裹格式酒馆解析不了');
            } else {
                say('   ✘ 流式也没拿到正文 ⇒ 需要看酒馆后台的原始响应');
            }
        }
    } catch (e) {
        const cause = e?.cause?.message ?? e?.cause;
        say(`   ✘ 流式抛错: ${e?.message}${cause ? ` / cause: ${cause}` : ''}`);
    }

    say('');
    say('判断方法：');
    say('  · 非流式返回空、流式有正文 ⇒ 该配置只能走流式');
    say('  · ① 不通而 ② 通 ⇒ 缺 custom_url 时酒馆无法路由');
    say('  · ⑤ 能通 ⇒ 用服务路径就行');
    log('请求体形状对照完成');
    return out.join('\n');
}

/**
 * 显示最近一次各阶段实际发出的请求体。
 *
 * 「附加参数没发出去」这类问题，看代码看不出来 —— 必须看真实请求。
 * 这里同时给出三样东西，缺一不可：
 *   1. overridePayload  我以为 merge 进去的
 *   2. requestData      我以为走顶层传的
 *   3. merged           两者合并后、真正要发的内容
 */
export async function showLastRequests() {
    const out = [];

    let snapshot;
    try {
        const mod = await import('./pipeline.js?v=0.6.0');
        snapshot = mod.getLastRequests();
    } catch (e) {
        setDiagOutput(`读取失败: ${e?.message}`);
        return null;
    }

    const pretty = (v) => (v == null ? '(无)' : JSON.stringify(v, null, 2));

    for (const stage of ['critic', 'final']) {
        const record = snapshot?.[stage];
        out.push(`=== ${stage === 'critic' ? '② 校验' : '③ 改写'} ===`);
        if (!record) {
            out.push('（还没跑过这个阶段）');
            out.push('');
            continue;
        }
        out.push(`连接配置: ${record.profileId}`);
        out.push(`流式: ${record.stream}`);
        out.push(`停止字段: ${record.abortFlag || '(未设置)'}`);
        out.push('');
        out.push('-- overridePayload（会 merge 进请求体）--');
        out.push(pretty(record.overridePayload));
        out.push('');
        out.push('-- requestData（走顶层传入）--');
        out.push(pretty(record.requestData));
        out.push('');
        out.push('-- 合并后实际发出 --');
        out.push(pretty(record.merged));
        out.push('');
    }

    out.push('排查要点：');
    out.push('  · 「合并后实际发出」里没有你在面板里填的东西 ⇒ 合并那一步有问题');
    out.push('  · 有，但模型行为不符 ⇒ 上游不认这个字段名（各家不一样）');
    out.push('  · 停止字段留空 ⇒ 只能靠断开连接中止，部分上游不吃这套');

    const text = out.join('\n');
    setDiagOutput(text);
    log('已导出最近请求体');
    return text;
}

/** 挂到 window，方便不开面板直接调用 */
export function exposeGlobals() {
    globalThis.awDiagnose = diagnose;
    globalThis.awProbe = probe;
    globalThis.awProbeSecret = probeSecret;
    globalThis.awProbeShape = probeShape;
    globalThis.awLastRequests = showLastRequests;
}
