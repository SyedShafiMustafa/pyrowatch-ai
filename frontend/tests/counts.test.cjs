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
    this.tagName = '';
    this.nodeType = 1;
  }
  addEventListener(name, fn) { this.listeners[name] = fn; }
  append(...nodes) { this.children.push(...nodes); }
  add(node) { this.children.push(node); }
  click() { this.clicked = true; }
  replaceChildren(...nodes) { this.children = nodes; this.rows = nodes; }
  setAttribute(name, value) { this[name] = value; }
  removeAttribute(name) { delete this[name]; }
  hasAttribute(name) { return Object.hasOwn(this, name); }
  scrollIntoView() {}
  focus() { this.focused = true; if(this.ownerDocument)this.ownerDocument.activeElement=this; }
  querySelectorAll(selector) {
    const children = this.children.flatMap(child => [child, ...(child.querySelectorAll?.('*') || [])]);
    if(selector==='*')return children;
    if(selector==='.event-history-row')return children.filter(child=>child.className==='event-history-row');
    if(selector==='button')return children.filter(child=>child.tagName==='button');
    return [];
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  remove() { this.removed = true; }
  get lastChild() { return this.children.at(-1); }
  get options() { return this.children; }
}

function dashboard(sampleOverride = null, protocol = 'http:', workspace = false, responseOverride = null) {
  const elements = new Map();
  const calls = [];
  const blobs = [];
  const createdElements = [];
  const documentListeners = {};
  const sample = {
    issues: ['schema warning', 'duplicate notice'],
    rows: [{
      latitude: -33, longitude: 150, time: '2026-10-10T00:00:00Z',
      satellite: 'N20', instrument: 'VIIRS', confidence_raw: 'h',
      confidence: 1, frp: 5, score: 62, why: 'backend explanation', event_id: 7,
      f_recency: 0.2, f_confidence: 1, f_frp: 0.3, f_repeats: 0, f_brightness: 0.4,
      c_recency: 5, c_confidence: 20, c_frp: 7.5, c_repeats: 0, c_brightness: 4,
      repeat_count: 0, source_line: 2, source_fields: {}, possible_static_source: false
    }],
    events: [{event_id: 7, pixels: 1, first_seen: '2026-10-10T00:00:00Z', last_seen: '2026-10-10T00:00:00Z', top_score: 62, peak_frp: 5, lat: -33, lon: 150}],
    intelligence: {
      model: {status: 'unavailable', reason: 'model artifact is missing'},
      events: [{event_id: 7, features: {detection_count: 1}, trend: {status: 'insufficient_data', reason: 'not enough acquisition times', span_h: 0}, anomaly: {status: 'unavailable', anomaly_score: null}}]
    },
    weights: {recency: 0.25, confidence: 0.2, frp: 0.25, repeats: 0.2, brightness: 0.1},
    evaluation: {
      triage_score: {'p@10': 0.7, 'p@25': 0.6},
      frp_only: {'p@10': 0.6, 'p@25': 0.5},
      n_labelled: 20,
      interpretation: 'descriptive ranking check; labels require independent provenance'
    },
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
  const samplePayload = sampleOverride || sample;
  const uploaded = {
    ...sample,
    rows: [
      {...sample.rows[0], confidence_raw: '=1+1', why: '=2+2, \"quoted\"'},
      {...sample.rows[0], latitude: -34, longitude: 151, time: '2026-10-11T00:00:00Z', satellite: 'N20', source_line: 3, score: 70, f_frp: 0.9},
      {...sample.rows[0], latitude: -35, longitude: 152, time: '2026-10-12T00:00:00Z', satellite: 'N21', source_line: 4, score: 60, f_frp: 0.1}
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
  const testDocument = {
      activeElement: null,
      addEventListener(name, fn) { documentListeners[name] = fn; },
      createTextNode(text) { return {textContent: text}; },
      getElementById(id) {
        if (!elements.has(id)) { const node=new Element(); node.ownerDocument=testDocument; elements.set(id,node); }
        return elements.get(id);
      },
      createElement(tagName) {
        const element = new Element();
        element.ownerDocument=testDocument;
        element.tagName = tagName;
        createdElements.push(element);
        return element;
      }
    };
  const context = vm.createContext({
    document: testDocument,
    window: {location: {protocol, port: protocol==='file:'?'':'8010', origin: protocol==='file:'?'null':'http://127.0.0.1:8010'}},
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
      if (responseOverride) { const override = responseOverride(target, options); if (override) return override; }
      if (target.endsWith('/api/sample')) return jsonResponse(samplePayload);
      if (target.endsWith('/api/upload')) {
        return options.body.file.name === 'invalid.csv'
          ? jsonResponse({detail: 'Upload must be UTF-8 CSV'}, 400)
          : jsonResponse(uploaded);
      }
      return jsonResponse({ok: true});
    }
  });
  elements.set('filterRail', new Element());
  elements.get('filterRail').hidden = true;
  if (workspace) {
    context.window.PyroData = require('../workspace-data.js');
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'workspace.js'), 'utf8'), context);
  }
  vm.runInContext(source, context);
  return {elements, calls, blobs, createdElements, documentListeners, document: testDocument};
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
  assert.equal(elements.get('timelineDensity').children.length, 1, 'timeline density uses the sample acquisition timestamp');
  assert.equal(elements.get('mapEmptyState').hidden, true, 'coordinate-valid observations reveal the map');

  await elements.get('toggleFilters').listeners.click();
  assert.equal(elements.get('filterRail').hidden, false, 'filter rail opens on demand');
  assert.equal(elements.get('toggleFilters')['aria-expanded'], 'true');
  await elements.get('closeFilters').listeners.click();
  assert.equal(elements.get('filterRail').hidden, true, 'filter rail closes on demand');
  assert.equal(elements.get('toggleFilters')['aria-expanded'], 'false');

  const file = {name: 'valid.csv'};
  await elements.get('file').listeners.change({target: {files: [file]}});
  assert.equal(elements.get('provenance').textContent, 'User-supplied data; provenance unverified');
  assert.equal(elements.get('mTotal').textContent, '3');
  assert.equal(elements.get('mAccepted').textContent, '3');
  assert.equal(elements.get('mRejected').textContent, '0');
  assert.equal(elements.get('mDuplicates').textContent, '0');
  assert.equal(elements.get('mVisible').textContent, '3');
  assert.equal(elements.get('tlRange').max, '2');
  assert.equal(elements.get('tb').children[0].children.length, 9);

  elements.get('tlRange').value = '0';
  elements.get('tlRange').listeners.input({target: elements.get('tlRange')});
  assert.equal(elements.get('mVisible').textContent, '1', 'timeline scrubbing limits the shared dataset');
  elements.get('tlRange').value = '2';
  elements.get('tlRange').listeners.input({target: elements.get('tlRange')});
  assert.equal(elements.get('mVisible').textContent, '3', 'moving to the final acquisition restores all dated rows');

  elements.get('eventContent').children[0].listeners.click();
  assert.ok(elements.get('dossierContent').children.length > 0);
  assert.ok(elements.get('dossierContent').children.some(child => child.textContent === 'Anomaly indicator'));
  assert.ok(elements.get('dossierContent').children.some(child => child.textContent === 'Unavailable'));

  elements.get('modeDuel').listeners.click();
  assert.equal(elements.get('duelWrap').hidden, false);
  assert.equal(elements.get('duelListContent').hidden, false, 'comparison falls back to rankings when Leaflet is unavailable');
  assert.match(elements.get('duelNote').children[0].textContent, /Top-25 overlap/);

  elements.get('openPalette').listeners.click();
  assert.equal(elements.get('palette').hidden, false);
  elements.get('paletteInput').value = 'Compare triage';
  elements.get('paletteInput').listeners.input();
  elements.get('paletteList').children[0].children[1].listeners.click();
  assert.equal(elements.get('palette').hidden, true);
  assert.equal(elements.get('duelWrap').hidden, false, 'palette command performs its advertised action');

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

