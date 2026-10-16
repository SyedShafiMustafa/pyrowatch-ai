// Exercise the actual show() renderer with a minimal DOM/Leaflet harness.
const assert = require('node:assert/strict');
const test = require('node:test');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');

function render(data) {
  const elements = Object.fromEntries(['issues', 'tb', 'bSample', 'file'].map(id => [id, {}]));
  const layer = {addTo() { return this; }, clearLayers() {}};
  const map = {setView() { return this; }};
  const context = vm.createContext({
    document: {getElementById: id => elements[id]},
    L: {map: () => map, tileLayer: () => layer, layerGroup: () => layer},
    data,
  });
  vm.runInContext(source + '\nshow(data);', context);
  return elements.issues.innerHTML;
}

test('uses ingestion counts, never issue count or displayed row count', () => {
  const html = render({rows: [], issues: ['duplicate', 'invalid row', 'schema issue'],
    ingestion: {accepted: 7, rejected: 1, deduplicated: 1}});
  assert.ok(html.startsWith('<p>7 valid, 1 rejected, 1 duplicates</p>'));
  assert.ok(html.includes('schema issue'));
});

test('schema errors do not invent rejected data rows', () => {
  assert.ok(render({rows: [], issues: ['missing columns'],
    ingestion: {accepted: 0, rejected: 0, deduplicated: 0}})
    .startsWith('<p>0 valid, 0 rejected, 0 duplicates</p>'));
});

test('legacy responses report issues without assuming they are rejections', () => {
  assert.ok(render({rows: [], issues: ['duplicate', 'schema error']})
    .startsWith('<p>0 valid, 2 issues</p>'));
});
