<script def>
{
  "navigationBarTitleText": "读伴",
  "description": "用户正在看英文论文、书或文档，对眼前的一段文字、公式、图表或整页内容提问时调用，例如“这段什么意思”“帮我解释这个公式”“翻译这一段”“总结这页在讲什么”。页面会用眼镜相机拍下用户视野中的内容，识别文字后给出中文解读并朗读，之后可以单击镜腿语音追问。把用户的原话放进 question。",
  "schema": {
    "data": {
      "type": "object",
      "properties": {
        "question": {
          "type": "string",
          "maxLength": 200,
          "description": "用户对眼前内容提出的问题原话，例如“这段在讲什么”“这个公式怎么理解”。没有明确问题时省略，页面默认解读整段内容。"
        },
        "task": {
          "type": "string",
          "enum": ["explain", "translate", "summarize"],
          "description": "explain = 解读（默认）；translate = 逐句翻译成中文；summarize = 概括要点。"
        }
      }
    }
  }
}
</script>

<script setup>
import wx from 'wx';
import { createTempleInput } from '../../lib/temple.js';
import {
  SYSTEM_PROMPT,
  buildFollowUpInstruction,
  buildImageInstruction,
  buildImageMessages,
  buildSpokenInstruction,
  classifyCameraError,
  clampText,
  classifyFollowUp,
  errorMessage,
  extractTranscript,
  hintFor,
  normalizeInput,
  normalizeText,
  parseReply,
  photoToDataUrl,
  spokenText,
  statusFor,
  taskLabel
} from '../../lib/reply.js';

const LLM_TIMEOUT_MS = 45000;
const ASR_IDLE_TIMEOUT_MS = 6000;
const STREAM_POLL_MS = 16;
const SCROLL_STEP_PX = 120;
const MAX_CAPTURE_FAILURES = 2;
const SPEECH_LANG = 'zh-CN';

const STEPS = {
  ready: '拍照 ○ · 识别 ○ · 解读 ○',
  capturing: '拍照 ● · 识别 ○ · 解读 ○',
  reading: '拍照 ✓ · 识别与解读 ●',
  answered: '拍照 ✓ · 识别 ✓ · 解读 ✓',
  listening: '追问 ◉ · 说完后单击结束',
  spoken: '相机不可用 · 听写 ✓ · 解读 ●'
};

