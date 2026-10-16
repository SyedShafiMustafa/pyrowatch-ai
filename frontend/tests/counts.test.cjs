const assert = require('node:assert/strict');
const test = require('node:test');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');

class Element {
  constructor(ownerDocument) {
    this.ownerDocument = ownerDocument;
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
  replaceChildren(...nodes) {
    if(this.children.some(node => node.contains?.(this.ownerDocument?.activeElement)))this.ownerDocument.activeElement=this.ownerDocument.body;
    this.children = nodes; this.rows = nodes;
  }
  contains(node) { return this===node || this.children.some(child => child.contains?.(node)); }
  focus() { if(!this.disabled&&this.ownerDocument)this.ownerDocument.activeElement=this; }
  setAttribute(name, value) { this[name] = value; }
  set innerHTML(_) { throw new Error("Unsafe HTML rendering"); }
  scrollIntoView() {}
  get options() { return this.children; }
}

function dashboard(protocol = 'http:', overrides = {}) {
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
      repeat_count: 0, source_line: 2, source_fields: {}, possible_static_source: false,
      persistent_source_status: 'insufficient_history', event_id: 7
    }],
    events: [{event_id: 7, pixels: 1, top_score: 62, peak_frp: 5,
      first_seen: '2026-10-10T00:00:00Z', last_seen: '2026-10-10T00:00:00Z', duration_h: 0,
      lat: -33, lon: 150}],
    intelligence: {
      model: {status: 'unavailable', version: 'phase4-event-iforest-v1', reason: 'model artifact is missing'},
      events: [{event_id: 7,
        trend: {status: 'insufficient_data', reason: 'need at least three valid-FRP acquisition times'},
        anomaly: {status: 'unavailable', model_version: 'phase4-event-iforest-v1', anomaly_score: null, anomaly_flag: null}}]
    },
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
    json: async () => JSON.parse(JSON.stringify(body))
  });
  class Form {
    append(name, value) { this[name] = value; }
  }
  const markers = [], map = {setView() { return this; }, fitBounds() {}, panTo(value) { this.panned = value; }};
  const leaflet = {
    map: () => map,
    tileLayer: () => ({on() {}, addTo() {}}),
    layerGroup: () => ({addTo() {return this;}, clearLayers() {markers.length = 0;}}),
    circleMarker: coords => {const m = {coords, handlers: {}, bindPopup() {}, on(name, fn) {this.handlers[name] = fn;}, addTo() {markers.push(this);}, openPopup() {this.opened = true;}, getLatLng() {return coords;}}; return m;},
    featureGroup: () => ({getBounds: () => ({pad() {return this;}})})
  };
  const mockDocument = {
      getElementById(id) {
        if (!elements.has(id)) elements.set(id, new Element(mockDocument));
        return elements.get(id);
      },
      createElement(tagName) {
        const element = new Element(mockDocument);
        element.tagName = tagName;
        createdElements.push(element);
        return element;
      }
    };
  mockDocument.body=new Element(mockDocument);
  mockDocument.activeElement=mockDocument.body;
  const context = vm.createContext({
    document: mockDocument,
    window: {location: {protocol}, L: overrides.map ? leaflet : undefined},
    L: leaflet,
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
      if (target.endsWith('/api/sample')) return jsonResponse(overrides.sample ?? sample);
      if (target.endsWith('/api/upload')) {
        return options.body.file.name === 'invalid.csv'
          ? jsonResponse({detail: 'Upload must be UTF-8 CSV'}, 400)
          : jsonResponse(overrides.uploaded ?? uploaded);
      }
      return jsonResponse({ok: true});
    }
  });
  // Test-only inspection of the actual closure-owned array, not the cloned fetch fixture.
  vm.runInContext(source.replace('bind();initMap();render();health();',
    'bind();initMap();render();health();globalThis.readLoadedDataset=()=>state.dataset;'), context);
  return {elements, calls, blobs, createdElements, markers, map, document: mockDocument, readLoadedDataset: context.readLoadedDataset};
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
  assert.equal(elements.get('tb').children[0].children[6].textContent, 'Insufficient history');
  const displayed = createdElements.map(element => element.textContent).filter(Boolean).join('\n');
  assert.match(displayed, /Model anomaly analysis: unavailable: model artifact is missing/);
  assert.match(displayed, /Observed FRP trend: insufficient_data/);
  assert.match(displayed, /Anomaly indicator: unavailable \(phase4-event-iforest-v1\)/);

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

