'use strict';

const fs = require('fs');
const path = require('path');
const { gliderHome } = require('./paths.js');

function readJsonIfPresent(filePath, label) {
  if (!fs.existsSync(filePath)) return null;
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`Invalid ${label} JSON at ${filePath}: ${error.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Invalid ${label} at ${filePath}: expected a JSON object`);
  }
  return parsed;
}

function firstJson(paths, label) {
  for (const filePath of paths) {
    const data = readJsonIfPresent(filePath, label);
    if (data) return { data, source: filePath };
  }
  return { data: {}, source: null };
}

function optionalString(value, field, source) {
  if (value == null) return null;
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Invalid browser config${source ? ` at ${source}` : ''}: "${field}" must be a non-empty string`);
  }
  return value;
}

function loadBrowserConfig(options = {}) {
  const home = options.home || gliderHome();
  const configResult = firstJson([
    path.join(home, 'config', 'browser.json'),
    path.join(home, 'browser.json'),
  ], 'browser config');
  const registryResult = firstJson([
    path.join(home, 'config', 'browsers-registry.json'),
    path.join(home, 'browsers-registry.json'),
  ], 'browser registry');

  const config = configResult.data;
  const registry = registryResult.data.registry || registryResult.data;
  if (!registry || typeof registry !== 'object' || Array.isArray(registry)) {
    throw new Error(`Invalid browser registry${registryResult.source ? ` at ${registryResult.source}` : ''}: expected an object`);
  }

  const use = optionalString(config.use, 'use', configResult.source);
  let resolved = config;
  if (use) {
    if (!registry[use]) {
      throw new Error(`Unknown browser registry key "${use}" in ${configResult.source}`);
    }
    resolved = registry[use];
    if (!resolved || typeof resolved !== 'object' || Array.isArray(resolved)) {
      throw new Error(`Invalid browser registry entry "${use}" in ${registryResult.source}`);
    }
  }

  const name = optionalString(resolved.name, 'name', use ? registryResult.source : configResult.source) || 'Google Chrome';
  const appPath = optionalString(resolved.path, 'path', use ? registryResult.source : configResult.source);
  const processName = optionalString(resolved.processName, 'processName', use ? registryResult.source : configResult.source) || name;
  const bootstrapUrl = optionalString(
    config.bootstrapUrl ?? resolved.bootstrapUrl,
    'bootstrapUrl',
    configResult.source
  ) || 'https://www.google.com/';

  return {
    name,
    path: appPath,
    processName,
    bootstrapUrl,
    use,
    source: configResult.source,
    registrySource: registryResult.source,
    registry,
  };
}

function isBrowserInternalUrl(url) {
  return /^(?:about|arc|brave|chrome|chrome-extension|edge|opera|vivaldi):/i.test(String(url || ''));
}

module.exports = {
  isBrowserInternalUrl,
  loadBrowserConfig,
};
