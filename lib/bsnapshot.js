'use strict';

function buildSnapshotExpression(interactiveOnly) {
  return `(() => {
  const interactiveOnly = ${interactiveOnly ? 'true' : 'false'};
  const vis = (el) => {
    if (!el) return false;
    const s = getComputedStyle(el);
    if (s.visibility === 'hidden' || s.display === 'none') return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const cssPath = (el) => {
    if (el.id) return '#' + CSS.escape(el.id);
    const tid = el.getAttribute('data-testid');
    if (tid) return '[data-testid="' + tid.replace(/"/g, '\\\\"') + '"]';
    const parts = [];
    let cur = el;
    while (cur && cur.nodeType === 1 && cur !== document.body) {
      let part = cur.tagName.toLowerCase();
      const parent = cur.parentElement;
      if (parent) {
        const sibs = Array.from(parent.children).filter((c) => c.tagName === cur.tagName);
        if (sibs.length > 1) part += ':nth-of-type(' + (sibs.indexOf(cur) + 1) + ')';
      }
      parts.unshift(part);
      cur = parent;
      if (parts.length >= 4) break;
    }
    return parts.join(' > ');
  };
  const roleOf = (el) => el.getAttribute('role') || ({ A: 'link', BUTTON: 'button', INPUT: 'textbox', SELECT: 'combobox', TEXTAREA: 'textbox' }[el.tagName] || el.tagName.toLowerCase());
  const textOf = (el) => (el.getAttribute('aria-label') || el.textContent || el.value || el.getAttribute('placeholder') || '').trim().replace(/\\s+/g, ' ').slice(0, 120);
  const sel = interactiveOnly
    ? 'a[href],button,input,select,textarea,[role="button"],[role="link"],[role="tab"],[role="menuitem"],[contenteditable="true"]'
    : 'a[href],button,input,select,textarea,[role],[onclick],h1,h2,h3,label,summary';
  const seen = new Set();
  const elements = [];
  let n = 0;
  for (const el of document.querySelectorAll(sel)) {
    if (!vis(el)) continue;
    const selector = cssPath(el);
    if (seen.has(selector)) continue;
    seen.add(selector);
    n += 1;
    elements.push({
      id: n,
      role: roleOf(el),
      text: textOf(el),
      selector,
      aria: el.getAttribute('aria-label') || null,
      tag: el.tagName.toLowerCase(),
      href: el.href || null,
    });
    if (n >= 200) break;
  }
  return { url: location.href, title: document.title, elements };
})()`;
}

function formatSnapshotText(data) {
  const lines = [`URL: ${data.url}`, `Title: ${data.title}`, '', 'Elements:'];
  for (const el of data.elements || []) {
    lines.push(`[${el.id}]<${el.role}> ${el.text || '(empty)'}  ${el.selector}`);
  }
  return lines.join('\n');
}

module.exports = { buildSnapshotExpression, formatSnapshotText };
