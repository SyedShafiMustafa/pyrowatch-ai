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
const breakdownText = elements => content(elements.get('breakdownContent'));
const tieButtons = elements => descendants(elements.get('breakdownContent')).filter(n => n.tagName === 'button');
function breakdownRows() {
  return [
    // row A: every factor present; brightness measurement is present at the 300 K reference -> genuine zero.
    {event_id: 0, latitude: 10, longitude: 20, time: '2026-10-10T00:00:00Z', satellite: 'N20', instrument: 'VIIRS',
     confidence: 1, frp: 5, brightness: 300, repeat_count: 0, score: 90, why: '+25.0 frp; +20.0 confidence',
     f_recency: 1, f_confidence: 1, f_frp: 1, f_repeats: 0, f_brightness: 0,
     c_recency: 25, c_confidence: 20, c_frp: 25, c_repeats: 0, c_brightness: 0, score_missing_factors: []},
    // row B: tied maximum; frp measurement is missing so the backend assigns zero contribution.
    {event_id: 0, latitude: 10, longitude: 20, time: '2026-10-10T01:00:00Z', satellite: 'N20', instrument: 'VIIRS',
     confidence: 0.5, frp: null, brightness: 350, repeat_count: 1, score: 90, why: '+20.0 confidence',
     f_recency: 1, f_confidence: 0.5, f_frp: 0, f_repeats: 0.25, f_brightness: 0.5,
     c_recency: 25, c_confidence: 10, c_frp: 0, c_repeats: 5, c_brightness: 5, score_missing_factors: ['frp']},
    // row C: lower score; some contribution fields are absent and a normalized value is unavailable.
    {event_id: 0, latitude: 10, longitude: 20, time: '2026-10-10T02:00:00Z', satellite: 'N20', instrument: 'VIIRS',
     confidence: null, frp: 0, brightness: null, repeat_count: 0, score: 20, why: 'partial evidence',
     f_recency: 1, f_confidence: null, f_frp: 0, f_repeats: null, f_brightness: null,
     c_recency: 20, c_confidence: null, c_frp: 0, c_repeats: 5, c_brightness: null, score_missing_factors: ['confidence', 'brightness']}
  ];
}
function breakdownPayload(rows = breakdownRows(), events = [{event_id: 0, pixels: 3, top_score: 90, peak_frp: 5,
  first_seen: '2026-10-10T00:00:00Z', last_seen: '2026-10-10T02:00:00Z', duration_h: 2, lat: 10, lon: 20}]) {
  return {rows, issues: [], events, ingestion: {accepted: rows.length, rejected: 0, deduplicated: 0, total_records: rows.length, data_kind: 'synthetic'}};
}

test('priority breakdown renders all five contribution factors for the selected observation', async () => {
  const {elements} = dashboard('http:', {sample: breakdownPayload()});
  await elements.get('bSample').listeners.click();
  elements.get('tb').children[0].listeners.click();
  const text = breakdownText(elements);
  assert.equal(elements.get('timelineEvent').value, '0');
  assert.ok(text.includes('Event review priority: 90.00 / 100'), text);
  assert.ok(text.includes('Highest observation score within this event'));
  assert.ok(text.includes('Observation review priority: 90.00 / 100'));
  assert.ok(text.includes('Recency: 25.00 pts'));
  assert.ok(text.includes('Confidence: 20.00 pts'));
  assert.ok(text.includes('Fire radiative power (FRP): 25.00 pts'));
  assert.ok(text.includes('Repeat observations: 0.00 pts'));
  assert.ok(text.includes('Brightness: 0.00 pts'));
  assert.ok(text.includes('normalized f_recency: 1.000'));
  assert.ok(text.includes('Backend explanation: +25.0 frp'));
});

