/**
 * Agent Writer - 自检与连通性探测
 *
 * 为什么需要这个：酒馆后端在平板上，改完代码没法开 devtools 慢慢查。
 * 出问题时点一下「运行自检」，把文本框里的结果截图发出来即可。
 *
 * 同时挂到 window.awDiagnose() / window.awProbe()，平板外接键盘时可直接调。
 */

import { log, setDiagOutput, VERSION } from './ui/panel.js?v=0.8.8';
import { describeMenuContainer, isMenuItemMounted } from './ui/menu.js?v=0.8.8';

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
    out.push(line('扩展版本', VERSION ?? '(未导出)'));
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
 * 数据来自 CHAT_COMPLETION_SETTINGS_READY 事件里那一份 generate_data
 * （注入之后的快照），不是我以为发了什么。
 *
 * 三种结果对应三种病因：
 *   · 显示「没认领到」     ⇒ 槽位标记没进 messages，或事件根本没发
 *   · 认领到了但字段是空的 ⇒ 面板里那个阶段没填附加参数
 *   · 字段在、模型行为不符 ⇒ 上游不认这个字段名（各家写法不一样）
 */
export async function showLastRequests() {
    const out = [];

    let snapshot;
    try {
        const mod = await import('./pipeline.js?v=0.8.8');
        snapshot = mod.getLastRequests?.();
    } catch (e) {
        setDiagOutput(`读取失败: ${e?.message}`);
        return null;
    }

    if (!snapshot) {
        setDiagOutput('读不到最近请求记录（pipeline.getLastRequests 不可用）。');
        return null;
    }

    const pretty = (v) => (v == null ? '(无)' : JSON.stringify(v, null, 2));

    for (const stage of ['critic', 'final']) {
        const record = snapshot[stage];
        out.push(`=== ${stage === 'critic' ? '② 校验' : '③ 改写'} ===`);
        if (!record) {
            out.push('（还没跑过这个阶段）');
            out.push('');
            continue;
        }

        if (record.claimed === false) {
            out.push('✘ 没认领到这次请求');
            out.push(`  ${record.note ?? ''}`);
            out.push('');
            continue;
        }

        out.push('✔ 已认领并注入');
        out.push('-- 本次附加的字段 --');
        out.push(pretty(record.applied));
        out.push('');
        out.push('-- 注入后请求体顶层字段（messages 省略）--');
        out.push(pretty(record.body));
        out.push('');
    }

    out.push('排查要点：');
    out.push('  · 「没认领到」 ⇒ 附加参数根本没发出去，不是上游不认');
    out.push('  · 「本次附加的字段」是 {} ⇒ 面板里那个阶段没填附加参数');
    out.push('  · 字段在、模型行为不符 ⇒ 上游不认这个字段名（各家写法不一样）');
    out.push('  · reasoning_effort 只调「想多久」，关思考要用 thinking');

    const text = out.join('\n');
    setDiagOutput(text);
    log('已导出最近请求体');
    return text;
}

/**
 * 换渠道专项诊断：把「面板里填的明文密钥」按**两种请求形状**送给上游。
 *
 * 背景：同一个 key 在别的扩展里能通，在本扩展里 401。既然直连探针已经
 * 证明 key 本身没问题，那问题就在「酒馆怎么把这个凭据送出去」这一步。
 * 这一步有两条不同的路，必须分开测：
 *
 *   形状 A —— 扩展现在用的：custom_api.key
 *     TavernHelper 的 resolveProxyPreset / applyCustomApiOverrides 会把它
 *     落到 reverse_proxy + proxy_password 上，由酒馆按厂商分支去设请求头。
 *
 *   形状 B —— 织幕（st-end-component-generator）用的：顶层 custom_include_headers
 *     直接给酒馆一份「要附加哪些请求头」的 YAML，酒馆只负责合并。
 *     这条路对请求头的控制是精确的，不依赖厂商分支。
 *
 * 两个形状都不通 ⇒ 端点在酒馆这条链路上确实不接受这个密钥；
 * 形状 B 通而 A 不通 ⇒ 就是 custom_api.key 这条路的解析出了问题，改用 B。
 *
 * @param {string} [apiUrl]
 * @param {string} [key]
 * @param {string} [model]
 * @param {boolean} [useStream]
 */
