const assert = require('node:assert/strict');
const test = require('node:test');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');

class Element {
  constructor() {
    this.children = [];
    this.listeners = {};
    this.classList = {add() {}, toggle() {}};
    this.style = {setProperty() {}};
    this.dataset = {};
    this.value = '';
    this.checked = false;
    this.hidden = false;
    this.disabled = false;
    this.rows = this.children;
  }
  addEventListener(name, fn) { this.listeners[name] = fn; }
  append(...nodes) { this.children.push(...nodes); }
  add(node) { this.children.push(node); }
  click() { this.clicked = true; }
  replaceChildren(...nodes) { this.children = nodes; this.rows = nodes; }
  setAttribute() {}
  scrollIntoView() {}
  get options() { return this.children; }
}

function dashboard() {
  const elements = new Map();
  const calls = [];
  const blobs = [];
  const createdElements = [];
  const sample = {
    issues: ['schema warning', 'duplicate notice'],
    rows: [{
      latitude: -33, longitude: 150, time: '2026-10-10T00:00:00Z',
      satellite: 'N20', instrument: 'VIIRS', confidence_raw: 'h',
      confidence: 1, frp: 5, score: 62, why: 'backend explanation',
      repeat_count: 0, source_line: 2, source_fields: {}, possible_static_source: false
    }],
    events: [],
    evaluation: null,
    ingestion: {
      total_records: 3, accepted: 1, rejected: 1, deduplicated: 1,
      physical_lines: 4, columns: ['latitude', 'longitude'],
      outcomes: [
        {line: 2, status: 'accepted', reason: 'validated'},
        {line: 3, status: 'deduplicated', reason: 'duplicate'},
        {line: 4, status: 'rejected', reason: 'invalid'}
      ],
      data_kind: 'synthetic'
    }
  };
  const uploaded = {
    ...sample,
    rows: [
      {...sample.rows[0], confidence_raw: '=1+1', why: '=2+2, \"quoted\"'},
      {...sample.rows[0], latitude: -34, longitude: 151, time: '2026-10-11T00:00:00Z', satellite: 'N20', source_line: 3},
      {...sample.rows[0], latitude: -35, longitude: 152, time: '2026-10-12T00:00:00Z', satellite: 'N21', source_line: 4}
    ],
    ingestion: {
      ...sample.ingestion,
      total_records: 3, accepted: 3, rejected: 0, deduplicated: 0,
      outcomes: [], data_kind: 'user_supplied_unverified'
    }
  };
  const jsonResponse = (body, status = 200) => ({
    ok: status >= 200 && status < 300,
    status,
    headers: {get: () => 'application/json'},
    json: async () => body
  });
  class Form {
    append(name, value) { this[name] = value; }
  }
  const context = vm.createContext({
    document: {
      getElementById(id) {
        if (!elements.has(id)) elements.set(id, new Element());
        return elements.get(id);
      },
      createElement(tagName) {
        const element = new Element();
        element.tagName = tagName;
        createdElements.push(element);
        return element;
      }
    },
    window: {},
    Option: class { constructor(text, value) { this.textContent = text; this.value = value; } },
    FormData: Form,
    URL: Object.assign(class extends URL {}, {
      createObjectURL(blob) { blobs.push(blob); return 'blob:mock-export'; },
      revokeObjectURL() {}
    }),
    Blob: class { constructor(parts, options) { this.parts = parts; this.type = options.type; } },
    AbortController,
    setTimeout,
    clearTimeout,
    fetch: async (url, options = {}) => {
      const target = String(url);
      calls.push({url: target, options});
      if (target.endsWith('/api/sample')) return jsonResponse(sample);
      if (target.endsWith('/api/upload')) {
        return options.body.file.name === 'invalid.csv'
          ? jsonResponse({detail: 'Upload must be UTF-8 CSV'}, 400)
          : jsonResponse(uploaded);
      }
      return jsonResponse({ok: true});
    }
  });
  vm.runInContext(source, context);
  return {elements, calls, blobs, createdElements};
}

test('dashboard health, sample, and upload use the configured backend and render API ingestion counts', async () => {
  const {elements, calls, blobs, createdElements} = dashboard();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(elements.get('connectionStatus').textContent, 'API connected');

  await elements.get('bSample').listeners.click();
  assert.equal(elements.get('provenance').textContent, 'Synthetic demo data (backend-reported)');
  assert.equal(elements.get('mAccepted').textContent, '1');
  assert.equal(elements.get('mRejected').textContent, '1');
  assert.equal(elements.get('mDuplicates').textContent, '1');
  assert.equal(elements.get('mTotal').textContent, '3');
  assert.equal(elements.get('mVisible').textContent, '1');

  const file = {name: 'valid.csv'};
  await elements.get('file').listeners.change({target: {files: [file]}});
  assert.equal(elements.get('provenance').textContent, 'User-supplied data; provenance unverified');
  assert.equal(elements.get('mTotal').textContent, '3');
  assert.equal(elements.get('mAccepted').textContent, '3');
  assert.equal(elements.get('mRejected').textContent, '0');
  assert.equal(elements.get('mDuplicates').textContent, '0');
  assert.equal(elements.get('mVisible').textContent, '3');

  const preservedCount = elements.get('resultCount').textContent;
  const invalidFile = {name: 'invalid.csv'};
  await elements.get('file').listeners.change({target: {files: [invalidFile]}});
  assert.match(elements.get('datasetMessage').textContent, /Upload failed; previous dataset remains displayed\. Request error \(HTTP 400\): Upload must be UTF-8 CSV/);
  assert.equal(elements.get('resultCount').textContent, preservedCount);
  assert.equal(elements.get('mTotal').textContent, '3');
  assert.equal(elements.get('mAccepted').textContent, '3');
  assert.equal(elements.get('mRejected').textContent, '0');
  assert.equal(elements.get('mDuplicates').textContent, '0');
  assert.equal(elements.get('provenance').textContent, 'User-supplied data; provenance unverified');

  elements.get('search').value = 'N20';
  elements.get('search').listeners.input({target: {value: 'N20'}});
  assert.equal(elements.get('mVisible').textContent, '2');
  await elements.get('exportCsv').listeners.click();
  assert.equal(elements.get('announcement').textContent, 'Exported all 2 matching observations.');
  assert.equal(blobs.length, 1);
  const csv = blobs[0].parts[0];
  assert.equal(csv.split('\r\n').length, 3);
  assert.match(csv, /\"'=1\+1\"/);
  assert.match(csv, /\"'=2\+2, \"\"quoted\"\"\"/);
  assert.ok(!csv.includes('N21'));
  assert.equal(createdElements.at(-1).download, 'fire-triage-matching-observations.csv');

  assert.deepEqual(calls.map(call => call.url), [
    'http://127.0.0.1:8010/api/health',
    'http://127.0.0.1:8010/api/sample',
    'http://127.0.0.1:8010/api/upload',
    'http://127.0.0.1:8010/api/upload'
  ]);
  assert.equal(calls[2].options.method, 'POST');
  assert.equal(calls[2].options.body.file, file);
  assert.equal(calls[3].options.method, 'POST');
  assert.equal(calls[3].options.body.file, invalidFile);
});
