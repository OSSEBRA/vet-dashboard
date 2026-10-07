# VET dashboard

A dependency-free, client-side dashboard for district-heating VET calculations, time-series analysis, period comparisons, and intervention analysis. It uses native HTML, CSS, JavaScript modules, and SVG charts; no framework, backend, or remote service is required.

## What VET means

The Volumetric Energy Transfer index describes useful thermal energy delivered per unit volume of primary water circulated in the network:

```text
VET [kWh/m³] = sold energy [MWh] × 1,000 / pumped primary volume [m³]
```

Energy and volume must describe the same reporting period. Snapshot calculates this for one period. Time series calculates it for each accepted interval and calculates a period result from total energy divided by total volume, not from the arithmetic mean of interval ratios.

VET and normalized utilization `η_VET` answer different questions and are shown together. VET is delivered energy per circulated volume. `η_VET` is VET divided by the volumetric potential associated with the selected temperature bounds:

```text
Temperature span [K] = T_cap − T_floor
Volumetric potential [kWh/m³] = 1.163 × temperature span
η_VET [%] = VET / volumetric potential × 100
```

The 1.163 coefficient uses the default water approximation `ρ = 1,000 kg/m³` and `cp = 4.186 kJ/(kg·K)`. η_VET has a thermodynamic connection to temperature-potential utilization; it is not an exergy-efficiency calculation. Neither measure is assigned a good/bad threshold.

## CAP and FLOOR

`T_cap` is the highest temperature level available at the selected network boundary. In Automatic mode, CAP is the interval's measured supply temperature at the same system boundary where pumped primary volume is measured. It does not use a setpoint. Engineering curve mode can use an imported CAP curve; otherwise it falls back to row CAP and then measured supply. Manual / Scenario mode uses the fixed CAP entered in the Time series controls.

`T_floor` is the lowest temperature level at which useful heat extraction remains feasible under a selected method. Measured return temperature does not directly define `T_floor`. In Automatic / Historical mode, historical measured return observations grouped by outdoor temperature identify an empirical operational reference curve; it is not an absolute thermodynamic minimum:

1. Group observations into 2 °C outdoor-temperature bins.
2. Require at least 20 observations before supporting a bin. Bins below 20 are marked low-confidence / unsupported and do not contribute to the curve.
3. Use the linearly interpolated 10th percentile of measured return temperature as the bin FLOOR.
4. Interpolate between supported bin centers. Outside their range, hold the nearest value and mark it as outside calibration.

The dashboard shows bin counts, historical observations, the FLOOR curve, and a median-return curve. The percentile, bin width, and minimum count are fixed at 10%, 2 °C, and 20 for this implementation. Missing or insufficient outdoor/return data does not create a substitute FLOOR.

In Automatic / Historical mode, the interface calls `T_cap − T_floor` the **reference temperature span** and `1.163 × span` the **reference volumetric potential**. η_VET is utilization relative to this historical reference. It can exceed 100%; that means measured VET is above the empirical reference, not that operation is impossible or that a physical maximum was violated. Engineering curve and Manual / Scenario modes use operator-defined bounds, described as an available span and practical volumetric potential. In Snapshot / Manual mode, entered `T_cap` and `T_floor` remain independent of optional measured supply and return diagnostics; those values are used to report measured ΔT.

This historical FLOOR algorithm is an operational benchmarking method used by this implementation, not a universal thermodynamic constant. It conditions on outdoor temperature only; it does not normalize for load, season, or other operating conditions. The 20-observation rule is a support threshold, not a confidence interval or statistical guarantee.

## Time-series workflow