test('priority breakdown works for event id 0', async () => {
  const {elements} = dashboard('http:', {sample: breakdownPayload()});
  await elements.get('bSample').listeners.click();
  pick(elements, '0');
  assert.equal(elements.get('timelineEvent').value, '0');
  assert.ok(breakdownText(elements).includes('Event review priority: 90.00 / 100'));
});

test('priority breakdown distinguishes genuine zeros from missing measurements', async () => {
  const {elements} = dashboard('http:', {sample: breakdownPayload()});
  await elements.get('bSample').listeners.click();
  elements.get('tb').children[0].listeners.click(); // row A: brightness present at reference -> genuine zero
  assert.ok(breakdownText(elements).includes('Genuine zero: the measurement is present but contributes 0.00 points'));
  elements.get('tb').children[1].listeners.click(); // row B: frp measurement missing -> backend zero
  const text = breakdownText(elements);
  assert.ok(text.includes('Fire radiative power (FRP): 0.00 pts'));
  assert.ok(text.includes('The raw measurement is missing, so the backend assigned 0 contribution'));
});

test('priority breakdown reports missing contribution fields and unavailable normalized values', async () => {
  const {elements} = dashboard('http:', {sample: breakdownPayload()});
  await elements.get('bSample').listeners.click();
  elements.get('tb').children[2].listeners.click(); // row C
  const text = breakdownText(elements);
  assert.ok(text.includes('Confidence: Unavailable'));
  assert.ok(text.includes('Brightness: Unavailable'));
  assert.ok(text.includes('not returned by this API response'));
  assert.ok(text.includes('Contribution provided, but no normalized value was returned'));
  assert.ok(text.includes('Repeat observations: 5.00 pts'));
});

test('priority breakdown separates the event maximum from the selected observation score', async () => {
  const {elements} = dashboard('http:', {sample: breakdownPayload()});
  await elements.get('bSample').listeners.click();
  elements.get('tb').children[2].listeners.click(); // row C (score 20)
  const text = breakdownText(elements);
  assert.ok(text.includes('Event review priority: 90.00 / 100'));
  assert.ok(text.includes('Observation review priority: 20.00 / 100'));
  assert.ok(text.includes('This is not the event maximum; the highest score in event 0 is 90.00'));
});

test('priority breakdown lists every observation tied for the event maximum and lets each be inspected', async () => {
  const {elements, document} = dashboard('http:', {sample: breakdownPayload()});
  await elements.get('bSample').listeners.click();
  elements.get('tb').children[0].listeners.click(); // row A, tied at 90 with row B
  assert.ok(breakdownText(elements).includes('2 observations tie for this maximum'));
  let buttons = tieButtons(elements);
  assert.equal(buttons.length, 2);
  assert.equal(buttons[0]['aria-pressed'], 'true');
  assert.equal(buttons[1]['aria-pressed'], 'false');
  buttons[1].focus();
  buttons[1].listeners.click();
  const text = breakdownText(elements);
  assert.ok(text.includes('The raw measurement is missing, so the backend assigned 0 contribution'));
  assert.ok(text.includes('Observation review priority: 90.00 / 100'));
  const after = tieButtons(elements);
  assert.equal(after[1]['aria-pressed'], 'true');
  assert.equal(after[0]['aria-pressed'], 'false');
  assert.equal(document.activeElement, after[1]); // focus follows the observation key across the re-render
});

test('priority breakdown keeps the event maximum independent of table filters', async () => {
  const {elements} = dashboard('http:', {sample: breakdownPayload()});
  await elements.get('bSample').listeners.click();
  elements.get('frpMin').listeners.input({target: {value: '1000'}}); // hide every observation from the table
  assert.equal(elements.get('mVisible').textContent, '0');
  pick(elements, '0'); // the event maximum must come from the full event, not the filtered table
  const text = breakdownText(elements);
  assert.ok(text.includes('Event review priority: 90.00 / 100'));
  assert.ok(text.includes('2 observations tie for this maximum'));
  assert.equal(tieButtons(elements).length, 2);
});

