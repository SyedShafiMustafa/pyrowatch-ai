(() => {
  "use strict";
  const API_BASE_URL="http://127.0.0.1:8010";
  const PAGE=50, $=id=>document.getElementById(id);
  const state={dataset:[],issues:[],ingestion:null,provenance:"unknown",events:[],intelligence:{model:null,events:[]},evaluation:null,weights:null,search:"",filters:{confidenceMin:0,frpMin:null,fromDate:"",toDate:"",satellite:"",daynight:"",staticOnly:false,event:""},sort:"score",limit:PAGE,selectedKey:null,timelineEvent:null,timelineButtons:new Map(),breakdownButtons:new Map(),loading:false,error:null,message:"",map:null,layer:null,markers:new Map(),mapAvailable:false,tileFailed:false,keyByObject:new WeakMap()};
  const el=(tag,cls,text)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=String(text);return n;};
  const text=(id,value)=>$(id).textContent=value==null?"Unavailable":String(value);
  const fmt=(v,d=2)=>v==null||v===""||!Number.isFinite(Number(v))?"Unavailable":Number(v).toFixed(d);
  const date=v=>{if(typeof v!=="string"||!v)return null;const d=new Date(v);return Number.isNaN(d.getTime())?null:d;};
  const time=v=>{const d=date(v);return d?d.toISOString().replace("T"," ").replace(/\.\d{3}Z$/," UTC"):"Unavailable";};
  function parse(payload){
    if(!payload||typeof payload!=="object"||Array.isArray(payload))throw Error("The server returned an unexpected response format.");
    if(!Array.isArray(payload.rows)||!Array.isArray(payload.issues)||!payload.ingestion||typeof payload.ingestion!=="object")throw Error("Response is missing required observations, issues, or ingestion metadata.");
    const rows=payload.rows.filter(r=>r&&typeof r==="object"&&!Array.isArray(r));if(rows.length!==payload.rows.length)throw Error("Response contains an invalid observation record.");
    const intelligence=payload.intelligence&&typeof payload.intelligence==="object"&&!Array.isArray(payload.intelligence)?payload.intelligence:{};
    return {rows,issues:payload.issues.filter(x=>typeof x==="string"),ingestion:payload.ingestion,provenance:["synthetic","user_supplied_unverified"].includes(payload.ingestion.data_kind)?payload.ingestion.data_kind:"unknown",events:Array.isArray(payload.events)?payload.events.filter(x=>x&&typeof x==="object"):[],intelligence:{model:intelligence.model&&typeof intelligence.model==="object"?intelligence.model:null,events:Array.isArray(intelligence.events)?intelligence.events.filter(x=>x&&typeof x==="object"):[]},evaluation:payload.evaluation??null,weights:payload.weights&&typeof payload.weights==="object"?payload.weights:null};
  }
  async function api(path,options={}){
    if(window.location?.protocol==="file:")throw Error("This dashboard was opened as a local file. Start the backend and open http://127.0.0.1:8010/ so the browser can connect to the API.");
    const ctrl=new AbortController(),timer=setTimeout(()=>ctrl.abort(),30000);let res;
    try{res=await fetch(new URL(path,API_BASE_URL),{...options,signal:ctrl.signal});}catch(e){clearTimeout(timer);throw Error(e.name==="AbortError"?"The request timed out. Try again.":"Could not reach the API. Check the connection and retry.");}clearTimeout(timer);
    const type=res.headers.get("content-type")||"";let body;
    try{body=type.includes("application/json")?await res.json():await res.text();}catch(_){throw Error(`The server returned invalid JSON (HTTP ${res.status}).`);}
    if(!res.ok){let detail=body&&typeof body.detail==="string"?body.detail:"The server could not complete the request.";if(/traceback|stack trace|\bat [\w.]+\s*\(/i.test(detail))detail="The server returned an internal error.";detail=detail.replace(/(token|password|secret|api[_-]?key|authorization)\s*[:=]\s*\S+/ig,"$1=[redacted]").slice(0,300);throw Error(`${res.status>=500?"Server error":"Request error"} (HTTP ${res.status}): ${detail}`);}
    if(!type.includes("application/json")||!body||typeof body!=="object"||Array.isArray(body))throw Error("The server response was not JSON data as expected.");return body;
  }
  // API has no stable ID: this composite key uses returned identity fields plus an in-load occurrence number. Exact duplicate rows may not retain identity across reloads/reordering.
  function setKeys(rows){const counts=new Map();for(const r of rows){const base=JSON.stringify([r.latitude,r.longitude,r.time,r.satellite,r.instrument,r.source_line]);const n=(counts.get(base)||0)+1;counts.set(base,n);state.keyByObject.set(r,`${base}|occurrence:${n}`);}}
  // Successful dataset replacement deliberately resets every filter and the sort to avoid stale constraints on unrelated data.
  function replace(parsed,message){setKeys(parsed.rows);state.dataset=parsed.rows;state.issues=parsed.issues;state.ingestion=parsed.ingestion;state.provenance=parsed.provenance;state.events=parsed.events;state.intelligence=parsed.intelligence;state.evaluation=parsed.evaluation;state.weights=parsed.weights;state.selectedKey=null;state.timelineEvent=null;details(null);state.limit=PAGE;state.search="";state.filters={confidenceMin:0,frpMin:null,fromDate:"",toDate:"",satellite:"",daynight:"",staticOnly:false,event:""};state.sort="score";for(const [id,value] of Object.entries({search:"",confidenceMin:"0",frpMin:"",fromDate:"",toDate:"",satelliteFilter:"",daynightFilter:"",eventFilter:"",sortBy:"score"}))$(id).value=value;$("staticOnly").checked=false;text("confidenceValue","0.00");state.error=null;state.message=message;render();announce(message);}
  function announce(s){$("announcement").textContent=s;}
  function loading(v){state.loading=v;$("bSample").disabled=v;$("file").disabled=v;$("bSample").textContent=v?"Loading…":"Load synthetic sample";}
  async function sample(){if(state.loading)return;loading(true);state.error=null;state.message="Loading synthetic sample…";status();try{replace(parse(await api("/api/sample")),"Synthetic sample loaded successfully from the API.");}catch(e){state.error=e.message;state.message=(state.dataset.length?"Sample load failed; previous dataset remains displayed. ":"")+e.message;status();announce(state.message);}finally{loading(false);}}
  async function upload(file){if(!file||state.loading)return;loading(true);state.error=null;state.message=`Uploading ${file.name}…`;status();const form=new FormData();form.append("file",file);try{replace(parse(await api("/api/upload",{method:"POST",body:form})),`CSV processed by API: ${file.name}. Provenance is unverified user-supplied data.`);}catch(e){state.error=e.message;state.message=(state.dataset.length?"Upload failed; previous dataset remains displayed. ":"")+e.message;status();announce(state.message);}finally{loading(false);$("file").value="";}}
  function filtered(){const f=state.filters,q=state.search.trim().toLowerCase();const a=state.dataset.filter(r=>{
    if(q&&![r.time,r.satellite,r.instrument,r.event_id,r.why,r.source_line,r.confidence_raw].some(v=>String(v??"").toLowerCase().includes(q)))return false;
    const c=Number(r.confidence);if(f.confidenceMin>0&&(!Number.isFinite(c)||c<f.confidenceMin))return false;
    if(f.frpMin!==null&&(r.frp==null||r.frp===""||!Number.isFinite(Number(r.frp))||Number(r.frp)<f.frpMin))return false;
    const d=date(r.time);if(f.fromDate&&(!d||d<new Date(`${f.fromDate}T00:00:00Z`)))return false;if(f.toDate&&(!d||d>=new Date(`${f.toDate}T00:00:00Z`).getTime()+86400000))return false;
    if(f.satellite&&`${r.satellite??"Unavailable"} / ${r.instrument??"Unavailable"}`!==f.satellite)return false;
    const dn=String(r.daynight||"").toLowerCase(),period=dn==="d"||dn==="day"?"day":dn==="n"||dn==="night"?"night":"unknown";if(f.daynight&&(f.daynight==="unknown"?period!=="unknown":period!==f.daynight))return false;
    if(f.staticOnly&&r.possible_static_source!==true)return false;if(f.event&&String(r.event_id??"")!==f.event)return false;return true;
  });
    a.sort((x,y)=>{if(state.sort==="time")return(date(y.time)?.getTime()??-Infinity)-(date(x.time)?.getTime()??-Infinity);if(state.sort==="satellite")return String(x.satellite??"").localeCompare(String(y.satellite??""));const rawX=x[state.sort],rawY=y[state.sort],ax=rawX==null||rawX===""?NaN:Number(rawX),ay=rawY==null||rawY===""?NaN:Number(rawY);return(Number.isFinite(ay)?ay:-Infinity)-(Number.isFinite(ax)?ax:-Infinity);});return a;
  }
  const validCoord=r=>r.latitude!=null&&r.longitude!=null&&r.latitude!==""&&r.longitude!==""&&Number.isFinite(Number(r.latitude))&&Number.isFinite(Number(r.longitude))&&Number(r.latitude)>=-90&&Number(r.latitude)<=90&&Number(r.longitude)>=-180&&Number(r.longitude)<=180;
  const color=s=>s==null||s===""||!Number.isFinite(Number(s))?"#53645b":`hsl(${120-Math.max(0,Math.min(100,Number(s)))*1.2} 62% 38%)`;
  function fallback(s){$("mapFallback").hidden=false;$("mapFallback").textContent=s;$("map").hidden=true;}
  function initMap(){try{if(!window.L||typeof L.map!=="function"||typeof L.tileLayer!=="function"||typeof L.layerGroup!=="function"){fallback("Map unavailable: Leaflet did not load. Use the observation table to review records.");return;}state.map=L.map("map",{scrollWheelZoom:false}).setView([-33,150.3],5);const tiles=L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png",{attribution:"© OpenStreetMap contributors",maxZoom:19});tiles.on("tileerror",()=>{if(!state.tileFailed){state.tileFailed=true;$("mapFallback").hidden=false;$("mapFallback").textContent="Map background tiles are unavailable. Markers may still be shown.";}});tiles.addTo(state.map);state.layer=L.layerGroup().addTo(state.map);state.mapAvailable=true;$("mapFallback").hidden=true;$("map").hidden=false;}catch(_){state.mapAvailable=false;fallback("Map could not be initialized. The observation table remains available.");}}
  function updateMap(rows){if(!state.mapAvailable||!state.layer)return;try{state.layer.clearLayers();state.markers.clear();const valid=rows.filter(validCoord),plotted=valid.slice(0,1500);for(const r of plotted){const key=state.keyByObject.get(r),c=color(r.score),m=L.circleMarker([Number(r.latitude),Number(r.longitude)],{radius:6,weight:1.5,color:c,fillColor:c,fillOpacity:.78});const popup=document.createElement("div");popup.append(el("strong","",`Review priority: ${fmt(r.score,1)}`),el("p","",`Time: ${time(r.time)}`),el("p","",`Explanation: ${r.why??"Unavailable"}`));m.bindPopup(popup);m.on("click",()=>select(key,false));m.addTo(state.layer);state.markers.set(key,m);}if(plotted.length)state.map.fitBounds(L.featureGroup([...state.markers.values()]).getBounds().pad(.12),{maxZoom:10});else state.map.setView([-33,150.3],5);if(valid.length>plotted.length){$("mapFallback").hidden=false;$("mapFallback").textContent=`Map displays ${plotted.length} of ${valid.length} coordinate-valid filtered observations for responsiveness. All matching observations remain in the table and export.`;}else if(!state.tileFailed)$("mapFallback").hidden=true;}catch(_){state.mapAvailable=false;fallback("Map rendering failed. The observation table remains available.");}}
  function detailLine(dl,label,value){const row=el("div","detail-row");row.append(el("dt","",label),el("dd","",value==null||value===""?"Unavailable":value));dl.append(row);}
  function details(r){const box=$("detailContent"),score=$("scoreContent");box.replaceChildren();score.replaceChildren();if(!r){box.append(el("p","muted","Select a table row or marker."));score.append(el("p","muted","Backend explanation appears here when a record is selected."));return;}const dl=el("dl","detail-list"),vals=[["UI observation key",state.keyByObject.get(r)],["Latitude",fmt(r.latitude,5)],["Longitude",fmt(r.longitude,5)],["Acquisition time",time(r.time)],["Satellite",r.satellite],["Instrument",r.instrument],["Raw confidence",r.confidence_raw],["Normalized confidence",fmt(r.confidence,3)],["FRP (API units unspecified)",r.frp==null?null:fmt(r.frp,3)],["Brightness (API units unspecified)",r.brightness==null?null:fmt(r.brightness,2)],["Event identifier",r.event_id],["Historical recurrence",r.persistent_source_status??(r.possible_static_source==null?null:r.possible_static_source?"possible persistent source":"not flagged")],["Source CSV line",r.source_line],["Label",r.label],["Repeat count",r.repeat_count]];vals.forEach(x=>detailLine(dl,...x));box.append(dl);if(r.source_fields&&typeof r.source_fields==="object"){const d=document.createElement("details");d.append(el("summary","","Source fields returned by API"));const sd=el("dl","detail-list");Object.entries(r.source_fields).forEach(x=>detailLine(sd,...x));d.append(sd);box.append(d);}score.append(el("p","score-value",`Review priority: ${fmt(r.score)} / 100`),el("p","",r.why??"Unavailable"));}
  function select(key,open=true){const r=state.dataset.find(x=>state.keyByObject.get(x)===key);if(!r)return;state.selectedKey=key;const rows=filtered(),index=rows.findIndex(x=>state.keyByObject.get(x)===key);if(index>=state.limit)state.limit=index+1;details(r);table(rows);const m=state.markers.get(key);if(m&&open){m.openPopup();state.map.panTo(m.getLatLng());}const row=[...$("tb").rows].find(x=>x.dataset.key===key);if(row)row.scrollIntoView({block:"nearest"});openTimeline(r.event_id);}
  // Require an explicit timezone: never interpret an unknown acquisition time as local time.
  function timelineDate(value){
    if(typeof value!=="string")return null;
    const m=value.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/);
    if(!m)return null;
    const [,y,month,day,hour,minute,second]=m.map(Number);
    if(month<1||month>12||day<1||day>new Date(Date.UTC(y,month,0)).getUTCDate()||hour>23||minute>59||second>59)return null;
    return date(value);
  }
  function timeline(){
    const box=$("timelineContent"),picker=$("timelineEvent"),dataset=state.dataset;box.replaceChildren();state.timelineButtons.clear();
    const ids=[...new Set([...state.events,...state.dataset].filter(r=>r.event_id!=null&&r.event_id!=="").map(r=>String(r.event_id)))];
    picker.replaceChildren(new Option("Select a candidate event",""));ids.forEach(id=>picker.add(new Option(`Event ${id}`,id)));
    picker.value=state.timelineEvent??"";
    if(state.timelineEvent===null){box.append(el("p","muted","Select an event, table row or map marker to inspect its observations."));return;}
    const history=state.dataset.filter(r=>r.event_id!=null&&String(r.event_id)===state.timelineEvent).map(r=>({row:r,at:timelineDate(r.time)}));
    const known=history.filter(x=>x.at).sort((a,b)=>a.at-b.at),unknown=history.filter(x=>!x.at);
    box.append(el("h3","",`Event ${state.timelineEvent}`),el("p","help",`${history.length} accepted response entries from this load, independent of table filters. Repeated entries and simultaneous observations remain separate.`));
    if(!history.length){box.append(el("p","muted","No accepted observations available for this event."));return;}
    const visible=new Set(filtered().map(r=>state.keyByObject.get(r)));
    for(const [heading,entries] of [["Chronological observations (UTC)",known],["Time unavailable or invalid",unknown]]){
      if(!entries.length)continue;
      box.append(el("h4","",heading));const list=el("ol","timeline-list");
      for(const {row:r,at} of entries){
        const key=state.keyByObject.get(r),item=el("li","timeline-entry"),dl=el("dl","detail-list");item.dataset.key=key;
        detailLine(dl,"Acquisition time (supplied; UTC)",at?time(r.time):"Unavailable / invalid");
        if(!at&&r.time!=null)detailLine(dl,"Time value received",r.time);
        for(const [label,value] of [["Latitude (supplied)",r.latitude],["Longitude (supplied)",r.longitude],["Satellite (supplied)",r.satellite],["Instrument (supplied)",r.instrument],["Raw confidence (supplied)",r.confidence_raw],["FRP (supplied; API units unspecified)",r.frp],["Normalized confidence (derived by API)",fmt(r.confidence,3)],["Elapsed from first timed observation (derived)",at?`${fmt((at-known[0].at)/3600000,3)} h`:null]])detailLine(dl,label,value);
        item.append(dl);
        const b=el("button","text-button",visible.has(key)?"Select observation":"Hidden by table filters");b.type="button";b.disabled=!visible.has(key);b.setAttribute("aria-pressed",String(key===state.selectedKey));state.timelineButtons.set(key,b);
        b.addEventListener("click",()=>{
          // Ignore callbacks from an old load, even if its observation keys recur.
          if(state.dataset!==dataset||b.disabled)return;
          const observationKey=key,restoreFocus=document.activeElement===b;
          select(observationKey);
          // Restore focus by the stable observation key, never a fragile list index. If the equivalent button is gone (observation removed or dataset replaced), leave focus where the browser placed it instead of stealing focus to the table or another unrelated control.
          const equivalent=state.dataset===dataset?state.timelineButtons.get(observationKey):null;
          if(restoreFocus&&equivalent&&!equivalent.disabled)equivalent.focus();
        });item.append(b);list.append(item);
      }
      box.append(list);
    }
  }
  function openTimeline(id){state.timelineEvent=id==null||id===""?null:String(id);timeline();breakdown();evidence();}
  // Phase 5.2: explain the backend's uncalibrated review priority. Contributions (c_*) and
  // normalized factors (f_*) are read directly from the API response; the frontend never
  // recomputes the scoring formula. Any field may be absent, so every check is explicit.
  const PRIORITY_FACTORS=[["Recency","recency"],["Confidence","confidence"],["Fire radiative power (FRP)","frp"],["Repeat observations","repeats"],["Brightness","brightness"]];
  const FACTOR_DETAIL={
    recency:{rawLabel:"Acquisition time (supplied; UTC)",raw:r=>time(r.time),explain:"Relative to the latest observation in this loaded dataset, with a 24-hour half-life. It is not measured from the current clock."},
    confidence:{rawLabel:"Normalized confidence (API)",raw:r=>r.confidence==null||r.confidence===""?null:fmt(r.confidence,3),explain:"The API-normalized confidence value for this detection."},
    frp:{rawLabel:"FRP (API units unspecified)",raw:r=>r.frp==null||r.frp===""?null:fmt(r.frp,3),explain:"A bounded logarithmic factor of the supplied fire radiative power measurement; the API does not state units."},
    repeats:{rawLabel:"Other nearby detections within ±72 h",raw:r=>r.repeat_count==null||r.repeat_count===""?null:String(r.repeat_count),explain:"Other distinct acquisition times in the same approximate spatial bin (about 0.02°) within ±72 hours. This is not the event's row count."},
    brightness:{rawLabel:"Brightness (API units unspecified)",raw:r=>r.brightness==null||r.brightness===""?null:fmt(r.brightness,2),explain:"A bounded transformation of the supplied brightness measurement, referenced to 300 K."}
  };
  const isNumber=v=>v!==null&&v!==undefined&&v!==""&&Number.isFinite(Number(v));
  // The event maximum is the highest individual observation score, not an average or total.
  function eventMaximum(id){
    const rows=state.dataset.filter(r=>r.event_id!=null&&String(r.event_id)===String(id));
    const record=state.events.find(e=>e.event_id!=null&&String(e.event_id)===String(id));
    const backend=record&&isNumber(record.top_score)?Number(record.top_score):null;
    const scores=rows.filter(r=>isNumber(r.score)).map(r=>Number(r.score));
    const maximum=backend!==null?backend:(scores.length?Math.max(...scores):null);
    const tied=maximum===null?[]:rows.filter(r=>isNumber(r.score)&&Math.abs(Number(r.score)-maximum)<1e-9);
    return {maximum,tied};
  }
  function observationButtons(rows,dataset){
    const list=el("ul","tie-list");
    for(const r of rows){
      const key=state.keyByObject.get(r),li=el("li","tie-entry");
      li.append(el("p","tie-meta",`${time(r.time)} · observation key ${key??"Unavailable"}`));
      const b=el("button","text-button",key===state.selectedKey?"Selected observation":"Inspect this observation");b.type="button";b.disabled=key==null;b.setAttribute("aria-pressed",String(key===state.selectedKey));
      if(key!=null)state.breakdownButtons.set(key,b);
      b.addEventListener("click",()=>{
        if(state.dataset!==dataset||b.disabled)return;
        const observationKey=key,restoreFocus=document.activeElement===b;
        select(observationKey);
        // Match Phase 5.1: restore focus by key, or leave it alone if the observation is gone.
        const equivalent=state.dataset===dataset?state.breakdownButtons.get(observationKey):null;
        if(restoreFocus&&equivalent&&!equivalent.disabled)equivalent.focus();
      });
      li.append(b);list.append(li);
    }
    return list;
  }
  function factorEntry(r,name,key,missing){
    const detail=FACTOR_DETAIL[key],cRaw=r[`c_${key}`],fRaw=r[`f_${key}`];
    const cKnown=isNumber(cRaw),fKnown=isNumber(fRaw),raw=detail.raw(r);
    const entry=el("div","factor-entry");
    entry.append(el("p","factor-head",`${name}: ${cKnown?`${fmt(cRaw,2)} pts`:"Unavailable"}`));
    const meta=[];
    if(fKnown)meta.push(`normalized f_${key}: ${fmt(fRaw,3)}`);
    if(raw!==null&&raw!==undefined&&raw!=="")meta.push(`${detail.rawLabel}: ${raw}`);
    entry.append(el("p","muted",meta.length?meta.join(" · "):"No normalized or raw value was returned for this factor."));
    let status;
    if(!cKnown&&!fKnown)status="Contribution and normalized value not returned by this API response.";
    else if(!cKnown)status="Contribution field not returned by this API response.";
    else if(!fKnown)status="Contribution provided, but no normalized value was returned.";
    else if(missing)status="The raw measurement is missing, so the backend assigned 0 contribution.";
    else if(Number(cRaw)===0)status="Genuine zero: the measurement is present but contributes 0.00 points.";
    else status=`Contributes ${fmt(cRaw,2)} of the 100 review-priority points.`;
    const kind=!cKnown||!fKnown?"unavailable":(missing?"missing":(Number(cRaw)===0?"zero":"points"));
    entry.append(el("p",`factor-status ${kind}`,status));
    entry.append(el("p","help",detail.explain));
    return entry;
  }
  function breakdown(){
    const box=$("breakdownContent"),dataset=state.dataset;
    box.replaceChildren();state.breakdownButtons.clear();
    box.append(el("h3","","Event review priority"));
    if(state.timelineEvent===null){
      box.append(el("p","muted","Select an event, table row or map marker to see the highest observation score within it."));
    }else{
      const {maximum,tied}=eventMaximum(state.timelineEvent);
      box.append(el("p","score-value",`Event review priority: ${maximum===null?"Unavailable":`${fmt(maximum,2)} / 100`}`));
      box.append(el("p","help","Highest observation score within this event. It is one observation's score, not an average, sum, or aggregate for the event."));
      if(maximum!==null&&tied.length){box.append(el("p","muted",tied.length===1?"1 observation produced this maximum:":`${tied.length} observations tie for this maximum. Inspect each:`));box.append(observationButtons(tied,dataset));}
      else if(maximum!==null)box.append(el("p","muted","No observation in the current dataset matches that maximum."));
    }
    box.append(el("h3","","Selected observation breakdown"));
    const r=state.selectedKey?state.dataset.find(x=>state.keyByObject.get(x)===state.selectedKey):null;
    if(!r){box.append(el("p","muted","Select an observation in the table, timeline or map to see its score contributions."));return;}
    box.append(el("p","score-value",`Observation review priority: ${isNumber(r.score)?`${fmt(r.score,2)} / 100`:"Unavailable"}`));
    if(state.timelineEvent!==null){
      if(r.event_id!=null&&String(r.event_id)!==String(state.timelineEvent))box.append(el("p","muted",`This observation belongs to event ${r.event_id}, not the event shown above.`));
      else{
        const {maximum,tied}=eventMaximum(state.timelineEvent);
        if(maximum!==null&&isNumber(r.score)&&Math.abs(Number(r.score)-maximum)<1e-9)box.append(el("p","muted",tied.length>1?`This observation is tied for the highest score in event ${state.timelineEvent}.`:`This observation has the highest score in event ${state.timelineEvent}.`));
        else if(maximum!==null&&isNumber(r.score))box.append(el("p","muted",`This is not the event maximum; the highest score in event ${state.timelineEvent} is ${fmt(maximum,2)}.`));
        else box.append(el("p","muted","Event maximum unavailable for comparison."));
      }
    }
    box.append(el("p","help","This observation's own score is separate from the event maximum. Scores are uncalibrated review priorities, not fire probabilities or predictions of spread."));
    if(r.why!==null&&r.why!==undefined&&r.why!=="")box.append(el("p","muted",`Backend explanation: ${r.why}`));
    const missing=new Set(Array.isArray(r.score_missing_factors)?r.score_missing_factors.map(String):[]);
    const list=el("div","factor-list");
    for(const [name,key] of PRIORITY_FACTORS)list.append(factorEntry(r,name,key,missing.has(key)));
    box.append(list);
    box.append(el("p","help","Contributions are returned by the API; this dashboard does not recompute the scoring formula and shows values as received."));
  }
  // Phase 5.3: deterministic evidence and uncertainty. Every value comes from the API response;
  // nothing is inferred, scored, or generated, and no LLM is used. Fields may be absent, so
  // each state is decided with explicit null/undefined checks.
  const RECURRENCE_STATUS={possible_persistent_source:"Recurrence flagged (possible persistent source)",not_flagged:"Recurrence not flagged",insufficient_history:"Insufficient history to assess recurrence"};
  const TREND_STATUS={rising:"FRP rising",falling:"FRP falling",stable:"FRP stable",insufficient_data:"Insufficient data for a trend"};
  function intelligenceFor(id){
    if(id===null)return null;
    const events=state.intelligence&&Array.isArray(state.intelligence.events)?state.intelligence.events:[];
    return events.find(e=>e&&e.event_id!=null&&String(e.event_id)===String(id))||null;
  }
  const evidenceStatus=(label,text,state)=>el("p",`evidence-status ${state}`,`${label}: ${text}`);
  function evidenceFactor(r,name,key,missing){
    const cRaw=r[`c_${key}`],fRaw=r[`f_${key}`],cKnown=isNumber(cRaw),fKnown=isNumber(fRaw);
    let text,state;
    if(!cKnown&&!fKnown){text="contribution and normalized value unavailable (not returned by the API)";state="unavailable";}
    else if(!cKnown){text="contribution field unavailable (not returned by the API)";state="unavailable";}
    else if(!fKnown){text="normalized value unavailable; contribution shown as received";state="unavailable";}
    else if(missing.has(key)){text="measurement missing; the backend assigns 0 contribution";state="missing";}
    else if(Number(cRaw)===0){text="measurement present with a genuine zero contribution";state="zero";}
    else{text=`measurement present; contributes ${fmt(cRaw,2)} points`;state="present";}
    return el("p",`evidence-factor ${state}`,`${name} — ${text}`);
  }
  function evidence(){
    const box=$("evidenceContent");box.replaceChildren();
    const event=state.timelineEvent;
    const r=state.selectedKey?state.dataset.find(x=>state.keyByObject.get(x)===state.selectedKey):null;
    const intel=intelligenceFor(event);
    const model=state.intelligence&&state.intelligence.model?state.intelligence.model:null;
    const anomaly=intel&&intel.anomaly?intel.anomaly:null;
    const missing=new Set(r&&Array.isArray(r.score_missing_factors)?r.score_missing_factors.map(String):[]);

    box.append(el("h3","","Supporting evidence"));
    if(event===null)box.append(el("p","muted","Select an event, table row or map marker to see its supporting evidence."));
    else{
      const {maximum,tied}=eventMaximum(event);
      box.append(el("p","muted",maximum===null?"Event review priority: Unavailable":`Event review priority: ${fmt(maximum,2)} / 100 — the highest observation score, not an event average.`));
      if(maximum!==null&&tied.length)box.append(el("p","help",tied.length===1?`Highest-scoring observation: ${time(tied[0].time)} · key ${state.keyByObject.get(tied[0])??"Unavailable"}`:`${tied.length} observations tie for the highest score: ${tied.map(x=>time(x.time)).join("; ")}`));
    }
    if(r){
      const dl=el("dl","detail-list");
      detailLine(dl,"Observation review priority (derived; uncalibrated)",isNumber(r.score)?`${fmt(r.score,2)} / 100`:null);
      detailLine(dl,"Acquisition time (supplied; UTC)",r.time==null?null:time(r.time));
      detailLine(dl,"Latitude (supplied)",r.latitude==null?null:fmt(r.latitude,5));
      detailLine(dl,"Longitude (supplied)",r.longitude==null?null:fmt(r.longitude,5));
      detailLine(dl,"Satellite (supplied)",r.satellite);
      detailLine(dl,"Instrument (supplied)",r.instrument);
      detailLine(dl,"Raw confidence (supplied)",r.confidence_raw);
      detailLine(dl,"Normalized confidence (derived by the API)",r.confidence==null?null:fmt(r.confidence,3));
      detailLine(dl,"FRP (supplied; API units unspecified)",r.frp==null?null:fmt(r.frp,3));
      detailLine(dl,"Brightness (supplied; API units unspecified)",r.brightness==null?null:fmt(r.brightness,2));
      detailLine(dl,"Day / night (supplied)",r.daynight);
      detailLine(dl,"Other nearby detections within ±72 h (derived; not the event row count)",r.repeat_count==null?null:String(r.repeat_count));
      detailLine(dl,"Source CSV line (supplied)",r.source_line);
      box.append(dl);
      box.append(el("p","muted",`Contribution points reported by the API: ${PRIORITY_FACTORS.map(([name,key])=>`${name} ${isNumber(r[`c_${key}`])?fmt(r[`c_${key}`],2):"Unavailable"}`).join(" · ")}`));
      if(r.why!=null&&r.why!=="")box.append(el("p","muted",`Backend explanation: ${r.why}`));
    }else{
      box.append(el("p","muted","Select an observation in the table, timeline or map to list its measurements."));
    }

    box.append(el("h3","","Missing evidence"));
    if(r){
      for(const [name,key] of PRIORITY_FACTORS)box.append(evidenceFactor(r,name,key,missing));
    }else{
      box.append(el("p","muted","Select an observation to classify each scoring factor."));
    }
    const md=el("dl","detail-list");
    const rowMissing=r?[...missing]:null;
    detailLine(md,"Observation factors the API marks missing",r===null?"Unavailable":(Array.isArray(r.score_missing_factors)?(rowMissing.length?rowMissing.join(", "):"None reported"):"Not reported by the API"));
    const featureMissing=intel&&Array.isArray(intel.missing_features)?intel.missing_features.map(String):null;
    detailLine(md,"Event features unavailable",event===null?"Unavailable":(intel===null?"Unavailable":(featureMissing===null?"Not reported by the API":(featureMissing.length?featureMissing.join(", "):"None reported"))));
    box.append(md);
    if(rowMissing&&rowMissing.length)box.append(el("p","help","The API lists the missing measurements but does not state why each is absent, so the reason was not provided."));
    if(featureMissing&&featureMissing.length)box.append(el("p","help","The API lists these event features as unavailable without a per-feature reason, so the reason was not provided."));

    box.append(el("h3","","Trend status and limitations"));
    if(event===null)box.append(el("p","muted","Select an event to see its trend evidence."));
    else if(!intel||!intel.trend)box.append(el("p","muted","Trend evidence unavailable from this API response."));
    else{
      const trend=intel.trend,status=trend.status;
      box.append(evidenceStatus("Trend",TREND_STATUS[status]||(status==null?"Unavailable":String(status)),status==="insufficient_data"?"insufficient":(TREND_STATUS[status]?"ok":"unavailable")));
      box.append(el("p","muted",trend.reason?`Reported reason: ${trend.reason}`:"Reported reason: not provided."));
      const dl=el("dl","detail-list");
      detailLine(dl,"Distinct acquisition times used",trend.distinct_observation_times==null?null:String(trend.distinct_observation_times));
      detailLine(dl,"Time span covered (h)",trend.span_h==null?null:fmt(trend.span_h,2));
      detailLine(dl,"Observed mean-FRP change (MW; API units unspecified)",trend.frp_change_mw==null?null:fmt(trend.frp_change_mw,3));
      detailLine(dl,"Observed mean-FRP change fraction",trend.frp_change_fraction==null?null:fmt(trend.frp_change_fraction,3));
      detailLine(dl,"Early detections per acquisition time",trend.early_detections_per_time==null?null:fmt(trend.early_detections_per_time,3));
      detailLine(dl,"Late detections per acquisition time",trend.late_detections_per_time==null?null:fmt(trend.late_detections_per_time,3));
      box.append(dl);
      if(trend.sampling_limitation)box.append(el("p","help",`Sampling limitation: ${trend.sampling_limitation}`));
      box.append(el("p","help","A measured change in mean FRP is not confirmed physical fire spread, and gaps in observations do not prove that activity stopped."));
    }

    box.append(el("h3","","Recurrence evidence"));
    if(!r)box.append(el("p","muted","Select an observation to see its historical recurrence evidence."));
    else{
      const status=r.persistent_source_status;
      box.append(evidenceStatus("Historical recurrence",RECURRENCE_STATUS[status]||(status==null?"Unavailable":String(status)),status==="possible_persistent_source"?"flagged":(status==="not_flagged"?"not-flagged":(status==="insufficient_history"?"insufficient":"unavailable"))));
      if(status==null)box.append(el("p","muted","The API did not return a recurrence status."));
      const ev=r.persistent_source_evidence;
      if(ev&&typeof ev==="object"&&!Array.isArray(ev)){
        const dl=el("dl","detail-list");
        detailLine(dl,"Distinct historical acquisition times",ev.distinct_times==null?null:String(ev.distinct_times));
        detailLine(dl,"Distinct historical days",ev.distinct_days==null?null:String(ev.distinct_days));
        detailLine(dl,"History coverage (days)",ev.coverage_days==null?null:fmt(ev.coverage_days,2));
        detailLine(dl,"Historical first seen",ev.first_seen==null?null:time(ev.first_seen));
        detailLine(dl,"Historical last seen",ev.last_seen==null?null:time(ev.last_seen));
        detailLine(dl,"Approximate spatial bin (degrees)",ev.spatial_bin_degrees==null?null:fmt(ev.spatial_bin_degrees,3));
        detailLine(dl,"Required distinct days",ev.min_days==null?null:String(ev.min_days));
        detailLine(dl,"Required distinct times",ev.min_distinct_times==null?null:String(ev.min_distinct_times));
        detailLine(dl,"Required coverage (days)",ev.min_coverage_days==null?null:fmt(ev.min_coverage_days,2));
        detailLine(dl,"Lookback window (days)",ev.lookback_days==null?null:String(ev.lookback_days));
        box.append(dl);
        box.append(el("p","muted",ev.reason!=null&&ev.reason!==""?`Reported evidence reason: ${ev.reason}`:"Reported evidence reason: not provided."));
      }else{
        box.append(el("p","muted","Historical evidence detail: not provided by the API."));
      }
      box.append(el("p","help","Recurrence evidence does not confirm a recurring wildfire; the repeat count reflects other nearby detections, not independent fire events."));
    }

    box.append(el("h3","","Anomaly & model availability"));
    if(anomaly){
      if(anomaly.status==="available")box.append(evidenceStatus("Anomaly indicator",anomaly.anomaly_flag===true?"Anomaly flagged":anomaly.anomaly_flag===false?"No anomaly flagged by this model":"Flag not returned by the API",anomaly.anomaly_flag===true?"flagged":anomaly.anomaly_flag===false?"not-flagged":"unavailable"));
      else box.append(evidenceStatus("Anomaly indicator",anomaly.status==="unavailable"?"Unavailable — analysis could not be produced":(anomaly.status==null?"Unavailable":String(anomaly.status)),"unavailable"));
      if(anomaly.model_version!=null)box.append(el("p","muted",`Model version: ${anomaly.model_version}`));
      if(anomaly.anomaly_score!=null)box.append(el("p","muted",`Anomaly score (model output; not a fire probability): ${fmt(anomaly.anomaly_score,3)}`));
      box.append(el("p","help","Unavailable anomaly output is not evidence that no anomaly exists; an anomaly score is separate from the review priority and is not a fire probability."));
    }else{
      box.append(evidenceStatus("Anomaly indicator",event===null?"Unavailable (no event selected)":"Unavailable from this API response","unavailable"));
      box.append(el("p","help","Unavailable anomaly output is not evidence that no anomaly exists."));
    }
    if(model)box.append(evidenceStatus("Anomaly model",model.status==="available"?`Available${model.version?` (${model.version})`:""}`:`Unavailable${model.version?` (${model.version})`:""}${model.reason?` — ${model.reason}`:""}`,model.status==="available"?"ok":"unavailable"));
    else box.append(evidenceStatus("Anomaly model","availability not reported by the API","unavailable"));

    box.append(el("h3","","Uncertainty summary"));
    const notes=[];
    if(r&&missing.size)notes.push(`${missing.size} scoring measurement${missing.size===1?"":"s"} missing (${[...missing].join(", ")}); the backend assigns zero contribution and the API does not state the reason.`);
    if(event===null)notes.push("No event is selected, so trend and event-level evidence are not shown.");
    else if(!intel||!intel.trend||intel.trend.status==="insufficient_data")notes.push(`Trend cannot be assessed${intel&&intel.trend&&intel.trend.reason?`: ${intel.trend.reason}`:" from the current observation history"}.`);
    else notes.push(`Trend is based on ${intel.trend.distinct_observation_times==null?"an unreported number of":intel.trend.distinct_observation_times} distinct acquisition times; a measured FRP change is not confirmed physical spread and observation gaps do not prove that activity stopped.`);
    if(r){
      const status=r.persistent_source_status,reason=r.persistent_source_evidence&&r.persistent_source_evidence.reason;
      if(status==="insufficient_history")notes.push(`Historical recurrence cannot be assessed${reason?`: ${reason}`:"; the reason was not provided"}.`);
      else if(status==="possible_persistent_source")notes.push("Historical recurrence evidence flags a possibly persistent source; this is not a confirmed wildfire.");
      else if(status==="not_flagged")notes.push("Recurrence was not flagged for this observation.");
    }
    if(anomaly&&anomaly.status==="unavailable")notes.push("Anomaly analysis is unavailable; missing model output is not evidence that no anomaly exists.");
    else if(anomaly&&anomaly.status==="available")notes.push(`Anomaly analysis is available and ${anomaly.anomaly_flag===true?"flagged this event":"did not flag this event"}; the anomaly score is not a fire probability.`);
    notes.push("The review priority is an uncalibrated heuristic, not a fire probability, and satellite detections alone do not confirm a wildfire or its cause.");
    const ul=el("ul","uncertainty-list");
    for(const n of notes)ul.append(el("li","",n));
    box.append(ul);
  }
  function table(rows){const tb=$("tb");tb.replaceChildren();const page=rows.slice(0,state.limit);for(const r of page){const tr=document.createElement("tr"),key=state.keyByObject.get(r);tr.className="observation-row";tr.dataset.key=key;tr.tabIndex=0;tr.setAttribute("aria-selected",String(key===state.selectedKey));if(key===state.selectedKey)tr.classList.add("selected");const recurrence=r.persistent_source_status==="insufficient_history"?"Insufficient history":r.possible_static_source===true?"Possible":r.possible_static_source===false?"No":"Unavailable";const vals=[fmt(r.score,1),time(r.time),fmt(r.confidence),r.frp==null?"Unavailable":fmt(r.frp),r.satellite??"Unavailable",r.event_id??"Unavailable",recurrence];vals.forEach((v,i)=>{const td=document.createElement("td");td.textContent=String(v);if(i===0){td.className="priority-cell";td.style.setProperty("--priority-color",color(r.score));}tr.append(td);});tr.addEventListener("click",()=>select(key));tr.addEventListener("keydown",e=>{if(e.key==="Enter"||e.key===" "){e.preventDefault();select(key);}});tb.append(tr);}$("pageInfo").textContent=rows.length?`Showing ${page.length} of ${rows.length} matching observations. Export includes all ${rows.length}.`:"No matching observations.";$("showMore").hidden=page.length>=rows.length;$("showMore").textContent=`Show ${Math.min(PAGE,rows.length-page.length)} more`;$("tableWrap").hidden=!rows.length;$("emptyState").hidden=!!rows.length;$("emptyTitle").textContent=state.dataset.length?"No observations match these filters.":"No observations to display.";$("emptyText").textContent=state.dataset.length?"Clear filters to see the full dataset.":"Load a dataset from the API to begin.";$("clearFromEmpty").hidden=!state.dataset.length||!!rows.length;$("exportCsv").disabled=!state.dataset.length;if(state.selectedKey&&!rows.some(r=>state.keyByObject.get(r)===state.selectedKey)){state.selectedKey=null;details(null);}}
  function ingestion(){const ing=state.ingestion,g=$("ingestionSummary");g.replaceChildren();if(!ing){text("provenance","No dataset loaded.");["mTotal","mAccepted","mRejected","mDuplicates","mEvents","mVisible"].forEach(id=>text(id,"—"));return;}text("provenance",{synthetic:"Synthetic demo data (backend-reported)",user_supplied_unverified:"User-supplied data; provenance unverified",unknown:"Unknown provenance"}[state.provenance]);for(const [label,value] of [["Physical CSV lines",ing.physical_lines],["Input columns",Array.isArray(ing.columns)?ing.columns.join(", ")||"Unavailable":null],["Record outcomes",Array.isArray(ing.outcomes)?ing.outcomes.length:null]]){const n=el("div","ingestion-item");n.append(el("span","",label),el("strong","",value==null?"Unavailable":value));g.append(n);}text("mTotal",ing.total_records??"Unavailable");text("mAccepted",ing.accepted??"Unavailable");text("mRejected",ing.rejected??"Unavailable");text("mDuplicates",ing.deduplicated??"Unavailable");text("mEvents",state.events.length);if(Array.isArray(ing.outcomes)&&ing.outcomes.length){const d=document.createElement("details");d.className="outcome-details";d.append(el("summary","",`Record validation outcomes (${ing.outcomes.length})`));const ul=document.createElement("ul");for(const o of ing.outcomes){const li=el("li","",[o.line!=null?`line ${o.line}${o.end_line!=null&&o.end_line!==o.line?`–${o.end_line}`:""}`:"line unavailable",o.status,o.reason].filter(Boolean).join(" · "));ul.append(li);}d.append(ul);g.append(d);}if(state.issues.length){const d=document.createElement("details");d.className="outcome-details";d.append(el("summary","",`Validation messages (${state.issues.length})`));const ul=document.createElement("ul");state.issues.forEach(issue=>ul.append(el("li","",issue)));d.append(ul);g.append(d);}}
  function events(){const box=$("eventContent"),sel=$("eventFilter"),old=state.filters.event,intelligence=state.intelligence||{model:null,events:[]},byEvent=new Map((intelligence.events||[]).map(e=>[String(e.event_id),e]));box.replaceChildren();sel.replaceChildren(new Option("All events",""));for(const e of state.events)if(e.event_id!=null)sel.add(new Option(`Event ${e.event_id} · ${e.pixels??"?"} observations`,String(e.event_id)));sel.value=[...sel.options].some(o=>o.value===old)?old:"";state.filters.event=sel.value;if(intelligence.model){const reason=intelligence.model.reason?`: ${intelligence.model.reason}`:"";box.append(el("p","muted",`Model anomaly analysis: ${intelligence.model.status??"Unavailable"}${reason}`));}if(!state.events.length){box.append(el("p","muted","Event information unavailable from this API response."));return;}for(const e of state.events.slice(0,8)){const card=el("article","event-card"),intel=byEvent.get(String(e.event_id)),trend=intel?.trend,anomaly=intel?.anomaly;card.append(el("h3","",`Event ${e.event_id??"Unavailable"}`),el("p","",`${e.pixels??"Unavailable"} observations · top score ${fmt(e.top_score,1)} · peak FRP ${fmt(e.peak_frp)} (units unspecified)`),el("p","muted",`${time(e.first_seen)} — ${time(e.last_seen)} · duration ${fmt(e.duration_h)} h`),el("p","muted",`Mean location: ${fmt(e.lat,4)}, ${fmt(e.lon,4)}`));if(trend)card.append(el("p","muted",`Observed FRP trend: ${trend.status??"Unavailable"}${trend.reason?` — ${trend.reason}`:""}`));if(anomaly)card.append(el("p","muted",anomaly.status==="available"?`Anomaly indicator: ${anomaly.anomaly_flag?"flagged":"not flagged"}; score ${fmt(anomaly.anomaly_score,3)} (separate from review priority)`: `Anomaly indicator: unavailable${anomaly.model_version?` (${anomaly.model_version})`:""}`));const b=el("button","text-button","Filter to event");b.type="button";b.addEventListener("click",()=>{state.filters.event=String(e.event_id);$("eventFilter").value=String(e.event_id);state.timelineEvent=String(e.event_id);render();});const view=el("button","text-button","View timeline");view.type="button";view.disabled=e.event_id==null;view.addEventListener("click",()=>openTimeline(e.event_id));card.append(b,view);box.append(card);}if(state.events.length>8)box.append(el("p","help",`Showing 8 of ${state.events.length} supplied events; all are available in the event filter.`));}
  function evaluation(){const box=$("evaluationContent");box.replaceChildren();if(!state.evaluation||typeof state.evaluation!=="object"){box.append(el("p","muted","Evaluation results unavailable from the current API."));return;}const dl=el("dl","detail-list");Object.entries(state.evaluation).forEach(([k,v])=>detailLine(dl,k.replaceAll("_"," "),typeof v==="object"?JSON.stringify(v):v));box.append(dl);}
  function status(){text("datasetMessage",state.message||"");$("datasetMessage").classList.toggle("error-text",!!state.error);$("connectionDot").classList.toggle("is-error",!!state.error);$("connectionDot").classList.toggle("is-ready",!!state.ingestion&&!state.error);}
  function render(){status();ingestion();events();evaluation();const rows=filtered();text("mVisible",rows.length);text("resultCount",`${rows.length} matching observations from ${state.dataset.length} accepted observations.`);table(rows);updateMap(rows);timeline();breakdown();evidence();if(state.selectedKey)details(state.dataset.find(r=>state.keyByObject.get(r)===state.selectedKey)||null);const vals=[...new Set(state.dataset.map(r=>`${r.satellite??"Unavailable"} / ${r.instrument??"Unavailable"}`))].sort(),s=$("satelliteFilter"),old=state.filters.satellite;s.replaceChildren(new Option("All available",""));vals.forEach(v=>s.add(new Option(v,v)));s.value=vals.includes(old)?old:"";state.filters.satellite=s.value;}
  function csvCell(v,isText=false){if(v==null)return"";let s=typeof v==="object"?JSON.stringify(v):String(v);if(isText&&/^\s*[=+@\-]/.test(s))s="'"+s;return`"${s.replaceAll('"','""')}"`;}
  function exportCsv(){const rows=filtered();if(!rows.length){announce("There are no matching observations to export.");return;}const cols=["observation_key","latitude","longitude","time_utc","satellite","instrument","confidence_raw","confidence","frp","brightness","daynight","label","event_id","possible_static_source","score","why","repeat_count","source_line","source_fields"],lines=[cols.map(x=>csvCell(x,true)).join(",")];for(const r of rows){const vals=[state.keyByObject.get(r),r.latitude,r.longitude,r.time,r.satellite,r.instrument,r.confidence_raw,r.confidence,r.frp,r.brightness,r.daynight,r.label,r.event_id,r.possible_static_source,r.score,r.why,r.repeat_count,r.source_line,r.source_fields];lines.push(vals.map((v,i)=>csvCell(v,![1,2,7,8,9,11,14,16,17].includes(i))).join(","));}const url=URL.createObjectURL(new Blob(["\ufeff"+lines.join("\r\n")],{type:"text/csv;charset=utf-8"})),a=document.createElement("a");a.href=url;a.download="fire-triage-matching-observations.csv";a.click();URL.revokeObjectURL(url);announce(`Exported all ${rows.length} matching observations.`);}
  function reset(){state.search="";state.filters={confidenceMin:0,frpMin:null,fromDate:"",toDate:"",satellite:"",daynight:"",staticOnly:false,event:""};state.sort="score";state.limit=PAGE;for(const [id,v] of Object.entries({search:"",confidenceMin:"0",frpMin:"",fromDate:"",toDate:"",satelliteFilter:"",daynightFilter:"",eventFilter:"",sortBy:"score"}))$(id).value=v;text("confidenceValue","0.00");$("staticOnly").checked=false;render();}
  function bind(){ $("timelineEvent").addEventListener("change",e=>openTimeline(e.target.value));$("bSample").addEventListener("click",sample);$("file").addEventListener("change",e=>upload(e.target.files?.[0]));$("exportCsv").addEventListener("click",exportCsv);$("search").addEventListener("input",e=>{state.search=e.target.value;state.limit=PAGE;render();});$("confidenceMin").addEventListener("input",e=>{state.filters.confidenceMin=Number(e.target.value);text("confidenceValue",fmt(e.target.value));render();});$("frpMin").addEventListener("input",e=>{state.filters.frpMin=e.target.value===""?null:Number(e.target.value);render();});for(const [id,key] of [["fromDate","fromDate"],["toDate","toDate"],["satelliteFilter","satellite"],["daynightFilter","daynight"],["eventFilter","event"]])$(id).addEventListener("change",e=>{state.filters[key]=e.target.value;if(key==="event")state.timelineEvent=e.target.value===""?null:String(e.target.value);state.limit=PAGE;render();});$("staticOnly").addEventListener("change",e=>{state.filters.staticOnly=e.target.checked;render();});$("sortBy").addEventListener("change",e=>{state.sort=e.target.value;render();});$("resetFilters").addEventListener("click",reset);$("clearFromEmpty").addEventListener("click",reset);$("showMore").addEventListener("click",()=>{state.limit+=PAGE;table(filtered());});}
  async function health(){try{const r=await api("/api/health");if(r.ok!==true)throw Error("Health endpoint returned an unexpected response.");text("connectionStatus","API connected");$("connectionDot").classList.add("is-ready");}catch(e){text("connectionStatus","API unavailable");$("connectionDot").classList.add("is-error");state.message=e.message;status();}}
  bind();initMap();render();health();
})();
