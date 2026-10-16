# Limitations (keep in app + README; never claim accuracy we haven't measured)
- A detection is a thermal anomaly, not a confirmed fire (flares, factories, volcanoes, agricultural burns).
- Cloud, smoke and gaps between passes hide fires; no detection != no fire.
- Pixels are 375 m (VIIRS) / 1 km (MODIS): locations are approximate.
- Confidence scales differ between instruments.
- Score weights are analyst-tunable judgement, not learned from data.
- Repeat detections raise both real fires and static heat sources; the static flag needs an archive.
- Evaluation on synthetic labels only tests the pipeline. Report only what we hand-checked.
- Decision support for review; not an emergency-response system.