test('priority breakdown clears on dataset replacement', async () => {
  const {elements} = dashboard('http:', {sample: breakdownPayload(), uploaded: payload([])});
  await elements.get('bSample').listeners.click();
  elements.get('tb').children[0].listeners.click();
  assert.ok(breakdownText(elements).includes('Recency: 25.00 pts'));
  await elements.get('file').listeners.change({target: {files: [{name: 'empty.csv'}]}});
  const text = breakdownText(elements);
  assert.ok(text.includes('Select an event, table row or map marker to see the highest observation score within it'));
  assert.ok(text.includes('Select an observation in the table, timeline or map to see its score contributions'));
  assert.equal(descendants(elements.get('breakdownContent')).filter(n => n.className === 'factor-entry').length, 0);
  assert.equal(tieButtons(elements).length, 0);
});

test('priority breakdown renders untrusted text safely', async () => {
  const rows = breakdownRows();
  rows[0].why = '<img src=x onerror=alert(1)>';
  const {elements, createdElements} = dashboard('http:', {sample: breakdownPayload(rows)});
  await elements.get('bSample').listeners.click();
  elements.get('tb').children[0].listeners.click();
  assert.ok(breakdownText(elements).includes('<img src=x onerror=alert(1)>'));
  assert.ok(!createdElements.some(n => n.tagName === 'img'));
});

