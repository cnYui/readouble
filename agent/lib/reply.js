// Pure logic for the ReaDouble explain Page: input normalization, prompt
// building, reply parsing, follow-up command classification, and photo
// encoding. No runtime globals are touched here so `npm test` can cover it.

export const MAX_QUESTION_LENGTH = 200;
export const DEFAULT_QUESTION = '解释我正在看的这一段';
export const TASKS = ['explain', 'translate', 'summarize'];
export const MAX_SPOKEN_LENGTH = 240;
export const MAX_TRANSCRIPT_LENGTH = 400;

// A model that cannot see the attached photo is told to answer with this
// token instead of inventing a passage (the Studio default model did exactly
// that on 2026-09-11: a poster photo came back as a Transformer paragraph).
export const NO_IMAGE_TOKEN = 'NO_IMAGE';

export function isNoImageReply(text) {
  const cleaned = normalizeText(text).replace(/[。.！!\s]+$/, '');
  return cleaned === NO_IMAGE_TOKEN || cleaned.indexOf(NO_IMAGE_TOKEN) === 0;
}

export const SYSTEM_PROMPT = [
  '你是「读伴」，陪用户读英文论文的助手，运行在 Rokid 眼镜上。',
  '用户会把眼镜对准论文拍照，照片就是用户此刻正在看的页面。',
  '规则：',
  '0. 用户说附上了照片时，先确认你真的看到了这张照片：看不到照片或看不清上面的文字，只输出 ' + NO_IMAGE_TOKEN + ' 这一个词，绝对不要凭记忆编造原文。用户是念出文字而不是拍照时，忽略这一条。',
  '1. 先找到与用户问题最相关的段落、公式或图表；用户没有指明时，解读照片中央最主要的段落。',
  '2. 第一次回答严格按三段输出，标题原样保留，每段各占一行：',
  '【原文】不超过两句话的关键原文摘录（英文原样，公式用文字描述）',
  '【解读】用中文说明这段在讲什么、为什么重要，120 字以内，口语化、适合朗读',
  '【术语】最多 3 个关键术语，每个一行，格式“术语：一句话解释”；没有就写“无”',
  '3. 照片模糊、太远或没有可读文字时不要编造，只输出【解读】说明看不清，并建议靠近或对准段落。',
  '4. 用户追问时直接回答，不再使用三段格式，80 字以内。',
  '5. 回答语言跟随用户提问的语言，默认中文。'
].join('\n');

const SECTION_MARKERS = {
  excerpt: '【原文】',
  explanation: '【解读】',
  terms: '【术语】'
};

export function normalizeText(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/\r\n?/g, '\n').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

function unicodeLength(value) {
  return Array.from(value).length;
}

function clampUnicode(value, limit) {
  const chars = Array.from(value);
  return chars.length <= limit ? value : chars.slice(0, limit).join('');
}

// Query from the host conversation: { question?: string, task?: enum }.
// Invalid shapes never block the Page; they fall back to the default question.
export function normalizeInput(query) {
  const input = query === undefined || query === null ? {} : query;
  if (typeof input !== 'object' || Array.isArray(input)) {
    return { question: DEFAULT_QUESTION, task: 'explain', valid: false };
  }
  let valid = true;
  let question = normalizeText(input.question);
  if (input.question !== undefined && typeof input.question !== 'string') valid = false;
  if (unicodeLength(question) > MAX_QUESTION_LENGTH) {
    question = clampUnicode(question, MAX_QUESTION_LENGTH);
    valid = false;
  }
  if (!question) question = DEFAULT_QUESTION;
  let task = typeof input.task === 'string' ? input.task : 'explain';
  if (TASKS.indexOf(task) < 0) {
    if (input.task !== undefined) valid = false;
    task = 'explain';
  }
  return { question, task, valid };
}

export function taskLabel(task) {
  if (task === 'translate') return '翻译';
  if (task === 'summarize') return '概括';
  return '解读';
}

// First turn: photo + question.
// Marks the message as carrying a photo, so system rule 0 (NO_IMAGE) applies.
export const PHOTO_ATTACHED_NOTE = '（本条消息附上了一张照片）';

export function buildImageInstruction(question, task) {
  return PHOTO_ATTACHED_NOTE + imageInstructionBody(question, task);
}

function imageInstructionBody(question, task) {
  const q = question || DEFAULT_QUESTION;
  if (task === 'translate') {
    return '用户的问题：' + q +
      '。请把照片中用户所指的段落逐句翻译成中文：【原文】只摘录首句，【解读】放完整译文（可以超过 120 字），【术语】列出其中的难词。';
  }
  if (task === 'summarize') {
    return '用户的问题：' + q +
      '。请概括照片中这一页或这一段的要点：【原文】摘录标题或首句，【解读】用 3 句话概括核心贡献与方法，【术语】列出关键术语。';
  }
  return '用户的问题：' + q + '。请按规定的三段格式解读照片中对应的内容。';
}

