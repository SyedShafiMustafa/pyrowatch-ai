const test = require('node:test');
const assert = require('node:assert/strict');
const D = require('../workspace-data.js');

test('strict UTC chronology keeps duplicates, zero event ID, and undated rows without mutation',()=>{
  const rows=[{event_id:0,time:'2026-10-11T01:00:00Z'},{event_id:0,time:'2026-10-10T00:00:00Z'},{event_id:0,time:'2026-10-10T00:00:00Z'},{event_id:0,time:'2026-02-30T00:00:00Z'},{event_id:0,time:'2026-10-10 00:00:00'},{event_id:1,time:null}];
  const before=JSON.stringify(rows), history=D.chronology(D.members(rows,'0'));
  assert.deepEqual(history.map(item=>item.index),[1,2,0,3,4]);
  assert.equal(history.filter(item=>item.at===null).length,2);
  assert.equal(JSON.stringify(rows),before);
  assert.equal(D.timeRange(rows).undated,3);
  assert.equal(D.utc('2026-10-10T05:30:00+05:30'),D.utc('2026-10-10T00:00:00Z'));
  assert.deepEqual(D.chronology([]),[]);
  assert.equal(D.chronology([rows[0]]).length,1);
});
test('wrapped bounds and footprints stay small across the antimeridian and retain ordinary coordinates',()=>{
  const rows=[{latitude:10,longitude:179.9},{latitude:10.1,longitude:-179.9}];
  const b=D.bounds(rows);assert.ok(Math.abs(b.east-b.west-.2)<1e-8);
  const polygon=D.footprint(rows);assert.equal(polygon.type,'MultiPolygon');
  assert.ok(polygon.coordinates.flat(2).every(([lon,lat])=>Math.abs(lon)<=180 && Math.abs(lat)<=90));
  assert.equal(D.footprint([{latitude:0,longitude:0}]),null);
  assert.equal(D.bounds([{latitude:null,longitude:0}]),null);
  assert.deepEqual(D.bounds([{latitude:-33,longitude:150},{latitude:-34,longitude:151}]),{west:150,east:151,south:-34,north:-33});
});
test('analytics counts every accepted observation, preserves zero FRP and excludes unavailable values',()=>{
  const summary=D.summaries([{time:'2026-10-10T00:00:00Z',frp:0,score:0},{time:'2026-10-10T00:00:00Z',frp:10,score:100},{time:'2026-10-10T00:00:00Z',frp:null,score:null},{time:'invalid',frp:'',score:20}]);
  assert.equal(summary.daily[0].count,3);assert.equal(summary.daily[0].meanFrp,5);assert.equal(summary.daily[0].frpCount,2);
  assert.deepEqual(summary.scores,[1,1,0,0,1]);assert.equal(summary.missingFrp,2);assert.equal(summary.undated,1);
});
test('reports carry API contributions, provenance, missing fields and response-local identities',()=>{
  const state={rows:[{event_id:0,time:null,score:0,c_frp:0},{event_id:1,time:null,score:60}],events:[{event_id:0,top_score:0},{event_id:1,top_score:60}],provenance:'user_supplied_unverified',ingestion:{accepted:2,rejected:1},intelligence:{model:{status:'unavailable'},events:[{event_id:0,missing_features:['mean_frp']}]}};
  const report=D.report(state,0,'2026-10-17T00:00:00Z');assert.equal(report.observations.length,1);assert.equal(report.observations[0].c_frp,0);assert.equal(Object.hasOwn(report.observations[0],'frp'),false);assert.equal(report.dataset.source,'user_supplied_unverified');assert.equal(report.intelligence.model.status,'unavailable');assert.equal(report.generated_at,'2026-10-17T00:00:00Z');
  assert.equal(D.report(state,null).observations.length,2);
});
test('CSV exports escape spreadsheet formula strings and preserve numeric negative coordinates',()=>{
  const csv=D.csv([{event_id:0,latitude:-33,longitude:150,confidence_raw:'=1+1',why:'@SUM(1,2)',frp:0}]);
  assert.match(csv,/"'=1\+1"/);assert.match(csv,/"'@SUM\(1,2\)"/);assert.match(csv,/"-33"/);assert.match(csv,/"0"/);
});