test('priority breakdown does not disturb the Phase 5.1 timeline or its focus restoration', async () => {
  const {elements, document} = dashboard('http:', {sample: breakdownPayload()});
  await elements.get('bSample').listeners.click();
  pick(elements, '0');
  assert.equal(entries(elements).length, 3);
  const item = entries(elements)[1], key = item.dataset.key, oldButton = buttonFor(item);
  oldButton.focus();
  oldButton.listeners.click();
  const replacement = buttonFor(entries(elements).find(n => n.dataset.key === key));
  assert.notEqual(replacement, oldButton);
  assert.equal(document.activeElement, replacement);
  assert.equal(entries(elements).find(n => buttonFor(n) === document.activeElement).dataset.key, key);
});
const evidenceText = elements => content(elements.get('evidenceContent'));
function evidenceRows() {
  return [
    // row A: complete measurements; brightness at the 300 K reference -> genuine zero.
    {event_id: 0, latitude: 10, longitude: 20, time: '2026-10-10T00:00:00Z', satellite: 'N20', instrument: 'VIIRS',
     confidence: 1, frp: 5, brightness: 300, repeat_count: 2, score: 80, why: '+25.0 frp; +20.0 confidence',
     f_recency: 1, f_confidence: 1, f_frp: 1, f_repeats: 0.5, f_brightness: 0,
     c_recency: 25, c_confidence: 20, c_frp: 25, c_repeats: 10, c_brightness: 0, score_missing_factors: [],
     possible_static_source: false, persistent_source_status: 'not_flagged',
     persistent_source_evidence: {distinct_times: 4, distinct_days: 3, coverage_days: 12.5, first_seen: '2026-09-20T00:00:00Z',
       last_seen: '2026-10-02T00:00:00Z', spatial_bin_degrees: 0.01, min_days: 10, min_distinct_times: 0, min_coverage_days: 0, lookback_days: null}},
    // row C: recurrence flagged; the repeats contribution field is absent from the response.
    {event_id: 0, latitude: 10, longitude: 22, time: '2026-10-10T02:00:00Z', satellite: 'N20', instrument: 'VIIRS',
     confidence: 0.5, frp: 2, brightness: 400, repeat_count: 5, score: 40, why: 'partial evidence',
     f_recency: 1, f_confidence: 0.5, f_frp: 0.5, f_repeats: null, f_brightness: 0.5,
     c_recency: 20, c_confidence: 10, c_frp: 10, c_repeats: null, c_brightness: 5, score_missing_factors: [],
     possible_static_source: true, persistent_source_status: 'possible_persistent_source',
     persistent_source_evidence: {distinct_times: 12, distinct_days: 11, coverage_days: 40, first_seen: '2026-08-01T00:00:00Z',
       last_seen: '2026-09-10T00:00:00Z', spatial_bin_degrees: 0.01, min_days: 10, min_distinct_times: 0, min_coverage_days: 0, lookback_days: null}},
    // row B: measurements missing; recurrence history insufficient.
    {event_id: 0, latitude: 10, longitude: 21, time: '2026-10-10T01:00:00Z', satellite: 'N20', instrument: 'VIIRS',
     confidence: null, frp: null, brightness: null, repeat_count: 0, score: 10, why: '',
     f_recency: 0.5, f_confidence: 0, f_frp: 0, f_repeats: 0, f_brightness: 0,
     c_recency: 10, c_confidence: 0, c_frp: 0, c_repeats: 0, c_brightness: 0, score_missing_factors: ['confidence', 'frp', 'brightness'],
     possible_static_source: false, persistent_source_status: 'insufficient_history',
     persistent_source_evidence: {reason: 'no historical archive', distinct_times: 0, distinct_days: 0, coverage_days: 0}}
  ];
}
function evidenceIntel(over = {}) {
  const trend = over.trend === undefined
    ? {status: 'insufficient_data', frp_change_mw: null, frp_change_fraction: null, early_detections_per_time: null,
       late_detections_per_time: null, distinct_observation_times: 3, span_h: 2,
       reason: 'need at least three valid-FRP acquisition times over six hours',
       sampling_limitation: 'observation opportunities and missed overpasses are unknown'}
    : over.trend;
  const anomaly = over.anomaly === undefined
    ? {event_id: 0, status: 'unavailable', model_version: 'phase4-event-iforest-v1', anomaly_score: null, anomaly_flag: null}
    : over.anomaly;
  const model = over.model === undefined
    ? {status: 'unavailable', version: 'phase4-event-iforest-v1', reason: 'model artifact is missing'}
    : over.model;
  return {model, events: [{event_id: 0, first_seen: '2026-10-10T00:00:00Z', last_seen: '2026-10-10T02:00:00Z',
    features: {detection_count: 3, distinct_observation_times: 3, duration_h: 2, peak_frp: 5, mean_frp: 3.5,
      mean_confidence: 0.75, peak_brightness: 400, mean_brightness: 350, frp_delta_mw: null,
      detection_frequency_delta: null, observed_footprint_delta_km2: null, median_revisit_h: null},
    missing_features: ['frp_delta_mw', 'detection_frequency_delta', 'observed_footprint_delta_km2', 'median_revisit_h'],
    trend, anomaly}]};
}
function evidencePayload(rows = evidenceRows(), intelligence = evidenceIntel()) {
  return {rows, issues: [], events: [{event_id: 0, pixels: 3, top_score: 80, peak_frp: 5, first_seen: '2026-10-10T00:00:00Z',
      last_seen: '2026-10-10T02:00:00Z', duration_h: 2, lat: 10, lon: 20}], intelligence,
    ingestion: {accepted: rows.length, rejected: 0, deduplicated: 0, total_records: rows.length, data_kind: 'synthetic'}};
}

test('evidence panel lists supporting measurements with supplied versus derived labels', async () => {
  const {elements} = dashboard('http:', {sample: evidencePayload()});
  await elements.get('bSample').listeners.click();
  elements.get('tb').children[0].listeners.click(); // row A
  const t = evidenceText(elements);
  assert.equal(elements.get('timelineEvent').value, '0');
  assert.ok(t.includes('Supporting evidence'));
  assert.ok(t.includes('Observation review priority (derived; uncalibrated)'));
  assert.ok(t.includes('Satellite (supplied)'));
  assert.ok(t.includes('N20'));
  assert.ok(t.includes('Instrument (supplied)'));
  assert.ok(t.includes('Raw confidence (supplied)'));
  assert.ok(t.includes('Normalized confidence (derived by the API)'));
  assert.ok(t.includes('FRP (supplied; API units unspecified)'));
  assert.ok(t.includes('Brightness (supplied; API units unspecified)'));
  assert.ok(t.includes('Other nearby detections within ±72 h (derived; not the event row count)'));
  assert.ok(t.includes('Contribution points reported by the API'));
  assert.ok(t.includes('Backend explanation: +25.0 frp'));
});

