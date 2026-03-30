import '@testing-library/jest-dom/vitest';

class MockIntersectionObserver {
  observe(): void {}
  disconnect(): void {}
  unobserve(): void {}
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
}

Object.defineProperty(globalThis, 'IntersectionObserver', {
  writable: true,
  configurable: true,
  value: MockIntersectionObserver,
});

type StorageMethodName = 'getItem' | 'setItem' | 'removeItem' | 'clear' | 'key';

function hasWorkingStorage(storage: unknown): storage is Storage {
  if (!storage || typeof storage !== 'object') {
    return false;
  }

  return ['getItem', 'setItem', 'removeItem', 'clear', 'key'].every((method) =>
    typeof (storage as Record<StorageMethodName, unknown>)[method as StorageMethodName] === 'function',
  );
}

function createStorageMock(): Storage {
  const store = new Map<string, string>();

  return {
    get length() {
      return store.size;
    },
    clear() {
      store.clear();
    },
    getItem(key) {
      return store.has(key) ? store.get(key)! : null;
    },
    key(index) {
      return Array.from(store.keys())[index] ?? null;
    },
    removeItem(key) {
      store.delete(key);
    },
    setItem(key, value) {
      store.set(String(key), String(value));
    },
  };
}

function installStorageMock(name: 'localStorage' | 'sessionStorage') {
  try {
    if (hasWorkingStorage(window[name])) {
      return;
    }
  } catch {
    // Some runtimes expose the property but throw when accessed.
  }

  const storage = createStorageMock();

  Object.defineProperty(window, name, {
    value: storage,
    writable: true,
    configurable: true,
  });

  Object.defineProperty(globalThis, name, {
    value: storage,
    writable: true,
    configurable: true,
  });
}

installStorageMock('localStorage');
installStorageMock('sessionStorage');
