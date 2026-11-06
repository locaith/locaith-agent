import { Component, h, type ComponentChildren, type FunctionComponent, type RefObject } from 'preact';
import { useEffect } from 'preact/hooks';

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

function shallowEqual(a: object, b: object): boolean {
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if ((a as Record<string, unknown>)[k] !== (b as Record<string, unknown>)[k]) return false;
  }
  return true;
}

/** memo tối giản (Preact core không có; tránh kéo cả preact/compat vào bundle). */
export function memo<P extends object>(
  Comp: FunctionComponent<P>,
  areEqual: (prev: P, next: P) => boolean = shallowEqual,
): FunctionComponent<P> {
  class Memo extends Component<P> {
    shouldComponentUpdate(next: P) {
      return !areEqual(this.props, next);
    }
    render() {
      return h(Comp as FunctionComponent<object>, this.props as object);
    }
  }
  return Memo as unknown as FunctionComponent<P>;
}

/** Gọi `onOutside` khi bấm chuột/chạm ra ngoài `ref` hoặc nhấn Esc, chỉ khi `active`. */
export function useDismiss(ref: RefObject<HTMLElement | null>, active: boolean, onOutside: () => void): void {
  useEffect(() => {
    if (!active) return;
    const onPointer = (e: PointerEvent) => {
      const el = ref.current;
      if (el && e.target instanceof Node && !el.contains(e.target)) onOutside();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.isComposing) {
        e.stopPropagation();
        onOutside();
      }
    };
    document.addEventListener('pointerdown', onPointer, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', onPointer, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [active, onOutside, ref]);
}

/** Chép văn bản; dùng Clipboard API, rơi về execCommand khi bị chặn. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

export function readFileAsBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => {
      const result = String(reader.result ?? '');
      resolve(result.slice(result.indexOf(',') + 1));
    };
    reader.readAsDataURL(file);
  });
}

export type Children = ComponentChildren;