test('evidence panel distinguishes genuine zeros from missing measurements', async () => {
  const {elements} = dashboard('http:', {sample: evidencePayload()});
  await elements.get('bSample').listeners.click();
  elements.get('tb').children[0].listeners.click(); // row A: brightness present at reference -> genuine zero
  assert.ok(evidenceText(elements).includes('measurement present with a genuine zero contribution'));
  elements.get('tb').children[2].listeners.click(); // row B: measurements missing
  const t = evidenceText(elements);
  assert.ok(t.includes('measurement missing; the backend assigns 0 contribution'));
  assert.ok(t.includes('Observation factors the API marks missing'));
  assert.ok(t.includes('confidence, frp, brightness'));
});

test('evidence panel does not fabricate reasons for missing fields', async () => {
  const {elements} = dashboard('http:', {sample: evidencePayload()});
  await elements.get('bSample').listeners.click();
  elements.get('tb').children[2].listeners.click(); // row B
  const t = evidenceText(elements);
  assert.ok(t.includes('does not state why each is absent, so the reason was not provided'));
  assert.ok(t.includes('without a per-feature reason, so the reason was not provided'));
  assert.ok(!t.includes('because'));
});

test('evidence panel reports trend status, insufficiency and sampling limitations', async () => {
  const {elements} = dashboard('http:', {sample: evidencePayload()});
  await elements.get('bSample').listeners.click();
  elements.get('tb').children[0].listeners.click();
  const t = evidenceText(elements);
  assert.ok(t.includes('Trend: Insufficient data for a trend'));
  assert.ok(t.includes('need at least three valid-FRP acquisition times over six hours'));
  assert.ok(t.includes('Sampling limitation: observation opportunities and missed overpasses are unknown'));
  assert.ok(t.includes('A measured change in mean FRP is not confirmed physical fire spread'));
  // An available trend keeps its own status and numbers.
  const stable = dashboard('http:', {sample: evidencePayload(evidenceRows(), evidenceIntel({trend: {status: 'stable',
    frp_change_mw: 0.5, frp_change_fraction: 0.05, early_detections_per_time: 2, late_detections_per_time: 2,
    distinct_observation_times: 4, span_h: 10, reason: 'observed first-to-last mean FRP; gaps and missed passes are unobserved',
    sampling_limitation: 'observation opportunities and missed overpasses are unknown'}}))});
  await stable.elements.get('bSample').listeners.click();
  stable.elements.get('tb').children[0].listeners.click();
  const st = evidenceText(stable.elements);
  assert.ok(st.includes('Trend: FRP stable'));
  assert.ok(st.includes('Observed mean-FRP change (MW; API units unspecified)'));
  assert.ok(st.includes('0.500'));
});

test('evidence panel distinguishes recurrence states and history evidence', async () => {
  const {elements} = dashboard('http:', {sample: evidencePayload()});
  await elements.get('bSample').listeners.click();
  elements.get('tb').children[0].listeners.click(); // row A: not flagged
  assert.ok(evidenceText(elements).includes('Historical recurrence: Recurrence not flagged'));
  assert.ok(evidenceText(elements).includes('Distinct historical days'));
  elements.get('tb').children[2].listeners.click(); // row B: insufficient history
  assert.ok(evidenceText(elements).includes('Historical recurrence: Insufficient history to assess recurrence'));
  assert.ok(evidenceText(elements).includes('Reported evidence reason: no historical archive'));
  elements.get('tb').children[1].listeners.click(); // row C: flagged
  assert.ok(evidenceText(elements).includes('Historical recurrence: Recurrence flagged (possible persistent source)'));
});

