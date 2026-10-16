const map = L.map("map").setView([-33, 150.3], 8);
L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {attribution: "&copy; OpenStreetMap"}).addTo(map);
let layer = L.layerGroup().addTo(map), markers = {};

function show(data) {
  const counts = data.ingestion;
  const summary = counts
    ? `${counts.accepted} valid, ${counts.rejected} rejected, ${counts.deduplicated} duplicates`
    : `${data.rows.length} valid, ${data.issues.length} issues`;
  document.getElementById("issues").innerHTML =
    `<p>${summary}</p>` + data.issues.map(i => `<div>• ${i}</div>`).join("");
  layer.clearLayers(); markers = {};
  data.rows.forEach((r, i) => {
    const m = L.circleMarker([r.latitude, r.longitude], {
      radius: 3 + Math.sqrt(r.frp), color: `hsl(${55 - r.score * 0.6},88%,45%)`, fillOpacity: .7
    }).bindPopup(`Score ${r.score.toFixed(0)}<br>${r.why}`).addTo(layer);
    markers[i] = m;
  });
  if (data.rows.length) map.fitBounds(L.featureGroup(Object.values(markers)).getBounds().pad(.1));
  document.getElementById("tb").innerHTML = data.rows.slice(0, 60).map((r, i) =>
    `<tr class="r" data-i="${i}"><td>${i + 1}</td><td><b>${r.score.toFixed(0)}</b></td><td>${r.why}</td><td>${r.time.slice(0, 16)}</td>
     <td>${r.confidence_raw}</td><td>${r.frp.toFixed(1)}</td><td>${r.repeat_count}</td><td>${r.event_id}</td><td>${r.possible_static_source ? "possible" : ""}</td></tr>`).join("");
}
document.getElementById("tb").onclick = e => {
  const tr = e.target.closest("tr.r"); if (tr) markers[tr.dataset.i].openPopup();
};
document.getElementById("bSample").onclick = () => fetch("/api/sample").then(r => r.json()).then(show);
document.getElementById("file").onchange = e => {
  const fd = new FormData(); fd.append("file", e.target.files[0]);
  fetch("/api/upload", {method: "POST", body: fd}).then(r => r.json()).then(show);
};
