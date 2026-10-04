// 领域逻辑验证：不依赖浏览器，用内存版 localStorage 模拟用户已有的数据。
const store = new Map()
globalThis.window = {
  localStorage: {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => void store.set(k, v),
  },
}

await import('./dom-run.mjs')