test('evidence panel distinguishes flagged, not-flagged, unavailable and incompatible anomaly states', async () => {
  const base = dashboard('http:', {sample: evidencePayload()});
  await base.elements.get('bSample').listeners.click();
  base.elements.get('tb').children[0].listeners.click();
  const bt = evidenceText(base.elements);
  assert.ok(bt.includes('Anomaly indicator: Unavailable — analysis could not be produced'));
  assert.ok(bt.includes('Unavailable anomaly output is not evidence that no anomaly exists'));
  assert.ok(bt.includes('Anomaly model: Unavailable (phase4-event-iforest-v1) — model artifact is missing'));

  const flagged = dashboard('http:', {sample: evidencePayload(evidenceRows(), evidenceIntel({
    anomaly: {event_id: 0, status: 'available', model_version: 'phase4-event-iforest-v1', anomaly_score: 0.42, anomaly_flag: true},
    model: {status: 'available', version: 'phase4-event-iforest-v1', reason: null}}))});
  await flagged.elements.get('bSample').listeners.click();
  flagged.elements.get('tb').children[0].listeners.click();
  const ft = evidenceText(flagged.elements);
  assert.ok(ft.includes('Anomaly indicator: Anomaly flagged'));
  assert.ok(ft.includes('Anomaly model: Available (phase4-event-iforest-v1)'));
  assert.ok(ft.includes('not a fire probability'));

  const notFlagged = dashboard('http:', {sample: evidencePayload(evidenceRows(), evidenceIntel({
    anomaly: {event_id: 0, status: 'available', model_version: 'phase4-event-iforest-v1', anomaly_score: -0.1, anomaly_flag: false}}))});
  await notFlagged.elements.get('bSample').listeners.click();
  notFlagged.elements.get('tb').children[0].listeners.click();
  assert.ok(evidenceText(notFlagged.elements).includes('Anomaly indicator: No anomaly flagged by this model'));

  const incompatible = dashboard('http:', {sample: evidencePayload(evidenceRows(), evidenceIntel({
    model: {status: 'unavailable', version: 'phase4-event-iforest-v1', reason: 'event features are incompatible with model'}}))});
  await incompatible.elements.get('bSample').listeners.click();
  incompatible.elements.get('tb').children[0].listeners.click();
  assert.ok(evidenceText(incompatible.elements).includes('event features are incompatible with model'));
});

test('evidence panel works for event id 0', async () => {
  const {elements} = dashboard('http:', {sample: evidencePayload()});
  await elements.get('bSample').listeners.click();
  pick(elements, '0');
  assert.equal(elements.get('timelineEvent').value, '0');
  assert.ok(evidenceText(elements).includes('Event review priority: 80.00 / 100'));
});

test('evidence panel stays synchronized with the timeline and priority breakdown', async () => {
  const {elements, document} = dashboard('http:', {sample: evidencePayload()});
  await elements.get('bSample').listeners.click();
  pick(elements, '0');
  assert.ok(entries(elements).length === 3);
  const item = entries(elements)[1], key = item.dataset.key, btn = buttonFor(item);
  btn.focus();
  btn.listeners.click();
  assert.ok(breakdownText(elements).includes('Observation review priority:'));
  assert.ok(evidenceText(elements).includes('Supporting evidence'));
  assert.equal(elements.get('timelineEvent').value, '0');
  assert.equal(entries(elements).find(n => buttonFor(n) === document.activeElement).dataset.key, key);
});

