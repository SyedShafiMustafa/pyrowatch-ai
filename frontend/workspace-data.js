/* Pure presentation transforms. Official scores and event membership come from the API. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PyroData = api;
})(typeof window === 'undefined' ? globalThis : window, function () {
  'use strict';
  const numeric = value => value == null || value === '' || typeof value === 'boolean' || !Number.isFinite(Number(value)) ? null : Number(value);
  function utc(value) {
    if (typeof value !== 'string') return null;
    const match = value.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/);
    if (!match) return null;
    const [, y, m, d, h, min, s] = match.map(Number);
    if (m < 1 || m > 12 || d < 1 || d > new Date(Date.UTC(y, m, 0)).getUTCDate() || h > 23 || min > 59 || s > 59) return null;
    const at = Date.parse(value);
    return Number.isFinite(at) ? at : null;
  }
  const coordinate = row => numeric(row.latitude) != null && numeric(row.longitude) != null && Math.abs(Number(row.latitude)) <= 90 && Math.abs(Number(row.longitude)) <= 180;
  const members = (rows, id) => id == null ? [] : rows.filter(row => row.event_id != null && String(row.event_id) === String(id));
  const chronology = rows => rows.map((row, index) => ({row, index, at: utc(row.time)})).sort((a, b) => (a.at == null) - (b.at == null) || (a.at ?? 0) - (b.at ?? 0) || a.index - b.index);
  function timeRange(rows) {
    const times = rows.map(row => utc(row.time)).filter(value => value != null);
    return {first: times.length ? new Date(times.reduce((a, b) => Math.min(a, b))).toISOString() : null,
      last: times.length ? new Date(times.reduce((a, b) => Math.max(a, b))).toISOString() : null, undated: rows.length - times.length};
  }
  // Smallest circular longitude interval; never use an arithmetic longitude mean at the dateline.
  function bounds(rows) {
    const points = rows.filter(coordinate);
    if (!points.length) return null;
    const longitudes = points.map(row => (Number(row.longitude) + 360) % 360).sort((a, b) => a - b);
    let gap = -1, start = 0;
    longitudes.forEach((lon, i) => {
      const next = i === longitudes.length - 1 ? longitudes[0] + 360 : longitudes[i + 1];
      if (next - lon > gap) { gap = next - lon; start = next % 360; }
    });
    const west = start > 180 ? start - 360 : start;
    const latitudes = points.map(row => Number(row.latitude));
    return {west, east: west + 360 - gap, south: latitudes.reduce((a, b) => Math.min(a, b)), north: latitudes.reduce((a, b) => Math.max(a, b))};
  }
  function footprint(rows) {
    const b = bounds(rows);
    if (!b || b.west === b.east || b.south === b.north) return null;
    const ring = (w, e) => [[w,b.south],[e,b.south],[e,b.north],[w,b.north],[w,b.south]];
    return b.east <= 180 ? {type:'Polygon', coordinates:[ring(b.west,b.east)]}
      : {type:'MultiPolygon', coordinates:[[ring(b.west,180)],[ring(-180,b.east-360)]]};
  }
  function summaries(rows) {
    const daily = new Map(), scores = [0,0,0,0,0];
    let missingScore = 0, missingFrp = 0, undated = 0;
    for (const row of rows) {
      const score = numeric(row.score), frp = numeric(row.frp), at = utc(row.time);
      if (score == null || score < 0 || score > 100) missingScore++;
      else scores[Math.min(4, Math.floor(score / 20))]++;
      if (frp == null) missingFrp++;
      if (at == null) { undated++; continue; }
      const day = new Date(at).toISOString().slice(0,10);
      const bucket = daily.get(day) || {day, count:0, frpCount:0, frpTotal:0};
      bucket.count++; if (frp != null) { bucket.frpCount++; bucket.frpTotal += frp; }
      daily.set(day,bucket);
    }
    return {daily:[...daily.values()].sort((a,b)=>a.day.localeCompare(b.day)).map(b=>({...b,meanFrp:b.frpCount ? b.frpTotal/b.frpCount : null})), scores, missingScore, missingFrp, undated};
  }
  const limitations = [
    'Satellite thermal detections are candidate observations, not confirmed wildfires.',
    'Official priority is an uncalibrated 0–100 heuristic; it is not fire probability or predicted spread.',
    'Event priority is the maximum individual observation score. Event IDs are local to this response.',
    'Clustering forms candidate groups, not fire perimeters. Displayed bounds enclose supplied coordinates only.',
    'Gaps do not prove activity stopped. Location differences alone do not prove physical spread.',
    'Observation opportunities, cloud effects and missed overpasses are not measured here.',
    'Anomaly outputs are separate from official priority and do not identify wildfire.',
    'This report is a snapshot of a request-based dataset, not continuous live monitoring.'
  ];
  function report(state, eventId, generatedAt = new Date().toISOString()) {
    const isEvent = eventId != null;
    const rows = isEvent ? members(state.rows,eventId) : state.rows;
    const events = isEvent ? state.events.filter(e=>String(e.event_id)===String(eventId)) : state.events;
    const eventIntel = state.intelligence?.events;
    return {report_schema:'pyrowatch.review.v1', generated_at:generatedAt, scope:isEvent?'candidate_event':'dataset',
      event_id:isEvent?eventId:null, dataset:{source:state.provenance, file_name:state.sourceName || null, response_loaded_at:state.loadedAt || null,
        observation_time_range:timeRange(state.rows), ingestion:state.ingestion},
      observation_time_range:timeRange(rows), accepted_rows_in_scope:rows.length,
      events, observations:chronology(rows).map(item=>item.row),
      intelligence:{model:state.intelligence?.model || null, events:Array.isArray(eventIntel)?eventIntel.filter(e=>!isEvent || String(e.event_id)===String(eventId)):[]},
      evaluation:state.evaluation || null, official_weights:state.weights || null, limitations};
  }
  function csv(rows) {
    const fields=['event_id','time','latitude','longitude','satellite','instrument','confidence_raw','confidence','frp','score','c_recency','c_confidence','c_frp','c_repeats','c_brightness','persistent_source_status','why'];
    const cell=value=>{let text=value==null?'':String(value);if(typeof value==='string' && /^[\s]*[=+\-@]/.test(text))text="'"+text;return '"'+text.replaceAll('"','""')+'"';};
    return [fields.join(','),...rows.map(row=>fields.map(field=>cell(row[field])).join(','))].join('\r\n');
  }
  return {numeric,utc,coordinate,members,chronology,timeRange,bounds,footprint,summaries,report,csv,limitations};
});