// Camera unavailable: the user reads the passage aloud instead.
export function buildSpokenInstruction(question, spokenText) {
  return '相机不可用，用户念出了论文中的这段文字：“' + spokenText +
    '”。用户的问题：' + (question || DEFAULT_QUESTION) + '。请按规定的三段格式解读。';
}

export function buildFollowUpInstruction(kind, text) {
  if (kind === 'translate') return '请把刚才照片中我所指的段落逐句翻译成中文，直接给译文。';
  if (kind === 'summarize') return '请用三句话概括刚才照片中这一段的要点。';
  return text;
}

// Splits "【原文】…【解读】…【术语】…" into parts. Missing markers degrade
// gracefully: the whole text becomes the explanation.
export function parseReply(text) {
  const source = normalizeText(text);
  const result = { excerpt: '', explanation: '', terms: [] };
  if (!source) return result;
  const positions = [];
  for (const key of Object.keys(SECTION_MARKERS)) {
    const marker = SECTION_MARKERS[key];
    const index = source.indexOf(marker);
    if (index >= 0) positions.push({ key, index, marker });
  }
  if (positions.length === 0) {
    result.explanation = source;
    return result;
  }
  positions.sort((a, b) => a.index - b.index);
  const leading = normalizeText(source.slice(0, positions[0].index));
  for (let i = 0; i < positions.length; i += 1) {
    const start = positions[i].index + positions[i].marker.length;
    const end = i + 1 < positions.length ? positions[i + 1].index : source.length;
    const body = normalizeText(source.slice(start, end)).replace(/^[:：\s]+/, '');
    if (positions[i].key === 'terms') {
      result.terms = parseTerms(body);
    } else {
      result[positions[i].key] = body;
    }
  }
  if (!result.explanation && leading) result.explanation = leading;
  return result;
}

export function parseTerms(body) {
  const cleaned = normalizeText(body);
  if (!cleaned || /^(无|没有|无术语|none)[。.]?$/i.test(cleaned)) return [];
  const lines = cleaned.split(/\n+|；|;/).map((line) => line.trim()).filter(Boolean);
  const terms = [];
  for (const line of lines) {
    const stripped = line.replace(/^[-•*\d.、)\s]+/, '');
    const match = stripped.match(/^(.+?)\s*[:：]\s*(.+)$/);
    if (match) {
      terms.push({ k: 't' + terms.length, name: match[1].trim(), meaning: match[2].trim() });
    } else if (stripped) {
      terms.push({ k: 't' + terms.length, name: stripped, meaning: '' });
    }
    if (terms.length >= 3) break;
  }
  return terms;
}

// Deterministic local commands take precedence over sending a follow-up to
// the model. Returns { kind, text }.
export function classifyFollowUp(transcript) {
  const text = normalizeText(transcript).replace(/[。！!，,？?\s]+$/g, '');
  if (!text) return { kind: 'empty', text: '' };
  if (/^(重拍|再拍|重新拍|再拍一张|换一段|拍这段|拍一下|重新拍照)/.test(text)) {
    return { kind: 'recapture', text };
  }
  if (/^(结束|退出|关闭|再见|不用了|拜拜|好了)$/.test(text)) {
    return { kind: 'finish', text };
  }
  if (/^(翻译|翻译一下|翻译这段|翻译一遍|翻译成中文)$/.test(text)) {
    return { kind: 'translate', text };
  }
  if (/^(总结|概括|总结一下|概括一下|总结这段)$/.test(text)) {
    return { kind: 'summarize', text };
  }
  return { kind: 'question', text: clampUnicode(text, MAX_TRANSCRIPT_LENGTH) };
}

// Short, single-line notice text: the runtime does not reliably apply
// text-overflow ellipsis, so clamp in JS.
export function clampText(value, limit) {
  const chars = Array.from(normalizeText(value).replace(/\s+/g, ' '));
  return chars.length <= limit ? chars.join('') : chars.slice(0, limit).join('') + '…';
}

export function spokenText(parsed, fallback) {
  const source = parsed && parsed.explanation ? parsed.explanation : normalizeText(fallback);
  const flat = source.replace(/\s+/g, ' ').trim();
  return clampUnicode(flat, MAX_SPOKEN_LENGTH);
}

export function errorMessage(error) {
  if (!error) return '未知错误';
  if (typeof error === 'string') return error;
  if (error.message) return String(error.message);
  if (error.errMsg) return String(error.errMsg);
  return String(error);
}

