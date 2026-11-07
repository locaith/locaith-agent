export const BRAND_NAMES: RegExp;
export const CDN_HOSTS: RegExp;
export function readBundledString(js: string, key: string): string | undefined;
export function verifyBrowserPackage(dir: string, opts?: { root?: string }): { passed: string[] };
