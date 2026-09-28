# Device findings

Protocol notes for the devices supported by this app. Every entry was tested on
real hardware. Where noted, behaviour was confirmed with Zigbee sniffer captures
(CC2531) under a Tuya gateway, a Sonoff iHost and Zigbee2MQTT, and cross-checked
against the zigbee2mqtt converters.

The code is MIT licensed. Feel free to reuse any of this in other apps.

Legend: **[sniffer]** confirmed by packet capture · **[field]** confirmed by
long-running use on Homey · `TODO` needs to be filled in by the author.

---

## Contents

- [Cross-cutting findings](#cross-cutting-findings)
  - [Tuya ZCL extensions on switches and plugs (0x0006, 0xE000, 0xE001)](#tuya-zcl-extensions-on-switches-and-plugs)
  - [Time cluster (0x000A): Homey must act as time server](#time-cluster-0x000a-homey-must-act-as-time-server)
  - [Battery reporting needs a ZDO bind that Homey does not retry](#battery-reporting-needs-a-zdo-bind-that-homey-does-not-retry)
  - [Sleepy end devices: do not poll](#sleepy-end-devices-do-not-poll)
  - [Measuring Zigbee traffic per device](#measuring-zigbee-traffic-per-device)
- [Devices](#devices)
  - [Water tank monitor — TS0601 / _TZE200_lvkk0hdg](#water-tank-monitor)
  - [Ekaza siren — TS0601 / _TZE204_q76rtoa9](#ekaza-siren)
  - [Heiman gas detector — TS0204 / _TYZB01_0w3d5uw3](#heiman-gas-detector)
  - [2-gang wireless remote — TS0042 / _TZ3000_tzvbimpq](#2-gang-wireless-remote)
  - [Door/window sensors — TS0203](#doorwindow-sensors)
  - [LCD temperature/humidity sensor — TS0201 / _TZ3000_ywagc4rj](#lcd-temperaturehumidity-sensor)
  - [Temperature/humidity clock — TS0601 / _TZE200_cirvgep4, _TZE204_cirvgep4](#temperaturehumidity-clock)
  - [Power strip 4 + USB — TS011F / _TZ3000_cfnprab5](#power-strip-4--usb)
  - [Zigbee repeater — TS0207 / _TZ3000_nkkl7uzv](#zigbee-repeater)
- [NovaDigital switches and plugs (companion app)](#novadigital-switches-and-plugs-companion-app)
  - [Crosslink: one Homey command switching several gangs](#crosslink-one-homey-command-switching-several-gangs)

---

## Cross-cutting findings

### Tuya ZCL extensions on switches and plugs

**[sniffer]** Decoded from captures of TS000x / TS011F devices.

**On/Off cluster 0x0006: Tuya vendor attributes**

| Attribute | ID | Type | Meaning |
|---|---|---|---|
| backlightControl | 0x5000 | bool | Backlight behind the rocker (wall switches only; TS011F does **not** support it) |
| childLock | 0x8000 | bool | Physical button lock |
| indicatorMode | 0x8001 | enum8 | LED indicator behaviour (plugs) |
| powerOnStateGlobal | 0x8002 | enum8 | Power-on restore for **all** gangs at once |
| onTime / offWaitTime | 0x4001 / 0x4002 | uint16 | Write both to the same value (seconds) to configure countdown/inching |

**Cluster 0xE000 (57344): countdown reporting, EP1 only**

| Attribute | ID | Meaning |
|---|---|---|
| inchingTime | 0xD001 | Configured countdown duration (s) |
| inchingRemain | 0xD002 | Remaining countdown (s) |

- Both attributes use Tuya's non-standard data type **0x48**. Wire format:
  `[len: uint8 = 2][value: uint16 big-endian]`.
- The cluster must be registered in the app, otherwise every reconnect logs
  `cluster_unavailable` for each spontaneous report.
- **Useful side effect:** TS011F reports `inchingTime` only on power-restore or
  rejoin. That makes it a reliable "came back after a power cut" signal with no
  false positives, because countdown is not otherwise used in Homey.
- Read-only here. Configure the countdown through 0x0006 (0x4001/0x4002), not
  through this cluster.

**Cluster 0xE001 (57345): per-gang settings, present on every endpoint**

| Attribute | ID | Type | Meaning |
|---|---|---|---|
| (unknown) | 0xD000–0xD003 | uint8 | Seen in the spontaneous Report Attributes burst at power-on. Observed value 0 |
| powerOnStateGang | 0xD010 | enum8 | Power-on restore for **this** gang: 0 off, 1 on, 2 last state |
| tuyaMagic | 0xD011 | uint8 | Pairing magic byte (read-only) |
| switchMode | 0xD030 | enum8 | External input wiring: 0 toggle, 1 state, 2 momentary |

Global (0x0006/0x8002) and per-gang (0xE001/0xD010) power-on behaviour are
independent. Setting the global one does not update the per-gang values.

### Time cluster (0x000A): Homey must act as time server

**[field]** Confirmed via device interviews. Used by every driver in both apps.

- Most Tuya (and Sonoff) devices have an **output** binding to the
  coordinator's Time cluster and periodically ask Homey for the time.
- With no bound cluster registered, zigbee-clusters answers every such query
  with `binding_unavailable`. The result is log noise and devices that never
  get a valid time.
- Fix: register a shared time server on each endpoint,
  `endpoint.bind('time', new TimeServerBoundCluster())`, answering with:
  - `time`: live UTC in Zigbee epoch (seconds since 2000-01-01)
  - `timeZone`: local offset in seconds
  - `timeStatus`: synchronized
  - `localTime` = time + timeZone
- Some Sonoff devices (e.g. MINI-ZB1GP) also read `dstStart` / `dstEnd` /
  `dstShift`. Without them zigbee-clusters logs `not_implemented`, so a
  subclass adds those attributes.
- The Time cluster schema itself is registered globally, so reads and writes
  are parsed correctly.
- Related: Tuya devices send unsolicited Basic cluster (0x0000) reports during
  init. Binding a silent Basic bound cluster stops the "error while sending
  default error response" spam when the device is already unreachable.
- This is the ZCL Time cluster. TS0601 devices that request time through the
  Tuya cluster (0xEF00 command 0x24) need a separate answer via that cluster.
  Some devices use **both**, see the
  [temperature/humidity clock](#temperaturehumidity-clock).

**Tuya time sync (0xEF00, command 0x24)**

- Payload, 10 bytes: `[seq: 2 bytes][UTC: uint32 BE][local time: uint32 BE]`.
  `seq` echoes the first two bytes of the device's request.
- When the request prefix is `00 06` or `00 00`, answer with the 8-byte form
  (no `seq`).
- **Epochs differ:** Tuya uses Unix seconds (since 1970); the ZCL Time cluster
  uses seconds since 2000-01-01. Mixing them up shifts the clock by 30 years.

Implementation: [`lib/TimeCluster.js`](../lib/TimeCluster.js).

### Battery reporting needs a ZDO bind that Homey does not retry

**[sniffer]** Seen on TS0203 door sensors, three independent captures (Tuya
gateway, Sonoff iHost, Zigbee2MQTT).

- The device **does** send spontaneous battery reports, but only after a ZDO
  **Bind Request** for Power Configuration (0x0001) has been accepted.
- iHost and Z2M (both zigbee-herdsman) do this explicitly and in the same order:
  Bind Request, then Configure Reporting for `batteryPercentageRemaining` and
  `batteryVoltage` **separately**.
- On Homey, `configureAttributeReporting()` only sends the ZCL command, never a
  bind (verified in the homey-zigbeedriver source). The manifest `bindings`
  run once at pairing on Homey's closed platform layer, with no retry if the
  device was asleep at that moment.
- Result: battery reporting on Homey is unreliable for this reason, not because
  of the firmware. It can't be fixed from driver code. Documented here so nobody
  has to re-diagnose it.

### Sleepy end devices: do not poll

**[field]** Door sensors, LCD sensor, clock, remote.

- Devices with `receiveWhenIdle: false` do not answer `readAttributes` while
  asleep. Measured timeout rate was close to 100% during real idle periods.
  They only answer around genuine wake events (contact change, button, rejoin).
- Polling them only produces dead traffic and error logs. This app instead
  treats **any inbound frame** as proof of life and retries configuration
  (IAS enroll, reporting) on the next wake.
- Timeouts have to match the device. TS0203 door sensors routinely go ~14 h
  overnight without a frame, so they use a 24 h timeout.

### Measuring Zigbee traffic per device

`lib/AvailabilityManager.js` counts raw inbound Zigbee frames per device in
hourly buckets, before any driver filtering. The app's settings page (Traffic
tab) shows the current hour and the last 24 h per device. This is how the
water tank monitor's ~200k frames/day was measured, and it is a quick way to
spot devices that flood the mesh.

---

## Devices

### Water tank monitor

`TS0601` / `_TZE200_lvkk0hdg` (EPT Tech TLC2206-ZB, ultrasonic). Driver:
[`drivers/water_tank_monitor`](../drivers/water_tank_monitor/device.js).
Discussed upstream in JohanBendz/com.tuya.zigbee#1477.

| DP | Type | Direction | Meaning | Raw unit |
|---|---|---|---|---|
| 1 | enum | report | Liquid state: 0 normal, 1 low, 2 high | — |
| 2 | value | report | Liquid depth, 0–400 | **cm** (Z2M ÷100 → m) |
| 7 | value | read/write | High threshold | % |
| 8 | value | read/write | Low threshold | % |
| 19 | value | read/write | Installation height (sensor to tank bottom) | **mm** (Z2M ÷1000 → m) |
| 21 | value | read/write | Sensor to full-level distance | **mm** (Z2M ÷1000 → m) |
| 22 | value | report | Liquid percentage, 0–100 | % |

- Reading (DP2) is in cm while the writable distances (DP19/21) are in mm.
- Writes use 32-bit value DPs, followed by a `dataQuery` for read-back. The
  device echoes the new values.
- Validate before writing: low < high, full-level distance < installation height.
- The device requests Tuya time and should be answered.
- **Traffic: ~200k inbound frames/day (~2–3/s, continuous)** measured on Homey.
  ~10k/hour on Hubitat, so this is the device, not the platform. Driver-side
  filtering (duplicates, change threshold, minimum interval) protects
  capabilities and flows but cannot reduce RF traffic. The author moved this
  device to a separate Zigbee network because of it.
- Z2M limits DP19 to 3 m and DP21 to 2 m. This driver allows DP19 up to 4 m,
  consistent with the 0–400 cm range of DP2.
- Power source: the device announces itself as battery-powered, but Z2M forces
  it to mains. `TODO: confirm how your unit is powered (USB/mains vs battery).`

### Ekaza siren

`TS0601` / `_TZE204_q76rtoa9`. Driver: [`drivers/ekaza_siren`](../drivers/ekaza_siren/device.js).
Not supported by JohanBendz/com.tuya.zigbee at the time of writing.

**[sniffer]**

| DP | Type | Meaning |
|---|---|---|
| 5 | enum | Volume: 0 low, 1 medium, 2 high |
| 7 | value | Alarm duration, seconds (0–1800) |
| 13 | bool | Alarm on/off |
| 15 | value | Battery, 0–100 % |
| 21 | enum | Melody, 0–17 (18 melodies, list below) |

- The sniffer capture suggested the volume enum was inverted; testing on the
  device showed 0 = low. Trust the table above.
- Send melody, volume and duration **before** DP13=true. The driver sends them
  as one bulk command with 200 ms spacing.
- The device does **not** send DP13=false when the duration ends. Reset the UI
  state with a local timer (duration + 2 s).
- Melodies: 0 Doorbell chime, 1 Für Elise, 2 Westminster chimes, 3 Fast double
  doorbell, 4 William Tell overture, 5 Turkish march, 6 Security alarm,
  7 Chemical spill alert, 8 Piercing alarm clock, 9 Smoke alarm, 10 Dog barking,
  11 Police siren, 12 Doorbell chime (reverb), 13 Mechanical telephone,
  14 Fire/ambulance, 15 Elevator, 16 Buzzing alarm clock, 17 School bell.

### Heiman gas detector

`TS0204` / `_TYZB01_0w3d5uw3`. Driver: [`drivers/gas_detector`](../drivers/gas_detector/device.js).
Not supported by JohanBendz/com.tuya.zigbee at the time of writing.

IAS Zone (0x0500), mains-powered, zone type reported as `carbonMonoxideSensor`.

| zoneStatus bit | Meaning |
|---|---|
| 0 (0x0001) alarm1 | Gas detected |
| 6 (0x0040) trouble | Device fault |
| 8 (0x0100) test | Test mode (logged only) |

- The test button raises alarm1 exactly like a real detection. Filter short
  activations with a Flow condition ("stays on for X seconds") rather than in
  the driver.
- Send `zoneEnrollResponse` on every init and handle `zoneEnrollRequest` for
  re-enrollment after a factory reset.
- The device sends Tuya manufacturer-specific frames (0xF1) on the Basic
  cluster. They can be ignored.
- IAS devices are silent while idle, so availability is callback-driven (4 h
  timeout). Being mains-powered, it can safely answer an active poll before
  being marked offline.

### 2-gang wireless remote

`TS0042` / `_TZ3000_tzvbimpq`. Driver:
[`drivers/wireless_switch_remote_2_gang`](../drivers/wireless_switch_remote_2_gang/device.js).
Seeded from JohanBendz/com.tuya.zigbee. Not supported there for this fingerprint
at the time of writing.

**[sniffer]** Cross-checked against zigbee2mqtt `fz.tuya_on_off_action`.

- One endpoint per button (EP1 left, EP2 right).
- A press is On/Off (0x0006) cluster-specific command **0xFD**. Press type is
  `frame[3]`: 0 single, 1 double, 2 long.
- This unit sends one frame per press with a unique TSN. Sibling TS004x
  firmwares double-fire with the same TSN (JohanBendz/com.tuya.zigbee#793), so
  dropping an immediate repeat of the same TSN is kept as a safeguard.
- Intercept 0xFD by wrapping `node.handleFrame`, not replacing it, so battery
  reports (0x0001) still reach the normal handler. Guard against wrapping twice
  on re-init.
- Battery: `batteryPercentageRemaining`, 0–200 → %. Parse spontaneous reports;
  don't read at startup (sleepy).

### Door/window sensors

`TS0203`. IAS Zone (0x0500), zone type contactSwitch.

| Driver | Fingerprints | Battery |
|---|---|---|
| [`doorwindowsensor`](../drivers/doorwindowsensor/device.js) | `_TZ3000_7tbsruql`, `_TZ3000_osu834un` | CR2032 |
| [`doorwindowsensor_2`](../drivers/doorwindowsensor_2/device.js) | `_TZ3000_6zvw8ham`, `_TZ3000_decxrtwa` | 2× AAA |

| zoneStatus bit | Meaning |
|---|---|
| 0 (0x0001) alarm1 | Open |
| 1 (0x0002) alarm2 | Open (secondary check, AAA variant) |
| 3 (0x0008) battery | Low battery |

- **Enrollment matters.** Without a valid enroll response some units stop
  sending `zoneStatusChangeNotification` entirely, which looks like the device
  went silent. Send `zoneEnrollResponse` on every init, handle
  `zoneEnrollRequest`, and retry on later wake-ups: sleepy units often miss the
  CIE address write / enroll response at app start.
- Battery reporting: see [the ZDO bind finding](#battery-reporting-needs-a-zdo-bind-that-homey-does-not-retry).
- ~14 h without any frame overnight is normal **[field]**. Use a 24 h
  availability timeout and don't poll.

### LCD temperature/humidity sensor

`TS0201` / `_TZ3000_ywagc4rj`. Driver: [`drivers/lcdtemphumidsensor`](../drivers/lcdtemphumidsensor/device.js).

- Sleepy end device, CR2032. **Does not accept** Configure Reporting; it reports
  on change by itself.
- Conversions: temperature raw ÷ 100 (standard), **humidity raw ÷ 10**
  (non-standard; ZCL would be ÷ 100), battery raw ÷ 2.
- Probes the coordinator's Time cluster. Not needed here; can be ignored.
- `cluster.on('report')` was unreliable in some homey-zigbeedriver versions.
  Marking the device alive inside `reportParser` works reliably.

### Temperature/humidity clock

`TS0601` / `_TZE200_cirvgep4`, `_TZE204_cirvgep4`. Driver:
[`drivers/temphumidclock`](../drivers/temphumidclock/device.js).

| DP | Meaning |
|---|---|
| 1 | Temperature, raw ÷ 10 → °C |
| 2 | Humidity, % |
| 3 | Battery enum: 0 = 33 %, 1 = 66 %, 2 = 100 % |
| 9 | Temperature unit: 0 °C, 1 °F |

- Sleepy. Sends bursts of repeated frames on each wake. Drop unchanged values.
- **Uses both time paths [sniffer]:** Tuya command 0x24 on 0xEF00 and a ZCL
  Time cluster (0x000A) read.
  - On a Tuya time request, answer with 0x24 (local timezone) and then send the
    gateway status command **0x10 with payload `[0x00, 0x36]`**, as the Tuya hub
    does in the capture after a time sync.
  - The ZCL Time read is answered by the shared time server, but it is also a
    useful wake signal: if no Tuya time request arrives within 10 s, push the
    Tuya time (0x24 + 0x10) anyway. Throttle this fallback to once per 2 min,
    unless a new rejoin (Device Announce) happened.
- Send nothing else while it is awake: extra commands during rejoin can miss
  the short wake window.

### Power strip 4 + USB

`TS011F` / `_TZ3000_cfnprab5`. Driver: [`drivers/socket_power_strip`](../drivers/socket_power_strip/device.js).

- Five endpoints (4 sockets + USB), each with 0x0006, plus 0xE000 on EP1.
- Supports `powerOnStateGlobal` (0x8002) and `indicatorMode` (0x8001). **No**
  `backlightControl` (0x5000).
- Power-restore detection via 0xE000 `inchingTime` (see
  [above](#tuya-zcl-extensions-on-switches-and-plugs)). Rejoin is signalled by
  ZDO Device Announce; `powerOnStateGlobal` may be reported periodically and is
  **not** a rejoin signal.
- Using both `registerCapability` and `configureAttributeReporting` for onoff
  processes every report twice. `registerCapabilityListener` alone is enough
  for UI → device.
- After a rejoin, re-read onOff on all endpoints and re-apply attribute
  reporting: the device can lose its reporting configuration after a power cycle.
- Secondary endpoints send unknown commands that only produce log noise. Filter
  them, but let attribute reports (cmd 0x0A) through.

### Zigbee repeater

`TS0207` / `_TZ3000_nkkl7uzv`. Driver: [`drivers/zigbee_repeater`](../drivers/zigbee_repeater/device.js).

- Sends **no** spontaneous ZCL frames. Availability needs an active ping
  (every 30 min here, same approach as Hubitat's generic repeater driver).
- Treat ZDO Device Announce as "back online" and restore availability
  immediately. A quiet router may otherwise stay marked unavailable after it
  returns.
- Probes the coordinator's Time cluster. Can be ignored.

---

## NovaDigital switches and plugs (companion app)

These live in a separate, published app:
[gpmachado/com.gpm.novadigital](https://github.com/gpmachado/com.gpm.novadigital)
(MIT). The same two structures cover every gang count from 1 to 6.

**[field]** All wall switches below (1, 2, 3, 4 and 6 gang) were tested on
real hardware, with no "crosslink". The findings apply to any Tuya wall switch
with the same structure, not only the NovaDigital-branded units.

### Crosslink: one Homey command switching several gangs

**[field]** Took a long time to get right.

- **Symptom:** turning on gang 1 **from Homey** also switched gang 2 (or all
  gangs). Physical buttons on the wall never caused it; only Homey → device
  commands did.
- **Context:** a multi-gang switch is paired as EP1 (main device) plus one
  Homey sub-device per extra gang, all sharing the same Zigbee node. Without
  strict isolation, a command meant for one gang was not confined to that
  gang's endpoint.
- **What works** (used by every ZCL multi-gang driver in com.gpm.novadigital):
  - Each device (main or sub-device) resolves **its own** endpoint once at init
    (`this._endpoint`, from `subDeviceId`) and never touches another gang's
    on/off.
  - UI → device: only `registerCapabilityListener('onoff')`, which sends
    `setOn()` / `setOff()` to `zclNode.endpoints[this._endpoint].clusters.onOff`.
    No `registerCapability('onoff', …)` for on/off.
  - Device → UI: an `attr.onOff` listener on that same endpoint's cluster, plus
    an `OnOffBoundCluster` bound on that endpoint for commands the device sends.
  - Settings shared by all gangs (backlight, global power-on) are read and
    written only from EP1.
- Implementation: `_setupOnOffEndpoint()` and `_onCapabilityOnOff()` in
  [`lib/TuyaZclBase.js`](https://github.com/gpmachado/com.gpm.novadigital/blob/main/lib/TuyaZclBase.js).

### ZCL switches (TS0001 / TS0002 / TS0003 / TS0004)

| Driver | Model | Fingerprints |
|---|---|---|
| 1 gang | TS0001 | `_TZ3000_ovyaisip`, `_TZ3000_pk8tgtdb` |
| 2 gang | TS0002 | `_TZ3000_ywubfuvt`, `_TZ3000_kgxej1dv` |
| 2 gang touch | TS0002 | `_TZ3000_jjdkhueq` |
| 3 gang | TS0003 | `_TZ3000_yervjnlj`, `_TZ3000_vjhcenzo`, `_TZ3000_qxcnwv26`, `_TZ3000_eqsair32`, `_TZ3000_f09j9qjb`, `_TZ3000_fawk5xjv`, `_TZ3000_ok0ggpk7` |
| 4 gang ZCL | TS0004 | `_TZ3000_lwthnp7j` |

- One endpoint per gang, each with 0x0006 and 0xE001. 0xE000 on EP1 only.
  All vendor attributes in
  [the ZCL extensions section](#tuya-zcl-extensions-on-switches-and-plugs) apply.
- Global settings (backlight 0x5000, powerOnStateGlobal 0x8002, indicator
  0x8001) belong to EP1. Per-gang power-on (0xD010) and switchMode (0xD030)
  are per endpoint.
- These settings live in non-volatile memory. Read them once at first pairing;
  after a rejoin the device reports them by itself, so re-reading on every boot
  is unnecessary traffic.
- childLock is reported by wall switches but has no practical use there.
- Inching (auto-off after a delay, for pulse/doorbell use) works per gang via
  0x0006 onTime/offWaitTime and persists across power cuts. Send one write per
  settings save, even when several inching values changed.
- Wall switches restore both relay state and configuration after a power cut.
  The backlight can be configured to stay off after power returns.

### Tuya DP switches (TS0601, 4 and 6 gang)

| Driver | Fingerprints | DPs |
|---|---|---|
| 4 gang | `_TZE200_shkxsgis`, `_TZE284_shkxsgis`, `_TZE204_aagrxlbd` | 1–4 gang on/off (bool), **14** power-on state enum (0 off, 1 on, 2 last state) |
| 6 gang | `_TZE200_r731zlxk`, `_TZE284_r731zlxk` | 1–6 gang on/off (bool) |

- Single endpoint (0xEF00). Each gang is exposed as a sub-device mapped to its DP.
- Ignore the echo of your own write so the UI doesn't flicker.

### Detecting "back after a power cut"

**[field]** Used for a "Reconnected after power cut" flow trigger. Works even
for outages too short to make the device unavailable.

- **ZCL switches and TS011F plugs:** the 0xE000 `inchingTime` report (see above).
- **4-gang DP switch:** DP14 (power-on state) is only reported on power restore.
- **6-gang DP switch (no such DP):** on power restore all gangs dump their state
  at once. **3 or more DPs within 600 ms** means a rejoin; in normal use gangs
  are toggled one at a time. Suppress this check right after your own commands
  (a flow switching 3 gangs produces the same burst), and apply a 30 s cooldown.
- A 120 s delay after app start avoids false triggers from the startup state
  sync.

### Smart plugs with metering (TS011F)

| Driver | Fingerprints |
|---|---|
| smartplug | `_TZ3000_88iqnhvd`, `_TZ3000_okaz9tjs` |
| smartplug_2 | `_TZ3210_fgwhjm9j` |
| smartplug_3 | `_TZ3000_cehuw1lw` |

- Power, current, voltage via Electrical Measurement (0x0B04); energy via
  Metering (0x0702).
- When unplugged, stop polling and rely on availability detection instead of
  generating failed requests.

---

`TODO` — additional sniffer findings not yet reflected in the code:

- `TODO: capture files / dates, if you want to reference them`
- `TODO: anything else you found while investigating clusters`
