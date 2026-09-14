import { useEffect } from 'react';

const ZOOM_IN = 1.15;
const ZOOM_OUT = 0.87;

function isTypingTarget(el) {
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}

// Ctrl/Cmd +, Ctrl/Cmd -, Ctrl/Cmd 0 zoom the diagram about the centre of
// `containerRef`, using the same maths as the view's own wheel handler.
// Always preventDefault on the keys we handle — otherwise WebView2 zooms the
// whole page instead, which is exactly what this is here to avoid.
// `initial` is the view's own starting {tx, ty}, restored (at scale 1) on
// Ctrl+0 — each view passes whatever it used for its own useState seed.
export function useZoomShortcuts(containerRef, setView, { min = 0.3, max = 3, initial = { tx: 0, ty: 0 } } = {}) {
  useEffect(() => {
    function onKeyDown(e) {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      if (isTypingTarget(e.target)) return;

      const isZoomIn = e.key === '=' || e.key === '+' || e.code === 'NumpadAdd';
      const isZoomOut = e.key === '-' || e.key === '_' || e.code === 'NumpadSubtract';
      const isReset = e.key === '0' || e.code === 'Numpad0';
      if (!isZoomIn && !isZoomOut && !isReset) return;

      e.preventDefault();
      const el = containerRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const cx = rect.width / 2;
      const cy = rect.height / 2;

      setView((v) => {
        if (isReset) {
          return { ...v, scale: 1, tx: initial.tx, ty: initial.ty };
        }
        const ns = Math.min(max, Math.max(min, v.scale * (isZoomIn ? ZOOM_IN : ZOOM_OUT)));
        const wx = (cx - v.tx) / v.scale;
        const wy = (cy - v.ty) / v.scale;
        return { scale: ns, tx: cx - wx * ns, ty: cy - wy * ns };
      });
    }

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [containerRef, setView, min, max, initial.tx, initial.ty]);
}