export async function probeChannel(apiUrl, key, model, useStream = false) {
    const context = ctx();
    if (!context) {
        setDiagOutput('getContext() 不可用。');
        return null;
    }

    const svc = context.ConnectionManagerRequestService ?? globalThis.ConnectionManagerRequestService;
    const profile = (() => {
        try {
            return svc?.getProfile?.(getDiagProfileId(context));
        } catch { return null; }
    })();

    // 地址/模型优先用面板里填的 —— 这个诊断是要验证「扩展配的那套」，
    // 不是验证连接配置里那套。
    const url = String(apiUrl ?? '').trim() || profile?.['api-url'] || '';
    const useModel = String(model ?? '').trim() || profile?.model || '';
    const plainKey = String(key ?? '').trim();

    const out = [];
    const say = (s) => { out.push(s); setDiagOutput(out.join('\n')); };

    const mask = (v) => {
        const s = String(v ?? '');
        if (!s) return '(空)';
        if (s.length <= 12) return `${s.slice(0, 3)}…${s.slice(-2)}（${s.length} 字符）`;
        return `${s.slice(0, 6)}…${s.slice(-4)}（${s.length} 字符）`;
    };

    const hash = async (v) => {
        try {
            const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(v)));
            return [...new Uint8Array(buf)].slice(0, 4).map((b) => b.toString(16).padStart(2, '0')).join('');
        } catch {
            return '(算不出)';
        }
    };

    say('=== 面板填的渠道 ===');
    say(`API 地址           ${url || '(空 ← 空的话根本不会走换渠道，会掉回当前连接)'}`);
    say(`模型               ${useModel || '(空)'}`);
    say(`API 密钥           ${mask(plainKey)}`);
    say(`  指纹             ${await hash(plainKey)}`);
    say(`流式               ${useStream ? '开（Cline 必须开：非流式会被包一层 data）' : '关'}`);
    say('');
    if (!url || !plainKey) {
        say('⚠ 地址或密钥是空的。这两个都填上才有意义 ——');
        say('  密钥为空时酒馆会退回「当前连接」的凭据，于是拿别的密钥去打 Cline，必然 401。');
        say('');
    }

    const messages = [{ role: 'user', content: 'Say OK' }];

    async function attempt(label, body, note = '') {
        say(`${label}`);
        if (note) say(`   ${note}`);
        try {
            const resp = await fetch('/api/backends/chat-completions/generate', {
                method: 'POST',
                headers: context.getRequestHeaders?.() ?? { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            const text = await resp.text();

            // 开了流式时返回的是 SSE，不是 JSON —— 别拿 JSON.parse 去判成败，
            // 否则「成功但正文在 SSE 里」会被误报成失败（这里踩过一次）。
            if (body.stream && resp.ok && /^\s*data:/m.test(text)) {
                const lines = text.split('\n').filter((l) => l.startsWith('data:'));
                const done = lines.some((l) => l.includes('[DONE]'));
                let chars = 0;
                for (const line of lines) {
                    if (line.includes('[DONE]')) continue;
                    let j = null;
                    try { j = JSON.parse(line.slice(5).trim()); } catch { continue; }
                    const innerD = j?.data ?? j;
                    chars += String(innerD?.choices?.[0]?.delta?.content ?? '').length;
                }
                say(`   ✔ HTTP ${resp.status}  流式通：分片 ${lines.length} 个，正文 ${chars} 字${done ? '，收到 [DONE]' : ''}`);
                return true;
            }

            let parsed = null;
            try { parsed = JSON.parse(text); } catch { /* 非 JSON */ }

            if (parsed?.error) {
                const msg = typeof parsed.error === 'object'
                    ? (parsed.error.message ?? JSON.stringify(parsed.error))
                    : String(parsed.error);
                say(`   ✘ HTTP ${resp.status}  ${msg}`);
                return false;
            }
            // 注意 Cline 非流式会把标准结构包一层 data，这里两种都认
            const inner = parsed?.data ?? parsed;
            const content = inner?.choices?.[0]?.message?.content
                ?? inner?.choices?.[0]?.text
                ?? parsed?.content
                ?? '';
            if (typeof content === 'string' && content.trim()) {
                say(`   ✔ HTTP ${resp.status}  返回: ${JSON.stringify(content.slice(0, 60))}`);
                return true;
            }
            say(`   △ HTTP ${resp.status} 通了，但正文为空`);
            if (parsed?.data && !parsed?.choices) {
                say('     （响应被包了一层 data —— 这是 Cline 非流式的特征，换流式就正常）');
            }
            if (!parsed) say(`     （响应不是 JSON，前 120 字：${text.slice(0, 120)}）`);
            return false;
        } catch (e) {
            say(`   抛错: ${e?.message}`);
            return false;
        } finally {
            say('');
        }
    }

    const base = {
        stream: useStream,
        messages,
        model: useModel,
        chat_completion_source: 'custom',
        custom_url: url,
        max_tokens: 32,
        use_sysprompt: true,
    };

    const okA = await attempt(
        '形状 A —— 旧做法：custom_api.key（TavernHelper 会拼一份 Authorization）',
        { ...base, key: plainKey },
    );

    const okB = await attempt(
        '形状 B —— 现在用的：顶层 custom_include_headers 直接指定 Authorization',
        { ...base, custom_include_headers: `"Authorization": "Bearer ${plainKey}"` },
    );

    // 顺便看看酒馆里那个密钥是不是同一个（只比指纹）
    let serverKey = null;
    try {
        const resp = await fetch('/api/secrets/find', {
            method: 'POST',
            headers: context.getRequestHeaders?.() ?? { 'Content-Type': 'application/json' },
            body: JSON.stringify({ key: 'api_key_custom' }),
        });
        if (resp.ok) serverKey = (await resp.json())?.value ?? null;
    } catch { /* 读不到就算了 */ }
    if (serverKey) {
        say(`酒馆里存的 api_key_custom   ${mask(serverKey)}  指纹 ${await hash(serverKey)}`);
        say(`⇒ 与面板里填的${serverKey === plainKey ? '一致' : '**不一致** ← 若形状 A 失败而这条能通，就是它'}`);
        say('');
        if (serverKey !== plainKey) {
            await attempt('形状 A′ —— 改用酒馆里存的密钥值', { ...base, key: serverKey });
        }
    }

    say('=== 判断 ===');
    say('形状 A 是 0.8.8 之前的旧做法，形状 B 是现在用的 —— 所以「A 不通、B 通」是预期结果。');
    say('');
    if (okB) {
        if (okA) {
            say('✔ 两种形状都通。B 是现在用的那条，配置没问题。');
        } else {
            say('✔ 形状 B 通 —— 这正是扩展现在用的那条路，配置正确。');
            say('  （形状 A 不通是正常的，它已经不用了，列在这里只为了对照。）');
        }
        say('');
        say('下一步不是继续看这个诊断，而是看扩展**实发**的那次请求：');
        say('  跑一次 ②，再点「查看实际请求体」，确认 custom_include_headers 带上了 Authorization。');
    } else if (okA) {
        say('△ 形状 A 通、形状 B 不通 —— 少见。把结果发我。');
    } else {
        say('✘ 形状 B 也不通 ⇒ 酒馆这条链路确实不接受这个密钥。');
        say('  但如果直连探针（probe-endpoint.mjs）同一个 key 是通的，');
        say('  那就说明差别在酒馆服务端转发这一层，需要看酒馆后台日志里真正的请求。');
    }
    log('换渠道诊断完成');
    return out.join('\n');
}

/**
 * 显示扩展**实际会构造出来的** custom_api —— 不发任何请求。
 *
 * 为什么需要它：换渠道诊断测的是「酒馆接受哪种形状」，那是关于**酒馆**的结论；
 * 这个函数回答的是另一个问题 ——「**扩展自己**发出去的是哪一种」。
 * 401 那轮排查里这两个问题被混在一起，绕了很久。
 *
 * 用的是 tavern.buildCustomApi，和真正发请求时同一个函数，
 * 所以这里显示的就是实发内容，不存在「文档和实现走偏」的可能。
 */
export async function dumpChannelPlan(settings) {
    const out = [];

    let buildCustomApi;
    try {
        const mod = await import('./tavern.js?v=0.8.8');
        buildCustomApi = mod.buildCustomApi;
    } catch (e) {
        setDiagOutput(`读取失败: ${e?.message}`);
        return null;
    }
    if (typeof buildCustomApi !== 'function') {
        setDiagOutput('tavern.buildCustomApi 不可用（装的可能是旧版）。');
        return null;
    }

    const mask = (v) => {
        const s = String(v ?? '');
        if (!s) return '(空)';
        return s.length <= 12 ? `${s.slice(0, 3)}…${s.slice(-2)}` : `${s.slice(0, 6)}…${s.slice(-4)}`;
    };

    /** 密钥不能明文打到面板上 */
    const redact = (api) => {
        const copy = JSON.parse(JSON.stringify(api));
        if (copy.custom_include_headers?.Authorization) {
            const raw = String(copy.custom_include_headers.Authorization);
            copy.custom_include_headers.Authorization =
                `${mask(raw.replace(/^Bearer\s+/i, ''))}${/^Bearer\s+/i.test(raw) ? '  ⚠ 带 Bearer 前缀（会被拼成双前缀）' : '（裸 key，正确）'}`;
        }
        return copy;
    };

    out.push('=== 扩展实际会构造的 custom_api（不发请求）===');
    out.push('');

    for (const stage of ['critic', 'final']) {
        const label = stage === 'critic' ? '② 校验' : '③ 改写';
        const s = settings?.[stage];
        out.push(`--- ${label} ---`);
        if (!s) {
            out.push('（读不到该阶段设置）');
            out.push('');
            continue;
        }

        const api = buildCustomApi(s);
        out.push(`走哪条路: ${s.apiUrl ? '直接地址（形状 B）' : (s.proxyPreset ? '酒馆代理预设' : '当前连接')}`);
        out.push('custom_api = ' + JSON.stringify(redact(api), null, 2));
        out.push('');

        // 思考开关不在这里 —— 它走 CHAT_COMPLETION_SETTINGS_READY 事件注入，
        // 是另一条路。不显示的话，用户没法从这个 dump 确认自己的思考设置。
        const fields = s.bodyFields ?? {};
        const hasThinking = Object.prototype.hasOwnProperty.call(fields, 'thinking');
        out.push('附加请求体字段（思考开关走这条，不在上面的 custom_api 里）:');
        out.push('  ' + (Object.keys(fields).length ? JSON.stringify(fields) : '{}  ← 空'));
        if (hasThinking) {
            out.push(`  ⇒ thinking.type = ${JSON.stringify(fields.thinking?.type)}`);
        } else {
            out.push('  ⚠ 没设 thinking，上游默认值会生效 ——');
            out.push('     DeepSeek 官方 API 默认**开**思考，要关就得显式写');
            out.push('     {"thinking":{"type":"disabled"}}。');
            out.push('     Cline 则是怎么写都关不掉（实测它静默忽略这个字段）。');
        }
        out.push('');

        if (s.apiUrl && !s.apiKey) {
            out.push('⚠ 填了地址但没填密钥 —— 酒馆会退回「当前连接」的凭据，');
            out.push('  拿别的密钥去打这个端点，必然认证失败。');
            out.push('');
        }
        if (api.custom_include_headers?.Authorization?.startsWith?.('Bearer')) {
            out.push('⚠ Authorization 值里带了 Bearer 前缀，TavernHelper 会再加一次，');
            out.push('  拼成 "Bearer Bearer ..."。值应该只放裸 key。');
            out.push('');
        }
        if (api.key !== undefined) {
            out.push('⚠ 仍在传 custom_api.key —— 0.8.8 起应该走 custom_include_headers。');
            out.push('');
        }
    }

    out.push('怎么看：');
    out.push('  · custom_include_headers.Authorization 应该是「裸 key」');
    out.push('  · 不该出现 custom_api.key');
    out.push('  · 地址应该是 base url，/chat/completions 由酒馆补');
    out.push('  · 思考开关在「附加请求体字段」那一节，不在 custom_api 里');

    const text = out.join('\n');
    setDiagOutput(text);
    log('已导出扩展实际构造的 custom_api');
    return text;
}

/**
 * 用**面板里真实的参数**复现一次 ② 的请求。
 *
 * 为什么需要它：`probeChannel` 用的是它自己编的参数（temperature 0.3、
 * max_tokens 32/100），而那和实跑的值可能差很远（实测面板里是 0.9 / 50000）。
 * 拿近似值测出来的「通」，不能证明实跑会通 —— 上游完全可能因为
 * max_tokens 超限之类的理由拒绝，而各家对这类拒绝的报错文案又很不一样。
 *
 * 所以这里严格照抄实跑：同一个 custom_api、同一组 bodyFields、同一个 useStream。
 *
 * @param {object} settings 完整设置（含 critic / final）
 */
export async function probeExact(settings) {
    const context = ctx();
    if (!context) {
        setDiagOutput('getContext() 不可用。');
        return null;
    }

    const out = [];
    const say = (s) => { out.push(s); setDiagOutput(out.join('\n')); };

    const mask = (v) => {
        const s = String(v ?? '');
        if (!s) return '(空)';
        return s.length <= 12 ? `${s.slice(0, 3)}…${s.slice(-2)}（${s.length}）` : `${s.slice(0, 6)}…${s.slice(-4)}（${s.length}）`;
    };

    let buildCustomApi;
    try {
        ({ buildCustomApi } = await import('./tavern.js?v=0.8.8'));
    } catch (e) {
        setDiagOutput(`读取失败: ${e?.message}`);
        return null;
    }

    const stage = settings?.critic;
    if (!stage) {
        setDiagOutput('读不到 ② 的设置。');
        return null;
    }

    const customApi = buildCustomApi(stage);
    const bodyFields = stage.bodyFields ?? {};
    const useStream = stage.useStream !== false;

    say('=== 用真实参数复现 ② 的请求 ===');
    say('');
    say(`API 地址     ${customApi.apiurl ?? '(用当前连接)'}`);
    say(`模型         ${customApi.model ?? '(不覆盖)'}`);
    say(`密钥         ${mask(stage.apiKey)}`);
    say(`temperature  ${customApi.temperature ?? '(不传)'}`);
    say(`max_tokens   ${customApi.max_tokens ?? '(不传)'}`);
    say(`流式         ${useStream ? '开' : '关'}`);
    say(`附加字段     ${Object.keys(bodyFields).length ? JSON.stringify(bodyFields) : '{}（空）'}`);
    say('');

    // 严格照抄 buildCustomApi 的产出 + 附加字段，只替掉 messages
    const body = {
        ...customApi,
        messages: [{ role: 'user', content: 'Say OK' }],
        stream: useStream,
        chat_completion_source: 'custom',
        custom_url: customApi.apiurl,
        use_sysprompt: false,
        ...bodyFields,
    };
    // key 已经在 custom_include_headers 里了，这里绝不能带 —— 带了就退回旧做法
    delete body.key;

    say('发出的 body 顶层字段：');
    say('  ' + Object.keys(body).join(', '));
    say('');

    const exactReport = await sendAndReport(context, body, say, out);

    // 只有真的复现了失败才继续二分 —— 没失败说明触发条件还没找到。
    if (verdictOf(exactReport) !== 'fail') {
        say('=== 判断 ===');
        say('  · 用真实参数这里是通的 ⇒ 差别在「走不走酒馆助手的 generate()」，');
        say('    下一步看「查看实际请求体」里实发的那份 generate_data。');
        const okText = out.join('\n');
        setDiagOutput(okText);
        log('真实参数复现完成（通过）');
        return okText;
    }

    say('=== 复现成功，继续二分 ===');
    say('每次只改一处，看哪个字段是触发点。');
    say('');

    const variants = [
        ['① 去掉 apiurl（诊断自己不发这个字段）', (b) => { delete b.apiurl; }],
        ['② 去掉 source', (b) => { delete b.source; }],
        ['③ 去掉 chat_completion_source', (b) => { delete b.chat_completion_source; }],
        ['④ 去掉 use_sysprompt', (b) => { delete b.use_sysprompt; }],
        ['⑤ max_tokens 降到 8192', (b) => { b.max_tokens = 8192; }],
        ['⑥ max_tokens 降到 1024', (b) => { b.max_tokens = 1024; }],
        ['⑦ temperature 改成 0.3', (b) => { b.temperature = 0.3; }],
        ['⑧ 只留 model + messages + stream + custom_include_headers', (b) => {
            for (const k of Object.keys(b)) {
                if (!['model', 'messages', 'stream', 'custom_include_headers'].includes(k)) delete b[k];
            }
        }],
    ];

    let found = null;
    for (const [label, mutate] of variants) {
        const v = JSON.parse(JSON.stringify(body));
        mutate(v);
        say(`--- ${label}`);
        const report = await sendAndReport(context, v, say, out);
        if (verdictOf(report) === 'ok') {
            found = label;
            say(`⇒ 「${label}」让它通了 —— 触发点就在这一项改掉的字段上。`);
            break;
        }
    }

    say('');
    say('=== 判断 ===');
    if (found) {
        say(`触发点在「${found}」改掉的字段上。`);
    } else {
        say('连最干净的 ⑧ 也失败 ⇒ 不是字段问题，是这条链路或这个 key 此刻的状态。');
        say('拿同一个 key 跑 agent-writer-tools/probe-endpoint.mjs 对照：');
        say('  直连通、这里不通 ⇒ 问题在酒馆后端这一层');
        say('  直连也不通       ⇒ key 的问题（额度用尽 / 已失效）');
    }

    const text = out.join('\n');
    setDiagOutput(text);
    log('真实参数复现 + 二分完成');
    return text;
}

/**
 * 把 body 发给酒馆后端并如实报告结果。
 *
 * 之所以要「如实」：上游的拒绝理由和 HTTP 状态码经常对不上
 * （Cline 就是撞额度也回 401），所以状态码和响应体必须都打出来，
 * 不能只凭状态码下结论。
 */
/**
 * 把 body 发给酒馆后端并如实报告结果。
 *
 * 之所以要「如实」：上游的拒绝理由和 HTTP 状态码经常对不上
 * （Cline 就是撞额度也回 401），所以状态码和响应体必须都打出来，
 * 不能只凭状态码下结论。
 *
 * @returns {Promise<string>} 原始响应文本（调用方据此判断通没通）
 */
async function sendAndReport(context, body, say, out) {
    try {
        const resp = await fetch('/api/backends/chat-completions/generate', {
            method: 'POST',
            headers: context.getRequestHeaders?.() ?? { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        const text = await resp.text();
        say(`HTTP ${resp.status}`);
        say('');

        let parsed = null;
        try { parsed = JSON.parse(text); } catch { /* 可能是 SSE 或纯文本 */ }

        if (parsed?.error) {
            const msg = typeof parsed.error === 'object'
                ? (parsed.error.message ?? JSON.stringify(parsed.error))
                : String(parsed.error);
            say('✘ 上游/酒馆报错：');
            say('  ' + msg);
        } else if (/^\s*data:/m.test(text)) {
            const lines = text.split('\n').filter((l) => l.startsWith('data:'));
            const done = lines.some((l) => l.includes('[DONE]'));
            let chars = 0;
            for (const line of lines) {
                if (line.includes('[DONE]')) continue;
                let j = null;
                try { j = JSON.parse(line.slice(5).trim()); } catch { continue; }
                chars += String((j?.data ?? j)?.choices?.[0]?.delta?.content ?? '').length;
            }
            say(`✔ 流式成功：分片 ${lines.length} 个，正文 ${chars} 字${done ? '，收到 [DONE]' : ''}`);
        } else if (parsed) {
            const inner = parsed?.data ?? parsed;
            const content = inner?.choices?.[0]?.message?.content ?? inner?.choices?.[0]?.text ?? parsed?.content ?? '';
            if (String(content).trim()) {
                say(`✔ 成功：${JSON.stringify(String(content).slice(0, 80))}`);
            } else {
                say('△ 通了但没正文。原始响应前 300 字：');
                say('  ' + text.slice(0, 300));
            }
        } else {
            say('响应不是 JSON，前 300 字：');
            say('  ' + text.slice(0, 300));
        }
        say('');
        return text;
    } catch (e) {
        say(`抛错: ${e?.message}${e?.cause ? ` / cause: ${e?.cause?.message ?? e.cause}` : ''}`);
        say('');
        return `抛错: ${e?.message}`;
    }
}

/** 从 sendAndReport 的输出里判断这次是通还是不通 */
function verdictOf(reportText) {
    if (/✔/.test(reportText)) return 'ok';
    if (/✘/.test(reportText)) return 'fail';
    return 'unknown';
}

/** 挂到 window，方便不开面板直接调用 */
export function exposeGlobals() {
    globalThis.awDiagnose = diagnose;
    globalThis.awProbe = probe;
    globalThis.awProbeSecret = probeSecret;
    globalThis.awProbeShape = probeShape;
    globalThis.awLastRequests = showLastRequests;
    globalThis.awProbeChannel = probeChannel;
    globalThis.awChannelPlan = dumpChannelPlan;
    globalThis.awProbeExact = probeExact;
}
