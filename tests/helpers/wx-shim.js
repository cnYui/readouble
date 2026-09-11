// Stand-in for the runtime's `wx` module. Tests assign `globalThis.__wx`
// before loading a page; every property read is delegated at access time.
const shim = {};
for (const key of ['media', 'speech', 'arrayBufferToBase64', 'exitMiniProgram', 'navigateTo']) {
  Object.defineProperty(shim, key, {
    enumerable: true,
    get() {
      return (globalThis.__wx || {})[key];
    }
  });
}
export default shim;