test('evidence panel clears on dataset replacement', async () => {
  const {elements} = dashboard('http:', {sample: evidencePayload(), uploaded: payload([])});
  await elements.get('bSample').listeners.click();
  elements.get('tb').children[0].listeners.click();
  assert.ok(evidenceText(elements).includes('Supporting evidence'));
  await elements.get('file').listeners.change({target: {files: [{name: 'empty.csv'}]}});
  const t = evidenceText(elements);
  assert.ok(t.includes('Select an event, table row or map marker to see its supporting evidence'));
  assert.ok(t.includes('Select an observation to classify each scoring factor'));
  assert.equal(descendants(elements.get('evidenceContent')).filter(n => n.className === 'evidence-factor').length, 0);
});

test('evidence panel keeps the event evidence independent of table filters', async () => {
  const {elements} = dashboard('http:', {sample: evidencePayload()});
  await elements.get('bSample').listeners.click();
  elements.get('frpMin').listeners.input({target: {value: '1000'}});
  assert.equal(elements.get('mVisible').textContent, '0');
  pick(elements, '0');
  const t = evidenceText(elements);
  assert.ok(t.includes('Event review priority: 80.00 / 100'));
  assert.ok(t.includes('Trend: Insufficient data for a trend'));
});

test('evidence panel renders untrusted API text safely', async () => {
  const rows = evidenceRows();
  rows[0].why = '<img src=x onerror=alert(1)>';
  rows[0].persistent_source_evidence.reason = '<img src=x onerror=alert(1)>';
  const intel = evidenceIntel({trend: {status: 'insufficient_data', frp_change_mw: null, frp_change_fraction: null,
    early_detections_per_time: null, late_detections_per_time: null, distinct_observation_times: 1, span_h: 0,
    reason: '<img src=x onerror=alert(1)>', sampling_limitation: 'unknown'}});
  const {elements, createdElements} = dashboard('http:', {sample: evidencePayload(rows, intel)});
  await elements.get('bSample').listeners.click();
  elements.get('tb').children[0].listeners.click();
  const t = evidenceText(elements);
  assert.ok(t.includes('<img src=x onerror=alert(1)>'));
  assert.ok(!createdElements.some(n => n.tagName === 'img'));
});

test('evidence panel carries status as text and preserves timeline keyboard focus', async () => {
  const {elements, document} = dashboard('http:', {sample: evidencePayload()});
  await elements.get('bSample').listeners.click();
  pick(elements, '0');
  assert.ok(evidenceText(elements).includes('Trend: Insufficient data for a trend')); // meaning is in the text, not colour alone
  const item = entries(elements)[0], key = item.dataset.key, oldButton = buttonFor(item);
  oldButton.focus();
  oldButton.listeners.click();
  const replacement = buttonFor(entries(elements).find(n => n.dataset.key === key));
  assert.notEqual(replacement, oldButton);
  assert.equal(document.activeElement, replacement);
});

test('evidence panel makes no calibrated-probability, confirmation or spread claim', async () => {
  const {elements} = dashboard('http:', {sample: evidencePayload()});
  await elements.get('bSample').listeners.click();
  elements.get('tb').children[0].listeners.click();
  const t = evidenceText(elements);
  assert.ok(t.includes('uncalibrated heuristic, not a fire probability'));
  assert.ok(t.includes('do not confirm a wildfire or its cause'));
  assert.ok(t.includes('not confirmed physical fire spread'));
  assert.ok(!t.includes('calibrated probability'));
  assert.ok(!t.includes('probability of fire'));
});

test('evidence panel preserves the Phase 5.2 breakdown and Phase 3 table behaviour', async () => {
  const {elements} = dashboard('http:', {sample: evidencePayload()});
  await elements.get('bSample').listeners.click();
  elements.get('tb').children[0].listeners.click();
  assert.ok(breakdownText(elements).includes('Event review priority: 80.00 / 100'));
  assert.ok(breakdownText(elements).includes('Observation review priority: 80.00 / 100'));
  assert.equal(elements.get('tb').children.length, 3);
  assert.equal(elements.get('resultCount').textContent, '3 matching observations from 3 accepted observations.');
});
