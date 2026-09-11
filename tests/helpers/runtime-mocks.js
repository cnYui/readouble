// Fake AIUI runtime globals for page tests: LanguageModel, SpeechRecognition,
// speechSynthesis, and the wx camera/base64 helpers.

export function installRuntime(options = {}) {
  const calls = {
    prompts: [],
    streams: [],
    photos: 0,
    spoken: [],
    recognitions: [],
    destroyed: 0
  };
  const settings = {
    availability: options.availability || 'available',
    imageReply: options.imageReply ||
      '【原文】We propose a new simple network architecture, the Transformer.\n【解读】这段提出了 Transformer：完全靠注意力机制，不用循环和卷积。\n【术语】attention：注意力机制\nrecurrence：循环结构',
    streamChunks: options.streamChunks || ['因为', '它把序列', '并行处理。'],
    photoError: options.photoError || null,
    promptError: options.promptError || null,
    cameraSupported: options.cameraSupported !== false
  };

  const session = {
    async prompt(messages) {
      calls.prompts.push(messages);
      if (settings.promptError) throw settings.promptError;
      return settings.imageReply;
    },
    promptStreaming(text) {
      calls.streams.push(text);
      const chunks = settings.streamChunks.slice();
      let emptyPollDone = false;
      return {
        async read() {
          if (settings.promptError) throw settings.promptError;
          if (!emptyPollDone) {
            emptyPollDone = true;
            return { done: false, value: undefined };
          }
          if (chunks.length === 0) return { done: true, value: undefined };
          return { done: false, value: chunks.shift() };
        }
      };
    },
    destroy() {
      calls.destroyed += 1;
    }
  };

  globalThis.LanguageModel = {
    async availability() {
      return settings.availability;
    },
    async create() {
      return session;
    }
  };

  class FakeRecognition {
    constructor() {
      this.started = 0;
      this.stopped = 0;
      this.aborted = 0;
      calls.recognitions.push(this);
    }
    start() {
      this.started += 1;
      if (this.onstart) this.onstart();
    }
    emit(transcript, isFinal) {
      if (this.onresult) {
        this.onresult({ results: [Object.assign([{ transcript }], { isFinal })] });
      }
    }
    stop() {
      this.stopped += 1;
      if (this.onend) this.onend();
    }
    abort() {
      this.aborted += 1;
    }
    fail(error, message) {
      if (this.onerror) this.onerror({ error, message });
      if (this.onend) this.onend();
    }
  }
  globalThis.SpeechRecognition = FakeRecognition;

  globalThis.SpeechSynthesisUtterance = class {
    constructor(text) {
      this.text = text;
    }
  };
  globalThis.speechSynthesis = {
    speak(utterance, mode) {
      calls.spoken.push({ text: utterance.text, mode });
    }
  };

  globalThis.__wx = {
    arrayBufferToBase64(buffer) {
      return Buffer.from(buffer).toString('base64');
    },
    media: settings.cameraSupported ? {
      createCameraContext() {
        return {
          async takePhoto() {
            calls.photos += 1;
            if (settings.photoError) throw settings.photoError;
            return { data: new Uint8Array([255, 216, 255, 224]).buffer, mimeType: 'image/jpeg' };
          }
        };
      }
    } : undefined
  };

  return { calls, settings, session };
}

export function uninstallRuntime() {
  delete globalThis.LanguageModel;
  delete globalThis.SpeechRecognition;
  delete globalThis.SpeechSynthesisUtterance;
  delete globalThis.speechSynthesis;
  delete globalThis.__wx;
}
