/**
 * Main world script - runs in the Overleaf tab's main context.
 *
 * Reads the full document from the CodeMirror 6 state, not the DOM. Overleaf's
 * editor DOM is virtualized and only contains visible lines.
 */

/**
 * Find the CM6 EditorView for a given .cm-editor element.
 *
 * This depends on Overleaf and CodeMirror internals. Keep changes minimal and
 * verify against a live Overleaf editor before refactoring.
 */
function findEditorView(editor) {
  try {
    const v = editor.querySelector('.cm-content')?.cmView?.view;
    if (typeof v?.state?.doc?.toString === 'function') return v;
  } catch {}

  for (const el of editor.querySelectorAll('*')) {
    try {
      if (typeof el.cmView?.view?.state?.doc?.toString === 'function') return el.cmView.view;
      if (typeof el.cmView?.state?.doc?.toString === 'function') return el.cmView;
    } catch {}
  }

  const fiberKey = Object.keys(editor).find(
    (k) => k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance'),
  );
  if (fiberKey) {
    let fiber = editor[fiberKey];
    let depth = 0;
    while (fiber && depth < 60) {
      try {
        let s = fiber.memoizedState;
        while (s) {
          const v = s.memoizedState ?? s;
          if (v?.state?.doc && typeof v.state.doc.toString === 'function') return v;
          s = s.next;
        }
        const props = fiber.memoizedProps;
        if (props) {
          for (const key of Object.keys(props)) {
            const v = props[key];
            if (v?.state?.doc && typeof v.state.doc.toString === 'function') return v;
          }
        }
      } catch {}
      fiber = fiber.return;
      depth++;
    }
  }

  return null;
}

window.addEventListener('message', (event) => {
  if (event.source !== window || event.data?.type !== 'LALE_DOC_TEXT_REQUEST') return;

  const { nonce } = event.data;
  try {
    const editor = document.querySelector('.cm-editor');
    if (!editor) {
      console.warn('[lale] .cm-editor not found');
      window.postMessage({ type: 'LALE_DOC_TEXT_REPLY', text: null, nonce }, '*');
      return;
    }

    const view = findEditorView(editor);
    if (!view) {
      console.warn('[lale] could not locate CM6 EditorView on .cm-editor');
      window.postMessage({ type: 'LALE_DOC_TEXT_REPLY', text: null, nonce }, '*');
      return;
    }

    window.postMessage({ type: 'LALE_DOC_TEXT_REPLY', text: view.state.doc.toString(), nonce }, '*');
  } catch (error) {
    console.error('[lale] main-world error:', error);
    window.postMessage({ type: 'LALE_DOC_TEXT_REPLY', text: null, nonce }, '*');
  }
});

window.addEventListener('message', (event) => {
  if (event.source !== window || event.data?.type !== 'LALE_SCROLL_TO_OFFSET_REQUEST') return;

  try {
    const editor = document.querySelector('.cm-editor');
    if (!editor) return;

    const view = findEditorView(editor);
    if (!view) return;

    const offset = Math.max(0, Math.min(event.data.offset, view.state.doc.length));
    view.dispatch({
      selection: { anchor: offset },
      scrollIntoView: true,
    });
    view.focus();
  } catch (error) {
    console.error('[lale] scroll-to-source error:', error);
  }
});