test('empty responses without optional Phase 4 fields render safely', async () => {
  const {elements} = dashboard({
    rows: [],
    issues: [],
    ingestion: {total_records: 0, accepted: 0, rejected: 0, deduplicated: 0, data_kind: 'user_supplied_unverified'}
  });
  await new Promise(resolve => setImmediate(resolve));
  await elements.get('bSample').listeners.click();
  assert.equal(elements.get('mVisible').textContent, '0');
  assert.equal(elements.get('timelineDensity').children.length, 0);
  assert.equal(elements.get('mapEmptyState').hidden, false, 'empty datasets show the geospatial empty state');
  assert.equal(elements.get('tlRange').disabled, true);
  assert.equal(elements.get('weightsPanel').hidden, true);
  assert.match(elements.get('evaluationContent').children[0].textContent, /No labelled evaluation/i);
  assert.match(elements.get('eventContent').children[0].textContent, /No event records/i);
});


test('file URL gives HTTP guidance without contacting the API', async () => {
  const {elements,calls}=dashboard(null,'file:');
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(elements.get('connectionStatus').textContent,'API unavailable');
  assert.match(elements.get('datasetMessage').textContent,/Open the dashboard over HTTP/);
  await elements.get('bSample').listeners.click();
  assert.equal(calls.length,0);
});

