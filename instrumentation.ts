export async function register() {
  // Node.js --localstorage-file flag can create a broken localStorage global.
  // Patch it to a safe no-op before Next.js internals try to use it.
  if (
    typeof (global as any).localStorage !== 'undefined' &&
    typeof (global as any).localStorage.getItem !== 'function'
  ) {
    (global as any).localStorage = {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
      clear: () => {},
      key: () => null,
      length: 0,
    };
  }
}
