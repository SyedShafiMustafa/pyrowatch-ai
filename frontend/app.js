(() => {
  "use strict";

  const API_BASE_URL = window.location?.port === "5500"
    ? "http://127.0.0.1:8010"
    : window.location?.origin || "http://127.0.0.1:8010";
  const PAGE_SIZE = 50;
  const FACTORS = ["recency", "confidence", "frp", "repeats", "brightness"];
  const $ = id => document.getElementById(id);
  const state = {
    rows: [], issues: [], ingestion: null, events: [], intelligence: null,
    evaluation: null, weights: null, provenance: "unknown", keys: new WeakMap(),
    filtered: [], selectedKey: null, selectedEvent: null, sort: "score",
    search: "", filters: {}, limit: PAGE_SIZE, times: [], cursor: -1,
    timer: null, loading: false, map: null, mapLayer: null, markers: new Map(),
    duel: false, duelMaps: [], duelLayers: [], exploratory: false,
    exploratoryWeights: null, paletteItems: [], paletteIndex: 0, paletteReturn: null,
    fitPending: false
  };

  const el = (tag, cls, value) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (value !== undefined) node.textContent = String(value);
    return node;
  };
  const setText = (id, value) => { const node = $(id); if (node) node.textContent = value == null ? "Unavailable" : String(value); };
  const fmt = (value, places = 2) => value == null || value === "" || !Number.isFinite(Number(value)) ? "Unavailable" : Number(value).toFixed(places);
  const parsedDate = value => {
    if (typeof value !== "string" || !value.trim()) return null;
    const result = new Date(value);
    return Number.isNaN(result.getTime()) ? null : result;
  };
  const fmtTime = value => {
    const result = parsedDate(value);
    return result ? result.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, " UTC") : "Unavailable";
  };
  const escAttr = value => String(value).replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

  async function request(path, options = {}) {
    if (window.location?.protocol === "file:") throw new Error("Open the dashboard over HTTP, such as http://127.0.0.1:8010/, so the API can be reached.");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    let response;
    try {
      response = await fetch(new URL(path, API_BASE_URL), { ...options, signal: controller.signal });
    } catch (error) {
      clearTimeout(timeout);
      throw new Error(error.name === "AbortError" ? "The API request timed out. Try again." : "Could not reach the API. Check the connection and retry.");
    }
    clearTimeout(timeout);
    const contentType = response.headers.get("content-type") || "";
    let body;
    try {
      body = contentType.includes("application/json") ? await response.json() : await response.text();
    } catch (_) {
      throw new Error(`The server returned invalid JSON (HTTP ${response.status}).`);
    }
    if (!response.ok) {
      let detail = body && typeof body.detail === "string" ? body.detail : "The server could not complete the request.";
      if (/traceback|stack trace|\bat [\w.]+\s*\(/i.test(detail)) detail = "The server returned an internal error.";
      detail = detail.replace(/(token|password|secret|api[_-]?key|authorization)\s*[:=]\s*\S+/ig, "$1=[redacted]").slice(0, 300);
      throw new Error(`${response.status >= 500 ? "Server error" : "Request error"} (HTTP ${response.status}): ${detail}`);
    }
    if (!contentType.includes("application/json") || !body || typeof body !== "object" || Array.isArray(body)) {
      throw new Error("The server response was not JSON data as expected.");
    }
    return body;
  }

  function parseResponse(payload) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("The server returned an unexpected response format.");
    if (!Array.isArray(payload.rows) || !Array.isArray(payload.issues) || !payload.ingestion || typeof payload.ingestion !== "object") {
      throw new Error("Response is missing required observations, issues, or ingestion metadata.");
    }
    if (payload.rows.some(row => !row || typeof row !== "object" || Array.isArray(row))) throw new Error("Response contains an invalid observation record.");
    return {
      rows: payload.rows,
      issues: payload.issues.filter(issue => typeof issue === "string"),
      ingestion: payload.ingestion,
      events: Array.isArray(payload.events) ? payload.events.filter(item => item && typeof item === "object" && !Array.isArray(item)) : [],
      intelligence: payload.intelligence && typeof payload.intelligence === "object" ? payload.intelligence : null,
      evaluation: payload.evaluation && typeof payload.evaluation === "object" ? payload.evaluation : null,
      weights: payload.weights && typeof payload.weights === "object" ? payload.weights : null,
      provenance: ["synthetic", "user_supplied_unverified"].includes(payload.ingestion.data_kind) ? payload.ingestion.data_kind : "unknown"
    };
  }

  // The API has no stable observation ID. This response-local key is only for selection and map sync.
  function assignKeys(rows) {
    const occurrences = new Map();
    for (const row of rows) {
      const base = JSON.stringify([row.latitude, row.longitude, row.time, row.satellite, row.instrument, row.source_line]);
      const count = (occurrences.get(base) || 0) + 1;
      occurrences.set(base, count);
      state.keys.set(row, `${base}|occurrence:${count}`);
    }
  }

  function stopPlayback() {
    if (state.timer !== null) clearInterval(state.timer);
    state.timer = null;
    const button = $("tlPlay");
    if (button) { button.textContent = "Play"; button.setAttribute("aria-pressed", "false"); }
  }
  function resetTimeline(rows) {
    stopPlayback();
    state.times = [...new Set(rows.map(row => parsedDate(row.time)?.getTime()).filter(Number.isFinite))].sort((a, b) => a - b);
    state.cursor = state.times.length - 1;
    const slider = $("tlRange");
    if (slider) {
      slider.min = "0";
      slider.max = String(Math.max(0, state.times.length - 1));
      slider.value = String(Math.max(0, state.cursor));
      slider.disabled = state.times.length === 0;
    }
    updateTimelineLabels();
  }
  function updateTimelineLabels() {
    const cursorTime = state.times[state.cursor];
    setText("tlLabel", cursorTime == null ? "No valid acquisition timestamps" : fmtTime(new Date(cursorTime).toISOString()));
    const undated = state.rows.filter(row => !parsedDate(row.time)).length;
    setText("tlElapsed", `${state.times.length} acquisition times · ${undated} undated excluded`);
    const density = $("timelineDensity");
    if (density) {
      density.replaceChildren();
      const counts = new Map();
      for (const row of state.rows) {
        const timestamp = parsedDate(row.time)?.getTime();
        if (Number.isFinite(timestamp)) counts.set(timestamp, (counts.get(timestamp) || 0) + 1);
      }
      const maxCount = Math.max(1, Array.from(counts.values()).reduce((largest, count) => Math.max(largest, count), 1));
      state.times.forEach((timestamp, index) => {
        const tick = el("i", "timeline-tick");
        const position = state.times.length < 2 ? 50 : index / (state.times.length - 1) * 100;
        const magnitude = counts.get(timestamp) || 1;
        tick.style.left = `${position}%`;
        tick.style.setProperty("--tick-height", `${Math.max(7, magnitude / maxCount * 29)}px`);
        tick.setAttribute("title", `${fmtTime(new Date(timestamp).toISOString())} · ${magnitude} observation${magnitude === 1 ? "" : "s"}`);
        density.append(tick);
      });
    }
    const scale = $("tlScale");
    if (scale) {
      scale.replaceChildren();
      if (state.times.length) {
        const marks = state.times.length < 3 ? state.times : [state.times[0], state.times[Math.floor((state.times.length - 1) / 2)], state.times[state.times.length - 1]];
        for (const mark of [...new Set(marks)]) scale.append(el("span", "mono", new Date(mark).toISOString().slice(0, 16).replace("T", " ") + "Z"));
      }
    }
  }

  function replaceDataset(parsed, message) {
    assignKeys(parsed.rows);
    state.rows = parsed.rows;
    state.fitPending = true;
    state.issues = parsed.issues;
    state.ingestion = parsed.ingestion;
    state.events = parsed.events;
    state.intelligence = parsed.intelligence;
    state.evaluation = parsed.evaluation;
    state.weights = parsed.weights;
    state.provenance = parsed.provenance;
    state.selectedKey = null;
    state.selectedEvent = null;
    state.search = "";
    state.filters = { confidenceMin: 0, frpMin: null, fromDate: "", toDate: "", satellite: "", daynight: "", staticOnly: false, event: "" };
    state.sort = "score";
    state.limit = PAGE_SIZE;
    state.exploratory = false;
    state.exploratoryWeights = state.weights ? { ...state.weights } : null;
    for (const [id, value] of Object.entries({
      search: "", confidenceMin: "0", frpMin: "", fromDate: "", toDate: "",
      satelliteFilter: "", daynightFilter: "", eventFilter: "", sortBy: "score"
    })) if ($(id)) $(id).value = value;
    if ($("staticOnly")) $("staticOnly").checked = false;
    if ($("weightsOn")) $("weightsOn").checked = false;
    resetTimeline(parsed.rows);
    state.message = message;
    state.error = null;
    syncWeightControls();
    render();
    announce(message);
  }
  function announce(message) { setText("announcement", message); }
  function toast(message, kind = "info") {
    const region = $("toasts");
    if (!region) return;
    const item = el("div", `toast ${kind}`);
    item.setAttribute("role", kind === "error" ? "alert" : "status");
    item.append(el("span", "", message));
    const close = el("button", "", "Dismiss");
    close.type = "button";
    close.setAttribute("aria-label", "Dismiss notification");
    close.addEventListener("click", () => item.remove());
    item.append(close);
    region.append(item);
  }
  function setLoading(loading) {
    state.loading = loading;
    if ($("bSample")) $("bSample").disabled = loading;
    if ($("file")) $("file").disabled = loading;
    if ($("ingestXray")) $("ingestXray").hidden = !loading;
  }
  async function loadSample() {
    if (state.loading) return;
    setLoading(true);
    state.error = false;
    state.message = "Loading the synthetic sample…";
    renderStatus();
    try {
      replaceDataset(parseResponse(await request("/api/sample")), "Synthetic sample loaded from the API.");
    } catch (error) {
      showRequestError("Sample load failed", error);
    } finally { setLoading(false); }
  }
  async function upload(file) {
    if (!file || state.loading) return;
    setLoading(true);
    state.error = false;
    state.message = `Uploading ${file.name}…`;
    renderStatus();
    const form = new FormData();
    form.append("file", file);
    try {
      replaceDataset(parseResponse(await request("/api/upload", { method: "POST", body: form })), `CSV processed: ${file.name}. Provenance remains unverified.`);
      toast("Upload processed. Counts below are reported by the API.", "ok");
    } catch (error) {
      showRequestError("Upload failed", error);
    } finally {
      setLoading(false);
      if ($("file")) $("file").value = "";
    }
  }
  function showRequestError(prefix, error) {
    state.error = true;
    state.message = `${prefix}; ${state.rows.length ? "previous dataset remains displayed. " : ""}${error.message}`;
    renderStatus();
    announce(state.message);
    toast(state.message, "error");
  }

  function validCoordinate(row) {
    return row.latitude != null && row.longitude != null && row.latitude !== "" && row.longitude !== "" &&
      Number.isFinite(Number(row.latitude)) && Number.isFinite(Number(row.longitude)) &&
      Number(row.latitude) >= -90 && Number(row.latitude) <= 90 &&
      Number(row.longitude) >= -180 && Number(row.longitude) <= 180;
  }
  function factorValue(row, factor) {
    const value = Number(row[`f_${factor}`]);
    return row[`f_${factor}`] != null && row[`f_${factor}`] !== "" && Number.isFinite(value) ? value : 0;
  }
  function exploratoryScore(row) {
    if (!state.exploratoryWeights) return null;
    const total = FACTORS.reduce((sum, factor) => sum + Number(state.exploratoryWeights[factor] || 0), 0);
    if (!(total > 0)) return null;
    return Math.max(0, Math.min(100, 100 * FACTORS.reduce((sum, factor) =>
      sum + factorValue(row, factor) * Number(state.exploratoryWeights[factor] || 0) / total, 0)));
  }
  function matchesFilters(row) {
    const filter = state.filters;
    const query = state.search.trim().toLowerCase();
    if (query && ![row.time, row.satellite, row.instrument, row.event_id, row.why, row.source_line, row.confidence_raw]
      .some(value => String(value ?? "").toLowerCase().includes(query))) return false;
    const confidence = Number(row.confidence);
    if (filter.confidenceMin > 0 && (!Number.isFinite(confidence) || confidence < filter.confidenceMin)) return false;
    if (filter.frpMin != null && (row.frp == null || row.frp === "" || !Number.isFinite(Number(row.frp)) || Number(row.frp) < filter.frpMin)) return false;
    const date = parsedDate(row.time);
    if (filter.fromDate && (!date || date < new Date(`${filter.fromDate}T00:00:00Z`))) return false;
    if (filter.toDate && (!date || date.getTime() >= new Date(`${filter.toDate}T00:00:00Z`).getTime() + 86400000)) return false;
    if (filter.satellite && `${row.satellite ?? "Unavailable"} / ${row.instrument ?? "Unavailable"}` !== filter.satellite) return false;
    const daynight = String(row.daynight || "").toLowerCase();
    const period = daynight === "d" || daynight === "day" ? "day" : daynight === "n" || daynight === "night" ? "night" : "unknown";
    if (filter.daynight && (filter.daynight === "unknown" ? period !== "unknown" : period !== filter.daynight)) return false;
    if (filter.staticOnly && row.possible_static_source !== true) return false;
    if (filter.event && String(row.event_id ?? "") !== filter.event) return false;
    if (state.times.length) {
      const timeValue = parsedDate(row.time)?.getTime();
      if (timeValue == null || timeValue > state.times[state.cursor]) return false;
    }
    return true;
  }
  function compareBy(a, b, sort = state.sort, exploratory = state.exploratory) {
    const metric = row => sort === "score" && exploratory ? exploratoryScore(row) : row[sort];
    if (sort === "time") return (parsedDate(b.time)?.getTime() ?? -Infinity) - (parsedDate(a.time)?.getTime() ?? -Infinity);
    if (sort === "satellite") return String(a.satellite ?? "").localeCompare(String(b.satellite ?? ""));
    const av = metric(a), bv = metric(b);
    const an = av == null || av === "" ? NaN : Number(av);
    const bn = bv == null || bv === "" ? NaN : Number(bv);
    return (Number.isFinite(bn) ? bn : -Infinity) - (Number.isFinite(an) ? an : -Infinity);
  }
  function filteredRows() { return state.rows.filter(matchesFilters).sort((a, b) => compareBy(a, b)); }
  function officialRows() { return state.rows.filter(matchesFilters).sort((a, b) => compareBy(a, b, "score", false)); }
  function frpRows(rows) {
    return [...rows].sort((a, b) => {
      const av = a.frp == null || a.frp === "" ? NaN : Number(a.frp);
      const bv = b.frp == null || b.frp === "" ? NaN : Number(b.frp);
      return (Number.isFinite(bv) ? bv : -Infinity) - (Number.isFinite(av) ? av : -Infinity);
    });
  }

  function mapColor(score) {
    return score == null || !Number.isFinite(Number(score)) ? "#8b9a91" : `hsl(${Math.max(8, 34 - Math.max(0, Math.min(100, Number(score))) * 0.24)} 86% 57%)`;
  }
  function setMapFallback(message) {
    if ($("mapFallback")) { $("mapFallback").hidden = false; $("mapFallback").textContent = message; }
    if ($("map")) $("map").hidden = true;
  }
  function initLeafletMap(elementId) {
    if (typeof L === "undefined" || !L.map || !$(elementId)) return null;
    const map = L.map(elementId, { scrollWheelZoom: false }).setView([-33, 150.3], 4);
    const darkTiles = L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
      attribution: "© OpenStreetMap contributors © CARTO", maxZoom: 20, subdomains: "abcd",
      className: "pyrowatch-geospatial-tiles"
    });
    let usedFallback = false;
    darkTiles.on("tileerror", () => {
      if (usedFallback) return;
      usedFallback = true;
      map.removeLayer(darkTiles);
      L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
        attribution: "© OpenStreetMap contributors", maxZoom: 19,
        className: "pyrowatch-geospatial-tiles"
      }).addTo(map);
    });
    darkTiles.addTo(map);
    return { map, layer: L.layerGroup().addTo(map) };
  }
  function initMaps() {
    try {
      const primary = initLeafletMap("map");
      if (!primary) { setMapFallback("Map unavailable. Use the ranked observation list to review records."); return; }
      state.map = primary.map;
      state.mapLayer = primary.layer;
      $("map").hidden = false;
      $("mapFallback").hidden = true;
      state.map.on("click", () => {});
    } catch (_) { setMapFallback("Map could not be initialized. The ranked list remains available."); }
  }
  function fitMap(map, markers) {
    if (!map || !markers.length || typeof L === "undefined" || !L.featureGroup) return;
    map.fitBounds(L.featureGroup(markers).getBounds().pad(0.12), { maxZoom: 10 });
  }
  function makePopup(row) {
    const popup = document.createElement("div");
    popup.append(el("strong", "", `Review priority: ${fmt(row.score, 1)} / 100`));
    popup.append(el("p", "", `Acquisition: ${fmtTime(row.time)}`));
    popup.append(el("p", "", `FRP: ${fmt(row.frp)} (API units)`));
    popup.append(el("p", "", row.why || "Explanation unavailable."));
    const eventButton = el("button", "text-button", `Open event ${row.event_id ?? "dossier"}`);
    eventButton.type = "button";
    eventButton.addEventListener("click", () => openEvent(row.event_id));
    popup.append(eventButton);
    return popup;
  }
  function updateMapEmptyState(rows) {
    const emptyState = $("mapEmptyState");
    if (!emptyState) return;
    const hasCoordinates = rows.some(validCoordinate);
    emptyState.hidden = hasCoordinates;
    const message = $("mapEmptyMessage");
    if (message) message.textContent = !state.rows.length
      ? "Load the synthetic sample or upload observations to plot coordinate-valid records."
      : rows.length === 0
        ? "No observations match the current time and filter settings."
        : "No coordinate-valid observations are available in this view.";
  }
  function renderPrimaryMap(rows) {
    if (!state.map || !state.mapLayer) return;
    state.mapLayer.clearLayers();
    state.markers.clear();
    const valid = rows.filter(validCoordinate);
    const plotted = valid.slice(0, 1500);
    const markerList = [];
    for (const row of plotted) {
      const key = state.keys.get(row);
      const color = mapColor(row.score);
      const marker = L.circleMarker([Number(row.latitude), Number(row.longitude)], {
        radius: key === state.selectedKey ? 8 : 5.5,
        weight: key === state.selectedKey ? 3 : 1.25,
        color, fillColor: color, fillOpacity: 0.82,
        className: key === state.selectedKey ? "pyrowatch-observation is-selected" : "pyrowatch-observation"
      }).bindPopup(makePopup(row));
      marker.on("click", () => selectObservation(key, false));
      marker.addTo(state.mapLayer);
      state.markers.set(key, marker);
      markerList.push(marker);
    }
    if (state.fitPending) {
      fitMap(state.map, markerList);
      state.fitPending = false;
    }
    if ($("mapFallback")) {
      $("mapFallback").hidden = !valid.length || valid.length <= plotted.length;
      if (valid.length > plotted.length) $("mapFallback").textContent = `Showing ${plotted.length} of ${valid.length} coordinate-valid filtered observations on the map.`;
    }
  }
  function ensureDuelMaps() {
    if (state.duelMaps.length) return;
    try {
      for (const id of ["mapLeft", "mapRight"]) {
        const result = initLeafletMap(id);
        if (!result) { state.duelMaps = []; state.duelLayers = []; return; }
        state.duelMaps.push(result.map);
        state.duelLayers.push(result.layer);
      }
    } catch (_) { state.duelMaps = []; state.duelLayers = []; }
  }
  function renderDuel(rows) {
    ensureDuelMaps();
    const topOfficial = officialRows().slice(0, 25);
    const topFrp = frpRows(rows).slice(0, 25);
    const overlap = topOfficial.filter(row => topFrp.includes(row)).length;
    const note = $("duelNote");
    if (note) {
      note.replaceChildren(
        el("span", "", `Same ${rows.length} filtered, in-time observations. Top-25 overlap: ${overlap}.`),
        el("span", "", " Rankings are descriptive orderings, not fire likelihood.")
      );
    }
    if (state.duelMaps.length === 2 && typeof L !== "undefined") {
      const groups = [topOfficial, topFrp];
      groups.forEach((group, index) => {
        const layer = state.duelLayers[index];
        layer.clearLayers();
        const markers = [];
        group.filter(validCoordinate).forEach((row, rankIndex) => {
          const rank = rankIndex + 1;
          const color = index === 0 ? "#ff9042" : "#5fb8ae";
          const icon = L.divIcon({
            className: "duel-badge",
            html: `<span aria-label="Rank ${rank}">${rank}</span>`,
            iconSize: [24, 24], iconAnchor: [12, 12]
          });
          const marker = L.marker([Number(row.latitude), Number(row.longitude)], { icon })
            .bindPopup(makePopup(row)).on("click", () => selectObservation(state.keys.get(row), false));
          marker.addTo(layer);
          markers.push(marker);
        });
        fitMap(state.duelMaps[index], markers);
        if (state.duelMaps[index].invalidateSize) setTimeout(() => state.duelMaps[index].invalidateSize(), 0);
      });
      if ($("duelListContent")) $("duelListContent").hidden = true;
    } else if ($("duelListContent")) {
      const list = $("duelListContent");
      list.hidden = false;
      list.replaceChildren(el("p", "panel-note", "Leaflet comparison maps are unavailable. Showing the same filtered records in rank order."));
      const table = el("table", "member-table");
      for (const [label, group, accent] of [["Triage score", topOfficial, "duel-cap-left"], ["FRP-only baseline", topFrp, "duel-cap-right"]]) {
        table.append(el("caption", accent, label));
        for (const [index, row] of group.entries()) {
          const tr = document.createElement("tr");
          tr.append(el("td", "mono", index + 1), el("td", "", `Event ${row.event_id ?? "Unavailable"} · ${fmtTime(row.time)}`), el("td", "mono", label === "Triage score" ? fmt(row.score, 1) : fmt(row.frp)));
          tr.addEventListener("click", () => selectObservation(state.keys.get(row)));
          table.append(tr);
        }
      }
      list.append(table);
    }
    const evaluation = state.evaluation;
    const explain = $("compareExplain");
    if (explain) {
      explain.hidden = !evaluation;
      explain.textContent = evaluation
        ? `API descriptive check on ${evaluation.n_labelled ?? "Unavailable"} labelled records. Triage precision@10: ${fmt(evaluation.triage_score?.["p@10"])}; FRP-only precision@10: ${fmt(evaluation.frp_only?.["p@10"])}. ${evaluation.interpretation || "Evaluation is not a real-world accuracy claim."}`
        : "No comparable labelled evaluation was returned for this dataset.";
    }
  }
  function setMapMode(duel) {
    state.duel = duel;
    if ($("modeSample")) { $("modeSample").classList.toggle("is-active", !duel); $("modeSample").setAttribute("aria-pressed", String(!duel)); }
    if ($("modeDuel")) { $("modeDuel").classList.toggle("is-active", duel); $("modeDuel").setAttribute("aria-pressed", String(duel)); }
    if ($("duelWrap")) $("duelWrap").hidden = !duel;
    if ($("map")) $("map").hidden = duel || !state.map;
    if (duel) renderDuel(filteredRows());
    else if (state.map && state.map.invalidateSize) setTimeout(() => state.map.invalidateSize(), 0);
  }

  function detailLine(list, label, value, className = "") {
    const row = el("div", "detail-row");
    row.append(el("dt", "", label), el("dd", className, value == null || value === "" ? "Unavailable" : value));
    list.append(row);
  }
  function renderScore(row) {
    const box = $("scoreContent");
    if (!box) return;
    box.replaceChildren();
    box.append(el("p", "score-value", `Official review priority: ${fmt(row.score, 1)} / 100`));
    if (state.exploratory) {
      const value = exploratoryScore(row);
      box.append(el("p", "badge ember", value == null ? "Exploratory score unavailable" : `Exploratory order: ${fmt(value, 1)} / 100`));
    }
    box.append(el("p", "why-line", row.why || "Explanation unavailable."));
    const contributions = FACTORS.map(factor => [factor, row[`c_${factor}`]]).filter(([, value]) => value != null && Number.isFinite(Number(value)));
    if (contributions.length) {
      box.append(el("h3", "score-heading", "Server-reported contributions"));
      const total = contributions.reduce((sum, [, value]) => sum + Math.max(0, Number(value)), 0) || 1;
      const bar = el("div", "waterfall");
      bar.setAttribute("role", "img");
      bar.setAttribute("aria-label", contributions.map(([factor, value]) => `${factor}: ${fmt(value, 2)} points`).join(", "));
      const colors = ["#8fb8ce", "#7fc992", "#ff9042", "#d9a95a", "#5fb8ae"];
      contributions.forEach(([factor, value], index) => {
        const segment = document.createElement("i");
        segment.style.width = `${Math.max(0, Number(value)) / total * 100}%`;
        segment.style.background = colors[index];
        segment.title = `${factor}: ${fmt(value, 2)} points`;
        bar.append(segment);
      });
      box.append(bar);
      const legend = el("div", "waterfall-legend");
      contributions.forEach(([factor, value], index) => {
        const entry = el("span", "");
        const marker = el("i", "");
        marker.style.background = colors[index];
        entry.append(marker, document.createTextNode ? document.createTextNode(`${factor} ${fmt(value, 2)}`) : el("span", "", `${factor} ${fmt(value, 2)}`));
        legend.append(entry);
      });
      box.append(legend);
    }
    const missing = new Set(Array.isArray(row.score_missing_factors) ? row.score_missing_factors : []);
    const factorMeaning = {
      recency: "Relative to the latest acquisition in this dataset, with a 24-hour half-life; not relative to today.",
      confidence: "API-normalized confidence for this detection.",
      frp: "Bounded logarithmic factor of the supplied FRP measurement.",
      repeats: "Other distinct acquisition times in an approximate 0.02° spatial bin within ±72 hours; not the event row count.",
      brightness: "Bounded factor from the supplied brightness measurement."
    };
    for (const factor of FACTORS) {
      const value = row[`c_${factor}`];
      const contribution = value == null || !Number.isFinite(Number(value)) ? "Contribution unavailable" : missing.has(factor) ? `Missing measurement; backend assigns ${fmt(value, 2)} points` : `${fmt(value, 2)} score points`;
      box.append(el("p", "panel-note", `${factor}: ${contribution}. ${factorMeaning[factor]}`));
    }
    box.append(el("p", "panel-note", "These are API-reported contributions, separate from raw sensor measurements. The score is an uncalibrated review priority, not a fire probability or spread prediction."));
  }
  function renderObservation(row) {
    const box = $("detailContent");
    if (!box) return;
    box.replaceChildren();
    if (!row) { box.append(el("p", "panel-note", "Select a table row or map marker.")); return; }
    const list = el("dl", "detail-list");
    [
      ["Response-local key", state.keys.get(row)], ["Latitude", fmt(row.latitude, 5)],
      ["Longitude", fmt(row.longitude, 5)], ["Acquisition time (UTC)", fmtTime(row.time)],
      ["Satellite", row.satellite], ["Instrument", row.instrument], ["Day / night at acquisition", row.daynight],
      ["Raw confidence", row.confidence_raw], ["Normalized confidence", fmt(row.confidence, 3)],
      ["FRP (MW when supported by source)", fmt(row.frp, 3)], ["Brightness", fmt(row.brightness, 2)],
      ["Event", row.event_id], ["Historical recurrence", row.persistent_source_status],
      ["Possible static source flag", row.possible_static_source == null ? null : row.possible_static_source ? "Yes" : "No"],
      ["Repeat count", row.repeat_count], ["Source CSV line", row.source_line]
    ].forEach(([label, value]) => detailLine(list, label, value, "mono"));
    box.append(list);
    if (row.source_fields && typeof row.source_fields === "object") {
      const details = document.createElement("details");
      details.append(el("summary", "", "Source fields"));
      const fields = el("dl", "detail-list");
      Object.entries(row.source_fields).forEach(([name, value]) => detailLine(fields, name, value));
      details.append(fields);
      box.append(details);
    }
    renderScore(row);
    if (row.event_id != null) renderDossier(row.event_id);
  }
  function eventData(eventId) {
    return state.events.find(item => String(item.event_id) === String(eventId)) || null;
  }
  function eventIntelligence(eventId) {
    const list = state.intelligence?.events;
    return Array.isArray(list) ? list.find(item => String(item.event_id) === String(eventId)) || null : null;
  }
  // Keep invalid or timezone-free values separate; they cannot be placed on a UTC timeline.
  function observedUtc(value) {
    if (typeof value !== "string") return null;
    const match = value.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/);
    if (!match) return null;
    const [, year, month, day, hour, minute, second] = match.map(Number);
    if (month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate() || hour > 23 || minute > 59 || second > 59) return null;
    return parsedDate(value);
  }
  function renderEventHistory(box, eventId, members) {
    const dated = members.map(row => ({row, at: observedUtc(row.time)})).filter(item => item.at).sort((a, b) => a.at - b.at);
    const undated = members.filter(row => !observedUtc(row.time)).map(row => ({row, at: null}));
    box.append(el("h3", "score-heading", "Event observation history"));
    box.append(el("p", "panel-note", `${members.length} accepted observations in this response, independent of table filters. Gaps do not prove activity stopped; location differences alone do not prove physical spread.`));
    if (!members.length) { box.append(el("p", "panel-note", "No accepted observations are available for this event.")); return; }
    const dataset = state.rows;
    const visible = new Set(filteredRows().map(row => state.keys.get(row)));
    for (const [heading, items] of [["Chronological observations (UTC)", dated], ["Time unavailable or invalid", undated]]) {
      if (!items.length) continue;
      box.append(el("h4", "score-heading", heading));
      const list = el("ol", "event-history");
      for (const {row, at} of items) {
        const key = state.keys.get(row), item = el("li", "event-history-row"), facts = el("dl", "detail-list");
        item.dataset.key = key;
        detailLine(facts, "Acquisition time (supplied; UTC)", at ? fmtTime(row.time) : "Unavailable / invalid");
        if (!at && row.time != null) detailLine(facts, "Time value received", row.time);
        for (const [label, value] of [["Latitude (supplied)", row.latitude], ["Longitude (supplied)", row.longitude], ["Satellite (supplied)", row.satellite], ["Instrument (supplied)", row.instrument], ["Raw confidence (supplied)", row.confidence_raw], ["FRP (supplied; API units unspecified)", row.frp], ["Normalized confidence (derived by API)", fmt(row.confidence, 3)], ["Elapsed from first timed observation (derived)", at ? `${fmt((at - dated[0].at) / 3600000, 3)} h` : null]]) detailLine(facts, label, value);
        item.append(facts);
        const button = el("button", "text-button", visible.has(key) ? "Select observation" : "Hidden by table filters");
        button.type = "button"; button.disabled = !visible.has(key); button.setAttribute("aria-pressed", String(state.selectedKey === key));
        button.addEventListener("click", () => {
          if (state.rows !== dataset || button.disabled) return;
          const restore = document.activeElement === button;
          selectObservation(key);
          // The dossier is rebuilt by selection. Find the equivalent by key, never by index or a data-derived selector.
          const successor = [...($("dossierContent")?.querySelectorAll?.(".event-history-row") || [])]
            .find(node => node.dataset.key === key)?.querySelector("button");
          if (restore && state.rows === dataset && successor && !successor.disabled) successor.focus();
        });
        item.append(button); list.append(item);
      }
      box.append(list);
    }
  }
  function renderDossier(eventId) {
    const box = $("dossierContent");
    if (!box) return;
    box.replaceChildren();
    state.selectedEvent = eventId == null ? null : String(eventId);
    const event = eventData(eventId);
    const intel = eventIntelligence(eventId);
    if (!event && !intel && !state.rows.some(row => row.event_id != null && String(row.event_id) === String(eventId))) { box.append(el("p", "panel-note", "Event details are unavailable for this observation.")); return; }
    box.append(el("h3", "", `Event ${event?.event_id ?? intel?.event_id ?? "Unavailable"}`));
    const info = el("dl", "detail-list");
    [
      ["Observations", event?.pixels ?? intel?.features?.detection_count],
      ["First observed", fmtTime(event?.first_seen ?? intel?.first_seen)],
      ["Last observed", fmtTime(event?.last_seen ?? intel?.last_seen)],
      ["Top review priority", fmt(event?.top_score, 1)],
      ["Peak FRP (source units)", fmt(event?.peak_frp, 2)],
      ["Event center", event && Number.isFinite(Number(event.lat)) && Number.isFinite(Number(event.lon)) ? `${fmt(event.lat, 4)}, ${fmt(event.lon, 4)}` : null]
    ].forEach(([label, value]) => detailLine(info, label, value));
    box.append(info);
    const trend = intel?.trend;
    box.append(el("h3", "score-heading", "Observed FRP trend"));
    if (!trend) box.append(el("p", "panel-note", "Event trend unavailable in this API response."));
    else {
      box.append(el("p", `badge ${trend.status === "rising" ? "ember" : trend.status === "falling" ? "steel" : "amber"}`, trend.status || "Unavailable"));
      detailLineTo(box, "FRP first-to-last change", trend.frp_change_mw == null ? null : `${fmt(trend.frp_change_mw, 2)} source units`);
      detailLineTo(box, "Acquisition span", trend.span_h == null ? null : `${fmt(trend.span_h, 1)} hours`);
      box.append(el("p", "panel-note", trend.reason || "Trend definition unavailable."));
      if (trend.sampling_limitation) box.append(el("p", "panel-note", trend.sampling_limitation));
    }
    box.append(el("h3", "score-heading", "Anomaly indicator"));
    const model = state.intelligence?.model;
    const anomaly = intel?.anomaly;
    if (!anomaly || anomaly.status !== "available" || anomaly.anomaly_score == null) {
      box.append(el("p", "badge off", "Unavailable"));
      box.append(el("p", "panel-note", model?.reason || "Anomaly score unavailable. It is not inferred from other event fields."));
    } else {
      box.append(el("p", "badge steel", `Anomaly score ${fmt(anomaly.anomaly_score, 4)} · ${anomaly.model_version || "version unavailable"}`));
      box.append(el("p", "panel-note", "Uncalibrated anomaly indicator. It is not a probability of fire."));
    }
    const members = state.rows.filter(row => row.event_id != null && String(row.event_id) === String(eventId));
    const possible = members.filter(row => row.persistent_source_status === "possible_persistent_source").length;
    box.append(el("h3", "score-heading", "Historical recurrence"));
    const insufficient = members.filter(row => row.persistent_source_status === "insufficient_history").length;
    const notFlagged = members.filter(row => row.persistent_source_status === "not_flagged").length;
    box.append(el("p", "panel-note", members.length
      ? `${possible} flagged possible persistent source; ${notFlagged} not flagged; ${insufficient} with insufficient history. Other statuses are unavailable. These do not identify a source type.`
      : "No associated observations are available."));
    const highest = members.filter(row => event?.top_score != null && Number(row.score) === Number(event.top_score));
    box.append(el("h3", "score-heading", "Why this event has its priority"));
    box.append(el("p", "panel-note", `The event priority is the highest individual observation score, not an average or a fire probability. ${highest.length} observation${highest.length === 1 ? "" : "s"} share the reported maximum.`));
    if (highest.length) {
      const list = el("ul", "");
      for (const row of highest) {
        const item = el("li", ""), button = el("button", "text-button", `${fmtTime(row.time)} · ${fmt(row.score, 1)} / 100 · ${row.why || "Explanation unavailable"}`);
        button.type = "button"; button.addEventListener("click", () => selectObservation(state.keys.get(row)));
        item.append(button); list.append(item);
      }
      box.append(list);
    } else box.append(el("p", "panel-note", "The source observation for the reported event maximum is unavailable in this response."));
    const missing = [...new Set(members.flatMap(row => Array.isArray(row.score_missing_factors) ? row.score_missing_factors : []))];
    box.append(el("h3", "score-heading", "Evidence and uncertainty"));
    box.append(el("p", "panel-note", missing.length ? `Some observations lack ${missing.join(", ")}; the backend treats missing score factors as zero.` : "No score factors are marked missing in the returned observations."));
    const missingFeatures = Array.isArray(intel?.missing_features) ? intel.missing_features : null;
    box.append(el("p", "panel-note", missingFeatures === null ? "Event feature availability was not reported by the API." : missingFeatures.length ? `Event features unavailable: ${missingFeatures.join(", ")}.` : "No event features are marked missing by the API."));
    box.append(el("p", "panel-note", members.some(row => row.persistent_source_status === "insufficient_history") ? "Historical recurrence is insufficient for at least one observation." : "Recurrence status is based only on the available archive."));
    box.append(el("p", "panel-note", "Satellite detections do not confirm wildfire identity, continuous activity, physical spread, or calibrated risk."));
    renderEventHistory(box, eventId, members);
    const top = [...members].sort((a, b) => compareBy(a, b, "score", false)).slice(0, 5);
    if (top.length) {
      const list = el("ul", "");
      for (const row of top) {
        const item = el("li", "");
        const button = el("button", "text-button", `${fmtTime(row.time)} · priority ${fmt(row.score, 1)} · ${row.why || "Explanation unavailable"}`);
        button.type = "button";
        button.addEventListener("click", () => selectObservation(state.keys.get(row)));
        item.append(button);
        list.append(item);
      }
      box.append(el("h3", "score-heading", "Related observations"), list);
    }
  }
  function detailLineTo(box, label, value) {
    const list = el("dl", "detail-list");
    detailLine(list, label, value);
    box.append(list);
  }
  function openEvent(eventId) {
    if (eventId == null) return;
    state.selectedEvent = String(eventId);
    if ($("eventFilter")) {
      state.filters.event = String(eventId);
      $("eventFilter").value = String(eventId);
    }
    render();
    renderDossier(eventId);
    if ($("dossierContent")?.scrollIntoView) $("dossierContent").scrollIntoView({ block: "nearest" });
  }
  function selectObservation(key, openMap = true) {
    const row = state.rows.find(item => state.keys.get(item) === key);
    if (!row) return;
    state.selectedKey = key;
    state.selectedEvent = row.event_id == null ? null : String(row.event_id);
    const list = filteredRows();
    const index = list.findIndex(item => state.keys.get(item) === key);
    if (index >= state.limit) state.limit = index + 1;
    renderObservation(row);
    renderTable(list);
    const marker = state.markers.get(key);
    if (marker && openMap && state.map) { marker.openPopup(); state.map.panTo(marker.getLatLng()); }
    const tableRow = [...$("tb").rows].find(item => item.dataset.key === key);
    if (tableRow?.scrollIntoView) tableRow.scrollIntoView({ block: "nearest" });
  }

  function renderTable(rows) {
    const body = $("tb");
    if (!body) return;
    body.replaceChildren();
    const page = rows.slice(0, state.limit);
    for (const [index, row] of page.entries()) {
      const key = state.keys.get(row);
      const tr = document.createElement("tr");
      tr.className = "observation-row";
      tr.dataset.key = key;
      tr.tabIndex = 0;
      tr.setAttribute("aria-selected", String(key === state.selectedKey));
      const priority = el("td", "priority-cell");
      priority.append(el("strong", "", fmt(row.score, 1)), el("span", "p-dot", ""));
      priority.lastChild?.style?.setProperty("--p-color", mapColor(row.score));
      if (state.exploratory) priority.append(el("span", "expl-mark", `E ${fmt(exploratoryScore(row), 1)}`));
      const values = [
        [el("td", "col-rank hd-num mono", index + 1), priority],
        [el("td", "mono", fmtTime(row.time))],
        [el("td", "hd-num mono", fmt(row.confidence, 2))],
        [el("td", "hd-num mono", fmt(row.frp, 2))],
        [el("td", "", `${row.satellite ?? "Unavailable"} / ${row.instrument ?? "Unavailable"}`)],
        [el("td", "mono", row.event_id ?? "Unavailable")],
        [el("td", row.persistent_source_status === "possible_persistent_source" ? "cell-static-yes" : "cell-static-no",
          row.persistent_source_status || (row.possible_static_source == null ? "Unavailable" : row.possible_static_source ? "Possible" : "Not flagged"))],
        [el("td", "note-chip", "—")]
      ].flat();
      tr.append(...values);
      tr.addEventListener("click", () => selectObservation(key));
      tr.addEventListener("keydown", event => {
        if (event.key === "Enter" || event.key === " ") { event.preventDefault(); selectObservation(key); }
      });
      body.append(tr);
    }
    setText("resultCount", `${rows.length} matching observations from ${state.rows.length} accepted records.`);
    setText("pageInfo", rows.length ? `Showing ${page.length} of ${rows.length}. Export includes all matches.` : "No matching observations.");
    if ($("showMore")) { $("showMore").hidden = page.length >= rows.length; $("showMore").textContent = `Show ${Math.min(PAGE_SIZE, rows.length - page.length)} more`; }
    if ($("tableWrap")) $("tableWrap").hidden = !rows.length;
    if ($("emptyState")) $("emptyState").hidden = !!rows.length;
    setText("emptyTitle", state.rows.length ? "No observations match these filters." : "No observations to display.");
    setText("emptyText", state.rows.length ? "Clear filters to see the full dataset." : "Load a dataset from the API to begin.");
    if ($("clearFromEmpty")) $("clearFromEmpty").hidden = !state.rows.length || !!rows.length;
    if ($("exportCsv")) $("exportCsv").disabled = !state.rows.length;
    if (state.selectedKey && !rows.some(row => state.keys.get(row) === state.selectedKey)) {
      state.selectedKey = null;
      renderObservation(null);
    }
  }
  function renderIngestion() {
    const ingestion = state.ingestion;
    const container = $("ingestionSummary");
    if (!container) return;
    container.replaceChildren();
    if (!ingestion) {
      setText("provenance", "No dataset loaded.");
      for (const id of ["mTotal", "mAccepted", "mRejected", "mDuplicates", "mEvents", "mVisible"]) setText(id, "—");
      return;
    }
    setText("provenance", {
      synthetic: "Synthetic demo data (backend-reported)",
      user_supplied_unverified: "User-supplied data; provenance unverified",
      unknown: "Provenance unavailable"
    }[state.provenance]);
    for (const [label, value] of [
      ["Physical CSV lines", ingestion.physical_lines],
      ["Input columns", Array.isArray(ingestion.columns) ? ingestion.columns.join(", ") || "Unavailable" : null],
      ["Record outcomes", Array.isArray(ingestion.outcomes) ? ingestion.outcomes.length : null]
    ]) {
      const item = el("div", "ingest-cell");
      item.append(el("span", "", label), el("strong", "", value == null ? "Unavailable" : value));
      container.append(item);
    }
    for (const [id, value] of [
      ["mTotal", ingestion.total_records], ["mAccepted", ingestion.accepted],
      ["mRejected", ingestion.rejected], ["mDuplicates", ingestion.deduplicated],
      ["mEvents", state.events.length]
    ]) setText(id, value);
    if (Array.isArray(ingestion.outcomes) && ingestion.outcomes.length) {
      const details = document.createElement("details");
      details.className = "outcome-details";
      details.append(el("summary", "", `Server record outcomes (${ingestion.outcomes.length})`));
      const list = el("ul", "");
      ingestion.outcomes.forEach(outcome => {
        const lines = outcome.line == null ? "line unavailable" : `line ${outcome.line}${outcome.end_line != null && outcome.end_line !== outcome.line ? `–${outcome.end_line}` : ""}`;
        list.append(el("li", `o-${outcome.status || "unknown"}`, [lines, outcome.status, outcome.reason].filter(Boolean).join(" · ")));
      });
      details.append(list);
      container.append(details);
    }
    if (state.issues.length) {
      const details = document.createElement("details");
      details.className = "outcome-details";
      details.append(el("summary", "", `Validation messages (${state.issues.length})`));
      const list = el("ul", "");
      state.issues.forEach(issue => list.append(el("li", "", issue)));
      details.append(list);
      container.append(details);
    }
  }
  function renderEvents() {
    const box = $("eventContent");
    if (!box) return;
    box.replaceChildren();
    setText("eventCount", state.events.length ? `${state.events.length} in response` : "");
    if (!state.events.length) { box.append(el("p", "panel-note", "No event records were returned for this dataset.")); return; }
    for (const event of state.events) {
      const button = el("button", "event-row", "");
      button.type = "button";
      button.setAttribute("aria-pressed", String(state.selectedEvent === String(event.event_id)));
      button.append(el("strong", "", `Event ${event.event_id ?? "Unavailable"}`));
      button.append(el("span", "", `${event.pixels ?? "Unavailable"} observations · priority ${fmt(event.top_score, 1)}`));
      button.append(el("span", "mono", `${fmtTime(event.first_seen)} — ${fmtTime(event.last_seen)}`));
      button.addEventListener("click", () => openEvent(event.event_id));
      box.append(button);
    }
  }
  function renderEvaluation() {
    const box = $("evaluationContent");
    if (!box) return;
    box.replaceChildren();
    if (!state.evaluation) { box.append(el("p", "panel-note", "No labelled evaluation was returned for this dataset.")); return; }
    const methods = ["triage_score", "frp_only", "newest_first", "confidence_only", "random_baseline", "random_order"];
    const labels = {
      triage_score: "Heuristic score", frp_only: "FRP-only baseline",
      newest_first: "Newest first", confidence_only: "Confidence only",
      random_baseline: "Prevalence baseline", random_order: "Seeded random order"
    };
    const table = el("table", "eval-table");
    const head = document.createElement("thead");
    const header = document.createElement("tr");
    ["Method", "P@10", "P@25"].forEach(value => header.append(el("th", "", value)));
    head.append(header);
    table.append(head);
    const body = document.createElement("tbody");
    methods.forEach(method => {
      const result = state.evaluation[method];
      if (result == null) return;
      const tr = document.createElement("tr");
      tr.append(el("td", "", method === "random_baseline" ? `${labels[method]} (prevalence ${fmt(result, 3)})` : labels[method]));
      tr.append(el("td", "mono", typeof result === "object" ? fmt(result["p@10"], 3) : "—"));
      tr.append(el("td", "mono", typeof result === "object" ? fmt(result["p@25"], 3) : "—"));
      body.append(tr);
    });
    table.append(body);
    box.append(table);
    box.append(el("p", "eval-note", `Descriptive check on ${state.evaluation.n_labelled ?? "Unavailable"} labelled records. ${state.evaluation.interpretation || "Not a real-world accuracy estimate."}`));
  }
  function renderStatus() {
    setText("datasetMessage", state.message || "");
    if ($("datasetMessage")) $("datasetMessage").classList.toggle("error-text", !!state.error);
    if ($("connectionDot")) {
      $("connectionDot").classList.toggle("is-error", !!state.error);
      $("connectionDot").classList.toggle("is-ready", !!state.ingestion && !state.error);
    }
  }
  function render() {
    renderStatus();
    renderIngestion();
    renderEvents();
    renderEvaluation();
    const rows = filteredRows();
    state.filtered = rows;
    const activeFilters = [
      !!state.search.trim(), Number(state.filters.confidenceMin) > 0,
      state.filters.frpMin != null && state.filters.frpMin !== "",
      !!state.filters.fromDate, !!state.filters.toDate, !!state.filters.satellite,
      !!state.filters.daynight, !!state.filters.staticOnly, !!state.filters.event
    ].filter(Boolean).length;
    setText("activeFilterCount", activeFilters);
    const filterButton = $("toggleFilters");
    if (filterButton) filterButton.setAttribute("aria-label", `Filters, ${activeFilters} active`);
    setText("mVisible", rows.length);
    const undated = state.rows.filter(row => !parsedDate(row.time)).length;
    if (state.times.length && undated) setText("tlElapsed", `${state.times.length} acquisition times · ${undated} undated excluded`);
    renderTable(rows);
    updateMapEmptyState(rows);
    renderPrimaryMap(rows);
    if (state.selectedKey) {
      const selected = state.rows.find(row => state.keys.get(row) === state.selectedKey);
      if (selected) renderObservation(selected);
    }
    const satellite = $("satelliteFilter");
    if (satellite) {
      const selected = state.filters.satellite;
      const choices = [...new Set(state.rows.map(row => `${row.satellite ?? "Unavailable"} / ${row.instrument ?? "Unavailable"}`))].sort();
      satellite.replaceChildren(new Option("All available", ""));
      choices.forEach(value => satellite.add(new Option(value, value)));
      satellite.value = choices.includes(selected) ? selected : "";
      state.filters.satellite = satellite.value;
    }
    syncWeightVisibility();
    if (state.duel) renderDuel(rows);
  }

  function syncWeightVisibility() {
    const panel = $("weightsPanel");
    const available = !!state.weights && state.rows.length > 0 && state.rows.some(row =>
      FACTORS.some(factor => row[`f_${factor}`] != null && Number.isFinite(Number(row[`f_${factor}`]))));
    if (panel) panel.hidden = !available;
    if ($("weightsNote") && !available) $("weightsNote").textContent = "Exploratory ranking is unavailable because documented score factors were not returned.";
  }
  function syncWeightControls() {
    if (!state.exploratoryWeights) return;
    for (const factor of FACTORS) {
      const input = $(`w${factor[0].toUpperCase()}${factor.slice(1)}`);
      const output = $(`w${factor[0].toUpperCase()}${factor.slice(1)}Out`);
      const value = Number(state.exploratoryWeights[factor]);
      if (input && Number.isFinite(value)) input.value = String(value);
      if (output) output.textContent = fmt(value, 2);
    }
  }
  function updateExploratoryWeight(factor, value) {
    if (!state.exploratoryWeights) return;
    state.exploratoryWeights[factor] = Number(value);
    syncWeightControls();
    render();
  }
  function toggleExploratory(enabled) {
    state.exploratory = enabled && !!state.weights;
    if ($("weightsOn")) $("weightsOn").checked = state.exploratory;
    render();
  }
  function resetFilters() {
    state.search = "";
    state.filters = { confidenceMin: 0, frpMin: null, fromDate: "", toDate: "", satellite: "", daynight: "", staticOnly: false, event: "" };
    state.sort = "score";
    state.limit = PAGE_SIZE;
    for (const [id, value] of Object.entries({
      search: "", confidenceMin: "0", frpMin: "", fromDate: "", toDate: "",
      satelliteFilter: "", daynightFilter: "", eventFilter: "", sortBy: "score"
    })) if ($(id)) $(id).value = value;
    if ($("staticOnly")) $("staticOnly").checked = false;
    if ($("confidenceValue")) $("confidenceValue").textContent = "0.00";
    render();
  }
  function csvCell(value, textField = false) {
    if (value == null) return "";
    let output = typeof value === "object" ? JSON.stringify(value) : String(value);
    if (textField && /^\s*[=+@\-]/.test(output)) output = "'" + output;
    return `"${output.replaceAll('"', '""')}"`;
  }
  function exportCsv() {
    const rows = filteredRows();
    if (!rows.length) { announce("There are no matching observations to export."); return; }
    const columns = ["observation_key", "latitude", "longitude", "time_utc", "satellite", "instrument", "confidence_raw", "confidence", "frp", "brightness", "daynight", "label", "event_id", "persistent_source_status", "score", "why", "repeat_count", "source_line", "source_fields"];
    const lines = [columns.map(value => csvCell(value, true)).join(",")];
    for (const row of rows) {
      const values = [state.keys.get(row), row.latitude, row.longitude, row.time, row.satellite, row.instrument, row.confidence_raw, row.confidence, row.frp, row.brightness, row.daynight, row.label, row.event_id, row.persistent_source_status, row.score, row.why, row.repeat_count, row.source_line, row.source_fields];
      lines.push(values.map((value, index) => csvCell(value, ![1, 2, 7, 8, 9, 11, 14, 16, 17].includes(index))).join(","));
    }
    const url = URL.createObjectURL(new Blob(["\ufeff" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "fire-triage-matching-observations.csv";
    link.click();
    URL.revokeObjectURL(url);
    announce(`Exported all ${rows.length} matching observations.`);
  }

  function openPalette() {
    const dialog = $("palette");
    if (!dialog) return;
    state.paletteReturn = document.activeElement;
    dialog.hidden = false;
    state.paletteIndex = 0;
    if ($("paletteInput")) { $("paletteInput").value = ""; $("paletteInput").focus(); }
    renderPalette();
  }
  function closePalette() {
    if ($("palette")) $("palette").hidden = true;
    if (state.paletteReturn?.focus) state.paletteReturn.focus();
  }
  function commandList(query = "") {
    const items = [
      ["Load synthetic sample", "Dataset", () => loadSample()],
      ["Focus observation search", "Navigate", () => $("search")?.focus()],
      ["Jump to ranking", "Navigate", () => $("tableHeading")?.scrollIntoView({ block: "start" })],
      ["Reset filters", "Filters", resetFilters],
      ["Show priority map", "Map", () => setMapMode(false)],
      ["Compare triage and FRP rankings", "Map", () => setMapMode(true)],
      ["Open ingestion report", "Dataset", () => $("ingestionHeading")?.scrollIntoView({ block: "nearest" })],
      ...state.events.filter(event => event.event_id != null).map(event =>
        [`Open event ${event.event_id}`, "Events", () => openEvent(event.event_id)])
    ];
    const lowered = query.trim().toLowerCase();
    return items.filter(([label, section]) => `${label} ${section}`.toLowerCase().includes(lowered));
  }
  function renderPalette() {
    const list = $("paletteList");
    if (!list) return;
    list.replaceChildren();
    state.paletteItems = commandList($("paletteInput")?.value || "");
    state.paletteIndex = Math.max(0, Math.min(state.paletteIndex, state.paletteItems.length - 1));
    if (!state.paletteItems.length) { list.append(el("li", "palette-empty", "No matching commands.")); return; }
    state.paletteItems.forEach(([label, section, action], index) => {
      const item = el("li", "");
      item.setAttribute("aria-selected", String(index === state.paletteIndex));
      item.append(el("span", "palette-sec", section));
      const button = el("button", "cmd", label);
      button.type = "button";
      button.addEventListener("click", () => { closePalette(); action(); });
      item.append(button);
      list.append(item);
    });
  }
  function executePaletteSelection() {
    const selected = state.paletteItems[state.paletteIndex];
    if (!selected) return;
    closePalette();
    selected[2]();
  }
  function isTypingTarget(target) {
    return !!target && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));
  }
  function moveSelection(delta) {
    const rows = filteredRows();
    if (!rows.length) return;
    let index = rows.findIndex(row => state.keys.get(row) === state.selectedKey);
    index = index < 0 ? (delta > 0 ? 0 : rows.length - 1) : Math.max(0, Math.min(rows.length - 1, index + delta));
    selectObservation(state.keys.get(rows[index]));
    const target = [...$("tb").rows].find(row => row.dataset.key === state.keys.get(rows[index]));
    if (target?.focus) target.focus();
  }
  function bindPalette() {
    $("openPalette")?.addEventListener("click", openPalette);
    $("paletteInput")?.addEventListener("input", () => { state.paletteIndex = 0; renderPalette(); });
    $("paletteInput")?.addEventListener("keydown", event => {
      if (event.key === "ArrowDown") { event.preventDefault(); state.paletteIndex = Math.min(state.paletteItems.length - 1, state.paletteIndex + 1); renderPalette(); }
      if (event.key === "ArrowUp") { event.preventDefault(); state.paletteIndex = Math.max(0, state.paletteIndex - 1); renderPalette(); }
      if (event.key === "Enter") { event.preventDefault(); executePaletteSelection(); }
      if (event.key === "Escape") { event.preventDefault(); closePalette(); }
    });
    $("palette")?.addEventListener("click", event => { if (event.target?.hasAttribute?.("data-palette-close")) closePalette(); });
    document.addEventListener?.("keydown", event => {
      const typing = isTypingTarget(event.target);
      if (!typing && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        $("palette")?.hidden ? openPalette() : closePalette();
        return;
      }
      const dialogOpen = !!$("palette") && !$("palette").hidden;
      if (dialogOpen && event.key === "Escape") { event.preventDefault(); closePalette(); return; }
      if (dialogOpen && event.key === "Tab") {
        const focusable = [...($("palette").querySelectorAll?.("input, button") || [])].filter(node => !node.disabled);
        if (!focusable.length) { event.preventDefault(); $("paletteInput")?.focus(); return; }
        const current = focusable.indexOf(document.activeElement);
        const next = event.shiftKey
          ? (current <= 0 ? focusable.length - 1 : current - 1)
          : (current < 0 || current === focusable.length - 1 ? 0 : current + 1);
        event.preventDefault();
        focusable[next].focus();
        return;
      }
      if (dialogOpen) {
        if (event.target !== $("paletteInput") && event.key === "ArrowDown") {
          event.preventDefault();
          state.paletteIndex = Math.min(state.paletteItems.length - 1, state.paletteIndex + 1);
          renderPalette();
        } else if (event.target !== $("paletteInput") && event.key === "ArrowUp") {
          event.preventDefault();
          state.paletteIndex = Math.max(0, state.paletteIndex - 1);
          renderPalette();
        } else if (event.target !== $("paletteInput") && event.key === "Enter") {
          event.preventDefault();
          executePaletteSelection();
        }
        return;
      }
      if (!typing && !event.ctrlKey && !event.metaKey && !event.altKey && (event.key.toLowerCase() === "j" || event.key.toLowerCase() === "k")) {
        event.preventDefault();
        moveSelection(event.key.toLowerCase() === "j" ? 1 : -1);
      }
    });
  }

  function bind() {
    const setFilterRailOpen = open => {
      const deck = $("deck");
      const rail = $("filterRail");
      const button = $("toggleFilters");
      if (rail) rail.hidden = !open;
      deck?.classList.toggle("filters-open", open);
      button?.setAttribute("aria-expanded", String(open));
      button?.setAttribute("title", open ? "Hide filters" : "Show filters");
      setTimeout(() => {
        state.map?.invalidateSize?.({ pan: false });
        state.duelMaps.forEach(map => map.invalidateSize?.({ pan: false }));
      }, 0);
      if (open) $("search")?.focus();
      else button?.focus();
    };
    $("toggleFilters")?.addEventListener("click", () => setFilterRailOpen(!!$("filterRail")?.hidden));
    $("closeFilters")?.addEventListener("click", () => setFilterRailOpen(false));
    $("bSample")?.addEventListener("click", loadSample);
    $("file")?.addEventListener("change", event => upload(event.target.files?.[0]));
    $("exportCsv")?.addEventListener("click", exportCsv);
    $("search")?.addEventListener("input", event => { state.search = event.target.value; state.limit = PAGE_SIZE; render(); });
    $("confidenceMin")?.addEventListener("input", event => {
      state.filters.confidenceMin = Number(event.target.value);
      setText("confidenceValue", fmt(event.target.value, 2));
      render();
    });
    $("frpMin")?.addEventListener("input", event => { state.filters.frpMin = event.target.value === "" ? null : Number(event.target.value); render(); });
    for (const [id, key] of [["fromDate", "fromDate"], ["toDate", "toDate"], ["satelliteFilter", "satellite"], ["daynightFilter", "daynight"], ["eventFilter", "event"]]) {
      $(id)?.addEventListener("change", event => { state.filters[key] = event.target.value; state.limit = PAGE_SIZE; render(); });
    }
    $("staticOnly")?.addEventListener("change", event => { state.filters.staticOnly = event.target.checked; render(); });
    $("sortBy")?.addEventListener("change", event => { state.sort = event.target.value; render(); });
    $("resetFilters")?.addEventListener("click", resetFilters);
    $("clearFromEmpty")?.addEventListener("click", resetFilters);
    $("showMore")?.addEventListener("click", () => { state.limit += PAGE_SIZE; renderTable(filteredRows()); });
    $("modeSample")?.addEventListener("click", () => setMapMode(false));
    $("modeDuel")?.addEventListener("click", () => setMapMode(true));
    $("tlRange")?.addEventListener("input", event => {
      if (!state.times.length) return;
      state.cursor = Math.max(0, Math.min(state.times.length - 1, Number(event.target.value) || 0));
      updateTimelineLabels();
      render();
    });
    $("tlPlay")?.addEventListener("click", () => {
      if (state.timer !== null) { stopPlayback(); return; }
      if (state.times.length < 2) { announce("Playback needs at least two valid acquisition times."); return; }
      if (state.cursor >= state.times.length - 1) state.cursor = 0;
      const button = $("tlPlay");
      button.textContent = "Pause";
      button.setAttribute("aria-pressed", "true");
      state.timer = setInterval(() => {
        if (state.cursor >= state.times.length - 1) { stopPlayback(); return; }
        state.cursor += 1;
        $("tlRange").value = String(state.cursor);
        updateTimelineLabels();
        render();
      }, 850);
      render();
    });
    $("tlReset")?.addEventListener("click", () => {
      stopPlayback();
      state.cursor = state.times.length - 1;
      if ($("tlRange")) $("tlRange").value = String(Math.max(0, state.cursor));
      updateTimelineLabels();
      render();
    });
    $("weightsOn")?.addEventListener("change", event => toggleExploratory(event.target.checked));
    $("weightsReset")?.addEventListener("click", () => {
      if (state.weights) state.exploratoryWeights = { ...state.weights };
      syncWeightControls();
      render();
    });
    for (const [factor, id] of [["recency", "wRecency"], ["confidence", "wConfidence"], ["frp", "wFrp"], ["repeats", "wRepeats"], ["brightness", "wBrightness"]]) {
      $(id)?.addEventListener("input", event => updateExploratoryWeight(factor, event.target.value));
    }
    $("tableWrap")?.addEventListener("keydown", event => {
      if (event.target?.closest?.("tr.observation-row")) {
        if (event.key === "j" || event.key === "k") { event.preventDefault(); moveSelection(event.key === "j" ? 1 : -1); }
      }
    });
    bindPalette();
  }
  async function checkHealth() {
    try {
      const result = await request("/api/health");
      if (result.ok !== true) throw new Error("Health endpoint returned an unexpected response.");
      setText("connectionStatus", "API connected");
      $("connectionDot")?.classList.add("is-ready");
    } catch (error) {
      setText("connectionStatus", "API unavailable");
      $("connectionDot")?.classList.add("is-error");
      state.error = true;
      state.message = error.message;
      renderStatus();
    }
  }

  bind();
  initMaps();
  resetTimeline([]);
  render();
  checkHealth();
  window.addEventListener?.("pagehide", stopPlayback);
  window.addEventListener?.("blur", stopPlayback);
})();
