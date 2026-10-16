'use strict';

function parseVersion(raw) {
  const core = String(raw || '').trim().split('-')[0].split('+')[0];
  const parts = core.split('.').map((n) => Number.parseInt(n, 10));
  if (parts.length < 1 || parts.some((n) => !Number.isInteger(n) || n < 0)) return null;
  while (parts.length < 3) parts.push(0);
  return parts.slice(0, 3);
}

function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return null;
  for (let i = 0; i < 3; i += 1) {
    if (left[i] < right[i]) return -1;
    if (left[i] > right[i]) return 1;
  }
  return 0;
}

function npmIsNewer(current, latest) {
  return compareVersions(current, latest) === -1;
}

module.exports = { parseVersion, compareVersions, npmIsNewer };