const nodes = element => [element,...(element.children||[]).flatMap(nodes)];
const textOf = element => nodes(element).map(node=>node.textContent||'').join('\n');
const history = elements => nodes(elements.get('dossierContent')).filter(node=>node.className==='event-history-row');
const historyButton = item => nodes(item).find(node=>node.tagName==='button');
const specialRows = [
  {event_id:0,time:'2026-10-12T00:00:00Z',score:70,frp:0,c_frp:0},
  {event_id:0,time:'2026-10-10T00:00:00Z',score:70,confidence_raw:'<img src=x onerror=alert(1)>'},
  {event_id:0,time:'2026-10-10T00:00:00Z',score:70,confidence_raw:'<img src=x onerror=alert(1)>'},
  {event_id:0,time:'invalid',score:5},
  {event_id:0,time:null,score:5},
  {event_id:1,time:'2026-10-09T00:00:00Z',score:30}
].map((row,index)=>({latitude:10,longitude:20,satellite:'N20',instrument:'VIIRS',source_line:index+2,...row}));
const specialPayload={rows:specialRows,events:[{event_id:0,pixels:5,top_score:70},{event_id:1,pixels:1,top_score:30}],issues:[],ingestion:{accepted:6,rejected:0,deduplicated:0,total_records:6,data_kind:'synthetic'}};

test('event dossier retains every row, chronological order, ties, zero and missing evidence', async () => {
  const before=JSON.stringify(specialPayload.rows);
  const {elements,createdElements}=dashboard(specialPayload);
  await elements.get('bSample').listeners.click();
  const eventZero=elements.get('eventContent').children.find(node=>textOf(node).includes('Event 0'));
  eventZero.listeners.click();
  const items=history(elements);
  assert.equal(items.length,5);
  assert.match(textOf(items[0]),/2026-10-10 00:00:00 UTC/);
  assert.match(textOf(items[1]),/2026-10-10 00:00:00 UTC/);
  assert.match(textOf(items[2]),/2026-10-12 00:00:00 UTC/);
  assert.equal(new Set(items.map(item=>item.dataset.key)).size,5);
  assert.match(textOf(elements.get('dossierContent')),/Time unavailable or invalid/);
  assert.match(textOf(elements.get('dossierContent')),/3 observations share the reported maximum/);
  assert.match(textOf(items[0]),/<img src=x onerror=alert\(1\)>/);
  assert.ok(!createdElements.some(node=>node.tagName==='img'));
  assert.equal(JSON.stringify(specialPayload.rows),before);
  assert.equal(specialPayload.rows[0].c_frp,0);
  assert.equal(Object.hasOwn(specialPayload.rows[1],'c_frp'),false);
});

test('history selection restores focus by key, respects filters, and ignores stale data', async () => {
  const {elements,document}=dashboard(specialPayload);
  await elements.get('bSample').listeners.click();
  elements.get('frpMin').listeners.input({target:{value:'1'}});
  const eventZero=elements.get('eventContent').children.find(node=>textOf(node).includes('Event 0'));
  eventZero.listeners.click();
  assert.equal(history(elements).length,5);
  assert.equal(elements.get('mVisible').textContent,'0');
  elements.get('frpMin').listeners.input({target:{value:''}});
  eventZero.listeners.click();
  const item=history(elements)[1],key=item.dataset.key,button=historyButton(item);
  button.focus();button.listeners.click();
  const successor=history(elements).find(node=>node.dataset.key===key);
  assert.notEqual(historyButton(successor),button);
  assert.equal(document.activeElement,historyButton(successor));
  elements.get('bSample').focus();
  await elements.get('bSample').listeners.click();
  assert.equal(document.activeElement,elements.get('bSample'));
  const count=history(elements).length;
  button.listeners.click();
  assert.equal(history(elements).length,count);
  assert.equal(document.activeElement,elements.get('bSample'));
});