function log(message) {
  console.log('[readouble] ' + message);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export default {
  data: {
    phase: 'ready',
    hostTarget: '',
    statusLabel: 'READY',
    statusGlyph: '○',
    questionLabel: '',
    taskLabel: '解读',
    stepText: STEPS.ready,
    captureTitle: '准备拍照',
    captureText: '把眼镜对准看不懂的段落',
    excerpt: '',
    excerptClass: '',
    explanation: '',
    pendingClass: '',
    terms: [],
    liveTranscript: '',
    errorTitle: '',
    errorText: '',
    notice: '',
    hint: '',
    scrollTop: 0,
    panelCapture: 'on',
    panelAnswer: '',
    panelListen: '',
    panelError: '',
    turnCount: 0
  },

  onLoad(query) {
    this._id = Math.random().toString(36).slice(2, 6);
    this._isVisible = false;
    this._phase = 'ready';
    this._turn = 0;
    this._turnTimer = null;
    this._asrTimer = null;
    this._session = null;
    this._recognition = null;
    this._asrFailed = false;
    this._stream = null;
    this._speechTask = null;
    this._speechPlayer = null;
    this._speechGeneration = 0;
    this._hasImage = false;
    this._hasAnswer = false;
    this._captureFailures = 0;
    this._errorKind = '';
    this._lastRequest = null;
    this._autoAttempted = false;
    this._input = createTempleInput({
      now: () => Date.now(),
      schedule: (callback, delay) => setTimeout(callback, delay),
      cancel: (timerId) => clearTimeout(timerId),
      onLoneGlobalHook: () => this._primary()
    });
    const input = normalizeInput(query);
    this._question = input.question;
    this._task = input.task;
    log('explain onLoad ' + this._id + ' query=' + JSON.stringify(query) +
      ' question=' + input.question + ' task=' + input.task + ' valid=' + input.valid);
    this._setPhase('ready', {
      questionLabel: '问：' + input.question,
      taskLabel: taskLabel(input.task),
      notice: input.valid ? '' : '没听清完整问题，先解读整段'
    });
  },

  onReady() {
    log('explain onReady ' + this._id);
    this._autoCapture();
  },

  onShow() {
    this._isVisible = true;
    log('explain onShow ' + this._id + ' phase=' + this._phase);
    // AIUI Studio 1.1.0 never delivered onReady to this Page (2026-09-11 log),
    // so the first show also triggers the automatic shot; _autoAttempted keeps it to one.
    this._autoCapture();
  },

  onHide() {
    log('explain onHide ' + this._id + ' phase=' + this._phase);
    this._isVisible = false;
    this._input.dispose();
    this._interrupt('hidden');
  },

  onUnload() {
    log('explain onUnload ' + this._id);
    this._isVisible = false;
    this._input.dispose();
    this._interrupt('unload');
    if (this._session) {
      try {
        this._session.destroy();
      } catch (error) {
        log('session destroy ignored: ' + errorMessage(error));
      }
      this._session = null;
    }
  },

  onTargetChanged(target, previousTarget) {
    log('explain target ' + previousTarget + ' -> ' + target);
    this.setData({ hostTarget: typeof target === 'string' ? target : '' });
  },

  onKeyDown(event) {
    if (!event) return;
    log('keydown ' + event.code + ' phase=' + this._phase + ' visible=' + this._isVisible);
    if (!this._isVisible) return;
    if (
      event.code === 'Enter' || event.code === 'Backspace' ||
      event.code === 'ArrowUp' || event.code === 'ArrowDown'
    ) {
      this._input.gestureKeyDown();
    }
  },

  onKeyUp(event) {
    if (!event) return;
    log('keyup ' + event.code + ' phase=' + this._phase + ' visible=' + this._isVisible);
    if (!this._isVisible) return;
    if (event.code === 'GlobalHook') {
      this._input.globalHookUp();
      return;
    }
    let owned = false;
    if (event.code === 'Enter') {
      this._input.gestureKeyUp();
      owned = this._primary();
    } else if (event.code === 'ArrowUp') {
      this._input.gestureKeyUp();
      owned = this._scroll(-1);
    } else if (event.code === 'ArrowDown') {
      this._input.gestureKeyUp();
      owned = this._scroll(1);
    } else if (event.code === 'Backspace') {
      // Back is left to the host (close / return); cleanup happens in onHide/onUnload.
      this._input.gestureKeyUp();
    }
    if (owned && typeof event.preventDefault === 'function') event.preventDefault();
  },

  // Single tap (Enter, or a lone GlobalHook). Returns true when owned.
  _primary() {
    const phase = this._phase;
    if (phase === 'ready') {
      this._capture('tap');
    } else if (phase === 'answered') {
      this._startListening();
    } else if (phase === 'listening') {
      this._finishListening();
    } else if (phase === 'error') {
      this._retry();
    }
    // capturing / reading: busy, swallow the tap so the host does not navigate away.
    return true;
  },

  // Swipe forward is -1 (ArrowUp), swipe back is +1 (ArrowDown): page the answer.
  _scroll(direction) {
    if (this._phase !== 'answered' && this._phase !== 'reading') return false;
    const next = Math.max(0, this.data.scrollTop + direction * SCROLL_STEP_PX);
    if (next === this.data.scrollTop) {
      this.setData({ notice: '已经在最上面' });
      return true;
    }
    this.setData({ scrollTop: next, notice: '' });
    return true;
  },

  _retry() {
    const kind = this._errorKind;
    if (kind === 'camera') {
      this._startListening();
    } else if (kind === 'camera-retry') {
      this._capture('retry');
    } else if (kind === 'llm' && this._lastRequest) {
      this._runRequest(this._lastRequest);
    } else if (kind === 'llm') {
      this._capture('retry');
    } else {
      this._startListening();
    }
  },

  _newTurn() {
    this._turn += 1;
    this._clearTurnTimer();
    return this._turn;
  },

  _clearTurnTimer() {
    if (this._turnTimer !== null) {
      clearTimeout(this._turnTimer);
      this._turnTimer = null;
    }
  },

  _armTurnTimer(turn) {
    this._clearTurnTimer();
    this._turnTimer = setTimeout(() => {
      this._turnTimer = null;
      if (turn !== this._turn) return;
      this._turn += 1;
      this._fail('llm', '模型超时', '等了 45 秒没有回答。');
    }, LLM_TIMEOUT_MS);
  },

  _clearAsrTimer() {
    if (this._asrTimer !== null) {
      clearTimeout(this._asrTimer);
      this._asrTimer = null;
    }
  },

  _refreshAsrTimer(turn) {
    this._clearAsrTimer();
    this._asrTimer = setTimeout(() => {
      this._asrTimer = null;
      if (turn !== this._turn || this._phase !== 'listening') return;
      log('asr idle timeout');
      this._finishListening();
    }, ASR_IDLE_TIMEOUT_MS);
  },

  _setPhase(phase, extra) {
    const status = statusFor(phase);
    this._phase = phase;
    const patch = {
      phase,
      statusLabel: status.label,
      statusGlyph: status.glyph,
      hint: hintFor(phase, this._errorKind),
      stepText: STEPS[phase] || this.data.stepText,
      panelCapture: phase === 'capturing' || phase === 'ready' ? 'on' : '',
      panelAnswer: phase === 'reading' || phase === 'answered' ? 'on' : '',
      panelListen: phase === 'listening' ? 'on' : '',
      panelError: phase === 'error' ? 'on' : ''
    };
    if (extra) {
      for (const key of Object.keys(extra)) patch[key] = extra[key];
    }
    this.setData(patch);
  },

  _fail(kind, title, text) {
    this._errorKind = kind;
    this._clearTurnTimer();
    this._clearAsrTimer();
    this._setPhase('error', { errorTitle: title, errorText: text || '', notice: '' });
  },

  // Cancels every in-flight turn and releases microphone, speaker, and camera.
  _interrupt(reason) {
    this._turn += 1;
    this._clearTurnTimer();
    this._clearAsrTimer();
    this._disposeRecognition();
    this._stopSpeech();
    this._stopStream();
    if (this._phase === 'listening' || this._phase === 'reading' || this._phase === 'capturing') {
      const next = this._hasAnswer && this._phase !== 'capturing' ? 'answered' : 'ready';
      this._setPhase(next, {
        notice: '已中断',
        pendingClass: '',
        captureTitle: '准备拍照',
        captureText: '单击镜腿重新拍照'
      });
    }
    log('interrupted: ' + reason);
  },

  // ---- camera ----------------------------------------------------------

  _cameraSupported() {
    if (wx && wx.media && typeof wx.media.createCameraContext === 'function') return true;
    const media = typeof navigator !== 'undefined' && navigator ? navigator.mediaDevices : null;
    return !!(media && typeof media.getUserMedia === 'function' && typeof ImageCapture !== 'undefined');
  },

  _autoCapture() {
    if (this._autoAttempted) return;
    this._autoAttempted = true;
    if (!this._cameraSupported()) {
      this._fail('camera', '相机不可用', '这个环境没有相机能力。单击镜腿，把看不懂的这段文字念给我听。');
      return;
    }
    this._capture('auto');
  },

  async _takePhoto() {
    if (wx && wx.media && typeof wx.media.createCameraContext === 'function') {
      const camera = wx.media.createCameraContext();
      if (camera && typeof camera.takePhoto === 'function') {
        return camera.takePhoto({ quality: 'high', mode: 'default' });
      }
    }
    const media = typeof navigator !== 'undefined' && navigator ? navigator.mediaDevices : null;
    if (media && typeof media.getUserMedia === 'function' && typeof ImageCapture !== 'undefined') {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true });
      this._stream = stream;
      try {
        const tracks = typeof stream.getVideoTracks === 'function' ? stream.getVideoTracks() : [];
        if (!tracks.length) throw new Error('没有可用的视频轨道');
        const capture = new ImageCapture(tracks[0]);
        return await capture.takePhoto({ quality: 'high', mode: 'default' });
      } finally {
        this._stopStream();
      }
    }
    throw new Error('相机不可用');
  },

  _stopStream() {
    const stream = this._stream;
    this._stream = null;
    if (!stream || typeof stream.getTracks !== 'function') return;
    try {
      stream.getTracks().forEach((track) => track.stop());
    } catch (error) {
      log('track stop ignored: ' + errorMessage(error));
    }
  },

  async _capture(source) {
    if (this._phase === 'capturing' || this._phase === 'reading') return;
    const turn = this._newTurn();
    this._disposeRecognition();
    this._stopSpeech();
    this._setPhase('capturing', {
      captureTitle: '正在拍照',
      captureText: '保持不动，段落放在视野中央',
      // The onLoad notice about a truncated question stays visible through the auto shot.
      notice: source === 'auto' ? this.data.notice : ''
    });
    let photo;
    try {
      photo = await this._takePhoto();
    } catch (error) {
      if (turn !== this._turn) return;
      const kind = classifyCameraError(error);
      // A rejected automatic shot is expected on some hosts and does not count.
      if (source !== 'auto') this._captureFailures += 1;
      log('takePhoto failed (' + source + ', #' + this._captureFailures + '): ' + kind + ' ' + errorMessage(error));
      if (kind === 'denied') {
        this._fail('camera', '相机权限被拒绝', '在 Hi Rokid App 里允许读伴使用相机，或单击镜腿把这段文字念给我听。');
      } else if (kind === 'unavailable') {
        this._fail('camera', '相机不可用', '当前设备没有可用相机。单击镜腿把这段文字念给我听。');
      } else if (source === 'auto') {
        this._setPhase('ready', {
          captureTitle: '需要你按一下',
          captureText: '单击镜腿后拍照，段落放在视野中央',
          notice: ''
        });
      } else if (this._captureFailures >= MAX_CAPTURE_FAILURES) {
        // Studio's webcam dialog reports a bare QuickJS exception when the
        // browser blocks the camera; after repeated failures stop retrying.
        this._fail('camera', '相机连续失败', '拍不到照片。单击镜腿，把看不懂的这段文字念给我听。');
      } else {
        this._fail('camera-retry', '拍照失败', '宿主没有返回照片，单击镜腿再拍一次。');
      }
      return;
    }
    this._captureFailures = 0;
    if (turn !== this._turn) return;
    let encoded;
    try {
      const encode = wx && typeof wx.arrayBufferToBase64 === 'function' ? wx.arrayBufferToBase64 : null;
      encoded = await photoToDataUrl(photo, encode);
    } catch (error) {
      if (turn !== this._turn) return;
      this._fail('camera-retry', '照片无法读取', errorMessage(error));
      return;
    }
    if (turn !== this._turn) return;
    log('photo ' + encoded.mimeType + ' ' + encoded.byteLength + ' bytes');
    this._hasImage = true;
    this._runRequest({
      kind: 'image',
      messages: buildImageMessages(buildImageInstruction(this._question, this._task), encoded.dataUrl),
      notice: '已拍照 · ' + Math.round(encoded.byteLength / 1024) + ' KB'
    }, turn);
  },

  // ---- language model --------------------------------------------------

  async _ensureSession() {
    if (this._session) return this._session;
    if (typeof LanguageModel === 'undefined') throw new Error('这个环境没有大模型能力');
    const status = await LanguageModel.availability();
    if (status !== 'available') throw new Error('大模型当前不可用');
    this._session = await LanguageModel.create({
      initialPrompts: [{ role: 'system', content: SYSTEM_PROMPT }]
    });
    return this._session;
  },

  // request: { kind: 'image' | 'text', messages? , text?, notice?, firstTurn? }
  async _runRequest(request, existingTurn) {
    const turn = existingTurn === undefined ? this._newTurn() : existingTurn;
    this._lastRequest = request;
    this._stopSpeech();
    const firstTurn = request.kind === 'image' || request.spoken === true;
    this._setPhase('reading', {
      notice: request.notice || '',
      pendingClass: 'pending',
      scrollTop: 0,
      explanation: firstTurn ? '正在识别文字并解读…' : '正在思考…',
      excerpt: firstTurn ? '' : this.data.excerpt,
      excerptClass: firstTurn ? '' : this.data.excerptClass,
      terms: firstTurn ? [] : this.data.terms,
      stepText: request.spoken ? STEPS.spoken : STEPS.reading
    });
    this._armTurnTimer(turn);
    let text = '';
    try {
      const session = await this._ensureSession();
      if (turn !== this._turn) return;
      if (request.kind === 'image') {
        text = await session.prompt(request.messages);
        if (turn !== this._turn) return;
      } else {
        const stream = session.promptStreaming(request.text);
        while (true) {
          const chunk = await stream.read();
          if (turn !== this._turn) return;
          if (chunk && chunk.done) break;
          if (chunk && typeof chunk.value === 'string' && chunk.value.length > 0) {
            text += chunk.value;
            this._showAnswer(text, true, firstTurn);
          } else {
            await sleep(STREAM_POLL_MS);
          }
        }
      }
    } catch (error) {
      if (turn !== this._turn) return;
      this._clearTurnTimer();
      log('model failed: ' + errorMessage(error));
      this._fail('llm', '解读失败', errorMessage(error));
      return;
    }
    this._clearTurnTimer();
    const parsed = this._showAnswer(text, false, firstTurn);
    this.setData({ turnCount: this.data.turnCount + 1 });
    this._speak(spokenText(parsed, text));
  },

  _showAnswer(text, pending, firstTurn) {
    const parsed = parseReply(text);
    const explanation = parsed.explanation || (pending ? '…' : '模型没有给出解读，单击重试。');
    const patch = {
      explanation,
      pendingClass: pending ? 'pending' : ''
    };
    if (firstTurn || parsed.excerpt) {
      patch.excerpt = parsed.excerpt;
      patch.excerptClass = parsed.excerpt ? 'on' : '';
    }
    if (firstTurn || parsed.terms.length) patch.terms = parsed.terms;
    if (pending) {
      this.setData(patch);
    } else {
      this._errorKind = '';
      this._hasAnswer = true;
      this._setPhase('answered', patch);
    }
    return parsed;
  },

  // ---- speech recognition (follow-up questions) -------------------------

  _startListening() {
    if (typeof SpeechRecognition === 'undefined') {
      this._fail('asr', '语音不可用', '这个环境没有语音识别能力。');
      return;
    }
    const turn = this._newTurn();
    this._disposeRecognition();
    this._stopSpeech();
    this._asrFailed = false;
    let finalTranscript = '';
    let liveTranscript = '';
    const recognition = new SpeechRecognition();
    recognition.lang = SPEECH_LANG;
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;
    recognition.onstart = () => {
      if (turn !== this._turn) return;
      this._refreshAsrTimer(turn);
    };
    recognition.onresult = (event) => {
      if (turn !== this._turn) return;
      const result = extractTranscript(event);
      liveTranscript = result.transcript;
      if (result.hasFinal && result.transcript) finalTranscript = result.transcript;
      this.setData({ liveTranscript: liveTranscript || '…' });
      this._refreshAsrTimer(turn);
    };
    recognition.onerror = (event) => {
      this._releaseRecognition(recognition);
      if (turn !== this._turn) return;
      this._asrFailed = true;
      const message = event && event.message ? (event.error || 'error') + ': ' + event.message : '语音识别失败';
      log('asr error ' + message);
      this._fail('asr', '没听清', message);
    };
    recognition.onend = () => {
      this._releaseRecognition(recognition);
      if (turn !== this._turn || this._asrFailed) return;
      this._clearAsrTimer();
      this._handleTranscript(turn, normalizeText(finalTranscript || liveTranscript));
    };
    this._recognition = recognition;
    this._setPhase('listening', { liveTranscript: '…', notice: '' });
    try {
      recognition.start();
    } catch (error) {
      this._releaseRecognition(recognition);
      this._fail('asr', '语音启动失败', errorMessage(error));
    }
  },

  _finishListening() {
    if (this._phase !== 'listening') return;
    this._clearAsrTimer();
    const recognition = this._recognition;
    if (!recognition) {
      this._handleTranscript(this._turn, '');
      return;
    }
    try {
      recognition.stop();
    } catch (error) {
      log('recognition stop ignored: ' + errorMessage(error));
      this._disposeRecognition();
      this._handleTranscript(this._turn, normalizeText(this.data.liveTranscript === '…' ? '' : this.data.liveTranscript));
    }
  },

  _releaseRecognition(recognition) {
    if (this._recognition === recognition) this._recognition = null;
  },

  _disposeRecognition() {
    const recognition = this._recognition;
    this._clearAsrTimer();
    if (!recognition) return;
    this._recognition = null;
    try {
      recognition.onstart = null;
      recognition.onresult = null;
      recognition.onerror = null;
      recognition.onend = null;
      recognition.abort();
    } catch (error) {
      log('recognition abort ignored: ' + errorMessage(error));
    }
  },

  _handleTranscript(turn, transcript) {
    if (turn !== this._turn) return;
    const command = classifyFollowUp(transcript);
    log('transcript kind=' + command.kind + ' text=' + command.text);
    if (command.kind === 'empty') {
      const next = this._hasAnswer ? 'answered' : (this._errorKind === 'camera' ? 'error' : 'ready');
      this._setPhase(next, { notice: '没听清，再试一次', liveTranscript: '' });
      return;
    }
    if (command.kind === 'finish') {
      this._interrupt('finish');
      if (typeof this.finish === 'function') this.finish();
      return;
    }
    if (command.kind === 'recapture') {
      this._hasImage = false;
      this._hasAnswer = false;
      this._setPhase('ready', { captureTitle: '准备重拍', captureText: '对准新的段落', liveTranscript: '' });
      this._capture('voice');
      return;
    }
    if (!this._hasImage) {
      this._runRequest({
        kind: 'text',
        text: buildSpokenInstruction(this._question, command.text),
        spoken: true,
        notice: '听写 · ' + clampText(command.text, 18)
      }, turn);
      return;
    }
    this._runRequest({
      kind: 'text',
      text: buildFollowUpInstruction(command.kind, command.text),
      notice: '追问 · ' + clampText(command.text, 18)
    }, turn);
  },

  // ---- speech synthesis -----------------------------------------------

  async _speak(text) {
    this._stopSpeech();
    if (!text) return;
    if (typeof speechSynthesis === 'undefined' || typeof SpeechSynthesisUtterance === 'undefined') return;
    const generation = this._speechGeneration;
    const utterance = new SpeechSynthesisUtterance(text);
    if (typeof speechSynthesis.synthesize === 'function' && typeof SpeechAudioPlayer !== 'undefined') {
      try {
        const task = await speechSynthesis.synthesize(utterance, {
          subtitles: 'none',
          audio: { preferredFormat: 'mp3' }
        });
        if (generation !== this._speechGeneration) {
          try {
            task.abort();
          } catch (error) {
            log('task abort ignored: ' + errorMessage(error));
          }
          return;
        }
        const player = new SpeechAudioPlayer(task, { trackMode: 'hidden' });
        this._speechTask = task;
        this._speechPlayer = player;
        player.play();
        return;
      } catch (error) {
        log('synthesize failed, falling back to speak(): ' + errorMessage(error));
        if (generation !== this._speechGeneration) return;
      }
    }
    if (typeof speechSynthesis.speak === 'function') {
      try {
        speechSynthesis.speak(utterance, 'immediate');
      } catch (error) {
        log('speak failed: ' + errorMessage(error));
      }
    }
  },

  _stopSpeech() {
    this._speechGeneration += 1;
    const task = this._speechTask;
    const player = this._speechPlayer;
    this._speechTask = null;
    this._speechPlayer = null;
    if (player) {
      try {
        player.stop();
      } catch (error) {
        log('player stop ignored: ' + errorMessage(error));
      }
      try {
        player.destroy();
      } catch (error) {
        log('player destroy ignored: ' + errorMessage(error));
      }
    }
    if (task && task.state === 'running') {
      try {
        task.abort();
      } catch (error) {
        log('task abort ignored: ' + errorMessage(error));
      }
    }
    if (typeof speechSynthesis !== 'undefined' && typeof speechSynthesis.cancel === 'function') {
      try {
        speechSynthesis.cancel();
      } catch (error) {
        log('speechSynthesis cancel ignored: ' + errorMessage(error));
      }
    }
  }
};
</script>