// Camera failures that mean "no permission / no camera" get a spoken fallback.
export function classifyCameraError(error) {
  const message = errorMessage(error).toLowerCase();
  if (/notallowed|permission|denied|拒绝|权限/.test(message)) return 'denied';
  if (/notfound|unavailable|not available|undefined|no camera|不可用|不支持/.test(message)) return 'unavailable';
  if (/interaction|focus|gesture|activation|user/.test(message)) return 'needs-gesture';
  return 'failed';
}

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

// Dependency-free Base64 for ArrayBuffer / typed arrays (used when the wx
// helper is missing). Builds the output in chunks to keep QuickJS happy.
export function arrayBufferToBase64(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const parts = [];
  let chunk = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const c = i + 2 < bytes.length ? bytes[i + 2] : 0;
    const triple = (a << 16) | (b << 8) | c;
    chunk += BASE64_ALPHABET[(triple >> 18) & 63] + BASE64_ALPHABET[(triple >> 12) & 63] +
      (i + 1 < bytes.length ? BASE64_ALPHABET[(triple >> 6) & 63] : '=') +
      (i + 2 < bytes.length ? BASE64_ALPHABET[triple & 63] : '=');
    if (chunk.length >= 8192) {
      parts.push(chunk);
      chunk = '';
    }
  }
  if (chunk) parts.push(chunk);
  return parts.join('');
}

function toArrayBuffer(data) {
  if (data instanceof ArrayBuffer) return data;
  if (ArrayBuffer.isView(data)) {
    return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  }
  return null;
}

// Accepts the wx CameraContext result ({ data, mimeType }) or a Blob from
// ImageCapture.takePhoto(). `encode` may be wx.arrayBufferToBase64.
export async function photoToDataUrl(photo, encode) {
  if (!photo) throw new Error('拍照没有返回图片');
  let mimeType = '';
  let buffer = null;
  if (typeof photo.arrayBuffer === 'function') {
    mimeType = typeof photo.type === 'string' ? photo.type : '';
    buffer = toArrayBuffer(await photo.arrayBuffer());
  } else {
    mimeType = typeof photo.mimeType === 'string' ? photo.mimeType : '';
    buffer = toArrayBuffer(photo.data);
  }
  if (!buffer || buffer.byteLength === 0) throw new Error('拍照结果没有图片数据');
  if (!mimeType) mimeType = 'image/jpeg';
  const base64 = typeof encode === 'function' ? encode(buffer) : arrayBufferToBase64(buffer);
  return { dataUrl: 'data:' + mimeType + ';base64,' + base64, mimeType, byteLength: buffer.byteLength };
}

// Message array in the shape the official chat sample sends to session.prompt().
export function buildImageMessages(instruction, dataUrl) {
  return [
    {
      role: 'user',
      content: [
        { type: 'text', text: instruction },
        { type: 'image_url', image_url: { url: dataUrl } }
      ]
    }
  ];
}

export const PHASE_STATUS = {
  capturing: { label: 'CAPTURE', glyph: '●' },
  ready: { label: 'READY', glyph: '○' },
  reading: { label: 'READING', glyph: '●' },
  answered: { label: 'DONE', glyph: '✓' },
  listening: { label: 'LISTEN', glyph: '◉' },
  error: { label: 'ERROR', glyph: '▲' }
};

export function statusFor(phase) {
  return PHASE_STATUS[phase] || PHASE_STATUS.error;
}

export function hintFor(phase, errorKind) {
  if (phase === 'ready') return '单击镜腿 拍下眼前的段落';
  if (phase === 'capturing') return '对准段落 保持不动';
  if (phase === 'reading') return '正在识别与解读 · 稍等';
  if (phase === 'answered') return '单击 语音追问 · 前后滑动 翻看';
  if (phase === 'listening') return '说出问题 · 单击 结束';
  if (phase === 'error') {
    if (errorKind === 'camera' || errorKind === 'vision') return '单击 念出这段文字 由我来解读';
    if (errorKind === 'llm') return '单击 重试';
    if (errorKind === 'asr') return '单击 再试一次';
    return '单击 重试';
  }
  return '';
}

// Joins the Web Speech result list the way the official chat sample does.
export function extractTranscript(event) {
  const results = event && event.results ? event.results : null;
  if (!results || typeof results.length !== 'number') {
    return { transcript: '', hasFinal: false };
  }
  const parts = [];
  let hasFinal = false;
  for (let index = 0; index < results.length; index += 1) {
    const result = results[index];
    const alternative = result && result[0];
    if (!alternative || !alternative.transcript) continue;
    parts.push(alternative.transcript);
    if (result.isFinal) hasFinal = true;
  }
  return { transcript: normalizeText(parts.join('')), hasFinal };
}
