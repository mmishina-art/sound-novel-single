/// <reference types="vite/client" />

declare const __APP_VERSION__: string;

/** package.json の name。保存データのキー・バックアップの app 名の元（vite.config.ts が埋め込む） */
declare const __APP_ID__: string;

interface Window {
  /** 起動できたら true。public/boot.js が、起動に失敗したかの判定に使う */
  __appStarted?: boolean;
}