test('official contribution display distinguishes zero from absent fields and remains separate from exploratory mode', async () => {
  const {elements}=dashboard(specialPayload);
  await elements.get('bSample').listeners.click();
  elements.get('eventContent').children.find(node=>textOf(node).includes('Event 0')).listeners.click();
  const entries=history(elements);
  historyButton(entries[2]).listeners.click();
  assert.match(textOf(elements.get('scoreContent')),/frp: 0.00 score points/);
  historyButton(history(elements)[0]).listeners.click();
  assert.match(textOf(elements.get('scoreContent')),/frp: Contribution unavailable/);
  assert.match(textOf(elements.get('scoreContent')),/Official review priority: 70.0 \/ 100/);
});

test('workspace event zero preserves filters, exports full history and invalidates stale reports on replacement', async () => {
  const {elements,blobs,createdElements}=dashboard(specialPayload,'http:',true);
  await elements.get('bSample').listeners.click();
  elements.get('frpMin').listeners.input({target:{value:'1000'}});
  elements.get('eventContent').children.find(node=>textOf(node).includes('Event 0')).listeners.click();
  assert.equal(elements.get('mVisible').textContent,'0');
  assert.equal(elements.get('eventFilter').value,'');
  assert.equal(history(elements).length,5);
  assert.equal(elements.get('inspectorTitle').textContent,'Candidate event 0');
  elements.get('reportSelected').listeners.click();
  assert.equal(elements.get('viewReports').hidden,false);
  assert.equal(elements.get('downloadReport').disabled,false);
  elements.get('downloadReport').listeners.click();
  const report=JSON.parse(blobs[0].parts[0]);
  assert.equal(report.scope,'candidate_event');
  assert.equal(report.event_id,'0');
  assert.equal(report.observations.length,5,'report includes all event members independent of filters');
  assert.equal(report.observations.filter(row=>row.time==='2026-10-10T00:00:00Z').length,2);
  assert.equal(report.observations[0].confidence_raw,'<img src=x onerror=alert(1)>');
  assert.ok(!createdElements.some(node=>node.tagName==='img'));
  assert.match(textOf(elements.get('reportPreview')),/not fire probability/);
  await elements.get('bSample').listeners.click();
  assert.equal(elements.get('downloadReport').disabled,true);
  assert.equal(elements.get('generateReport').disabled,true);
  assert.equal(history(elements).length,0);
});

test('workspace analytics, event comparison, navigation and dataset report use supplied data', async () => {
  const {elements,blobs}=dashboard(null,'http:',true);
  await elements.get('bSample').listeners.click();
  elements.get('navAnalytics').listeners.click();
  assert.equal(elements.get('viewAnalytics').hidden,false);
  assert.equal(elements.get('deck').hidden,true);
  assert.match(textOf(elements.get('acquisitionChart')),/2026-10-10/);
  assert.match(textOf(elements.get('eventComparison')),/unavailable/i);
  elements.get('navReports').listeners.click();
  elements.get('reportScope').value='dataset';
  elements.get('reportScope').listeners.change();
  elements.get('generateReport').listeners.click();
  elements.get('downloadReport').listeners.click();
  const report=JSON.parse(blobs[0].parts[0]);
  assert.equal(report.observations[0].score,62);
  assert.equal(report.observations[0].c_repeats,0);
  assert.equal(report.intelligence.model.status,'unavailable');
  assert.equal(report.dataset.source,'synthetic');
  assert.ok(report.dataset.response_loaded_at);
  elements.get('downloadReportCsv').listeners.click();
  assert.match(blobs[1].parts[0],/c_recency,c_confidence,c_frp/);
  elements.get('navData').listeners.click();
  assert.match(textOf(elements.get('dataContext')),/synthetic_sample.csv/);
});

test('upload 413 retains dataset and report; request errors do not mislabel a reachable API', async () => {
  const {elements}=dashboard(null,'http:',true,(url,options)=>url.endsWith('/api/upload')?{ok:false,status:413,headers:{get:()=> 'application/json'},json:async()=>({detail:'Upload request exceeds the 10485760-byte limit'})}:null);
  await elements.get('bSample').listeners.click();
  elements.get('eventContent').children[0].listeners.click();
  elements.get('reportSelected').listeners.click();
  await elements.get('file').listeners.change({target:{files:[{name:'oversize.csv'}]}});
  assert.match(elements.get('datasetMessage').textContent,/HTTP 413/);
  assert.equal(elements.get('mAccepted').textContent,'1');
  assert.equal(elements.get('connectionStatus').textContent,'API connected');
  assert.equal(elements.get('downloadReport').disabled,false);
});