<page class="shell">
  <view class="frame">
    <view class="topline">
      <text class="eyebrow">读伴 · {{taskLabel}}</text>
      <view class="chip">
        <text class="chip-glyph">{{statusGlyph}}</text>
        <text class="chip-text">{{statusLabel}}</text>
      </view>
    </view>
    <text class="question">{{questionLabel}}</text>
    <view class="divider"></view>
    <text class="steps">{{stepText}}</text>

    <view class="panel panel-capture {{panelCapture}}">
      <view class="capture-frame">
        <text class="capture-title">{{captureTitle}}</text>
        <text class="capture-text">{{captureText}}</text>
      </view>
    </view>

    <view class="panel panel-answer {{panelAnswer}}">
      <scroll-view class="answer-scroll" scroll-y="true" scroll-top="{{scrollTop}}">
        <view class="answer-body">
          <view class="excerpt-block {{excerptClass}}">
            <text class="section-label">原文</text>
            <text class="excerpt">{{excerpt}}</text>
          </view>
          <text class="section-label">解读</text>
          <text class="explanation {{pendingClass}}">{{explanation}}</text>
          <view class="terms">
            <block ink:for="{{terms}}" ink:key="k" ink:for-item="term">
              <view class="term-row">
                <text class="term-name">{{term.name}}</text>
                <text class="term-meaning">{{term.meaning}}</text>
              </view>
            </block>
          </view>
        </view>
      </scroll-view>
    </view>

    <view class="panel panel-listen {{panelListen}}">
      <view class="listen-box">
        <text class="listen-title">◉ 正在聆听</text>
        <text class="transcript">{{liveTranscript}}</text>
      </view>
    </view>

    <view class="panel panel-error {{panelError}}">
      <view class="error-box">
        <text class="error-title">▲ {{errorTitle}}</text>
        <text class="error-text">{{errorText}}</text>
      </view>
    </view>

    <view class="bottom">
      <text class="notice">{{notice}}</text>
      <text class="hint">{{hint}}</text>
    </view>
  </view>