test('file URL explains that the dashboard must be served over HTTP', async () => {
  const {elements, calls} = dashboard('file:');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(elements.get('connectionStatus').textContent, 'API unavailable');
  assert.match(elements.get('datasetMessage').textContent, /opened as a local file.*http:\/\/127\.0\.0\.1:8010\//);
  await elements.get('bSample').listeners.click();
  assert.match(elements.get('datasetMessage').textContent, /opened as a local file/);
  assert.equal(calls.length, 0);
});

const descendants = node => [node, ...(node.children || []).flatMap(descendants)];
const content = node => descendants(node).map(n => n.textContent || '').join('\n');
const entries = elements => descendants(elements.get('timelineContent')).filter(n => n.className === 'timeline-entry');
const timelineRows = [
  {time: '2026-10-12 00:00:00+00:00', frp: 9},
  {time: '2026-10-10T00:00:00Z', confidence_raw: '<img src=x onerror=alert(1)>'},
  {time: '2026-10-10T00:00:00Z', confidence_raw: '<img src=x onerror=alert(1)>'},
  {time: null}, {time: 'not a date'}, {time: '2026-02-30T00:00:00Z'},
  {time: '2026-10-10T00:00:00'},
  {time: '2026-10-09T00:00:00Z', event_id: 1}
].map(r => ({event_id: 0, latitude: 10, longitude: 20, satellite: 'N20', instrument: 'VIIRS', score: 50, ...r}));
function payload(rows = timelineRows) {
  return {rows, issues: [], events: [{event_id: 0}, {event_id: 1}, {event_id: 2}],
    ingestion: {accepted: rows.length, rejected: 0, deduplicated: 0, total_records: rows.length, data_kind: 'synthetic'}};
}
function pick(elements, id) {elements.get('timelineEvent').listeners.change({target: {value: id}});}

test('timeline orders all accepted event-0 rows, preserves duplicates and source order, and safely groups invalid times', async () => {
  const supplied = payload(), before = JSON.stringify(supplied);
  const {elements, createdElements} = dashboard('http:', {sample: supplied});
  await elements.get('bSample').listeners.click();
  pick(elements, '0');
  const items = entries(elements);
  assert.equal(items.length, 7);
  assert.match(content(items[0]), /2026-10-10 00:00:00 UTC/);
  assert.match(content(items[1]), /2026-10-10 00:00:00 UTC/);
  assert.match(content(items[2]), /2026-10-12 00:00:00 UTC/);
  assert.match(content(items[2]), /48.000 h/);
  assert.equal(new Set(items.map(n => n.dataset.key)).size, 7);
  assert.match(content(elements.get('timelineContent')), /Time unavailable or invalid/);
  assert.match(content(items[0]), /Raw confidence \(supplied\)\n<img src=x onerror=alert\(1\)>/);
  assert.match(content(items[0]), /FRP \(supplied; API units unspecified\)\nUnavailable/);
  assert.match(content(items[3]), /Raw confidence \(supplied\)\nUnavailable/);
  assert.ok(!createdElements.some(n => n.tagName === 'img'));
  assert.equal(JSON.stringify(supplied), before);
  pick(elements, '2');
  assert.equal(entries(elements).length, 0);
  assert.match(content(elements.get('timelineContent')), /No accepted observations/);
  pick(elements, '1');
  assert.equal(entries(elements).length, 1);
  assert.match(content(entries(elements)[0]), /0.000 h/);
});

test('timeline preserves filters, counts and map/table keys and resets on dataset replacement', async () => {
  const {elements, markers, map} = dashboard('http:', {sample: payload(), uploaded: payload([]), map: true});
  await elements.get('bSample').listeners.click();
  elements.get('frpMin').listeners.input({target: {value: '8'}});
  assert.equal(elements.get('mVisible').textContent, '1');
  const rowKey = elements.get('tb').children[0].dataset.key;
  const view = descendants(elements.get('eventContent')).find(n => n.textContent === 'View timeline');
  view.listeners.click();
  assert.equal(entries(elements).length, 7);
  assert.equal(elements.get('mVisible').textContent, '1');
  assert.equal(elements.get('mAccepted').textContent, '8');
  assert.equal(elements.get('eventFilter').value, '');
  assert.equal(markers.length, 1);
  assert.equal(descendants(entries(elements)[0]).find(n => n.tagName === 'button').disabled, true);
  const visible = entries(elements).find(n => n.dataset.key === rowKey);
  descendants(visible).find(n => n.tagName === 'button').listeners.click();
  assert.equal(elements.get('tb').children[0]['aria-selected'], 'true');
  assert.equal(markers[0].opened, true);
  assert.deepEqual(Array.from(map.panned), [10, 20]);
  elements.get('tb').children[0].listeners.click();
  assert.equal(elements.get('timelineEvent').value, '0');
  markers[0].handlers.click();
  assert.equal(elements.get('timelineEvent').value, '0');
  assert.equal(elements.get('tb').children[0].dataset.key, rowKey);
  await elements.get('file').listeners.change({target: {files: [{name: 'empty.csv'}]}});
  assert.equal(entries(elements).length, 0);
  assert.equal(elements.get('timelineEvent').value, '');
  assert.match(content(elements.get('timelineContent')), /Select an event/);
  assert.match(content(elements.get('detailContent')), /Select a table row/);
  assert.equal(markers.length, 0);
});


test('event filter and event-card selection reveal the matching timeline without clearing other filters', async () => {
  const {elements} = dashboard('http:', {sample: payload()});
  await elements.get('bSample').listeners.click();
  elements.get('frpMin').listeners.input({target: {value: '8'}});
  elements.get('eventFilter').listeners.change({target: {value: '1'}});
  assert.equal(elements.get('timelineEvent').value, '1');
  assert.equal(entries(elements).length, 1);
  assert.equal(elements.get('mVisible').textContent, '0');
  const filter = descendants(elements.get('eventContent')).find(n => n.textContent === 'Filter to event');
  filter.listeners.click();
  assert.equal(elements.get('timelineEvent').value, '0');
  assert.equal(entries(elements).length, 7);
  assert.equal(elements.get('mVisible').textContent, '1');
});


const buttonFor = item => descendants(item).find(n => n.tagName === 'button');
test('timeline restores focus by duplicate occurrence key for event 0 without stealing unrelated focus', async () => {
  const {elements, document} = dashboard('http:', {sample: payload()});
  await elements.get('bSample').listeners.click();
  assert.equal(document.activeElement, document.body);
  elements.get('timelineEvent').focus();
  pick(elements, '0');
  assert.equal(document.activeElement, elements.get('timelineEvent'));
  assert.equal(elements.get('timelineEvent').value, '0'); // Event id 0 must be a first-class, selectable event.
  const item = entries(elements)[1], key = item.dataset.key, oldButton = buttonFor(item);
  oldButton.focus();
  oldButton.listeners.click(); // Native Enter/Space activation dispatches click; no custom key handler.
  const replacement = buttonFor(entries(elements).find(n => n.dataset.key === key));
  assert.notEqual(replacement, oldButton);
  assert.equal(document.activeElement, replacement);
  assert.equal(entries(elements).find(n => buttonFor(n) === document.activeElement).dataset.key, key); // Restored by the stable observation key, not a list position.
  assert.equal(replacement['aria-pressed'], 'true');
  assert.notEqual(document.activeElement, buttonFor(entries(elements)[0]));
  elements.get('timelineEvent').focus();
  pick(elements, '1');
  assert.equal(document.activeElement, elements.get('timelineEvent'));
});

test('replacement never restores focus to stale observations even with reused keys', async () => {
  const {elements, document} = dashboard('http:', {sample: payload(), uploaded: payload()});
  await elements.get('bSample').listeners.click();
  pick(elements, '0');
  const stale = buttonFor(entries(elements)[0]);
  stale.focus();
  await elements.get('file').listeners.change({target: {files: [{name: 'replacement.csv'}]}});
  assert.equal(document.activeElement, document.body);
  assert.equal(entries(elements).length, 0);
  elements.get('timelineEvent').focus();
  stale.listeners.click();
  assert.equal(document.activeElement, elements.get('timelineEvent'));
  assert.equal(entries(elements).length, 0);
});

test('actual loaded dataset stays unchanged, including tied scores and zero versus missing contributions', async () => {
  const fixture = payload(timelineRows.map((r, i) => i===0 ? {...r,c_frp:0} : {...r}));
  const before = JSON.stringify(fixture.rows);
  const {elements, readLoadedDataset} = dashboard('http:', {sample: fixture});
  await elements.get('bSample').listeners.click();
  const loaded = readLoadedDataset();
  assert.equal(JSON.stringify(loaded), before);
  pick(elements, '0');
  for(const item of entries(elements).slice(0,3))buttonFor(item).listeners.click();
  assert.equal(readLoadedDataset(), loaded);
  assert.equal(JSON.stringify(readLoadedDataset()), before);
  assert.equal(loaded[0].c_frp, 0);
  assert.equal(Object.hasOwn(loaded[1], 'c_frp'), false);
  // All tied observations remain independently selectable; there is no Phase 5.2 breakdown yet.
  assert.equal(entries(elements).length, 7);
  assert.equal(new Set(entries(elements).map(n=>n.dataset.key)).size, 7);
});

test('timeline focus follows the occurrence key, not a sibling duplicate when identity fields collide', async () => {
  // All three rows share every field the key builder uses, so only the occurrence-in-load suffix separates them.
  const twin = {event_id: 3, latitude: 1, longitude: 2, time: '2026-01-01T00:00:00Z',
    satellite: 'N20', instrument: 'VIIRS', score: 40, frp: 4, source_line: 5};
  const {elements, document} = dashboard('http:', {sample: payload([{...twin}, {...twin}, {...twin}])});
  await elements.get('bSample').listeners.click();
  pick(elements, '3');
  assert.equal(elements.get('timelineEvent').value, '3');
  const items = entries(elements);
  assert.equal(items.length, 3);
  assert.equal(new Set(items.map(n => n.dataset.key)).size, 3);
  const target = items[2], key = target.dataset.key;
  assert.notEqual(key, items[0].dataset.key);
  assert.notEqual(key, items[1].dataset.key);
  const oldButton = buttonFor(target);
  oldButton.focus();
  oldButton.listeners.click(); // Native Enter/Space activation dispatches a click; no custom key handler is added.
  assert.equal(entries(elements).length, 3);
  const replacement = buttonFor(entries(elements).find(n => n.dataset.key === key));
  assert.notEqual(replacement, oldButton);
  assert.equal(document.activeElement, replacement);
  assert.equal(entries(elements).find(n => buttonFor(n) === document.activeElement).dataset.key, key);
  assert.notEqual(document.activeElement, buttonFor(entries(elements)[0]));
  assert.notEqual(document.activeElement, buttonFor(entries(elements)[1]));
});

test('timeline membership stays independent of table filters and tied observations never collapse', async () => {
  const {elements} = dashboard('http:', {sample: payload()});
  await elements.get('bSample').listeners.click();
  pick(elements, '0');
  assert.equal(entries(elements).length, 7);
  const keys = new Set(entries(elements).map(n => n.dataset.key));
  assert.equal(keys.size, 7); // Seven tied-score (50) observations remain distinct.
  // Filter the table down to nothing: the timeline must still list every accepted event-0 observation.
  elements.get('frpMin').listeners.input({target: {value: '1000'}});
  assert.equal(elements.get('mVisible').textContent, '0');
  assert.equal(entries(elements).length, 7);
  assert.equal(new Set(entries(elements).map(n => n.dataset.key)).size, 7);
  assert.ok(entries(elements).every(item => buttonFor(item).disabled === true)); // Hidden by filters, not dropped.
  // Clearing filters re-enables them without changing membership or order.
  elements.get('resetFilters').listeners.click();
  assert.equal(entries(elements).length, 7);
  assert.ok(entries(elements).every(item => buttonFor(item).disabled === false));
});
