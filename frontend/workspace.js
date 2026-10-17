/* View orchestration and presentation. The backend owns ingestion, scoring and clustering. */
window.PyroWorkspace = {
  create(context) {
    'use strict';
    const {state, el, $, fmt, fmtTime, openEvent, selectObservation, setMapMode, checkHealth, upload, loadSample, fetchLiveFirms, announce, toast, filteredRows, render} = context;
    const D = window.PyroData;
    let view = 'dashboard', reportSnapshot = null, reportSelection = null;
    let globe = null, globeLoading = null, globeActive = false, globeReady = false, globeSetupStarted = false, boundsLayer = null;
    let eventQuery = '', eventOrder = 'priority', datasetRef = null;
    let detections = true, eventBounds = true, basemap = true;
    const text = (id, value) => { if ($(id)) $(id).textContent = value; };
    const on = (id, event, fn) => $(id)?.addEventListener(event, fn);
    const note = value => el('p', 'panel-note', value);
    const button = (label, action, cls = 'text-button') => {
      const node = el('button', cls, label); node.type = 'button'; node.addEventListener('click', action); return node;
    };
    const sameId = (a,b) => a != null && b != null && String(a) === String(b);
    const selectedMembers = () => D.members(state.rows,state.selectedEvent);
    const intelligence = id => state.intelligence?.events?.find(item=>sameId(item.event_id,id));
    function facts(container, entries) {
      const list = el('dl','detail-list');
      entries.forEach(([label,value])=>{ const line=el('div','detail-row');line.append(el('dt','',label),el('dd','mono',value == null || value === '' ? 'Unavailable' : value));list.append(line); });
      container.append(list);
    }
    function navigate(next) {
      if (!['dashboard','map','events','analytics','reports','data'].includes(next)) return;
      const active = next;
      view = next === 'map' ? 'dashboard' : next;
      $('deck').hidden = view !== 'dashboard';
      for (const name of ['events','analytics','reports','data']) $('view'+name[0].toUpperCase()+name.slice(1)).hidden = view !== name;
      for (const name of ['dashboard','map','events','analytics','reports','data']) {
        const node = $('nav'+name[0].toUpperCase()+name.slice(1));
        if (name === active) node.setAttribute('aria-current','page'); else node.removeAttribute('aria-current');
      }
      if (next !== 'dashboard') { $('filterRail').hidden=true; $('toggleFilters').setAttribute('aria-expanded','false'); }
      if (view === 'dashboard') setTimeout(()=>{state.map?.invalidateSize?.();globe?.resize();state.duelMaps.forEach(map=>map.invalidateSize?.());if(next==='map')$('mapHeading').scrollIntoView({behavior:'smooth',block:'start'});},0);
      if (view === 'events') renderCatalog();
      if (view === 'analytics') renderAnalytics();
      if (view === 'data') renderContext();
      if (view === 'reports') reportControls();
    }
    function inspector(section) {
      for (const [id, panel] of [['Event','dossierPanel'],['Score','priorityPanel'],['Observation','observationPanel']]) {
        $(panel).hidden = id !== section; $('inspect'+id).setAttribute('aria-pressed',String(id===section));
      }
    }
    function filteredEvents() {
      const query=eventQuery.trim().toLowerCase();
      return state.events.filter(event=>!query || [event.event_id,event.lat,event.lon,...D.members(state.rows,event.event_id).map(row=>`${row.satellite ?? ''} ${row.instrument ?? ''}`)].some(value=>String(value??'').toLowerCase().includes(query)))
        .slice().sort((a,b)=>eventOrder==='recent' ? (D.utc(b.last_seen)??-Infinity)-(D.utc(a.last_seen)??-Infinity) : eventOrder==='count' ? (D.numeric(b.pixels)??-Infinity)-(D.numeric(a.pixels)??-Infinity) : (D.numeric(b.top_score)??-Infinity)-(D.numeric(a.top_score)??-Infinity));
    }
    function investigate(id) { navigate('dashboard'); inspector('Event'); openEvent(id); if($('dossierPanel').parentElement)$('dossierPanel').parentElement.scrollTop=0; locateEvent(); }
    function renderExplorer() {
      const box=$('eventContent');box.replaceChildren();
      const events=filteredEvents();
      text('eventCount',String(state.events.length));
      text('explorerCount',`${events.length} of ${state.events.length} candidate events · official priority`);
      if (!events.length) {box.append(note(state.events.length?'No candidate events match this search.':'Load a dataset to inspect candidate events.'));return;}
      for (const event of events) {
        const item=button('',()=>investigate(event.event_id),'event-row');item.setAttribute('aria-pressed',String(sameId(state.selectedEvent,event.event_id)));
        const score=D.numeric(event.top_score), title=el('span','event-top');title.append(el('strong','',`Event ${event.event_id ?? 'unavailable'}`),el('span','event-priority',fmt(score,1)));
        const b=D.bounds(D.members(state.rows,event.event_id));
        const location=b?`${fmt((b.south+b.north)/2,3)}°, ${fmt((((b.west+b.east)/2+540)%360)-180,3)}°`:'Coordinates unavailable';
        const scoreTrack=el('span','event-score-track'),scoreFill=el('i','');scoreFill.style.width=`${Math.max(0,Math.min(100,score??0))}%`;scoreTrack.append(scoreFill);
        item.append(title,scoreTrack,el('span','event-meta',`${event.pixels ?? '—'} observations · ${intelligence(event.event_id)?.trend?.status?.replaceAll('_',' ') || 'trend unavailable'}`),el('span','mono',location),el('span','mono',fmtTime(event.last_seen)));
        box.append(item);
      }
    }
    function table(headers, rows) {
      const node=el('table',''), head=el('thead',''), tr=el('tr','');
      headers.forEach(label=>{const th=el('th','',label);th.scope='col';tr.append(th);});head.append(tr);node.append(head);
      const body=el('tbody','');rows.forEach(cells=>{const row=el('tr','');cells.forEach(value=>{const td=el('td','');td.append(value && typeof value==='object' && value.nodeType ? value : el('span','',value??'Unavailable'));row.append(td);});body.append(row);});node.append(body);return node;
    }
    function renderCatalog() {
      const box=$('eventCatalog');box.replaceChildren();
      if (!state.events.length) {box.append(note('No events returned. Import a CSV or load the synthetic sample.'));return;}
      box.append(table(['Candidate event','Observations','Official priority','Peak FRP','First acquisition (UTC)','Last acquisition (UTC)','Trend','Review'],state.events.map(event=>[
        `Event ${event.event_id}`,event.pixels,fmt(event.top_score,1),fmt(event.peak_frp),fmtTime(event.first_seen),fmtTime(event.last_seen),intelligence(event.event_id)?.trend?.status || 'Unavailable',button('Investigate ↗',()=>investigate(event.event_id))
      ])));
    }
    function renderAnalytics() {
      const rows=filteredRows(), summary=D.summaries(rows), acquisitions=$('acquisitionChart'), priority=$('priorityChart');
      text('analyticsScope',`${rows.length} accepted observations match the dashboard filters and playback cursor. Event comparisons use complete histories.`);
      acquisitions.replaceChildren();priority.replaceChildren();
      if (!rows.length) {acquisitions.append(note('No matching observations. Load data or adjust the dashboard filters.'));priority.append(note('No matching scores.'));}
      else {
        const max=Math.max(0,...summary.daily.map(item=>item.count));
        const scale=Math.pow(10,Math.floor(Math.log10(Math.max(1,max))));
        const axisMax=Math.max(scale,Math.ceil(max/scale)*scale);
        const midpoint=Math.floor(axisMax/2);
        const frame=el('div','acquisition-plot');
        const axis=el('div','chart-y-axis');axis.setAttribute('aria-hidden','true');
        [axisMax,midpoint,0].forEach(value=>axis.append(el('span','',value)));
        const plot=el('div','chart-plot');
        const guides=el('div','chart-guides');guides.setAttribute('aria-hidden','true');
        for(let i=0;i<3;i++)guides.append(el('i',''));
        const chart=el('div','chart-bars');chart.setAttribute('role','img');chart.setAttribute('aria-label',`${summary.daily.length} UTC dates. Observation count axis from zero to ${axisMax}. Exact daily counts and FRP values are available in the table below.`);
        const dateStride=Math.max(1,Math.ceil(summary.daily.length/8));
        for (const [index,item] of summary.daily.entries()) {
          const column=el('div','chart-column');
          const bar=el('div','chart-bar');bar.style.height=`${axisMax?item.count/axisMax*100:0}%`;
          bar.title=`${item.day}: ${item.count} detections; mean FRP ${fmt(item.meanFrp)}`;
          bar.append(el('span','chart-value',item.count));
          const dateLabel=el('span','chart-date',index%dateStride===0||index===summary.daily.length-1?item.day.slice(5):'');
          dateLabel.title=item.day;column.append(bar,dateLabel);chart.append(column);
        }
        plot.append(guides,chart);frame.append(axis,plot);acquisitions.append(frame);
        const detail=el('details','chart-data');detail.append(el('summary','',`Inspect daily values · ${summary.undated} timestamps unavailable`),table(['UTC date','Detections','Mean FRP','FRP available'],summary.daily.map(day=>[day.day,day.count,fmt(day.meanFrp),`${day.frpCount}/${day.count}`])));acquisitions.append(detail);
        const dist=el('div','distribution'), maxScore=Math.max(1,...summary.scores);
        summary.scores.forEach((count,index)=>{const row=el('div','distribution-row'),track=el('div','distribution-track'),fill=el('i','distribution-fill');fill.style.width=`${count/maxScore*100}%`;track.append(fill);row.append(el('span','',`${index*20}–${index===4?100:index*20+19.99}`),track,el('span','',count));dist.append(row);});
        priority.append(dist,note(`${summary.missingScore} missing / invalid scores. ${summary.missingFrp} observations lack FRP. Counts are derived summaries; official scores are not recalculated.`));
      }
      renderComparison();
    }
    function populateEventSelect(id, preferred) {
      const select=$(id), previous=select.value;
      select.replaceChildren();
      state.events.filter(event=>event.event_id!=null).forEach(event=>select.add(new Option(`Event ${event.event_id} · priority ${fmt(event.top_score,1)}`,String(event.event_id))));
      select.value=state.events.some(event=>String(event.event_id)===previous)?previous:String(preferred ?? state.events[0]?.event_id ?? '');
      select.disabled=!state.events.length;
    }
    function renderComparison() {
      const box=$('eventComparison');box.replaceChildren();
      const a=state.events.find(event=>String(event.event_id)===$('compareA').value), b=state.events.find(event=>String(event.event_id)===$('compareB').value);
      if (!a || !b) {box.append(note('Load a dataset with candidate events to compare their observed attributes.'));return;}
      if(sameId(a.event_id,b.event_id))box.append(note('Both columns show the same candidate event. Choose a different event to compare.'));
      const features=event=>intelligence(event.event_id)?.features || {};
      const rows=[
        ['Accepted observations',a.pixels,b.pixels],['Official event maximum (0–100)',fmt(a.top_score,2),fmt(b.top_score,2)],
        ['First acquisition',fmtTime(a.first_seen),fmtTime(b.first_seen)],['Last acquisition',fmtTime(a.last_seen),fmtTime(b.last_seen)],
        ['API event center',`${fmt(a.lat,4)}, ${fmt(a.lon,4)}`,`${fmt(b.lat,4)}, ${fmt(b.lon,4)}`],
        ['Mean FRP (source units)',fmt(features(a).mean_frp),fmt(features(b).mean_frp)],['Peak FRP',fmt(a.peak_frp),fmt(b.peak_frp)],
        ['Acquisition span (h)',fmt(features(a).duration_h),fmt(features(b).duration_h)],
        ['Distinct acquisition times',features(a).distinct_observation_times,features(b).distinct_observation_times],
        ['Trend',intelligence(a.event_id)?.trend?.status,intelligence(b.event_id)?.trend?.status],
        ['First-to-last mean FRP change',fmt(intelligence(a.event_id)?.trend?.frp_change_mw),fmt(intelligence(b.event_id)?.trend?.frp_change_mw)],
        ['Missing event features',intelligence(a.event_id)?.missing_features?.join(', ') || (intelligence(a.event_id)?.missing_features?'None reported':'Unavailable'),intelligence(b.event_id)?.missing_features?.join(', ') || (intelligence(b.event_id)?.missing_features?'None reported':'Unavailable')],
        ['Anomaly analysis',intelligence(a.event_id)?.anomaly?.status || 'Unavailable',intelligence(b.event_id)?.anomaly?.status || 'Unavailable']
      ];
      for(const factor of ['recency','confidence','frp','repeats','brightness']) {
        const range=event=>{const maxRows=D.members(state.rows,event.event_id).filter(row=>D.numeric(row.score)!=null && D.numeric(row.score)===D.numeric(event.top_score));const values=maxRows.map(row=>D.numeric(row['c_'+factor]));return !values.length || values.some(v=>v==null)?'Unavailable / partial':`${fmt(Math.min(...values))}–${fmt(Math.max(...values))} points (${values.length} max-score observations)`;};
        rows.push([`${factor}: contributions of tied maxima`,range(a),range(b)]);
      }
      const histories=[a,b].map(event=>{const list=el('div','small-history');D.chronology(D.members(state.rows,event.event_id)).forEach(({row,at})=>list.append(el('p','',`${at==null?'Time unavailable':fmtTime(row.time)} · ${fmt(row.latitude,4)}, ${fmt(row.longitude,4)} · FRP ${fmt(row.frp)}`)));return list;});
      rows.push(['Accepted history',...histories]);
      const wrap=el('div','comparison-table');wrap.append(table(['Attribute',`Event ${a.event_id}`,`Event ${b.event_id}`],rows));box.append(wrap,note('Measured differences do not establish physical spread or source identity. Event centers are API aggregates and can be misleading near the antimeridian; map navigation uses wrapped coordinate bounds.'));
    }
    function renderContext() {
      const box=$('dataContext');box.replaceChildren();const range=D.timeRange(state.rows);
      facts(box,[['Source kind',state.provenance],['Input filename',state.sourceName],['Response loaded',state.loadedAt],['Last NASA FIRMS fetch',state.liveFirmsFetchedAt],['First acquisition',range.first],['Last acquisition',range.last],['Unavailable timestamps',range.undated],['Model status',state.intelligence?.model?.status],['Model reason',state.intelligence?.model?.reason]]);
      const method=$('methodology');method.replaceChildren();D.limitations.forEach(value=>method.append(note(value)));
      method.append(note('Current clustering implementation bounds pairwise distances to 2 km and acquisition span to 72 h. Grouping is deterministic within a response; it is not a tracked event identity across uploads.'));
    }
    function clearReport() {
      reportSnapshot=null;reportSelection=null;
      $('reportPreview').replaceChildren(note('Generate a fresh preview for this dataset and scope.'));
      reportControls();
    }
    function reportControls() {
      const eventScope=$('reportScope').value!=='dataset';
      $('generateReport').disabled=!state.ingestion || (eventScope && state.selectedEvent==null);
      for(const id of ['downloadReport','downloadReportCsv','printReport'])$(id).disabled=!reportSnapshot;
      text('reportScopeNote',eventScope?state.selectedEvent==null?'Select a candidate event in the dashboard first.':`Event ${state.selectedEvent} · ${selectedMembers().length} accepted observations; all timestamps, regardless of filters.`:`All ${state.rows.length} accepted observations; table filters do not truncate the report.`);
    }
    function generateReport() {
      if($('generateReport').disabled)return;
      const id=$('reportScope').value==='dataset'?null:state.selectedEvent;
      reportSnapshot=JSON.parse(JSON.stringify(D.report(state,id)));reportSelection=id;
      const report=reportSnapshot, box=$('reportPreview');box.replaceChildren();
      box.append(el('p','eyebrow','PYROWATCH / EVIDENCE REVIEW'),el('h2','',id==null?'Dataset review':`Candidate event ${id}`));
      facts(box,[['Generated (UTC)',report.generated_at],['Dataset source',report.dataset.source],['Input filename',report.dataset.file_name],['API response loaded',report.dataset.response_loaded_at],['Accepted observations in scope',report.accepted_rows_in_scope],['First acquisition',report.observation_time_range.first],['Last acquisition',report.observation_time_range.last],['Unavailable timestamps',report.observation_time_range.undated],['Anomaly model',report.intelligence.model?.status]]);
      box.append(el('h3','','Official priority & analysis'),note('Event priority is the highest individual observation score, with no averaging across the event. Contribution values below come directly from the API.'));
      for(const event of report.events.slice(0,20)) {
        const intel=report.intelligence.events.find(item=>sameId(item.event_id,event.event_id)), members=D.members(report.observations,event.event_id);
        box.append(el('h3','',`Event ${event.event_id} · official maximum ${fmt(event.top_score,2)} / 100`));
        facts(box,[['Accepted observations',event.pixels],['Peak FRP (source units)',fmt(event.peak_frp)],['Observed FRP trend',intel?.trend?.status],['FRP first-to-last change',fmt(intel?.trend?.frp_change_mw)],['Anomaly status',intel?.anomaly?.status],['Anomaly score (separate, uncalibrated)',fmt(intel?.anomaly?.anomaly_score,4)],['Missing event features',intel?.missing_features?.join(', ') || (intel?.missing_features?'None reported':'Unavailable')]]);
        box.append(note(intel?.trend?.reason || 'Trend analysis unavailable.'),note(intel?.trend?.sampling_limitation || 'Sampling opportunities are unknown.'));
        const recurrence=['possible_persistent_source','not_flagged','insufficient_history'].map(status=>`${members.filter(row=>row.persistent_source_status===status).length} ${status.replaceAll('_',' ')}`).join('; ');
        box.append(note(`Recurrence status: ${recurrence}. Other statuses are unavailable.`));
        const missing=[...new Set(members.flatMap(row=>Array.isArray(row.score_missing_factors)?row.score_missing_factors:[]))];
        box.append(note(missing.length?`Missing scoring measurements: ${missing.join(', ')}.`:'No scoring measurements are marked missing by the API.'));
      }
      if(report.events.length>20)box.append(note(`Preview shows the first 20 of ${report.events.length} events. The JSON export contains every event.`));
      const raw=el('details','chart-data');raw.append(el('summary','','Inspect full API analysis & weights'),el('pre','',JSON.stringify({events:report.events,intelligence:report.intelligence,official_weights:report.official_weights},null,2)));box.append(raw);
      const highest=report.observations.filter(row=>report.events.some(event=>sameId(event.event_id,row.event_id)&&D.numeric(row.score)!=null&&D.numeric(row.score)===D.numeric(event.top_score)));
      box.append(el('h3','','Observations responsible for event maxima (ties retained)'),table(['Event','UTC acquisition','Score','Recency','Confidence','FRP','Repeats','Brightness'],highest.map(row=>[row.event_id,fmtTime(row.time),fmt(row.score),...['recency','confidence','frp','repeats','brightness'].map(key=>fmt(row['c_'+key]))])));
      box.append(el('h3','','Accepted observation timeline'));
      const wrap=el('div','comparison-table');wrap.append(table(['Event','UTC acquisition','Coordinates','Satellite / instrument','Raw confidence','FRP','Priority'],report.observations.slice(0,200).map(row=>[row.event_id,D.utc(row.time)==null?'Unavailable / invalid':fmtTime(row.time),`${fmt(row.latitude,5)}, ${fmt(row.longitude,5)}`,`${row.satellite??'—'} / ${row.instrument??'—'}`,row.confidence_raw,fmt(row.frp),fmt(row.score)])));box.append(wrap);
      if(report.observations.length>200)box.append(note(`Preview shows the first 200 of ${report.observations.length} accepted observations; JSON and CSV exports contain the complete history.`));
      box.append(el('h3','','Methodology & limitations'));const limits=el('ul','');report.limitations.forEach(value=>limits.append(el('li','',value)));box.append(limits);
      box.append(el('h3','','Full snapshot'),note('The JSON download contains all observations, source fields, normalized factors, contributions, missing-factor flags, recurrence statuses, ingestion metadata and available evaluation outputs. Missing fields remain missing.'));
      reportControls();announce('Report preview generated from the loaded API response.');
    }
    function download(kind) {
      if(!reportSnapshot)return;
      const value=kind==='json'?JSON.stringify(reportSnapshot,null,2):D.csv(reportSnapshot.observations);
      const blob=new Blob([value],{type:kind==='json'?'application/json':'text/csv;charset=utf-8'}),url=URL.createObjectURL(blob),a=el('a','');
      a.href=url;a.download=`pyrowatch-${reportSnapshot.scope}-${reportSnapshot.generated_at.replace(/[:.]/g,'-')}.${kind}`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);announce(`${kind.toUpperCase()} report downloaded.`);
    }
    function layerVisibility() {
      for(const map of [state.map,...state.duelMaps].filter(Boolean)) {
        if(map===state.map && state.mapLayer) {
          if(detections && !map.hasLayer(state.mapLayer))map.addLayer(state.mapLayer);
          if(!detections && map.hasLayer(state.mapLayer))map.removeLayer(state.mapLayer);
        }
        const base=map.pyroBasemaps?.[state.basemapName];
        if(base && basemap && !map.hasLayer(base))map.addLayer(base);
        for(const layer of Object.values(map.pyroBasemaps||{}))if(layer!==base&&map.hasLayer(layer))map.removeLayer(layer);
        if(map.pyroLabels) {
          if(state.referenceLabels && !map.hasLayer(map.pyroLabels))map.addLayer(map.pyroLabels);
          if(!state.referenceLabels && map.hasLayer(map.pyroLabels))map.removeLayer(map.pyroLabels);
        }
        if(base && !basemap && map.hasLayer(base))map.removeLayer(base);
      }
      if(globeReady) {
        for(const [id,name] of [['basemap-satellite','satellite'],['basemap-terrain','terrain'],['basemap-reference','reference']])if(globe.getLayer(id))globe.setLayoutProperty(id,'visibility',basemap&&state.basemapName===name?'visible':'none');
        for(const [id,visible] of [['observations',detections],['selected-observation',detections],['event-bounds',eventBounds],['reference-labels',basemap&&state.referenceLabels]])if(globe.getLayer(id))globe.setLayoutProperty(id,'visibility',visible?'visible':'none');
        const opacity=Number(state.markerOpacity)||0.9;
        if(globe.getLayer('observations'))globe.setPaintProperty('observations','circle-opacity',opacity);
        if(globe.getLayer('selected-observation'))globe.setPaintProperty('selected-observation','circle-opacity',opacity);
      }
    }
    function gibsLayer(map, layer, date, format) {
      const attribution='<a href="https://earthdata.nasa.gov/eosdis/science-system-description/eosdis-components/gibs">NASA GIBS</a> · MODIS Terra Corrected Reflectance True Color';
      return L.tileLayer(`https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/${layer}/default/${date}/GoogleMapsCompatible_Level9/{z}/{y}/{x}.${format}`,{attribution,maxZoom:19,maxNativeZoom:9,opacity:layer==='Reference_Labels'?0.88:1});
    }
    function applyBasemap(name=state.basemapName,date=state.imageryDate) {
      state.basemapName=name;
      const dateChanged=date!==state.imageryDate;
      state.imageryDate=date;
      for(const map of [state.map,...state.duelMaps].filter(Boolean)) {
        if(dateChanged && map.pyroBasemaps?.satellite) {
          if(map.hasLayer(map.pyroBasemaps.satellite))map.removeLayer(map.pyroBasemaps.satellite);
          if(map.pyroLabels&&map.hasLayer(map.pyroLabels))map.removeLayer(map.pyroLabels);
          map.pyroBasemaps.satellite=gibsLayer(map,'MODIS_Terra_CorrectedReflectance_TrueColor',date,'jpg');
          map.pyroLabels=gibsLayer(map,'Reference_Labels',date,'png');
          map.pyroBasemaps.satellite.on('tileerror',()=>{if(map.pyroBaseName!=='satellite')return;state.basemapName='reference';map.pyroBaseName='reference';$('basemapSelect').value='reference';if(map===state.map)text('mapNote','NASA daily imagery is unavailable for this date or connection. Showing the OpenStreetMap reference basemap; observation markers and event bounds remain available.');layerVisibility();});
        }
        map.pyroBaseName=name;
        map._pyroBaseSelect=$('basemapSelect');
      }
      $('basemapSelect').value=name;
      $('mapDateControl').hidden=name!=='satellite';
      if(name==='satellite')text('mapNote','NASA GIBS MODIS true-colour imagery · daily product. Background acquisition can differ from detections; clouds and smoke can obscure the ground. Imagery does not confirm a fire. Event bounds enclose observations and are not perimeters.');
      else if(name==='terrain')text('mapNote','OpenTopoMap terrain with OpenStreetMap data. Terrain is contextual reference, not evidence of fire activity. Event bounds enclose observations and are not perimeters.');
      else text('mapNote','OpenStreetMap reference basemap. Event bounds enclose observed coordinates and are not fire perimeters.');
      layerVisibility();
      if(globeReady && dateChanged) {
        globe.removeLayer('basemap-satellite');
        globe.removeSource('satellite');
        globe.addSource('satellite',{type:'raster',tiles:[`https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/MODIS_Terra_CorrectedReflectance_TrueColor/default/${date}/GoogleMapsCompatible_Level9/{z}/{y}/{x}.jpg`],tileSize:256,maxzoom:9,attribution:'NASA GIBS · MODIS Terra Corrected Reflectance True Color'});
        globe.addLayer({id:'basemap-satellite',type:'raster',source:'satellite',layout:{visibility:'none'}},'observations');
        globe.removeLayer('reference-labels');
        globe.removeSource('labels');
        globe.addSource('labels',{type:'raster',tiles:[`https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/Reference_Labels/default/${date}/GoogleMapsCompatible_Level9/{z}/{y}/{x}.png`],tileSize:256,maxzoom:9,attribution:'NASA Earthdata · Reference Labels'});
        globe.addLayer({id:'reference-labels',type:'raster',source:'labels',layout:{visibility:'none'},paint:{'raster-opacity':0.88}},'observations');
        renderGlobe();
      }
    }
    function renderBounds() {
      if(!state.map || typeof L==='undefined')return;
      if(!boundsLayer)boundsLayer=L.layerGroup().addTo(state.map);
      boundsLayer.clearLayers();
      if(eventBounds) {
        const members=selectedMembers(), b=D.bounds(members);
        if(b && b.west!==b.east && b.south!==b.north)L.rectangle([[b.south,b.west],[b.north,b.east]],{color:'#b7a2b5',weight:1.5,fillColor:'#b7a2b5',fillOpacity:.06,dashArray:'4 4',interactive:false}).addTo(boundsLayer);
        const row=state.rows.find(row=>state.keys.get(row)===state.selectedKey);
        if(row && D.coordinate(row)) {
          const center=b?(b.west+b.east)/2:Number(row.longitude), lon=Number(row.longitude)+360*Math.round((center-Number(row.longitude))/360);
          L.circleMarker([Number(row.latitude),lon],{radius:9,weight:1.5,color:'#f0ebe2',fillOpacity:0,interactive:false}).addTo(boundsLayer);
        }
      }
      layerVisibility();
    }
    function locateEvent() {
      const b=D.bounds(selectedMembers());if(!b)return;
      if(globeActive && globeReady)focusGlobe(selectedMembers(),8);
      else state.map?.fitBounds([[b.south,b.west],[b.north,b.east]],{maxZoom:12});
    }
    function focusGlobe(rows,maxZoom=5) {
      if(!globeReady)return;
      const b=D.bounds(rows);
      if(!b){globe.flyTo({center:[0,10],zoom:.4,duration:0});return;}
      const longitude=((((b.west+b.east)/2)+180)%360+360)%360-180;
      const latitude=(b.south+b.north)/2;
      const span=Math.max(b.east-b.west,b.north-b.south,.05);
      const zoom=Math.max(.4,Math.min(maxZoom,Math.log2(360/span)-2.8));
      globe.flyTo({
        center:[longitude,latitude],zoom,
        duration:window.matchMedia?.('(prefers-reduced-motion: reduce)').matches?0:700
      });
    }
    function overview() {
      if(globeActive){focusGlobe(filteredRows());return;}
      const b=D.bounds(filteredRows());if(b)state.map?.fitBounds([[b.south,b.west],[b.north,b.east]],{maxZoom:10});else state.map?.setView([10,20],2);
    }
    function leaveGlobe() {
      globeActive=false;$('globeMap').hidden=true;$('globeStatus').hidden=true;$('modeGlobe').setAttribute('aria-pressed','false');$('modeGlobe').classList.toggle('is-active',false);
    }
    async function loadGlobeLibrary() {
      if(window.maplibregl)return;
      if(!globeLoading)globeLoading=new Promise((resolve,reject)=>{
        const css=el('link','');css.rel='stylesheet';css.href='https://unpkg.com/maplibre-gl@5.6.2/dist/maplibre-gl.css';document.head.append(css);
        const script=el('script','');script.src='https://unpkg.com/maplibre-gl@5.6.2/dist/maplibre-gl.js';script.crossOrigin='anonymous';
        const timeout=setTimeout(()=>reject(new Error('Globe library download timed out.')),15000);
        script.onload=()=>{clearTimeout(timeout);resolve();};script.onerror=()=>{clearTimeout(timeout);reject(new Error('Globe library could not be loaded.'));};document.head.append(script);
      });
      await globeLoading;
    }
    async function showGlobe() {
      setMapMode(false);globeActive=true;$('map').hidden=true;$('globeMap').hidden=false;$('globeStatus').hidden=false;
      text('globeStatus','Loading globe renderer…');$('modeGlobe').classList.toggle('is-active',true);$('modeGlobe').setAttribute('aria-pressed','true');$('modeSample').classList.toggle('is-active',false);$('modeSample').setAttribute('aria-pressed','false');
      try {
        await loadGlobeLibrary();if(!globeActive)return;
        if(globe){globe.resize();if(globeReady){renderGlobe();focusGlobe(filteredRows());text('globeStatus','Globe · NASA GIBS daily true-colour imagery. Background date may differ from detections; clouds and smoke obscure ground.');}else text('globeStatus','Globe renderer is initializing; imagery continues loading in the background.');return;}
        globe=new window.maplibregl.Map({container:'globeMap',center:[0,10],zoom:.4,maxZoom:17,attributionControl:true,
          style:{version:8,projection:{type:'globe'},sources:{},layers:[
            {id:'background',type:'background',paint:{'background-color':'#171614'}}
          ]}});
        globe.addControl(new window.maplibregl.NavigationControl({visualizePitch:true}),'top-right');
        globe.addControl(new window.maplibregl.ScaleControl({unit:'metric'}),'bottom-left');
        globe.on('error',event=>{
          if(event.sourceId==='satellite' && state.basemapName==='satellite') {
            state.basemapName='reference';$('basemapSelect').value='reference';layerVisibility();
            text('mapNote','NASA daily imagery is unavailable for this date or connection. Showing the OpenStreetMap reference basemap; observation markers and event bounds remain available.');
          }
          text('globeStatus',`Globe map error: ${event.error?.message || 'a map resource could not be loaded'}. Reference tiles remain available; map tiles require an internet connection.`);
        });
        const initializeGlobe = () => {
          if(globeSetupStarted)return;
          globeSetupStarted=true;
          try {
            globe.setProjection({type:'globe'});
            globe.addSource('satellite',{type:'raster',tiles:[`https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/MODIS_Terra_CorrectedReflectance_TrueColor/default/${state.imageryDate}/GoogleMapsCompatible_Level9/{z}/{y}/{x}.jpg`],tileSize:256,maxzoom:9,attribution:'NASA GIBS · MODIS Terra Corrected Reflectance True Color'});
            globe.addSource('terrain',{type:'raster',tiles:['https://tile.opentopomap.org/{z}/{x}/{y}.png'],tileSize:256,maxzoom:17,attribution:'Map data © OpenStreetMap contributors · OpenTopoMap CC-BY-SA'});
            globe.addSource('reference',{type:'raster',tiles:['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],tileSize:256,maxzoom:19,attribution:'© OpenStreetMap contributors'});
            globe.addSource('labels',{type:'raster',tiles:[`https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/Reference_Labels/default/${state.imageryDate}/GoogleMapsCompatible_Level9/{z}/{y}/{x}.png`],tileSize:256,maxzoom:9,attribution:'NASA Earthdata · Reference Labels'});
            globe.addLayer({id:'basemap-satellite',type:'raster',source:'satellite',layout:{visibility:'visible'}});
            globe.addLayer({id:'basemap-terrain',type:'raster',source:'terrain',layout:{visibility:'none'}});
            globe.addLayer({id:'basemap-reference',type:'raster',source:'reference',layout:{visibility:'none'}});
            globe.addLayer({id:'reference-labels',type:'raster',source:'labels',layout:{visibility:'none'},paint:{'raster-opacity':0.88}});
            globe.addSource('detections',{type:'geojson',data:{type:'FeatureCollection',features:[]}});
            globe.addLayer({id:'observations',type:'circle',source:'detections',paint:{'circle-radius':4,'circle-color':['case',['get','hasScore'],['interpolate',['linear'],['get','score'],0,'#8c7889',50,'#a38ca1',100,'#c0aac0'],'#a39c94'],'circle-opacity':state.markerOpacity,'circle-stroke-width':.8,'circle-stroke-color':'#eee8df'}});
            globe.addLayer({id:'selected-observation',type:'circle',source:'detections',filter:['==',['get','selected'],true],paint:{'circle-radius':7,'circle-color':'#a98da4','circle-opacity':state.markerOpacity,'circle-stroke-width':2,'circle-stroke-color':'#f0ebe2'}});
            globe.addSource('bounds',{type:'geojson',data:{type:'FeatureCollection',features:[]}});
            globe.addLayer({id:'event-bounds',type:'line',source:'bounds',paint:{'line-color':'#b7a2b5','line-width':1.5,'line-dasharray':[3,2]}});
            globe.on('click','observations',event=>{const key=event.features?.[0]?.properties?.key;if(key)selectObservation(key,false);});
            globe.on('mouseenter','observations',()=>{globe.getCanvas().style.cursor='pointer';});globe.on('mouseleave','observations',()=>{globe.getCanvas().style.cursor='';});
            globe.on('mousemove',event=>text('mapCoordinates',`${fmt(event.lngLat.lat,5)}°, ${fmt(event.lngLat.lng,5)}° · WGS84 globe`));
            globeReady=true;layerVisibility();text('globeStatus','Globe · NASA GIBS daily true-colour imagery. Background date may differ from detections; clouds and smoke obscure ground.');renderGlobe();focusGlobe(filteredRows());
          } catch(error) {
            text('globeStatus',`Globe initialization failed: ${error.message}. Use the 2D map or observation table; no map data was changed.`);
          }
        };
        const initializeWhenStyleReady = () => { if(globe.isStyleLoaded())initializeGlobe(); };
        globe.on('style.load',initializeGlobe);
        globe.on('load',initializeGlobe);
        globe.on('styledata',initializeWhenStyleReady);
        globe.on('render',initializeWhenStyleReady);
        if(globe.isStyleLoaded())initializeGlobe();
      } catch(error) { text('globeStatus',`${error.message} Use the 2D map or observation table. WebGL and a reachable MapLibre CDN are required.`); }
    }
    function renderGlobe() {
      if(!globeReady)return;
      const rows=filteredRows().filter(D.coordinate).slice(0,5000);
      const selected=state.rows.find(row=>state.keys.get(row)===state.selectedKey);
      if(selected && D.coordinate(selected) && !rows.includes(selected))rows.push(selected);
      globe.getSource('detections').setData({type:'FeatureCollection',features:rows.map(row=>({type:'Feature',properties:{key:state.keys.get(row),score:D.numeric(row.score)??0,hasScore:D.numeric(row.score)!=null,selected:state.keys.get(row)===state.selectedKey},geometry:{type:'Point',coordinates:[Number(row.longitude),Number(row.latitude)]}}))});
      const geometry=D.footprint(selectedMembers());globe.getSource('bounds').setData({type:'FeatureCollection',features:geometry?[{type:'Feature',geometry,properties:{}}]:[]});layerVisibility();
    }
    function selectionChanged() {
      if(reportSnapshot && reportSnapshot.scope==='candidate_event' && !sameId(reportSelection,state.selectedEvent))clearReport();
      text('inspectorTitle',state.selectedEvent==null?'Observation details':`Candidate event ${state.selectedEvent}`);
      $('reportSelected').disabled=state.selectedEvent==null;$('zoomEvent').disabled=!D.bounds(selectedMembers());
      renderExplorer();renderBounds();renderGlobe();reportControls();
    }
    function datasetChanged() { clearReport(); datasetRef=null; }
    function update() {
      if(datasetRef!==state.rows) {
        datasetRef=state.rows;populateEventSelect('compareA',state.events[0]?.event_id);populateEventSelect('compareB',state.events[1]?.event_id);
        const rows=filteredRows();if(globeActive&&globeReady&&rows.length)focusGlobe(rows);
      }
      const range=D.timeRange(state.rows);
      text('footerSource',state.ingestion?`${state.provenance==='synthetic'?'SYNTHETIC SAMPLE':state.provenance==='nasa_firms_live'?'NASA FIRMS LIVE':state.provenance==='user_supplied_unverified'?'UPLOADED / UNVERIFIED':'SOURCE UNKNOWN'} · ${state.rows.length} accepted`:'NO DATASET');
      text('footerRange',range.first?`${range.first.slice(0,16).replace('T',' ')} → ${range.last.slice(0,16).replace('T',' ')} UTC`:'Acquisition range unavailable');
      text('footerModel',`Anomaly model: ${state.intelligence?.model?.status || 'unavailable'}`);
      text('lastResponse',state.loadedAt?`Loaded ${state.loadedAt.slice(11,19)} UTC`:'No API data response yet');
      $('refreshData').disabled=state.loading || !state.sourceType;$('refreshData').textContent=state.sourceType==='upload'?'Reprocess upload':state.sourceType==='firms'?'Fetch live observations again':'Refresh dataset';
      text('inspectorTitle',state.selectedEvent==null?'Select an event':`Candidate event ${state.selectedEvent}`);
      $('reportSelected').disabled=state.selectedEvent==null;$('zoomEvent').disabled=!D.bounds(selectedMembers());
      renderBounds();renderGlobe();reportControls();
      if(view==='events')renderCatalog();if(view==='analytics')renderAnalytics();if(view==='data')renderContext();
    }
    for(const name of ['dashboard','map','events','analytics','reports','data'])on('nav'+name[0].toUpperCase()+name.slice(1),'click',()=>navigate(name));
    for(const section of ['Event','Score','Observation'])on('inspect'+section,'click',()=>inspector(section));
    on('openData','click',()=>navigate('data'));on('dataSample','click',loadSample);
    on('uploadLabel','keydown',event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();$('file').click();}});
    on('refreshData','click',()=>state.sourceType==='upload'?upload(state.sourceFile):state.sourceType==='firms'?fetchLiveFirms():loadSample());on('healthRefresh','click',checkHealth);
    on('fetchLiveFirms','click',fetchLiveFirms);
    on('eventSearch','input',event=>{eventQuery=event.target.value;renderExplorer();});on('eventSort','change',event=>{eventOrder=event.target.value;renderExplorer();});
    for(const id of ['eventsFilters','analyticsFilters'])on(id,'click',()=>{navigate('dashboard');if($('filterRail').hidden)$('toggleFilters').click();});
    on('compareA','change',renderComparison);on('compareB','change',renderComparison);
    on('reportSelected','click',()=>{navigate('reports');$('reportScope').value='event';reportControls();generateReport();});
    on('reportScope','change',clearReport);on('generateReport','click',generateReport);
    on('downloadReport','click',()=>download('json'));on('downloadReportCsv','click',()=>download('csv'));on('printReport','click',()=>{if(reportSnapshot)window.print();});
    on('modeGlobe','click',showGlobe);on('zoomEvent','click',locateEvent);on('mapOverview','click',overview);
    on('layerDetections','change',event=>{detections=event.target.checked;layerVisibility();saveLayers();});
    on('layerBounds','change',event=>{eventBounds=event.target.checked;renderBounds();layerVisibility();saveLayers();});
    on('layerBasemap','change',event=>{basemap=event.target.checked;layerVisibility();saveLayers();});
    on('layerLabels','change',event=>{state.referenceLabels=event.target.checked;layerVisibility();saveLayers();});
    on('basemapSelect','change',event=>applyBasemap(event.target.value));
    on('imageryDate','change',event=>{if(event.target.value)applyBasemap(state.basemapName,event.target.value);});
    on('markerOpacity','input',event=>{state.markerOpacity=Number(event.target.value);text('markerOpacityValue',`${Math.round(state.markerOpacity*100)}%`);render();});
    $('imageryDate').value=state.imageryDate;
    $('markerOpacity').value=String(state.markerOpacity);
    $('markerOpacityValue').textContent=`${Math.round(state.markerOpacity*100)}%`;
    function saveLayers(){try{window.localStorage?.setItem('pyrowatch.layers.v1',JSON.stringify({detections,eventBounds,basemap,referenceLabels:state.referenceLabels}));}catch(_){/* Preferences are optional. */}}
    try {const saved=JSON.parse(window.localStorage?.getItem('pyrowatch.layers.v1')||'null');if(saved){detections=saved.detections!==false;eventBounds=saved.eventBounds!==false;basemap=saved.basemap!==false;state.referenceLabels=saved.referenceLabels===true;}}catch(_){/* Ignore malformed local preferences. */}
    $('layerDetections').checked=detections;$('layerBounds').checked=eventBounds;$('layerBasemap').checked=basemap;$('layerLabels').checked=state.referenceLabels;
    applyBasemap(state.basemapName,state.imageryDate);
    window.addEventListener?.('resize',()=>{state.map?.invalidateSize?.();if(globeActive)globe?.resize();});
    return {navigate,renderExplorer,update,selectionChanged,datasetChanged,leaveGlobe};
  }
};
