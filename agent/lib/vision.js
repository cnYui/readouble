// OpenAI-compatible chat-completions client for the vision relay configured
// in config/vision.js. Pure helpers plus one async call that receives `fetch`
// as a parameter, so `npm test` can drive it without the AIUI runtime.
//
// The API key lives only in the config object handed in by the caller; it is
// placed in the Authorization header and never echoed into error messages.

import { errorMessage } from './reply.js';

export const DEFAULT_VISION_TIMEOUT_MS = 60000;
export const MAX_HISTORY_MESSAGES = 12;

function trimmed(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function clampMessage(value, limit) {
  const chars = Array.from(String(value));
  return chars.length <= limit ? chars.join('') : chars.slice(0, limit).join('') + '…';
}

// True only when a key, an https base URL, and a model are all present.
export function visionConfigured(config) {
  if (!config || config.enabled === false) return false;
  return trimmed(config.apiKey).length > 0 &&
    /^https:\/\/\S+$/.test(trimmed(config.baseUrl)) &&
    trimmed(config.model).length > 0;
}

export function chatCompletionsUrl(baseUrl) {
  return trimmed(baseUrl).replace(/\/+$/, '') + '/chat/completions';
}

export function buildVisionBody(config, messages) {
  const body = { model: trimmed(config.model), messages, stream: false };
  const effort = trimmed(config.reasoningEffort);
  if (effort) body.reasoning_effort = effort;
  return body;
}

export function buildVisionRequest(config, messages, signal) {
  const timeout = Number.isInteger(config.timeoutMs) && config.timeoutMs > 0 ?
    config.timeoutMs : DEFAULT_VISION_TIMEOUT_MS;
  const init = {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer ' + trimmed(config.apiKey)
    },
    body: JSON.stringify(buildVisionBody(config, messages)),
    timeout
  };
  if (signal) init.signal = signal;
  return { url: chatCompletionsUrl(config.baseUrl), init };
}

export function relayErrorDetail(bodyText) {
  try {
    const data = JSON.parse(bodyText);
    const error = data && data.error;
    if (typeof error === 'string') return clampMessage(error, 80);
    if (error && typeof error.message === 'string') return clampMessage(error.message, 80);
    if (data && typeof data.message === 'string') return clampMessage(data.message, 80);
  } catch (ignored) {
    // Not JSON: fall through to the status summary alone.
  }
  return '';
}

export function describeRelayStatus(status, bodyText) {
  let summary = '中转站返回错误';
  if (status === 401 || status === 403) summary = '中转站拒绝了这个密钥';
  else if (status === 404) summary = '中转站找不到这个模型或地址';
  else if (status === 429) summary = '请求太频繁或额度不足';
  else if (status >= 500) summary = '中转站暂时不可用';
  const detail = relayErrorDetail(bodyText);
  return summary + '（HTTP ' + status + '）' + (detail ? '：' + detail : '');
}

export function parseVisionResponse(data) {
  if (data && data.error) {
    const error = data.error;
    const text = typeof error === 'string' ? error : (error.message || JSON.stringify(error));
    throw new Error('中转站返回错误：' + clampMessage(text, 80));
  }
  const choice = data && Array.isArray(data.choices) ? data.choices[0] : null;
  const content = choice && choice.message ? choice.message.content : null;
  if (typeof content === 'string' && content.trim()) return content;
  if (Array.isArray(content)) {
    const text = content.map((part) => {
      if (typeof part === 'string') return part;
      return part && typeof part.text === 'string' ? part.text : '';
    }).join('');
    if (text.trim()) return text;
  }
  throw new Error('中转站没有返回文字答案');
}

// One non-streaming request. Rejects with a user-facing Chinese message.
export async function callVision(fetchFn, config, messages, signal) {
  if (typeof fetchFn !== 'function') throw new Error('这个环境不支持网络请求');
  const request = buildVisionRequest(config, messages, signal);
  let response;
  try {
    response = await fetchFn(request.url, request.init);
  } catch (error) {
    throw new Error('连不上中转站：' + clampMessage(errorMessage(error), 60));
  }
  const text = await response.text();
  if (!response.ok) throw new Error(describeRelayStatus(response.status, text));
  let data;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new Error('中转站返回的不是 JSON');
  }
  return parseVisionResponse(data);
}

// Keeps the system prompt and the photo turn (so follow-ups still see the
// photo), then the most recent messages.
export function trimHistory(history, limit = MAX_HISTORY_MESSAGES) {
  if (history.length <= limit) return history.slice();
  return history.slice(0, 2).concat(history.slice(history.length - (limit - 2)));
}
