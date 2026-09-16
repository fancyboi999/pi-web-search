import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isTransientSearchError, readWebSearchModelConfig, getWebSearchModelCandidates } from '../src/utils.ts';
import { webSearch } from '../src/web_search.ts';
import { writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('isTransientSearchError identifies transient and recoverable failures', () => {
    assert.equal(isTransientSearchError(new Error('Our servers are currently overloaded. Please try again later.')), true);
    assert.equal(isTransientSearchError(new Error('An error occurred while processing your request. You can retry your request, or contact us through our help center at help.openai.com if the error persists. Please include the request ID 81a89784-3705-4bbc-b8d1-69b609b6d44e in your message.')), true);
    assert.equal(isTransientSearchError(new Error('Rate limit exceeded: 429')), true);
    assert.equal(isTransientSearchError(new Error('HTTP 503 Service Unavailable')), true);
    assert.equal(isTransientSearchError(new Error('504 Gateway Timeout')), true);
    assert.equal(isTransientSearchError(new Error('fetch failed: ECONNRESET')), true);
    assert.equal(isTransientSearchError('Overloaded'), true);

    // Non-transient errors should not match
    assert.equal(isTransientSearchError(new Error('Invalid API Key')), false);
    assert.equal(isTransientSearchError(new Error('Invalid JSON input')), false);
    assert.equal(isTransientSearchError(new Error('Model not found')), false);
});

test('readWebSearchModelConfig parses single and array fallback declarations', () => {
    const tmpPath = join(tmpdir(), `test-web-search-${Date.now()}.json`);
    process.env.PI_WEB_SEARCH_CONFIG = tmpPath;

    try {
        // Case 1: Single fallback object
        writeFileSync(tmpPath, JSON.stringify({
            provider: 'openai-codex',
            model: 'gpt-5.6-luna',
            fallback: {
                provider: 'google-generative-ai',
                model: 'gemini-2.5-flash'
            }
        }));

        const cfg1 = readWebSearchModelConfig();
        assert.equal(cfg1.status, 'configured');
        assert.equal(cfg1.provider, 'openai-codex');
        assert.equal(cfg1.modelId, 'gpt-5.6-luna');
        assert.equal(cfg1.fallbacks.length, 1);
        assert.deepEqual(cfg1.fallbacks[0], { provider: 'google-generative-ai', modelId: 'gemini-2.5-flash' });

        // Case 2: Array of fallbacks
        writeFileSync(tmpPath, JSON.stringify({
            provider: 'openai-codex',
            model: 'gpt-5.6-luna',
            fallback: [
                { provider: 'google-generative-ai', model: 'gemini-2.5-flash' },
                { provider: 'anthropic', model: 'claude-3-7-sonnet-20250219' }
            ]
        }));

        const cfg2 = readWebSearchModelConfig();
        assert.equal(cfg2.fallbacks.length, 2);
        assert.equal(cfg2.fallbacks[1].provider, 'anthropic');
    } finally {
        try { unlinkSync(tmpPath); } catch {}
        delete process.env.PI_WEB_SEARCH_CONFIG;
    }
});

test('webSearch falls over to fallback model when primary encounters overloaded error', async () => {
    const tmpPath = join(tmpdir(), `test-web-search-failover-${Date.now()}.json`);
    process.env.PI_WEB_SEARCH_CONFIG = tmpPath;

    writeFileSync(tmpPath, JSON.stringify({
        provider: 'mock-primary',
        model: 'primary-model',
        fallback: {
            provider: 'mock-fallback',
            model: 'fallback-model'
        }
    }));

    const mockPrimary = {
        id: 'primary-model',
        provider: 'mock-primary',
        api: 'openai-responses',
        baseUrl: 'https://primary.example/v1'
    };

    const mockFallback = {
        id: 'fallback-model',
        provider: 'mock-fallback',
        api: 'google-generative-ai',
        baseUrl: 'https://fallback.example/v1'
    };

    const mockCtx = {
        modelRegistry: {
            find: (provider, id) => {
                if (provider === 'mock-primary' && id === 'primary-model') return mockPrimary;
                if (provider === 'mock-fallback' && id === 'fallback-model') return mockFallback;
                return undefined;
            },
            getApiKeyAndHeaders: async (model) => ({ ok: true, apiKey: 'test-key' })
        }
    };

    const previousFetch = globalThis.fetch;
    let primaryCalled = false;
    let fallbackCalled = false;

    globalThis.fetch = async (url) => {
        if (String(url).includes('primary.example')) {
            primaryCalled = true;
            return new Response('{"error":{"message":"Our servers are currently overloaded. Please try again later."}}', {
                status: 503,
                headers: { 'Content-Type': 'application/json' }
            });
        }
        if (String(url).includes('fallback.example')) {
            fallbackCalled = true;
            const sse = [
                'data: {"candidates":[{"content":{"parts":[{"text":"Answer from fallback search"}]},"groundingMetadata":{"groundingChunks":[{"web":{"title":"Fallback Source","uri":"https://fallback.example/source"}}]}}]}',
                '',
                'data: [DONE]',
                ''
            ].join('\n');
            return new Response(sse, {
                status: 200,
                headers: { 'Content-Type': 'text/event-stream' }
            });
        }
        throw new Error('Unexpected URL: ' + url);
    };

    try {
        const updateMessages = [];
        const result = await webSearch(
            'call-1',
            { query: 'test query' },
            new AbortController().signal,
            (update) => {
                if (update.content?.[0]?.text) updateMessages.push(update.content[0].text);
            },
            mockCtx
        );

        assert.equal(primaryCalled, true, 'Primary model must be attempted first');
        assert.equal(fallbackCalled, true, 'Fallback model must be called upon primary transient error');
        assert.equal(result.details.fallbackUsed, true, 'Result details must record fallbackUsed: true');
        assert.equal(result.details.model, 'fallback-model');
        assert.match(result.content[0].text, /Answer from fallback search/);
        assert.ok(updateMessages.some(m => m.includes('Retrying with fallback')), 'Should notify user of fallback');
    } finally {
        globalThis.fetch = previousFetch;
        try { unlinkSync(tmpPath); } catch {}
        delete process.env.PI_WEB_SEARCH_CONFIG;
    }
});

test('webSearch fails fast without fallback on non-transient errors', async () => {
    const tmpPath = join(tmpdir(), `test-web-search-notransient-${Date.now()}.json`);
    process.env.PI_WEB_SEARCH_CONFIG = tmpPath;

    writeFileSync(tmpPath, JSON.stringify({
        provider: 'mock-primary',
        model: 'primary-model',
        fallback: {
            provider: 'mock-fallback',
            model: 'fallback-model'
        }
    }));

    const mockPrimary = {
        id: 'primary-model',
        provider: 'mock-primary',
        api: 'openai-responses',
        baseUrl: 'https://primary.example/v1'
    };

    const mockFallback = {
        id: 'fallback-model',
        provider: 'mock-fallback',
        api: 'google-generative-ai',
        baseUrl: 'https://fallback.example/v1'
    };

    const mockCtx = {
        modelRegistry: {
            find: (provider, id) => {
                if (provider === 'mock-primary') return mockPrimary;
                if (provider === 'mock-fallback') return mockFallback;
                return undefined;
            },
            getApiKeyAndHeaders: async () => ({ ok: true, apiKey: 'test-key' })
        }
    };

    const previousFetch = globalThis.fetch;
    let fallbackCalled = false;

    globalThis.fetch = async (url) => {
        if (String(url).includes('primary.example')) {
            return new Response('{"error":{"message":"Invalid API Key provided"}}', {
                status: 401,
                headers: { 'Content-Type': 'application/json' }
            });
        }
        if (String(url).includes('fallback.example')) {
            fallbackCalled = true;
            return new Response('ok');
        }
    };

    try {
        const result = await webSearch(
            'call-2',
            { query: 'test query' },
            new AbortController().signal,
            undefined,
            mockCtx
        );

        assert.equal(fallbackCalled, false, 'Non-transient error (401 invalid key) must NOT trigger fallback');
        assert.ok(result.details?.error, 'Should return errorResult directly');
    } finally {
        globalThis.fetch = previousFetch;
        try { unlinkSync(tmpPath); } catch {}
        delete process.env.PI_WEB_SEARCH_CONFIG;
    }
});