1. Open **Time series** and import a CSV by dropping it or selecting a file.
2. Review accepted and rejected row counts and the row-level validation report.
3. Choose Automatic / Historical FLOOR, Engineering curve, or Manual / Scenario temperature potential.
4. Review period totals, volume-weighted averages, charts, and interval calculations.
5. Use **Compare periods** to select date-time ranges. Period VET uses total energy / total volume. Aggregate η_VET uses total sold energy divided by the total volumetric reference/practical potential energy associated with circulated volume. Network temperature averages are pumped-volume weighted; outdoor temperature is time-weighted using elapsed time between timestamps, with the final sample weighted by the preceding interval. Rows without an outdoor-temperature observation are omitted rather than filled. Regularly sampled data therefore uses equal weights.

For Automatic FLOOR period comparisons, choose **Use baseline period to calibrate FLOOR** (default) or **Use full historical dataset as FLOOR reference**. One curve is calibrated from that reference and frozen for both periods. Comparisons show duration, interval count, sold energy, and the time-weighted average outdoor temperature where available. They are descriptive; no weather correction or causal inference is applied.

## Intervention / Three-pipe analysis

The intervention tab uses the already imported time series. Enter a name, date, type, optional notes, baseline period, after-intervention period, and a whole-number stabilization period in days. The commissioning date and the selected number of calendar days before and after it are excluded automatically, including when a selected period endpoint overlaps the exclusion window. When two consecutive complete calendar years are present, the form defaults to comparing those full years with the intervention at their boundary; otherwise it starts with ranges around the dataset midpoint.

The result compares VET, η_VET, pumped volume, sold energy, volume-weighted supply and return temperatures, measured ΔT, the method-appropriate reference / available temperature span, and time-weighted average outdoor temperature when present. Absolute changes are shown, and relative changes are shown where meaningful. Charts separate baseline and after intervals and mark the intervention date. Differences are measured associations and the date alone does not establish causation.

For Automatic FLOOR, **Baseline period** is the default reference; **Full historical dataset** is also available. The same frozen curve is used in both formal comparison periods. The optional **Observed operational FLOOR development** result independently re-identifies the historical FLOOR curve from after-period return/outdoor observations. It is kept separate and is never substituted into the formal before/after η_VET calculation.

Three-pipe interpretation follows the VET definition. Return-side heat utilization may extract useful heat from return-side water without increasing primary circulation. A decentralized heat producer may increase useful delivered heat without increasing primary circulation. A return-temperature increase alone is not classified as deterioration or credited as improved VET; VET changes only with sold heat per pumped primary volume. The dashboard reports values without assigning a causal mechanism or rating.

## CSV schema

Required columns:

```csv
timestamp,sold_energy_MWh,pumped_volume_m3
```

Optional columns:

```text
supply_temperature_C,return_temperature_C,outdoor_temperature_C,T_cap_C,T_floor_C
```

Timestamps may be date-only or ISO date-time values. Date-only values and date/time controls use UTC calendar dates, independent of browser timezone. Date-times without an explicit timezone are interpreted as UTC; timestamps with an explicit `Z` or offset represent that instant and are displayed in UTC. Intervention date windows and date-only period ends use inclusive UTC calendar days. Hourly, daily, monthly, or other regularly sampled data are supported; actual timestamps are used rather than assuming a fixed timestep. Sold energy and pumped volume in each row must cover the same interval. CAP/FLOOR columns support legacy or engineering inputs but are not automatically substituted for missing Automatic CAP/FLOOR observations.

The importer reports missing required columns, malformed timestamps, invalid numeric values, nonpositive volume, negative sold energy, and invalid supplied bounds. It does not silently discard invalid rows. See [sample-vet-data.csv](./sample-vet-data.csv) for a synthetic daily dataset covering 2022–2023. The seasonal profiles are comparable across the two years; 2022 is the baseline, 2023 is post-intervention, and the demonstration intervention is dated 2023-01-01. The synthetic effect is represented through lower post-intervention return-temperature observations and lower calculated circulation for comparable energy demand. For transparency, synthetic pumped volume is derived as `sold_energy_MWh × 1,000 ÷ (1.163 × measured ΔT × 0.88)`, with 1.2% flow noise. The 0.88 factor and noise are dataset-generation assumptions, not additional VET or η_VET terms. VET and η_VET remain calculated from energy, volume, and the frozen temperature reference. An Engineering curve CSV uses `outdoor_temperature_C,T_floor_C` and may include `T_cap_C`.