</page>

<style>
.shell {
  width: 100%;
  height: 100%;
  padding: 12px 16px;
  box-sizing: border-box;
  color: #40ff5e;
  background-color: #000000;
}

.frame {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  min-height: 0;
  opacity: 0.84;
}

.frame:host-focus {
  opacity: 1;
}

.topline {
  display: flex;
  flex-direction: row;
  flex-shrink: 0;
  align-items: center;
  justify-content: space-between;
}

.eyebrow {
  font-size: 11px;
  line-height: 14px;
  letter-spacing: 0.08em;
  color: rgba(64, 255, 94, 0.48);
}

.chip {
  display: flex;
  flex-direction: row;
  align-items: center;
  min-height: 22px;
  padding: 0 8px;
  border: 1px solid rgba(64, 255, 94, 0.24);
  border-radius: 4px;
}

.chip-glyph {
  margin-right: 4px;
  font-size: 10px;
  line-height: 14px;
  color: #40ff5e;
}

.chip-text {
  font-size: 10px;
  line-height: 14px;
  letter-spacing: 0.05em;
  color: rgba(64, 255, 94, 0.72);
}

.question {
  flex-shrink: 0;
  margin-top: 8px;
  font-size: 12px;
  line-height: 16px;
  color: rgba(64, 255, 94, 0.72);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.divider {
  flex-shrink: 0;
  height: 1px;
  margin-top: 8px;
  background-color: rgba(64, 255, 94, 0.24);
}

.steps {
  flex-shrink: 0;
  margin-top: 6px;
  font-size: 11px;
  line-height: 14px;
  letter-spacing: 0.04em;
  color: rgba(64, 255, 94, 0.48);
}

.panel {
  display: none;
  flex-direction: column;
  flex: 1 1 auto;
  min-height: 0;
  margin-top: 8px;
}

.on {
  display: flex;
}

.capture-frame {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-height: 0;
  align-items: center;
  justify-content: center;
  padding: 12px;
  border: 1px solid rgba(64, 255, 94, 0.48);
  border-radius: 2px;
}

.capture-title {
  font-size: 16px;
  line-height: 20px;
  color: #40ff5e;
}

.capture-text {
  margin-top: 6px;
  font-size: 12px;
  line-height: 16px;
  text-align: center;
  color: rgba(64, 255, 94, 0.72);
}

.answer-scroll {
  flex: 1 1 auto;
  min-height: 0;
  width: 100%;
}

.answer-body {
  display: flex;
  flex-direction: column;
  padding-right: 8px;
}

.section-label {
  margin-top: 6px;
  font-size: 11px;
  line-height: 14px;
  letter-spacing: 0.08em;
  color: rgba(64, 255, 94, 0.48);
}

.excerpt-block {
  display: none;
  flex-direction: column;
}

.excerpt-block.on {
  display: flex;
}

.excerpt {
  margin-top: 2px;
  padding-left: 8px;
  border-left: 1px solid rgba(64, 255, 94, 0.24);
  font-size: 12px;
  line-height: 16px;
  color: rgba(64, 255, 94, 0.72);
}

.explanation {
  margin-top: 2px;
  font-size: 14px;
  line-height: 19px;
  color: rgba(64, 255, 94, 0.72);
}

.explanation.pending {
  color: rgba(64, 255, 94, 0.48);
}

.terms {
  display: flex;
  flex-direction: column;
  margin-top: 6px;
}

.term-row {
  display: flex;
  flex-direction: row;
  align-items: flex-start;
  min-height: 22px;
  margin-top: 2px;
}

.term-name {
  flex-shrink: 0;
  max-width: 170px;
  font-size: 13px;
  line-height: 17px;
  letter-spacing: 0.03em;
  color: #40ff5e;
}

.term-meaning {
  flex: 1 1 auto;
  margin-left: 8px;
  font-size: 12px;
  line-height: 17px;
  color: rgba(64, 255, 94, 0.72);
}

.listen-box,
.error-box {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-height: 0;
  padding: 12px;
  border-radius: 6px;
}

.listen-box {
  border: 1px solid rgba(64, 255, 94, 0.72);
  background-color: rgba(64, 255, 94, 0.06);
}

.error-box {
  border: 1px dashed rgba(64, 255, 94, 0.72);
}

.listen-title,
.error-title {
  font-size: 16px;
  line-height: 20px;
  color: #40ff5e;
}

.transcript {
  margin-top: 6px;
  font-size: 14px;
  line-height: 19px;
  color: rgba(64, 255, 94, 0.72);
}

.error-text {
  margin-top: 4px;
  font-size: 12px;
  line-height: 16px;
  color: rgba(64, 255, 94, 0.72);
}

.bottom {
  display: flex;
  flex-direction: row;
  flex-shrink: 0;
  align-items: center;
  justify-content: space-between;
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px solid rgba(64, 255, 94, 0.24);
}

.notice {
  flex-shrink: 1;
  min-width: 0;
  margin-right: 8px;
  font-size: 11px;
  line-height: 14px;
  color: rgba(64, 255, 94, 0.72);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.hint {
  flex-shrink: 0;
  font-size: 11px;
  line-height: 14px;
  letter-spacing: 0.04em;
  color: rgba(64, 255, 94, 0.48);
}

@media (target: _current) {
  .shell {
    padding: 10px 14px;
  }
}

@media (target: _blank) {
  .shell {
    padding: 12px 16px;
  }
}

/* Inline card in the conversation flow (about 448 x 150): keep the
   status, the explanation, and the hint; drop everything else. */
@media (max-height: 240px) {
  .shell {
    padding: 6px 12px;
  }
  .question,
  .divider,
  .steps,
  .excerpt-block,
  .terms,
  .section-label,
  .notice {
    display: none;
  }
  .panel {
    margin-top: 4px;
  }
  .capture-frame,
  .listen-box,
  .error-box {
    padding: 6px 10px;
  }
  .explanation {
    max-height: 57px;
    overflow: hidden;
  }
  .bottom {
    margin-top: 4px;
    padding-top: 4px;
  }
}
</style>
