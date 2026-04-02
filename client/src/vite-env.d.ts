/// <reference types="vite/client" />

interface Window {
  __BASE_PATH__?: string;
}

interface ImportMetaEnv {
  readonly VITE_BUILD_DATE?: string;
  readonly VITE_VERSION?: string;
  readonly VITE_BRANCH?: string;
  readonly VITE_COMMIT_HASH?: string;
  readonly VITE_REPO_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