## Privacy and local processing

Imported CSV data is processed locally in your browser. The dashboard does not upload or transmit imported datasets. It reads a selected or dropped file in the page using the browser File API, keeps the parsed values in in-memory JavaScript state for the current page session, and does not save the dataset to browser storage. The sample CSV is a synthetic file served as a static project asset.

## Run locally

From the project directory, start any static file server, for example:

```sh
python3 -m http.server 8000
```

Open <http://localhost:8000>. Select **Time series**, import `sample-vet-data.csv`, then try period comparison or open **Intervention / Three-pipe analysis**. No install step is needed.

Run calculation and dataset checks with Node.js:

```sh
node verify-model.mjs
```

The tests cover Snapshot formulas, CSV validation, automatic CAP/FLOOR, FLOOR binning and interpolation, period aggregation, time-weighted outdoor averages, frozen comparison references, intervention exclusion and reference behavior, date handling in positive and negative browser timezones, and GitHub Pages subdirectory paths.

## GitHub Pages deployment

All application assets use relative paths, so the site supports both a domain root and a repository path such as `https://USERNAME.github.io/vet-dashboard/`.

The page includes `noindex, nofollow`, and `robots.txt` requests that crawlers disallow the site. On a GitHub Pages project URL under `/<repository>/`, this repository's `robots.txt` is served under that subdirectory; crawlers normally look for robots rules at the host root (`/robots.txt`). The page-level meta directive still applies if a crawler visits the page. To have the robots file apply at the host root, deploy it as a root site or provide the host-root robots file separately. These directives only discourage crawling/indexing and do not restrict access.

1. Create a GitHub repository named `vet-dashboard` and choose public visibility if you intend the source to be public.
2. In this project, initialize Git, review the files being committed, and make the first commit. Configure your Git author name and email first, and choose an email you are comfortable making public:

   ```sh
   git init --initial-branch=main
   git add .
   git status --short
   git commit -m "Initial VET dashboard"
   ```

   Do not stage private operational datasets. Then add the new repository as `origin` and push the `main` branch (replace `USERNAME` with your GitHub username):

   ```sh
   git remote add origin https://github.com/USERNAME/vet-dashboard.git
   git push -u origin main
   ```

   GitHub may ask you to authenticate when you choose to push.
3. In the repository, open **Settings → Pages**. Under build and deployment, select **Deploy from a branch**, choose `main` and `/ (root)`, then save.
4. Wait for the Pages deployment to finish and open the published URL. The sample CSV download is relative to the repository subdirectory.

The project `.gitignore` excludes local environment/configuration files, editor settings, logs, and generated dependency folders. Review your repository contents before pushing; do not add real operational CSV exports.

## Methodological limitations

- Automatic FLOOR requires sufficiently populated 2 °C bins with both return and outdoor temperatures; it is not calibrated for load, season, network topology, or other conditions.
- The historical FLOOR method is an operational benchmark, not a universal thermodynamic constant. Post-intervention development may be noisy or unsupported when the selected period has too few observations.
- Outside the calibration range, the nearest supported FLOOR is held and flagged; the curve is not aggressively extrapolated.
- Aggregate η_VET is unavailable when selected intervals lack valid temperature-potential bounds.
- Intervention analysis is an observational before/after comparison. It does not weather-correct results or establish causation.
- This CSV format has no separate field for externally injected heat. VET uses the supplied sold-energy and pumped-volume measurements as entered.
- Sample values are synthetic and demonstrate the workflow; they are not an operating benchmark.

## Academic attribution

VET — Volumetric Energy Transfer Index

Developed from *Temperature-Based Capacity in Next Generation District Heating*, Oscar Raunio, 2026.

Interactive implementation of the VET methodology for district-heating analysis. This attribution does not imply endorsement by a university, employer, or other organization.
