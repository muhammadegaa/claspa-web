// Model pricing table — prompt and completion rates in USD per million tokens.
// Source: OpenRouter model list (manually updated; rates are pass-through from
// providers, no OpenRouter markup per their FAQ).
//
// Used for pre-flight cost estimates. Actual billed cost is always pulled from
// OpenRouter's /generation endpoint post-call and that's what we deduct from
// the user's balance. The estimate is only to decide whether to allow the call.
//
// Default fallback for unlisted models: Sonnet-tier rates (safe over-estimate).

const RATES = {
  // Anthropic
  'anthropic/claude-sonnet-4.6':  { prompt: 3.0,  completion: 15.0 },
  'anthropic/claude-haiku-4.5':   { prompt: 0.8,  completion: 4.0 },
  'anthropic/claude-opus-4.6':    { prompt: 15.0, completion: 75.0 },

  // OpenAI (hypothetical 5.x pricing; update when available on OpenRouter)
  'openai/gpt-5.4-nano':          { prompt: 0.05, completion: 0.4 },
  'openai/gpt-5.4-mini':          { prompt: 0.3,  completion: 1.2 },
  'openai/gpt-5.4':               { prompt: 2.5,  completion: 10.0 },
  'openai/gpt-5.4-pro':           { prompt: 15.0, completion: 75.0 },

  // Google
  'google/gemini-3.1-flash-lite-preview': { prompt: 0.1,  completion: 0.4 },
  'google/gemini-3-flash-preview':        { prompt: 0.3,  completion: 1.2 },
  'google/gemini-3.1-pro-preview':        { prompt: 2.5,  completion: 10.0 },
  'google/gemma-4-31b-it':                { prompt: 0.0,  completion: 0.0 },

  // Qwen
  'qwen/qwen3.5-flash-20260224':  { prompt: 0.05, completion: 0.2 },
  'qwen/qwen3.5-plus-20260216':   { prompt: 0.3,  completion: 1.2 },
  'qwen/qwen3.6-plus':            { prompt: 0.8,  completion: 4.0 },
  'qwen/qwen3.5-397b-a17b':       { prompt: 2.5,  completion: 10.0 },

  // Misc
  'mistralai/mistral-small-2603': { prompt: 0.2,  completion: 0.6 },
  'x-ai/grok-4.20':               { prompt: 3.0,  completion: 15.0 },
  'z-ai/glm-5.1':                 { prompt: 0.4,  completion: 1.2 },
  'z-ai/glm-4.7-flash':           { prompt: 0.05, completion: 0.2 },
};

// Safe default for models we haven't catalogued yet. Over-estimates so we
// never under-charge; user can complain and we can refund.
const DEFAULT_RATES = { prompt: 3.0, completion: 15.0 };

function getRates(model) {
  return RATES[model] || DEFAULT_RATES;
}

// Rough token estimate from text (OpenAI's ~4 chars/token is close enough for
// cost estimation purposes; post-call we use actual token counts).
function estimateTokensFromText(text) {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

function estimateTokensFromMessages(messages) {
  let total = 0;
  for (const m of messages || []) {
    if (typeof m.content === 'string') {
      total += estimateTokensFromText(m.content);
    } else if (Array.isArray(m.content)) {
      for (const part of m.content) {
        if (part.type === 'text') total += estimateTokensFromText(part.text);
      }
    }
    total += 4; // role tokens + framing overhead
  }
  return total;
}

// Estimate the max possible cost of a call in cents (integer).
// Includes a small safety buffer to avoid edge-case under-reservations.
function estimateMaxCostCents(model, messages, maxOutputTokens) {
  const rates = getRates(model);
  const inputTokens = estimateTokensFromMessages(messages);
  const outputTokens = maxOutputTokens || 1600;
  // $/M tokens → cents per token: rate / 1_000_000 * 100 = rate / 10_000
  const costDollars = (inputTokens * rates.prompt + outputTokens * rates.completion) / 1_000_000;
  // 5% buffer for tokenization differences
  return Math.ceil(costDollars * 100 * 1.05);
}

// Actual cost in cents from OpenRouter's /generation endpoint response.
function actualCostCents(generationData) {
  const totalCost = parseFloat(generationData?.total_cost || 0);
  return Math.ceil(totalCost * 100);
}

module.exports = {
  getRates,
  estimateTokensFromMessages,
  estimateMaxCostCents,
  actualCostCents,
};
